import { createMessageId, messageLookupKey } from "./message-identity.js";
import { applySlateResults, MATCH_SCORING } from "../slate-core.js";
import { APP_CONFIG } from "../config.js";
import {
  TEAM_COLOR_PALETTE,
  VICTORY_MODES,
  aggregateLifetimeStats,
  allPlayersSubmitted,
  allScoresConfirmed,
  allPlayersAssignedToTeams,
  buildPlayerGameSummary,
  calculateRoundResults,
  clampNumber,
  lockedPlayerIds,
  makeGameCode,
  makeHostNumber,
  normalizeEmail,
  normalizeNickname,
  now,
  rankLifetimeStats
} from "../core.js";
import { cleanQuestionStarter, promptFromQuery } from "../data/question-bank.js";

const SDK_VERSION = "12.18.0";
const sdkUrl = (service) =>
  `https://www.gstatic.com/firebasejs/${SDK_VERSION}/firebase-${service}.js`;

function appError(code, message) {
  return Object.assign(new Error(message), { code });
}

async function makePlayerLoginKey(email, displayName) {
  const source = `${normalizeEmail(email)}|${normalizeNickname(displayName)}`;
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export class FirebaseGameService {
  constructor() {
    this.isDemo = false;
    this.app = null;
    this.auth = null;
    this.db = null;
    this.api = {};
    this.profile = null;
  }

  async init() {
    const [appApi, authApi, databaseApi] = await Promise.all([
      import(sdkUrl("app")),
      import(sdkUrl("auth")),
      import(sdkUrl("database"))
    ]);

    this.api = { ...appApi, ...authApi, ...databaseApi };
    this.app = appApi.initializeApp(APP_CONFIG.firebase);
    this.auth = authApi.getAuth(this.app);
    this.db = databaseApi.getDatabase(this.app);
    await authApi.setPersistence(this.auth, authApi.browserLocalPersistence);
  }

  onAuth(callback) {
    return this.api.onAuthStateChanged(this.auth, async (user) => {
      try {
        this.profile = user ? await this.loadProfileForAuth(user) : null;
        if (this.profile) await this.prepareMessageIdentity();
        callback(this.profile ? this.toAppUser(user, this.profile) : null, this.profile);
      } catch (error) {
        console.error("Could not restore the signed-in profile.", error);
        // A temporary database read failure should not make a visible session
        // look signed out. Keep the last confirmed profile and let the user retry.
        if (user && this.profile) {
          callback(this.toAppUser(user, this.profile), this.profile);
          return;
        }
        this.profile = null;
        callback(null, null);
      }
    });
  }

  toAppUser(authUser, profile) {
    return {
      uid: profile.profileId,
      authUid: authUser.uid,
      email: profile.email,
      displayName: profile.displayName,
      isAnonymous: authUser.isAnonymous
    };
  }

  identityUid() {
    return this.profile?.profileId || this.auth.currentUser?.uid;
  }

  async loadProfileForAuth(user) {
    let profileId = user.uid;
    if (user.isAnonymous) {
      const session = await this.api.get(this.api.ref(this.db, `sessions/${user.uid}`));
      if (!session.exists()) return null;
      profileId = session.child("profileId").val();
    }
    const profile = await this.getProfile(profileId);
    return profile ? { ...profile, profileId } : null;
  }

  async ensureAnonymousAuth() {
    if (this.auth.currentUser && !this.auth.currentUser.isAnonymous) {
      await this.api.signOut(this.auth);
    }
    if (!this.auth.currentUser) {
      return (await this.api.signInAnonymously(this.auth)).user;
    }
    return this.auth.currentUser;
  }

  validatePlayerInput(email, displayName) {
    if (!normalizeEmail(email) || !normalizeEmail(email).includes("@")) {
      throw appError("INVALID_EMAIL", "Enter a valid email address.");
    }
    if (!normalizeNickname(displayName)) {
      throw appError("INVALID_NICKNAME", "Your nickname needs at least one letter or number.");
    }
  }

  async signUp({ email, displayName }) {
    this.validatePlayerInput(email, displayName);
    const authUser = await this.ensureAnonymousAuth();
    const cleanEmail = normalizeEmail(email);
    const cleanName = String(displayName).trim();
    const loginKey = await makePlayerLoginKey(cleanEmail, cleanName);
    const existing = await this.api.get(this.api.ref(this.db, `loginLookup/${loginKey}`));
    if (existing.exists()) {
      throw appError("PLAYER_EXISTS", "That player already exists. Choose Find Player instead.");
    }

    const profileId = this.api.push(this.api.ref(this.db, "users")).key;
    const profile = {
      displayName: cleanName,
      email: cleanEmail,
      role: "player",
      hostNumber: null,
      authProvider: "anonymous",
      ownerAuthUid: authUser.uid,
      loginKey,
      createdAt: now(),
      updatedAt: now()
    };

    await this.api.set(this.api.ref(this.db, `users/${profileId}`), profile);
    const claim = await this.api.runTransaction(
      this.api.ref(this.db, `loginLookup/${loginKey}`),
      (current) => current || profileId
    );
    if (claim.snapshot.val() !== profileId) {
      await this.api.remove(this.api.ref(this.db, `users/${profileId}`));
      throw appError("PLAYER_EXISTS", "That player was just created. Choose Find Player instead.");
    }
    await this.api.set(this.api.ref(this.db, `sessions/${authUser.uid}`), { profileId, loginKey });
    this.profile = { ...profile, profileId };
    await this.prepareMessageIdentity();
    return this.toAppUser(authUser, this.profile);
  }

  async signIn({ email, displayName }) {
    this.validatePlayerInput(email, displayName);
    const authUser = await this.ensureAnonymousAuth();
    const loginKey = await makePlayerLoginKey(email, displayName);
    const lookup = await this.api.get(this.api.ref(this.db, `loginLookup/${loginKey}`));
    if (!lookup.exists()) {
      throw appError("PLAYER_NOT_FOUND", "We did not find that email and nickname together.");
    }
    const profileId = lookup.val();
    await this.api.set(this.api.ref(this.db, `sessions/${authUser.uid}`), { profileId, loginKey });
    const profile = await this.getProfile(profileId);
    if (!profile) throw appError("PLAYER_NOT_FOUND", "That player profile is no longer available.");
    this.profile = { ...profile, profileId };
    await this.prepareMessageIdentity();
    return this.toAppUser(authUser, this.profile);
  }

  async signOut() {
    const authUser = this.auth.currentUser;
    if (authUser?.isAnonymous) {
      await this.api.remove(this.api.ref(this.db, `sessions/${authUser.uid}`)).catch(() => {});
    }
    if (authUser) await this.api.signOut(this.auth);
    this.profile = null;
  }

  async getProfile(uid) {
    const snapshot = await this.api.get(this.api.ref(this.db, `users/${uid}`));
    return snapshot.exists() ? snapshot.val() : null;
  }

  async prepareMessageIdentity() {
    try {
      return await this.ensureMessageIdentity();
    } catch (error) {
      // A pending rules update must not prevent an existing player from signing in.
      console.warn("Message ID setup will retry in Message Center.", error.code || error.message);
      return null;
    }
  }

  async ensureMessageIdentity() {
    const uid = this.identityUid();
    if (!uid) throw new Error("Find your player before opening Message Center.");
    if (this.messageIdentityTask?.uid === uid) return this.messageIdentityTask.promise;
    const promise = this.provisionMessageIdentity(uid);
    this.messageIdentityTask = { uid, promise };
    try { return await promise; }
    finally { if (this.messageIdentityTask?.promise === promise) this.messageIdentityTask = null; }
  }

  async provisionMessageIdentity(uid) {
    for (let attempt = 0; attempt < 8; attempt++) {
      const profile = await this.getProfile(uid);
      if (!profile) throw new Error("That player profile is no longer available.");
      const messageId = profile.messageId || createMessageId();
      const key = await messageLookupKey(messageId, profile.displayName);
      if (profile.messageId && profile.messageLookupKey === key) {
        if (this.identityUid() === uid) this.profile = { ...profile, profileId: uid };
        return { messageId, displayName: profile.displayName };
      }
      const updates = {
        [`users/${uid}/messageId`]: messageId,
        [`users/${uid}/messageLookupKey`]: key,
        [`messageIds/${messageId}`]: uid,
        [`messageLookup/${key}`]: uid
      };
      if (profile.messageLookupKey && profile.messageLookupKey !== key) updates[`messageLookup/${profile.messageLookupKey}`] = null;
      try {
        // Claim both directions together. Rules reject duplicate IDs and prevent
        // two devices from assigning different IDs to the same player.
        await this.api.update(this.api.ref(this.db), updates);
        if (this.identityUid() === uid) this.profile = { ...profile, profileId: uid, messageId, messageLookupKey: key };
        return { messageId, displayName: profile.displayName };
      } catch (error) {
        if (!/permission.?denied/i.test(String(error.code || error.message))) throw error;
        const latest = await this.getProfile(uid);
        if (latest?.messageId && (latest.messageId !== messageId || latest.displayName !== profile.displayName)) continue;
        let occupied;
        try { occupied = await this.api.get(this.api.ref(this.db, `messageIds/${messageId}`)); }
        catch { throw appError("MESSAGE_SETUP_REQUIRED", "Message IDs are not available yet. Ask the host to finish the message setup, then try again."); }
        if (!profile.messageId && occupied.exists() && occupied.val() !== uid) continue;
        throw appError("MESSAGE_SETUP_REQUIRED", "Message IDs are not available yet. Ask the host to finish the message setup, then try again.");
      }
    }
    throw new Error("Your Message ID could not be assigned. Please try again.");
  }

  async updateDisplayName(displayName) {
    const cleanName = String(displayName || "").trim();
    if (!normalizeNickname(cleanName)) {
      throw appError("INVALID_NICKNAME", "Your nickname needs at least one letter or number.");
    }
    const uid = this.identityUid();
    const oldProfile = { ...(await this.getProfile(uid)), profileId: uid };
    const [gamesSnapshot, statsSnapshot] = await Promise.all([
      this.api.get(this.api.ref(this.db, `sameSlateUserGames/${uid}`)),
      this.api.get(this.api.ref(this.db, `sameSlatePlayerStats/${uid}`))
    ]);
    const updates = {
      [`users/${uid}/displayName`]: cleanName,
      [`users/${uid}/updatedAt`]: now()
    };
    for (const gameId of Object.keys(gamesSnapshot.val() || {})) {
      const snapshot = await this.api.get(this.api.ref(this.db, `sameSlateGames/${gameId}`)).catch(() => null);
      const game = snapshot?.val();
      if (game?.players?.[uid]) updates[`sameSlateGames/${gameId}/players/${uid}/displayName`] = cleanName;
      if (game?.hostUid === uid) updates[`sameSlateGames/${gameId}/hostDisplayName`] = cleanName;
    }
    if (statsSnapshot.exists()) updates[`sameSlatePlayerStats/${uid}/displayName`] = cleanName;

    const [otherGamesSnapshot, otherStatsSnapshot] = await Promise.all([
      this.api.get(this.api.ref(this.db, `userGames/${uid}`)).catch(() => null),
      this.api.get(this.api.ref(this.db, `playerStats/${uid}`)).catch(() => null)
    ]);
    for (const gameId of Object.keys(otherGamesSnapshot?.val() || {})) {
      const snapshot = await this.api.get(this.api.ref(this.db, `games/${gameId}`)).catch(() => null);
      const game = snapshot?.val();
      if (game?.players?.[uid]) updates[`games/${gameId}/players/${uid}/displayName`] = cleanName;
      if (game?.hostUid === uid) updates[`games/${gameId}/hostDisplayName`] = cleanName;
    }
    if (otherStatsSnapshot?.exists()) updates[`playerStats/${uid}/displayName`] = cleanName;

    if (oldProfile.messageId) {
      const key = await messageLookupKey(oldProfile.messageId, cleanName);
      updates[`users/${uid}/messageLookupKey`] = key;
      updates[`messageLookup/${key}`] = uid;
      if (oldProfile.messageLookupKey && oldProfile.messageLookupKey !== key) updates[`messageLookup/${oldProfile.messageLookupKey}`] = null;
      oldProfile.messageLookupKey = key;
    }

    if (oldProfile.authProvider === "anonymous") {
      const newLoginKey = await makePlayerLoginKey(oldProfile.email, cleanName);
      const oldLoginKey = oldProfile.loginKey;
      const collision = await this.api.get(this.api.ref(this.db, `loginLookup/${newLoginKey}`));
      if (collision.exists() && collision.val() !== uid) {
        throw appError("NICKNAME_TAKEN", "That email and nickname combination already belongs to another player.");
      }
      updates[`users/${uid}/loginKey`] = newLoginKey;
      await this.api.update(this.api.ref(this.db), updates);
      if (oldLoginKey !== newLoginKey) {
        await this.api.set(this.api.ref(this.db, `loginLookup/${newLoginKey}`), uid);
        await this.api.set(this.api.ref(this.db, `sessions/${this.auth.currentUser.uid}`), {
          profileId: uid,
          loginKey: newLoginKey
        });
        await this.api.remove(this.api.ref(this.db, `loginLookup/${oldLoginKey}`));
      }
      this.profile = { ...oldProfile, displayName: cleanName, loginKey: newLoginKey, updatedAt: now() };
    } else {
      await Promise.all([
        this.api.updateProfile(this.auth.currentUser, { displayName: cleanName }),
        this.api.update(this.api.ref(this.db), updates)
      ]);
      this.profile = { ...oldProfile, displayName: cleanName, updatedAt: now() };
    }
    return this.profile;
  }

  async getCrossGameStats(playerUid) {
    const [feud, slate] = await Promise.all([
      this.api.get(this.api.ref(this.db, `playerStats/${playerUid}`)),
      this.api.get(this.api.ref(this.db, `sameSlatePlayerStats/${playerUid}`))
    ]);
    return { googlefeud: feud.val() || {}, sameSlate: slate.val() || {} };
  }

  watchMessages(callback, onError) {
    const query = this.api.query(this.api.ref(this.db, `mailboxes/${this.identityUid()}`), this.api.orderByChild("createdAt"), this.api.limitToLast(100));
    return this.api.onValue(query, (snapshot) => callback(Object.entries(snapshot.val() || {})
      .map(([id, value]) => ({ id, ...value })).sort((a, b) => b.createdAt - a.createdAt)), onError);
  }

  async sendMessage({ messageId, displayName, body, replyTo = null }) {
    const fromUid = this.identityUid();
    const text = String(body || "").trim();
    if (!text || text.length > 2000) throw new Error("Write a message of 1–2,000 characters.");
    let toUid;
    let toName;
    let recipientKey;
    if (replyTo) {
      const prior = await this.api.get(this.api.ref(this.db, `mailboxes/${fromUid}/${replyTo.id}`));
      if (!prior.exists() || prior.val().toUid !== fromUid || prior.val().fromUid !== replyTo.uid) throw new Error("That message is no longer available to reply to.");
      toUid = prior.val().fromUid; toName = prior.val().fromName;
    } else {
      recipientKey = await messageLookupKey(messageId, displayName);
      const target = await this.api.get(this.api.ref(this.db, `messageLookup/${recipientKey}`));
      if (!target.exists()) throw new Error("No player has that Message ID and nickname together. Check both and try again.");
      toUid = target.val(); toName = String(displayName).trim().slice(0, 30);
    }
    if (toUid === fromUid) throw new Error("Choose another player to message.");
    const id = this.api.push(this.api.ref(this.db, `mailboxes/${fromUid}`)).key;
    const message = { fromUid, toUid, fromName: this.profile.displayName, toName, body: text, createdAt: this.api.serverTimestamp(), ...(replyTo ? { replyToId: replyTo.id } : { recipientKey }) };
    await this.api.update(this.api.ref(this.db), { [`mailboxes/${fromUid}/${id}`]: message, [`mailboxes/${toUid}/${id}`]: message });
    return id;
  }

  async markMessageRead(id) {
    await this.api.set(this.api.ref(this.db, `mailboxes/${this.identityUid()}/${id}/readAt`), this.api.serverTimestamp());
  }

  async deleteMessage(id) {
    await this.api.remove(this.api.ref(this.db, `mailboxes/${this.identityUid()}/${id}`));
  }

  async listUsers() {
    const snapshot = await this.api.get(this.api.ref(this.db, "users"));
    return snapshot.exists() ? snapshot.val() : {};
  }

  async getMyHostRequest() {
    const uid = this.identityUid();
    const snapshot = await this.api.get(this.api.ref(this.db, `hostRequests/${uid}`));
    return snapshot.exists() ? snapshot.val() : null;
  }

  async requestHostAccess() {
    const uid = this.identityUid();
    const profile = this.profile || (await this.getProfile(uid));
    if (!profile || profile.role !== "player") {
      throw appError("PLAYER_REQUIRED", "Only player accounts need to request host access.");
    }
    const request = {
      displayName: profile.displayName,
      status: "pending",
      requestedAt: now()
    };
    await this.api.set(this.api.ref(this.db, `hostRequests/${uid}`), request);
    return request;
  }

  async cancelHostRequest() {
    const uid = this.identityUid();
    await this.api.remove(this.api.ref(this.db, `hostRequests/${uid}`));
  }

  async listHostRequests() {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can review host requests.");
    }
    const snapshot = await this.api.get(this.api.ref(this.db, "hostRequests"));
    return snapshot.exists() ? snapshot.val() : {};
  }

  async submitQuestion({ query, category }) {
    const uid = this.identityUid();
    const profile = this.profile || (await this.getProfile(uid));
    const cleanQuery = cleanQuestionStarter(query);
    const cleanCategory = String(category || "Community Pick").trim().slice(0, 40) || "Community Pick";
    if (cleanQuery.length < 3 || cleanQuery.length > 100) {
      throw appError("INVALID_QUESTION", "The question starter must be between 3 and 100 characters.");
    }
    const questionId = this.api.push(this.api.ref(this.db, `sameSlateQuestionSubmissions/${uid}`)).key;
    const timestamp = now();
    const submission = {
      questionId,
      submittedBy: uid,
      submittedByName: profile?.displayName || "Player",
      category: cleanCategory,
      query: cleanQuery,
      prompt: promptFromQuery(cleanQuery),
      status: "pending",
      submittedAt: timestamp,
      updatedAt: timestamp
    };
    await this.api.set(this.api.ref(this.db, `sameSlateQuestionSubmissions/${uid}/${questionId}`), submission);
    return submission;
  }

  async listMyQuestionSubmissions() {
    const uid = this.identityUid();
    const snapshot = await this.api.get(this.api.ref(this.db, `sameSlateQuestionSubmissions/${uid}`));
    if (!snapshot.exists()) return [];
    return Object.values(snapshot.val())
      .sort((a, b) => Number(b.submittedAt || 0) - Number(a.submittedAt || 0));
  }

  async listQuestionSubmissions() {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can review submitted questions.");
    }
    const snapshot = await this.api.get(this.api.ref(this.db, "sameSlateQuestionSubmissions"));
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val()).flatMap(([ownerUid, submissions]) =>
      Object.entries(submissions || {}).map(([questionId, submission]) => ({ ownerUid, questionId, ...submission }))
    ).sort((a, b) => {
      const statusOrder = { pending: 0, approved: 1, declined: 2 };
      return (statusOrder[a.status] ?? 3) - (statusOrder[b.status] ?? 3)
        || Number(b.submittedAt || 0) - Number(a.submittedAt || 0);
    });
  }

  async reviewQuestionSubmission(ownerUid, questionId, { query, category, status }) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can review submitted questions.");
    }
    if (!["pending", "approved", "declined"].includes(status)) {
      throw appError("INVALID_STATUS", "Choose Pending, Approved, or Declined.");
    }
    const cleanQuery = cleanQuestionStarter(query);
    const cleanCategory = String(category || "Community Pick").trim().slice(0, 40) || "Community Pick";
    if (cleanQuery.length < 3 || cleanQuery.length > 100) {
      throw appError("INVALID_QUESTION", "The question starter must be between 3 and 100 characters.");
    }
    const path = `sameSlateQuestionSubmissions/${ownerUid}/${questionId}`;
    const currentSnapshot = await this.api.get(this.api.ref(this.db, path));
    if (!currentSnapshot.exists()) throw appError("QUESTION_NOT_FOUND", "That submitted question no longer exists.");
    const timestamp = now();
    const prompt = promptFromQuery(cleanQuery);
    const reviewed = {
      ...currentSnapshot.val(),
      questionId,
      category: cleanCategory,
      query: cleanQuery,
      prompt,
      status,
      reviewedAt: timestamp,
      updatedAt: timestamp
    };
    const approvedPath = `sameSlateApprovedQuestions/${questionId}`;
    await this.api.update(this.api.ref(this.db), {
      [path]: reviewed,
      [approvedPath]: status === "approved" ? {
        id: `custom-${questionId}`,
        category: cleanCategory,
        query: cleanQuery,
        prompt,
        approvedAt: timestamp,
        updatedAt: timestamp
      } : null
    });
    return reviewed;
  }

  async listApprovedQuestions() {
    const snapshot = await this.api.get(this.api.ref(this.db, "sameSlateApprovedQuestions"));
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val())
      .map(([questionId, question]) => ({ questionId, ...question }))
      .sort((a, b) => String(a.prompt || "").localeCompare(String(b.prompt || ""), undefined, { sensitivity: "base", numeric: true }));
  }

  async createApprovedQuestion({ query, category }) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can add approved questions.");
    }
    const cleanQuery = cleanQuestionStarter(query);
    const cleanCategory = String(category || "Community Pick").trim().slice(0, 40) || "Community Pick";
    if (cleanQuery.length < 3 || cleanQuery.length > 100) {
      throw appError("INVALID_QUESTION", "The question starter must be between 3 and 100 characters.");
    }
    const questionId = this.api.push(this.api.ref(this.db, "sameSlateApprovedQuestions")).key;
    const timestamp = now();
    const question = {
      id: `custom-${questionId}`,
      category: cleanCategory,
      query: cleanQuery,
      prompt: promptFromQuery(cleanQuery),
      approvedAt: timestamp,
      updatedAt: timestamp
    };
    await this.api.set(this.api.ref(this.db, `sameSlateApprovedQuestions/${questionId}`), question);
    return { questionId, ...question };
  }

  async updateApprovedQuestion(questionId, { query, category }) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can edit approved questions.");
    }
    const questionRef = this.api.ref(this.db, `sameSlateApprovedQuestions/${questionId}`);
    const currentSnapshot = await this.api.get(questionRef);
    if (!currentSnapshot.exists()) {
      throw appError("QUESTION_NOT_FOUND", "That custom question no longer exists.");
    }
    const cleanQuery = cleanQuestionStarter(query);
    const cleanCategory = String(category || "Community Pick").trim().slice(0, 40) || "Community Pick";
    if (cleanQuery.length < 3 || cleanQuery.length > 100) {
      throw appError("INVALID_QUESTION", "The question starter must be between 3 and 100 characters.");
    }
    const current = currentSnapshot.val();
    const question = {
      id: `custom-${questionId}`,
      category: cleanCategory,
      query: cleanQuery,
      prompt: promptFromQuery(cleanQuery),
      approvedAt: current.approvedAt || now(),
      updatedAt: now()
    };
    await this.api.set(questionRef, question);
    return { questionId, ...question };
  }

  async deleteApprovedQuestion(questionId) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can delete approved questions.");
    }
    await this.api.remove(this.api.ref(this.db, `sameSlateApprovedQuestions/${questionId}`));
  }

  async dismissHostRequest(uid) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can dismiss host requests.");
    }
    await this.api.remove(this.api.ref(this.db, `hostRequests/${uid}`));
  }

  async approveHostRequest(uid) {
    const updated = await this.setUserRole(uid, "host");
    await this.dismissHostRequest(uid);
    return updated;
  }

  async setUserRole(uid, role, hostNumber = null) {
    if (!['player', 'host'].includes(role)) {
      throw appError("INVALID_ROLE", "Choose either Player or Host.");
    }
    const targetRef = this.api.ref(this.db, `users/${uid}`);
    try {
      // Realtime Database transactions may invoke their updater before the
      // server value has reached the local cache. Returning undefined for that
      // temporary null aborts the transaction and incorrectly reports that a
      // visible profile disappeared. Verify the record, then atomically patch
      // only the master-managed fields instead.
      const currentSnapshot = await this.api.get(targetRef);
      if (!currentSnapshot.exists()) {
        throw appError("PLAYER_NOT_FOUND", "That player profile no longer exists.");
      }
      const current = currentSnapshot.val();
      await this.api.update(targetRef, {
        role,
        hostNumber: role === "host" ? (hostNumber || current.hostNumber || makeHostNumber(uid)) : null,
        updatedAt: now()
      });
      // Role changes resolve any older pending request. The follow-up is safe
      // to ignore when upgrading from rules that predate the request queue.
      if (this.api.remove) {
        await this.api.remove(this.api.ref(this.db, `hostRequests/${uid}`)).catch(() => {});
      }
    } catch (error) {
      if (error?.code === "PERMISSION_DENIED" || /permission/i.test(String(error?.message || ""))) {
        throw appError("RULES_UPDATE_REQUIRED", "Master Controls needs the newest Firebase Database Rules. Publish the repository rules file in Firebase, refresh, and try again.");
      }
      throw error;
    }
    const updatedSnapshot = await this.api.get(targetRef);
    if (!updatedSnapshot.exists()) {
      throw appError("PLAYER_NOT_FOUND", "That player profile no longer exists.");
    }
    return updatedSnapshot.val();
  }

  async nextGameNumber() {
    const result = await this.api.runTransaction(
      this.api.ref(this.db, "meta/nextGameNumber"),
      (value) => Number(value || 1000) + 1
    );
    return result.snapshot.val();
  }

  async createGame({
    nickname,
    totalRounds,
    roundTimerEnabled = true,
    roundTimerSeconds,
    hostPlays,
    questionQueue,
    suggestionMode,
    questionSources = { original: true, custom: false },
    victoryMode = VICTORY_MODES.POINTS,
    teamMode = false,
    teamNames = [],
    directions = ["before", "after"],
    matchScoring = MATCH_SCORING.ONE
  }) {
    const uid = this.identityUid();
    const profile = this.profile || (await this.getProfile(uid));
    if (!["host", "master", "admin"].includes(profile?.role)) {
      throw new Error("This account has not been approved as a host.");
    }

    let code = makeGameCode();
    for (let attempts = 0; attempts < 5; attempts += 1) {
      const existing = await this.api.get(this.api.ref(this.db, `sameSlateGameCodes/${code}`));
      if (!existing.exists()) break;
      code = makeGameCode();
    }

    const gameId = this.api.push(this.api.ref(this.db, "sameSlateGames")).key;
    const gameNumber = await this.nextGameNumber();
    const cleanTeamNames = teamMode
      ? teamNames.slice(0, 4).map((name, index) => String(name || `Team #${index + 1}`).trim().slice(0, 30))
      : [];
    if (teamMode && cleanTeamNames.length < 2) {
      throw new Error("Team mode needs at least two teams.");
    }
    const teams = teamMode
      ? Object.fromEntries(cleanTeamNames.map((name, index) => [`team${index + 1}`, name || `Team #${index + 1}`]))
      : {};
    const teamColors = teamMode
      ? Object.fromEntries(cleanTeamNames.map((_, index) => [
          `team${index + 1}`,
          TEAM_COLOR_PALETTE[index % TEAM_COLOR_PALETTE.length].id
        ]))
      : {};
    const game = {
      gameKind: "sameSlate",
      matchScoring: matchScoring === MATCH_SCORING.MATCHES ? MATCH_SCORING.MATCHES : MATCH_SCORING.ONE,
      directions,
      gameId,
      gameNumber,
      code,
      nickname,
      hostUid: uid,
      hostDisplayName: profile.displayName,
      hostNumber: profile.hostNumber || makeHostNumber(uid),
      totalRounds,
      roundTimerEnabled: roundTimerEnabled !== false,
      roundTimerSeconds: clampNumber(
        roundTimerSeconds || APP_CONFIG.defaultRoundSeconds,
        APP_CONFIG.minRoundSeconds,
        APP_CONFIG.maxRoundSeconds
      ),
      currentRound: 0,
      status: "lobby",
      phase: "lobby",
      hostPlays,
      victoryMode: victoryMode === VICTORY_MODES.ROUNDS
        ? VICTORY_MODES.ROUNDS
        : VICTORY_MODES.POINTS,
      teamMode: Boolean(teamMode),
      teams,
      teamColors,
      suggestionMode,
      questionSources: {
        original: questionSources.original !== false,
        custom: Boolean(questionSources.custom)
      },
      questionQueue,
      seats: hostPlays ? { 0: uid } : {},
      players: hostPlays
        ? {
            [uid]: {
              seat: "0",
              displayName: profile.displayName,
              totalScore: 0,
              highRoundCount: 0,
              joinedAt: now(),
              locked: false
            }
          }
        : {},
      createdAt: now(),
      updatedAt: now()
    };

    // Create the game first so the game-code rule can verify its host securely.
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}`), game);
    await this.api.update(this.api.ref(this.db), {
      [`sameSlateGameCodes/${code}`]: gameId,
      [`sameSlateUserGames/${uid}/${gameId}`]: { code, nickname, role: "host", createdAt: now() }
    });
    return game;
  }

  async listMyGames() {
    const uid = this.identityUid();
    const snapshot = await this.api.get(this.api.ref(this.db, `sameSlateUserGames/${uid}`));
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val())
      .map(([gameId, summary]) => ({ gameId, ...summary }))
      .sort((a, b) => Number(b.createdAt || b.joinedAt || 0) - Number(a.createdAt || a.joinedAt || 0));
  }

  async listAllGames() {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can manage every game record.");
    }
    const snapshot = await this.api.get(this.api.ref(this.db, "sameSlateGames"));
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val())
      .map(([gameId, game]) => ({ gameId, ...game }))
      .sort((a, b) => Number(b.createdAt || 0) - Number(a.createdAt || 0));
  }

  async listHighScores() {
    const snapshot = await this.api.get(this.api.ref(this.db, "sameSlateLeaderboard"));
    if (!snapshot.exists()) return [];
    return Object.entries(snapshot.val())
      .map(([uid, entry]) => ({ uid, ...entry }))
      .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  }

  async listLifetimeStats() {
    const snapshot = await this.api.get(this.api.ref(this.db, "sameSlatePlayerStats"));
    if (!snapshot.exists()) return [];
    return rankLifetimeStats(Object.entries(snapshot.val())
      .map(([uid, entry]) => {
        const { gameSummaries, ...stats } = entry;
        return { uid, ...stats };
      }));
  }

  async updateLifetimeStatsForGame(gameId, game) {
    if (!game || game.status !== "finished") return;
    for (const [playerUid, player] of Object.entries(game.players || {})) {
      const gameSummary = buildPlayerGameSummary(game, playerUid);
      await this.api.runTransaction(this.api.ref(this.db, `sameSlatePlayerStats/${playerUid}`), (current) => {
        const gameSummaries = { ...(current?.gameSummaries || {}), [gameId]: gameSummary };
        const totals = aggregateLifetimeStats(gameSummaries);
        return {
          // A nickname change updates this public field directly. Preserve that
          // current value when older games are synchronized afterward.
          displayName: current?.displayName || player.displayName,
          ...totals,
          gameSummaries,
          lastGameId: gameId,
          updatedAt: now()
        };
      });
    }
  }

  async syncLifetimeStats() {
    const role = this.profile?.role;
    if (!["host", "master", "admin"].includes(role)) return 0;
    let games = [];
    if (["master", "admin"].includes(role)) {
      const snapshot = await this.api.get(this.api.ref(this.db, "sameSlateGames"));
      games = Object.values(snapshot.val() || {});
    } else {
      const summaries = await this.listMyGames();
      const hosted = summaries.filter((summary) => summary.role === "host");
      games = (await Promise.all(hosted.map((summary) => this.getGame(summary.gameId)))).filter(Boolean);
    }
    const finishedGames = games
      .filter((game) => game.status === "finished")
      .sort((a, b) => Number(a.finishedAt || a.createdAt || 0) - Number(b.finishedAt || b.createdAt || 0));
    for (const game of finishedGames) await this.updateLifetimeStatsForGame(game.gameId, game);
    return finishedGames.length;
  }

  async findGameByCode(rawCode) {
    const code = String(rawCode || "").trim().toUpperCase();
    const codeSnapshot = await this.api.get(this.api.ref(this.db, `sameSlateGameCodes/${code}`));
    if (!codeSnapshot.exists()) throw new Error("We couldn't find that game code.");
    const gameId = codeSnapshot.val();
    const gameSnapshot = await this.api.get(this.api.ref(this.db, `sameSlateGames/${gameId}`));
    if (!gameSnapshot.exists()) throw new Error("That game is no longer available.");
    return gameSnapshot.val();
  }

  async joinGame(code) {
    let game = await this.findGameByCode(code);
    const uid = this.identityUid();
    const profile = this.profile || (await this.getProfile(uid));
    for (let attempt = 0; attempt < APP_CONFIG.maxPlayers; attempt++) {
      if (game.players?.[uid]) return game;
      if (game.status !== "lobby") throw new Error("That game has already started.");
      const available = Array.from({ length: APP_CONFIG.maxPlayers }, (_, i) => String(i))
        .filter((seat) => !game.seats?.[seat]);
      if (!available.length) throw new Error("That game is full.");
      // Random free seats reduce collisions when a group joins together. Rules
      // reserve the seat and player atomically, enforcing the limit on the server.
      const seat = available[Math.floor(Math.random() * available.length)];
      const player = { seat, displayName: profile.displayName, totalScore: 0, highRoundCount: 0, joinedAt: now(), locked: false };
      try {
        await this.api.update(this.api.ref(this.db), {
          [`sameSlateGames/${game.gameId}/seats/${seat}`]: uid,
          [`sameSlateGames/${game.gameId}/players/${uid}`]: player,
          [`sameSlateUserGames/${uid}/${game.gameId}`]: {
            code: game.code, nickname: game.nickname, role: "player", joinedAt: now()
          }
        });
        return { ...game, players: { ...(game.players || {}), [uid]: player }, seats: { ...(game.seats || {}), [seat]: uid } };
      } catch (error) {
        if (!/permission.?denied/i.test(String(error.code || error.message))) throw error;
        const latest = await this.getGame(game.gameId);
        if (!latest) throw new Error("That game is no longer available.");
        if (!latest.seats?.[seat] && latest.status === "lobby") throw error;
        game = latest;
      }
    }
    throw new Error("The room is busy. Please try joining again.");
  }

  async selectTeam(gameId, teamId) {
    const game = await this.getGame(gameId);
    const uid = this.identityUid();
    if (!game || game.status !== "lobby") throw new Error("Teams are locked after the game starts.");
    if (!game.teamMode || !Object.prototype.hasOwnProperty.call(game.teams || {}, teamId)) {
      throw new Error("Choose one of the teams in this game.");
    }
    if (!game.players?.[uid]) throw new Error("Only contestants can join a team.");
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}/players/${uid}/teamId`), teamId);
  }

  async renameTeam(gameId, teamId, name) {
    const cleanName = String(name || "").trim();
    if (!cleanName || cleanName.length > 30) throw new Error("Team names must contain 1–30 characters.");
    const game = await this.getGame(gameId);
    if (!game?.teamMode || !Object.prototype.hasOwnProperty.call(game.teams || {}, teamId)) {
      throw new Error("That team no longer exists.");
    }
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}/teams/${teamId}`), cleanName);
  }

  async setTeamColor(gameId, teamId, colorId) {
    if (!TEAM_COLOR_PALETTE.some((color) => color.id === colorId)) {
      throw new Error("Choose one of the available team colors.");
    }
    const game = await this.getGame(gameId);
    const actorUid = this.identityUid();
    if (!game?.teamMode || !Object.prototype.hasOwnProperty.call(game.teams || {}, teamId)) {
      throw new Error("That team no longer exists.");
    }
    const canManage = game.hostUid === actorUid
      || ["master", "admin"].includes(this.profile?.role)
      || game.players?.[actorUid]?.teamId === teamId;
    if (!canManage) throw new Error("You can choose a color only for your own team.");
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}/teamColors/${teamId}`), colorId);
  }

  async deleteGame(gameId) {
    if (!["master", "admin"].includes(this.profile?.role)) {
      throw appError("MASTER_REQUIRED", "Only the master account can permanently delete games.");
    }

    const [gamesSnapshot, statsSnapshot, leaderboardSnapshot, userGamesSnapshot] = await Promise.all([
      this.api.get(this.api.ref(this.db, "sameSlateGames")),
      this.api.get(this.api.ref(this.db, "sameSlatePlayerStats")),
      this.api.get(this.api.ref(this.db, "sameSlateLeaderboard")),
      this.api.get(this.api.ref(this.db, "sameSlateUserGames"))
    ]);
    const allGames = gamesSnapshot.val() || {};
    const game = allGames[gameId];
    if (!game) throw new Error("That game has already been deleted.");

    const playerStats = statsSnapshot.val() || {};
    const leaderboard = leaderboardSnapshot.val() || {};
    const affectedPlayerIds = new Set(Object.keys(game.players || {}));
    for (const [playerUid, stats] of Object.entries(playerStats)) {
      if (stats?.gameSummaries?.[gameId]) affectedPlayerIds.add(playerUid);
    }
    for (const [playerUid, entry] of Object.entries(leaderboard)) {
      if (entry?.gameId === gameId) affectedPlayerIds.add(playerUid);
    }

    const updates = {
      [`sameSlateAnswers/${gameId}`]: null,
      [`sameSlateGames/${gameId}`]: null
    };
    if (game.code) updates[`sameSlateGameCodes/${game.code}`] = null;
    for (const [playerUid, games] of Object.entries(userGamesSnapshot.val() || {})) {
      if (games?.[gameId]) updates[`sameSlateUserGames/${playerUid}/${gameId}`] = null;
    }

    for (const playerUid of affectedPlayerIds) {
      const current = playerStats[playerUid] || {};
      const gameSummaries = Object.fromEntries(
        Object.entries(allGames)
          .filter(([otherGameId, otherGame]) => otherGameId !== gameId
            && otherGame?.status === "finished"
            && otherGame?.players?.[playerUid])
          .map(([otherGameId, otherGame]) => [
            otherGameId,
            buildPlayerGameSummary({ ...otherGame, gameId: otherGameId }, playerUid)
          ])
      );
      const remaining = Object.entries(gameSummaries);
      if (!remaining.length) {
        updates[`sameSlatePlayerStats/${playerUid}`] = null;
        updates[`sameSlateLeaderboard/${playerUid}`] = null;
        continue;
      }

      const totals = aggregateLifetimeStats(gameSummaries);
      const latest = remaining
        .slice()
        .sort(([, a], [, b]) => Number(b.finishedAt || 0) - Number(a.finishedAt || 0)
          || Number(b.gameNumber || 0) - Number(a.gameNumber || 0))[0];
      const bestSummary = gameSummaries[totals.bestGameId] || {};
      const displayName = current.displayName
        || game.players?.[playerUid]?.displayName
        || leaderboard[playerUid]?.displayName
        || "Player";
      updates[`sameSlatePlayerStats/${playerUid}`] = {
        displayName,
        ...totals,
        gameSummaries,
        lastGameId: latest[0],
        updatedAt: now()
      };
      updates[`sameSlateLeaderboard/${playerUid}`] = {
        displayName,
        score: Number(totals.bestGameScore || 0),
        gameId: totals.bestGameId,
        gameNumber: Number(bestSummary.gameNumber || totals.bestGameNumber || 0),
        lastPlayedAt: Number(bestSummary.finishedAt || totals.lastPlayedAt || 0)
      };
    }

    await this.api.update(this.api.ref(this.db), updates);
    return {
      gameId,
      gameNumber: game.gameNumber,
      nickname: game.nickname,
      affectedPlayers: affectedPlayerIds.size
    };
  }

  watchGame(gameId, callback) {
    let active = true;
    let revision = 0;
    const unsubscribe = this.api.onValue(this.api.ref(this.db, `sameSlateGames/${gameId}`), async (snapshot) => {
      const version = ++revision;
      const game = snapshot.exists() ? snapshot.val() : null;
      const uid = this.identityUid();
      const mine = game?.rounds?.[game.currentRound]?.answers?.[uid];
      if (game?.phase === "answering" && mine?.locked && !mine.text) {
        try {
          const answer = await this.api.get(this.api.ref(this.db, `sameSlateAnswers/${gameId}/${game.currentRound}/${uid}`));
          if (answer.exists()) Object.assign(mine, answer.val());
        } catch (error) { console.error("Could not restore your locked answer.", error); }
      }
      if (active && version === revision) callback(game);
    });
    return () => { active = false; unsubscribe(); };
  }

  async markLobbyReady(gameId) {
    const uid = this.identityUid();
    const game = await this.getGame(gameId);
    if (game?.teamMode && !game.teams?.[game.players?.[uid]?.teamId]) {
      throw new Error("Choose your team before marking yourself ready.");
    }
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}/lobbyReady/${uid}`), true);
  }

  async transactGame(gameId, update) {
    const reference = this.api.ref(this.db, `sameSlateGames/${gameId}`);
    let unsubscribe = () => {};
    try {
      // Keep a confirmed snapshot in the SDK cache while the transaction runs.
      // A one-off get alone can leave a cold transaction with null and abort it.
      await new Promise((resolve, reject) => {
        unsubscribe = this.api.onValue(reference, resolve, reject);
      });
      return await this.api.runTransaction(reference, update);
    } finally {
      unsubscribe();
    }
  }

  async getGame(gameId) {
    const snapshot = await this.api.get(this.api.ref(this.db, `sameSlateGames/${gameId}`));
    return snapshot.exists() ? snapshot.val() : null;
  }

  async startGame(gameId, roundPayload) {
    await this.getGame(gameId);
    const result = await this.transactGame(gameId, (game) => {
      if (!game || game.phase !== "lobby") return;
      const ids = Object.keys(game.players || {});
      if (ids.length < 2 || ids.length > 32 || !allPlayersAssignedToTeams(game)) return;
      for (const player of Object.values(game.players)) player.locked = true;
      const openedAt = now();
      const timerEnabled = game.roundTimerEnabled !== false;
      const durationSeconds = clampNumber(game.roundTimerSeconds || APP_CONFIG.defaultRoundSeconds, APP_CONFIG.minRoundSeconds, APP_CONFIG.maxRoundSeconds);
      game.currentRound = 1; game.status = "in_progress"; game.phase = "answering";
      game.rounds = { 1: { ...roundPayload, number: 1, openedAt, timerEnabled, ...(timerEnabled ? { durationSeconds, deadlineAt: openedAt + durationSeconds * 1000 } : {}), finalized: false } };
      game.updatedAt = openedAt;
      return game;
    });
    if (!result.committed) throw new Error("Start with 2–32 players, and have everyone choose a team when teams are enabled.");
  }

  async startNextRound(gameId, roundNumber, roundPayload) {
    await this.getGame(gameId);
    const result = await this.transactGame(gameId, (game) => {
      if (!game || game.phase !== "recap" || roundNumber !== game.currentRound + 1 || roundNumber > game.totalRounds) return;
      const openedAt = now();
      const timerEnabled = game.roundTimerEnabled !== false;
      const durationSeconds = clampNumber(game.roundTimerSeconds || APP_CONFIG.defaultRoundSeconds, APP_CONFIG.minRoundSeconds, APP_CONFIG.maxRoundSeconds);
      game.currentRound = roundNumber; game.phase = "answering";
      game.rounds[roundNumber] = { ...roundPayload, number: roundNumber, openedAt, timerEnabled, ...(timerEnabled ? { durationSeconds, deadlineAt: openedAt + durationSeconds * 1000 } : {}), finalized: false };
      game.updatedAt = openedAt;
      return game;
    });
    if (!result.committed) throw new Error("The room has already moved on. Refresh to see the current round.");
  }

  async submitAnswer(gameId, roundNumber, text, timedOut = false) {
    const uid = this.identityUid();
    const value = String(text || "").trim();
    if (value.length > 90) throw new Error("Keep your answer to 90 characters or fewer.");
    const answer = { text: value || "No answer", empty: !value, locked: true, submittedAt: now(), ...(timedOut ? { timedOut: true } : {}) };
    await this.api.update(this.api.ref(this.db), {
      [`sameSlateAnswers/${gameId}/${roundNumber}/${uid}`]: answer,
      [`sameSlateGames/${gameId}/rounds/${roundNumber}/answers/${uid}`]: { locked: true, submittedAt: answer.submittedAt }
    });
  }

  async expireAnsweringRound(gameId, roundNumber) {
    return this.revealMatchingRound(gameId, roundNumber, true);
  }

  async revealRound(gameId) {
    const game = await this.getGame(gameId);
    if (!game) return;
    return this.revealMatchingRound(gameId, game.currentRound, false);
  }

  async revealMatchingRound(gameId, roundNumber, expired) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const latest = await this.getGame(gameId);
      if (!latest || latest.phase !== "answering" || latest.currentRound !== Number(roundNumber)) return;
      const privateSnapshot = await this.api.get(this.api.ref(this.db, `sameSlateAnswers/${gameId}/${roundNumber}`));
      const answers = privateSnapshot.val() || {};
      let stale = false;
      const result = await this.transactGame(gameId, (game) => {
        stale = false;
        if (!game || game.phase !== "answering" || Number(game.currentRound) !== Number(roundNumber)) return;
        const round = game.rounds?.[roundNumber];
        if (!round || round.finalized) return;
        if (expired ? round.timerEnabled === false || Number(round.deadlineAt || 0) > now() : !allPlayersSubmitted(game)) return;
        if (lockedPlayerIds(game).some((uid) => round.answers?.[uid]?.locked && !answers[uid])) { stale = true; return; }
        round.answers = Object.fromEntries(lockedPlayerIds(game).map((uid) => [uid, answers[uid] || { text: "No answer", empty: true, locked: true, timedOut: true, submittedAt: now() }]));
        return applySlateResults(game, now());
      });
      if (result.committed || !stale) return result;
    }
    throw new Error("The last answers are still arriving. Tap Refresh to reveal the round.");
  }

  async confirmScore(gameId, roundNumber, points, selectedAnswerIndex = null) {
    const uid = this.identityUid();
    const claim = { points: Number(points), confirmedAt: now() };
    if (Number.isInteger(selectedAnswerIndex) && selectedAnswerIndex >= 0 && selectedAnswerIndex < 7) {
      claim.selectedAnswerIndex = selectedAnswerIndex;
    }
    await this.api.set(
      this.api.ref(this.db, `sameSlateGames/${gameId}/rounds/${roundNumber}/scoreClaims/${uid}`),
      claim
    );
  }

  async finalizeRound(gameId) {
    await this.transactGame(gameId, (game) => {
      if (!game || game.rounds?.[game.currentRound]?.finalized) return game;
      if (game.phase !== "scoring" || !allScoresConfirmed(game)) return;
      const results = calculateRoundResults(game);
      const best = Math.max(...results.map((result) => result.points));
      for (const result of results) {
        game.players[result.uid].totalScore = Number(game.players[result.uid].totalScore || 0) + result.points;
        if (best > 0 && result.points === best) {
          game.players[result.uid].highRoundCount =
            Number(game.players[result.uid].highRoundCount || 0) + 1;
        }
      }
      game.rounds[game.currentRound].results = Object.fromEntries(
        results.map((result) => [result.uid, { ...result, match: result.match || null }])
      );
      game.rounds[game.currentRound].finalized = true;
      game.rounds[game.currentRound].finalizedAt = now();
      game.phase = "recap";
      game.updatedAt = now();
      return game;
    });
  }

  async markReady(gameId, nextRound) {
    const uid = this.identityUid();
    await this.api.set(this.api.ref(this.db, `sameSlateGames/${gameId}/ready/${nextRound}/${uid}`), true);
  }

  async finishGame(gameId) {
    const game = await this.getGame(gameId);
    const finishedAt = now();
    await this.api.update(this.api.ref(this.db, `sameSlateGames/${gameId}`), {
      status: "finished",
      phase: "finished",
      finishedAt,
      updatedAt: finishedAt
    });
    const finishedGame = { ...game, status: "finished", phase: "finished", finishedAt, updatedAt: finishedAt };
    for (const [playerUid, player] of Object.entries(game.players || {})) {
      await this.api.runTransaction(this.api.ref(this.db, `sameSlateLeaderboard/${playerUid}`), (current) => {
        if (current && Number(current.score || 0) > Number(player.totalScore || 0)) return current;
        return {
          displayName: player.displayName,
          score: Number(player.totalScore || 0),
          gameId,
          gameNumber: game.gameNumber,
          lastPlayedAt: now()
        };
      });
    }
    try {
      await this.updateLifetimeStatsForGame(gameId, finishedGame);
    } catch (error) {
      // Finishing the live game must still succeed if the newly added stats
      // rules have not been published yet. A host/master sync repairs it later.
      console.error("Lifetime stats will be synchronized later.", error);
    }
  }

  async updateGameSettings(gameId, updates) {
    await this.api.update(this.api.ref(this.db, `sameSlateGames/${gameId}`), { ...updates, updatedAt: now() });
  }

  async removePlayer(gameId, uid) {
    const game = await this.getGame(gameId);
    const seat = game?.players?.[uid]?.seat;
    const updates = { [`sameSlateGames/${gameId}/players/${uid}`]: null };
    if (seat != null && game.seats?.[seat] === uid) updates[`sameSlateGames/${gameId}/seats/${seat}`] = null;
    await this.api.update(this.api.ref(this.db), updates);
  }

  async editFinalScore(gameId, roundNumber, uid, points) {
    await this.transactGame(gameId, (game) => {
      const result = game?.rounds?.[roundNumber]?.results?.[uid];
      if (!result) return game;
      const oldPoints = Number(result.points || 0);
      const newPoints = Number(points);
      game.rounds[roundNumber].results[uid].points = newPoints;
      game.rounds[roundNumber].results[uid].hostEdited = true;
      game.players[uid].totalScore = Number(game.players[uid].totalScore || 0) + newPoints - oldPoints;
      for (const player of Object.values(game.players || {})) player.highRoundCount = 0;
      for (const round of Object.values(game.rounds || {})) {
        const roundResults = Object.values(round.results || {});
        if (!round.finalized || !roundResults.length) continue;
        const best = Math.max(...roundResults.map((item) => Number(item.points || 0)));
        for (const item of roundResults) {
          if (best > 0 && Number(item.points || 0) === best && game.players[item.uid]) {
            game.players[item.uid].highRoundCount = Number(game.players[item.uid].highRoundCount || 0) + 1;
          }
        }
      }
      game.updatedAt = now();
      return game;
    });
    const updatedGame = await this.getGame(gameId);
    if (updatedGame?.status === "finished") {
      try {
        await this.updateLifetimeStatsForGame(gameId, updatedGame);
      } catch (error) {
        console.error("Lifetime stats will be synchronized later.", error);
      }
    }
  }
}
