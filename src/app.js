import { normalizeSlateAnswer } from "./slate-core.js";
import { APP_CONFIG, isFirebaseConfigured, isLiveSuggestionsConfigured } from "./config.js";
import {
  TEAM_COLOR_PALETTE,
  VICTORY_MODES,
  allPlayersAssignedToTeams,
  allPlayersSubmitted,
  allScoresConfirmed,
  accountRoleLabel,
  backgroundThemeForRoute,
  calculateTeamStandings,
  calculateRoundResults,
  escapeHtml,
  findAnswerMatch,
  formatDate,
  formatGameNumber,
  getTeamColor,
  getRound,
  getTeamWinners,
  getVictoryMode,
  isSelectedAnswerIndex,
  lockedPlayerIds,
  normalizeNickname,
  sortProfilesByRoleThenName,
  sortGameLeaderboard,
  victoryModeLabel,
  summarizeGame
} from "./core.js";
import { buildQuestionQueue, cleanQuestionStarter, promptFromQuery } from "./data/question-bank.js";
import { soundEffects } from "./services/effects.js?v=3";
import { FirebaseGameService } from "./services/firebase-service.js?v=2";
import { fetchLiveSuggestions } from "./services/live-suggestions.js";
import { sessionStore } from "./services/storage.js";

import { canPatchRound, viewForPhase } from "./services/live-ui.js";

import { messageCenterMarkup, bindMessageCenter } from "./services/messages.js?v=2";

const root = document.querySelector("#app");
const toastRegion = document.querySelector("#toast-region");

const state = {
  unsubscribeMessages: null,
  nightMode: sessionStore.getNightMode(),
  service: null,
  user: null,
  profile: null,
  game: null,
  gameId: null,
  unsubscribeGame: null,
  carouselRound: 1,
  users: null,
  hostRequests: null,
  myHostRequest: null,
  myQuestionSubmissions: null,
  adminQuestionSubmissions: null,
  questionSubmissionsError: "",
  approvedQuestions: null,
  approvedQuestionsError: "",
  adminGames: null,
  myGames: null,
  highScores: null,
  highScoresError: "",
  lifetimeStats: null,
  lifetimeStatsError: "",
  lifetimeStatsLoading: false,
  lifetimeStatsSynced: false,
  playedEffects: new Set(),
  roundTimerInterval: null,
  timerActions: new Set()
};

const uid = () => state.user?.uid;
const isHost = () =>
  Boolean(state.game && (state.game.hostUid === uid() || ["master", "admin"].includes(state.profile?.role)));
const isPlayer = () => Boolean(state.game?.players?.[uid()]);
const modeBadge = () => `<span class="pill live"><span class="live-dot"></span>Live game</span>`;

function playOnce(key, callback) {
  if (state.playedEffects.has(key)) return;
  state.playedEffects.add(key);
  callback();
}

function navigate(path) {
  window.location.hash = path.startsWith("#") ? path : `#${path}`;
}

function toast(message, type = "") {
  const item = document.createElement("div");
  item.className = `toast ${type}`;
  item.textContent = message;
  toastRegion.append(item);
  setTimeout(() => item.remove(), 4300);
}

function setBusy(button, busy, busyLabel = "Working…") {
  if (!button) return;
  const isSelect = button.tagName === "SELECT";
  if (busy) {
    button.dataset.wasDisabled = String(button.disabled);
    if (!isSelect) {
      button.dataset.label = button.textContent;
      button.textContent = busyLabel;
    }
    button.disabled = true;
    button.classList.add("is-busy");
  } else {
    if (!isSelect) button.textContent = button.dataset.label || button.textContent;
    button.disabled = button.dataset.wasDisabled === "true";
    button.classList.remove("is-busy");
  }
}

async function runAction(button, action, busyLabel) {
  try {
    setBusy(button, true, busyLabel);
    await action();
  } catch (error) {
    console.error(error);
    const authSetupBlocked = error.code === "auth/operation-not-allowed"
      || error.code === "auth/admin-restricted-operation"
      || String(error.message || "").includes("ADMIN_ONLY_OPERATION");
    const message = authSetupBlocked
      ? "Live player entry needs Anonymous Authentication enabled in Firebase."
      : error.message || "Something went wrong.";
    toast(message, "error");
  } finally {
    setBusy(button, false);
  }
}

function applyNightMode() {
  document.documentElement.classList.toggle("night-mode", state.nightMode);
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", state.nightMode ? "#061419" : "#063941");
  const button = document.querySelector("#night-mode-toggle");
  if (!button) return;
  button.setAttribute("aria-pressed", String(state.nightMode));
  button.setAttribute("title", state.nightMode ? "Turn night mode off" : "Turn night mode on");
  button.classList.toggle("night-mode-active", state.nightMode);
  button.querySelector(".night-mode-label").textContent = state.nightMode ? "NIGHT ON" : "NIGHT OFF";
}

function toggleNightMode() {
  state.nightMode = !state.nightMode;
  sessionStore.setNightMode(state.nightMode);
  // Do not render or navigate: keep draft answers, score selections, and timers intact.
  applyNightMode();
}

function topbar() {
  const displayName = state.profile?.displayName || "Player";
  return `
    <header class="topbar">
      <a class="brand" href="#/home" aria-label="${escapeHtml(APP_CONFIG.title)} home">
        <span class="brand-badge" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="M3 10 12 3l9 7M5 9v11h14V9M9 13h6M9 16h6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" /></svg></span><span class="brand-name">${escapeHtml(APP_CONFIG.title)}</span>
      </a>
      <div class="top-actions">
        ${state.user ? `<button id="profile-card-button" class="user-chip" type="button" title="Open lifetime player card" aria-label="Open ${escapeHtml(displayName)}'s lifetime player card">${escapeHtml(displayName)}</button>` : ""}
        <button id="sound-toggle" class="btn btn-ghost btn-small sound-toggle ${soundEffects.enabled ? "" : "muted-sound"}" type="button" aria-label="Toggle game sounds"><span class="sound-icon" aria-hidden="true">${soundEffects.enabled ? "🔊" : "🔇"}</span><span class="sound-label">${soundEffects.enabled ? "SOUND ON" : "SOUND OFF"}</span></button>
        <button id="night-mode-toggle" class="btn btn-ghost btn-small night-mode-toggle ${state.nightMode ? "night-mode-active" : ""}" type="button" aria-label="Night mode" aria-pressed="${state.nightMode}" title="Turn night mode ${state.nightMode ? "off" : "on"}"><svg class="night-mode-icon" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M20.7 14.2A9 9 0 0 1 9.8 3.3 9 9 0 1 0 20.7 14.2Z" stroke="currentColor" stroke-width="2" stroke-linejoin="round" /></svg><span class="night-mode-label">NIGHT ${state.nightMode ? "ON" : "OFF"}</span></button>
        ${state.game ? `<button id="refresh-game" class="btn btn-secondary btn-small refresh-game" type="button" aria-label="Refresh live game">↻ <span class="refresh-label">REFRESH</span></button>` : ""}
        ${state.game && state.user ? `<span class="top-action-divider" aria-hidden="true"></span>` : ""}
        ${state.user ? `<button id="account-menu" class="btn btn-ghost btn-small">Menu</button>` : `<a class="btn btn-ghost btn-small" href="#/auth">Sign in</a>`}
      </div>
    </header>`;
}

function legalFooter() {
  return `<footer class="legal-footer"><a class="slate-wordmark" href="#/home">SAME <span>SLATE</span></a><p>${escapeHtml(APP_CONFIG.officialDisclaimer)}</p><p class="creator-credit"><strong>Created by Sean</strong></p></footer>`;
}

function layout(content, pageClass = "") {
  clearInterval(state.roundTimerInterval);
  state.roundTimerInterval = null;
  root.innerHTML = `<div class="app-shell">${topbar()}<main class="page ${pageClass}">${content}${legalFooter()}</main></div>`;
  applyNightMode();
  document.querySelector("#night-mode-toggle")?.addEventListener("click", toggleNightMode);
  document.querySelector("#account-menu")?.addEventListener("click", showAccountMenu);
  document.querySelector("#profile-card-button")?.addEventListener("click", (event) => {
    openInGamePlayerCard(uid(), state.profile?.displayName, event.currentTarget, state.profile?.role);
  });
  document.querySelector("#sound-toggle")?.addEventListener("click", (event) => {
    const enabled = soundEffects.toggle();
    event.currentTarget.querySelector(".sound-icon").textContent = enabled ? "🔊" : "🔇";
    event.currentTarget.querySelector(".sound-label").textContent = enabled ? "SOUND ON" : "SOUND OFF";
    event.currentTarget.classList.toggle("muted-sound", !enabled);
  });
  document.querySelector("#refresh-game")?.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await runAction(event.currentTarget, async () => {
      const freshGame = await state.service.getGame(state.gameId || state.game?.gameId);
      if (!freshGame) throw new Error("This game room is no longer available.");
      state.game = freshGame;
      render();
      toast("Live game refreshed.", "success");
    }, "↻");
  });
  document.querySelectorAll(".team-name-button").forEach((button) => button.addEventListener("click", async (event) => {
    const nextName = window.prompt("Choose a new team name (1–30 characters):", button.dataset.teamName || "")?.trim();
    if (!nextName || nextName === button.dataset.teamName) return;
    await runAction(event.currentTarget, () => state.service.renameTeam(state.gameId || state.game?.gameId, button.dataset.teamId, nextName), "Saving…");
  }));
  document.querySelectorAll(".team-color-button").forEach((button) => button.addEventListener("click", () => {
    showTeamColorPicker(button.dataset.teamId);
  }));
  document.querySelectorAll(".player-card-trigger").forEach((button) => button.addEventListener("click", () => {
    openInGamePlayerCard(button.dataset.playerUid, button.dataset.playerName, button);
  }));
  soundEffects.syncBackgroundMusic(backgroundThemeForRoute(window.location.hash, state.game?.phase));
}

function showSoundSettings() {
  document.querySelector("#account-modal")?.remove();
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="modal-backdrop" id="sound-settings-modal">
      <div class="modal sound-settings-modal">
        <div class="sound-settings-heading"><div><p class="eyebrow">Audio mixer</p><h2 id="sound-settings-title">Sound Settings</h2></div><span aria-hidden="true">♫</span></div>
        <p>These settings are saved on this device. On iPhone, tap once after opening the page to start audio. The sound button at the top remains the master on/off control.</p>
        <section class="sound-settings" aria-labelledby="sound-settings-title">
          <div class="sound-slider-row">
            <div class="sound-slider-label"><label for="music-volume">Background music</label><output id="music-volume-value" for="music-volume">${Math.round(soundEffects.musicVolume * 100)}%</output></div>
            <input class="sound-range" id="music-volume" type="range" min="0" max="100" step="1" value="${Math.round(soundEffects.musicVolume * 100)}" />
            <p>Same Slate originals: “Same Wavelength” on the homepage and “Little Matches” during open-answer rounds.</p>
          </div>
          <div class="sound-slider-row">
            <div class="sound-slider-label"><label for="effects-volume">Game sound effects</label><output id="effects-volume-value" for="effects-volume">${Math.round(soundEffects.effectsVolume * 100)}%</output></div>
            <input class="sound-range" id="effects-volume" type="range" min="0" max="100" step="1" value="${Math.round(soundEffects.effectsVolume * 100)}" />
            <p>Answer locks, reveals, points, round wins, and finale sounds.</p>
          </div>
          <div class="theme-preview-grid"><button class="btn btn-ghost btn-small" id="preview-home-theme" type="button">▶ HOME THEME</button><button class="btn btn-ghost btn-small" id="preview-game-theme" type="button">▶ GAME THEME</button></div>
          <div class="sound-preview-row"><span>${soundEffects.enabled ? "Master sound is on" : "Master sound is off—use the top sound button to hear previews"}</span></div>
        </section>
        <div class="divider"></div>
        <button class="btn btn-primary" id="close-sound-settings" type="button">DONE</button>
      </div>
    </div>`
  );
  const modal = document.querySelector("#sound-settings-modal");
  const musicVolume = document.querySelector("#music-volume");
  const effectsVolume = document.querySelector("#effects-volume");
  const close = () => modal?.remove();
  document.querySelector("#close-sound-settings").addEventListener("click", close);
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  musicVolume.addEventListener("input", () => {
    const value = soundEffects.setMusicVolume(Number(musicVolume.value) / 100);
    document.querySelector("#music-volume-value").textContent = `${Math.round(value * 100)}%`;
  });
  effectsVolume.addEventListener("input", () => {
    const value = soundEffects.setEffectsVolume(Number(effectsVolume.value) / 100);
    document.querySelector("#effects-volume-value").textContent = `${Math.round(value * 100)}%`;
  });
  effectsVolume.addEventListener("change", () => soundEffects.previewEffect());
  document.querySelector("#preview-home-theme").addEventListener("click", () => soundEffects.previewTheme("home"));
  document.querySelector("#preview-game-theme").addEventListener("click", () => soundEffects.previewTheme("game"));
}

function showAccountMenu() {
  document.body.insertAdjacentHTML(
    "beforeend",
    `<div class="modal-backdrop" id="account-modal">
      <div class="modal">
        <h2>${escapeHtml(state.profile?.displayName || "Player")}</h2>
        <p>${escapeHtml(state.profile?.role || "player")} profile</p>
        <form id="nickname-form" class="form-grid">
          <div class="field"><label for="account-nickname">Change nickname</label><input class="input" id="account-nickname" name="displayName" maxlength="30" value="${escapeHtml(state.profile?.displayName || "")}" required autocomplete="nickname" /></div>
          <button class="btn btn-secondary" type="submit">SAVE NICKNAME</button>
        </form>
        <div class="divider"></div>
        <div class="button-stack">
          <a class="btn btn-primary" href="#/host">Game dashboard</a>
          <a class="btn btn-secondary" href="#/hall-of-fame">🏆 Hall of Fame</a>
          <a class="btn btn-secondary" href="#/questions">💡 Submit a Card</a>
          <a class="btn btn-secondary" href="#/messages">✉ Message Center</a>
          <button class="btn btn-secondary" id="open-sound-settings" type="button">♫ Sound Settings</button>
          ${["master", "admin"].includes(state.profile?.role) ? `<a class="btn btn-secondary" href="#/admin">Master controls</a>` : ""}
          <button class="btn btn-ghost" id="close-account">Close</button>
          <button class="btn btn-danger" id="sign-out">Sign out</button>
        </div>
      </div>
    </div>`
  );
  document.querySelector("#close-account").onclick = () => document.querySelector("#account-modal")?.remove();
  document.querySelector("#open-sound-settings").addEventListener("click", showSoundSettings);
  document.querySelectorAll("#account-modal a").forEach((link) =>
    link.addEventListener("click", () => document.querySelector("#account-modal")?.remove())
  );
  document.querySelector("#account-modal").addEventListener("click", (event) => {
    if (event.target.id === "account-modal") event.currentTarget.remove();
  });
  document.querySelector("#nickname-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const displayName = new FormData(event.currentTarget).get("displayName")?.trim();
    await runAction(event.submitter, async () => {
      const profile = await state.service.updateDisplayName(displayName);
      state.profile = profile;
      state.user = { ...state.user, displayName: profile.displayName };
      state.users = null;
      state.hostRequests = null;
      state.lifetimeStats = null;
      document.querySelector("#account-modal")?.remove();
      toast("Nickname updated.", "success");
      render();
    }, "Saving…");
  });
  document.querySelector("#sign-out").onclick = async (event) => {
    await runAction(event.currentTarget, async () => {
      await state.service.signOut();
      state.user = null;
      state.profile = null;
      state.myGames = null;
      state.adminGames = null;
      state.hostRequests = null;
      state.myHostRequest = null;
      state.myQuestionSubmissions = null;
      state.adminQuestionSubmissions = null;
      state.questionSubmissionsError = "";
      state.approvedQuestions = null;
      state.approvedQuestionsError = "";
      state.highScores = null;
      state.lifetimeStats = null;
      state.lifetimeStatsError = "";
      state.lifetimeStatsSynced = false;
      state.game = null;
      state.unsubscribeGame?.();
      document.querySelector("#account-modal")?.remove();
      navigate("/home");
    }, "Signing out…");
  };
}

function renderHome() {
  layout(
    `${celebrationPieces(22, "home-confetti")}<section class="hero">
      <div class="hero-copy">
        <p class="eyebrow">The word-matching party game</p>
        <h1>SAME <span class="accent">SLATE</span></h1>
        <p class="tagline">${escapeHtml(APP_CONFIG.tagline)}</p>
        <p class="disclaimer">${escapeHtml(APP_CONFIG.funnyDisclaimer)}</p>
        <div class="button-row center">
          <a class="btn btn-secondary" href="#/instructions">How to Play</a>
          <a class="btn btn-ghost" href="#/auth?next=join">User Login</a>
        </div>
      </div>
      <div class="hero-card">
        <div class="game-kicker">${modeBadge()}<span class="pill">Family friendly</span></div>
        <div class="panel-header">
          <h2>On the same slate?</h2>
          <p>Sign in, enter the six-character room code, and find out who thinks like you.</p>
        </div>
        <div class="button-stack">
          <a class="btn btn-main" href="#/join">JOIN GAME</a>
          ${!state.user ? `<a class="btn btn-primary" href="#/auth?next=join">PLAYER SIGN IN</a>` : `<a class="btn btn-primary" href="#/host">Open My Dashboard</a>`}
          ${state.user ? `<a class="btn btn-secondary" href="#/hall-of-fame">🏆 VIEW HALL OF FAME</a>` : ""}
        </div>
        <div class="divider"></div>
        <p class="muted center-text" style="font-size:12px;margin:0">No downloads. Phones, tablets, and computers can all play together.</p>
      </div>
    </section>
    <div class="button-row center">
      <a class="btn btn-ghost" href="${state.user ? "#/host" : "#/auth?next=host&access=host"}">Host Login</a>
    </div>`,
    ""
  );
}

function renderInstructions() {
  layout(`<section class="section-heading"><div><p class="eyebrow">Rules of play</p><h1>How to Play</h1><p>One blank. One answer. Who’s on your wavelength?</p></div></section>
    <section class="panel glow"><div class="instruction-list">
    <div class="instruction-step"><div><h3>Join the room</h3><p>Use your existing Google Feud email and nickname, or create a player. Enter the host’s six-character code. Games need 2–32 players.</p></div></div>
    <div class="instruction-step"><div><h3>Choose a team when enabled</h3><p>Choose before the host starts. You keep your individual score, and your points also count for your team.</p></div></div>
    <div class="instruction-step"><div><h3>Fill the blank</h3><p>On “Elbow ____”, you might write “pads” or “grease”. On “____ Field”, you might write “soccer” or “corn”. Type only the missing part.</p></div></div>
    <div class="instruction-step"><div><h3>Find your match</h3><p>Choose the answer you think another player will write. Keep it secret and lock it in. When everyone submits, everyone’s answers appear together.</p></div></div>
    <div class="instruction-step"><div><h3>Score automatically</h3><p><strong>One Point for a Match:</strong> match any other player and earn 1 point. <strong>One Point per Player:</strong> earn 1 point for each other player with your answer. In a group of four matching players, each earns 3 points.</p></div></div>
    <div class="instruction-step"><div><h3>Let the host lead</h3><p>Check the answers and rankings together. The host starts each next round; everyone’s screen follows automatically. The host can correct a score in Host Settings.</p></div></div>
    <div class="instruction-step"><div><h3>Win the game</h3><p>The host chooses Total Points or Most Rounds Won. Ties share the win. Completed games update player cards and the Hall of Fame.</p></div></div>
    </div><div class="notice"><span>💡</span><span>Capitalization, punctuation and extra spaces are ignored. Different spellings and plural forms stay separate. Empty answers never match.</span></div><div class="button-row center"><a class="btn btn-main" href="#/join">JOIN A GAME</a><a class="btn btn-ghost" href="#/home">Back Home</a></div></section>`, "compact");
}

function getHashParts() {
  const raw = window.location.hash.slice(1) || "/home";
  const [path, queryString = ""] = raw.split("?");
  return { segments: path.split("/").filter(Boolean), params: new URLSearchParams(queryString) };
}

function requireAuth(nextPath = "home") {
  if (state.user) return true;
  navigate(`/auth?next=${encodeURIComponent(nextPath)}`);
  return false;
}

function renderAuth(params) {
  const signup = params.get("mode") === "signup";
  const next = params.get("next") || "join";
  const hostAccess = params.get("access") === "host";
  const savedEmail = params.get("email") || "";
  const savedNickname = params.get("nickname") || "";
  layout(
    `<div class="panel glow">
      <div class="tabs">
        <button id="login-tab" class="tab ${signup ? "" : "active"}">Find Player</button>
        <button id="signup-tab" class="tab ${signup ? "active" : ""}">Create Player</button>
      </div>
      <div class="panel-header">
        <h1>${signup ? "Create your player" : hostAccess ? "Host Login" : "Welcome back"}</h1>
        <p>${signup ? "No password is needed. Your nickname can be changed later." : "Enter the email and nickname on your profile."}</p>
      </div>
      ${signup && params.get("missing") === "1" ? `<div class="notice warning"><span>👋</span><span>We did not find that email and nickname together. Confirm the information below to create a new player.</span></div><div class="spacer"></div>` : ""}
      <form id="auth-form" class="form-grid">
        <div class="field"><label for="email">Email <span class="label-note">(not shown; a made-up email is okay)</span></label><input class="input" id="email" name="email" type="email" required autocomplete="email" value="${escapeHtml(savedEmail)}" /></div>
        <div class="field"><label for="display-name">Nickname (Display Name)</label><input class="input" id="display-name" name="displayName" maxlength="30" required autocomplete="nickname" value="${escapeHtml(savedNickname)}" placeholder="What should the room call you?" /></div>
        <p class="field-help">Family trust mode: use the same email and display name next time. The email is never displayed in the game.</p>
        <button class="btn btn-main" type="submit">${signup ? "CREATE MY PLAYER" : "CONTINUE"}</button>
      </form>
    </div>`,
    "narrow"
  );
  document.querySelector("#login-tab").onclick = () => navigate(`/auth?next=${encodeURIComponent(next)}${hostAccess ? "&access=host" : ""}`);
  document.querySelector("#signup-tab").onclick = () => navigate(`/auth?mode=signup&next=${encodeURIComponent(next)}${hostAccess ? "&access=host" : ""}`);
  document.querySelector("#auth-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = event.submitter;
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await runAction(button, async () => {
      let user;
      try {
        user = signup ? await state.service.signUp(values) : await state.service.signIn(values);
      } catch (error) {
        if (!signup && error.code === "PLAYER_NOT_FOUND") {
          const query = new URLSearchParams({
            mode: "signup",
            missing: "1",
            next,
            email: values.email,
            nickname: values.displayName
          });
          if (hostAccess) query.set("access", "host");
          navigate(`/auth?${query}`);
          return;
        }
        throw error;
      }
      if (!user) return;
      state.user = user;
      state.profile = state.service.profile;
      state.myGames = null;
      state.adminGames = null;
      state.hostRequests = null;
      state.myHostRequest = null;
      state.highScores = null;
      state.highScoresError = "";
      state.lifetimeStats = null;
      state.lifetimeStatsError = "";
      state.lifetimeStatsSynced = false;
      toast(signup ? "Your player is ready—no password needed!" : "You're signed in.", "success");
      navigate(`/${next}`);
    }, signup ? "Creating…" : "Signing in…");
  });
}

function renderHostDashboard() {
  if (!requireAuth("host")) return;
  const canHost = ["host", "master", "admin"].includes(state.profile?.role);
  const activeGameId = sessionStore.getActiveGame();
  if (!canHost && state.myHostRequest === null) {
    state.service.getMyHostRequest().then((request) => {
      state.myHostRequest = request || false;
      if (window.location.hash.startsWith("#/host")) renderHostDashboard();
    }).catch((error) => {
      console.error("Could not load the host request.", error);
      state.myHostRequest = false;
    });
  }
  if (state.myGames === null) {
    state.service.listMyGames().then((games) => {
      state.myGames = games;
      if (window.location.hash.startsWith("#/host")) renderHostDashboard();
    }).catch(() => { state.myGames = []; });
  }
  if (state.highScores === null) {
    state.service.listHighScores().then((scores) => {
      state.highScores = scores;
      state.highScoresError = "";
      if (window.location.hash.startsWith("#/host")) renderHostDashboard();
    }).catch((error) => {
      console.error("Could not load high scores.", error);
      state.highScores = [];
      state.highScoresError = "High scores could not be loaded. Publish the latest Firebase Database Rules, then refresh.";
      if (window.location.hash.startsWith("#/host")) renderHostDashboard();
    });
  }
  const recentGames = state.myGames || [];
  const highScores = state.highScores || [];
  const topHighScores = highScores.slice(0, 10);
  layout(
    `<section class="section-heading">
      <div><p class="eyebrow">Host center</p><h1>Hello, ${escapeHtml(state.profile?.displayName || "Host")}</h1><p>${canHost ? `Host ${escapeHtml(state.profile?.hostNumber || "Master")}` : "Player account"}</p></div>
      ${modeBadge()}
    </section>
    ${!canHost ? `<div class="panel host-access-panel"><div class="panel-header"><h2>Want to host a game?</h2><p>Your player account is ready. Send a request so the master can approve host access from one organized list.</p></div>
      ${state.myHostRequest === null ? `<div class="empty-state">Checking request status…</div>` : state.myHostRequest ? `<div class="notice host-request-sent"><span>✓</span><span><strong>Host request sent</strong><br />The master will see ${escapeHtml(state.profile?.displayName || "your nickname")} in the pending-request queue.</span></div><div class="spacer"></div><div class="button-row"><button class="btn btn-ghost" id="cancel-host-request" type="button">CANCEL REQUEST</button><a class="btn btn-secondary" href="#/join">JOIN A GAME</a></div>` : `<div class="button-row"><button class="btn btn-main" id="request-host-access" type="button">REQUEST HOST ACCESS</button><a class="btn btn-secondary" href="#/join">JOIN A GAME</a></div>`}
    </div>` : `
      <div class="stats-grid">
        <div class="stat"><span class="stat-value">7</span><span class="stat-label">Answers per round</span></div>
        <div class="stat"><span class="stat-value">16</span><span class="stat-label">Player capacity</span></div>
        <div class="stat"><span class="stat-value">10</span><span class="stat-label">Top points</span></div>
      </div>
      <div class="spacer"></div>
      <div class="panel glow">
        <div class="panel-header"><h2>Start the show</h2><p>Create a new room or enter a code for an existing game you host.</p></div>
        <div class="button-stack">
          <a class="btn btn-main" href="#/create">CREATE NEW GAME</a>
          ${activeGameId ? `<a class="btn btn-primary" href="#/game/${encodeURIComponent(activeGameId)}/lobby">Resume Last Game</a>` : ""}
          <a class="btn btn-secondary" href="#/join">Enter Game Code</a>
          <a class="btn btn-secondary" href="#/hall-of-fame">🏆 Open Hall of Fame</a>
          ${["master", "admin"].includes(state.profile?.role) ? `<a class="btn btn-ghost" href="#/admin">Manage Host Accounts</a>` : ""}
        </div>
      </div>`}
      <div class="panel">
        <div class="panel-header"><h2>Previous Games</h2><p>Reopen a game to review its details, rounds, and final scores.</p></div>
        ${state.myGames === null ? `<div class="empty-state">Loading game history…</div>` : recentGames.length ? `<div class="player-list">${recentGames.slice(0, 10).map((game) => `<a class="player-row" style="color:inherit;text-decoration:none" href="#/game/${encodeURIComponent(game.gameId)}/details">${playerAvatar(game.nickname)}<div class="player-copy"><strong>${escapeHtml(game.nickname)}</strong><span>Code ${escapeHtml(game.code)} · ${escapeHtml(game.role)}</span></div><span class="player-status">OPEN</span></a>`).join("")}</div>` : `<div class="empty-state"><strong>No previous games yet</strong>Your first room will appear here.</div>`}
      </div>
      <div class="panel">
        <div class="panel-header"><h2>All-Time High Scores</h2><p>Top ten players by best completed-game total.</p></div>
        ${state.highScores === null ? `<div class="empty-state">Loading high scores…</div>` : state.highScoresError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.highScoresError)}</span></div>` : topHighScores.length ? `<div class="leaderboard">${topHighScores.map((entry, index) => `<div class="leader-row"><span class="rank">${index + 1}</span>${playerAvatar(entry.displayName)}<div class="player-copy"><strong>${escapeHtml(entry.displayName)}</strong><span>${escapeHtml(formatGameNumber({ gameNumber: entry.gameNumber }))}</span></div><div class="score"><strong>${entry.score}</strong><span>best</span></div></div>`).join("")}</div>` : `<div class="empty-state"><strong>No high scores yet</strong>Finish a game to claim the board.</div>`}
      </div>
    `,
    "compact"
  );
  document.querySelector("#request-host-access")?.addEventListener("click", (event) => {
    runAction(event.currentTarget, async () => {
      state.myHostRequest = await state.service.requestHostAccess();
      toast("Your host request was sent to the master.", "success");
      renderHostDashboard();
    }, "Sending…");
  });
  document.querySelector("#cancel-host-request")?.addEventListener("click", (event) => {
    runAction(event.currentTarget, async () => {
      await state.service.cancelHostRequest();
      state.myHostRequest = false;
      toast("Host request canceled.", "success");
      renderHostDashboard();
    }, "Canceling…");
  });
}

function formatHallValue(category, rawValue) {
  const value = Number(rawValue || 0);
  if (category.id === "average") return `${value.toFixed(2)} pts / round`;
  if (category.id === "streak") return `${value} round${value === 1 ? "" : "s"} straight`;
  if (category.id === "single-game") return `${value} points in one game`;
  if (category.id === "total-points") return `${value} lifetime points`;
  if (category.id === "rounds-played") return `${value} rounds played`;
  return `${value} rounds won`;
}

function buildHallCategories(stats) {
  const definitions = [
    { id: "total-points", title: "Most Points Scored", subtitle: "The all-time points champion", field: "totalPoints", trophy: "🏆" },
    { id: "rounds-played", title: "Most Rounds Played", subtitle: "Always ready for another round", field: "roundsPlayed", trophy: "🎟️" },
    { id: "rounds-won", title: "Most Rounds Won", subtitle: "The board-beating specialist", field: "roundsWon", trophy: "👑" },
    { id: "average", title: "Highest Average", subtitle: "Best points per completed round", field: "averagePointsPerRound", trophy: "📈" },
    { id: "single-game", title: "Highest Single Game", subtitle: "The biggest one-game score", field: "bestGameScore", trophy: "⚡" },
    { id: "streak", title: "Longest Win Streak", subtitle: "Most scoring rounds won in a row", field: "bestRoundWinStreak", trophy: "🔥" }
  ];
  return definitions.map((category) => {
    const highest = Math.max(0, ...stats.map((player) => Number(player[category.field] || 0)));
    const winners = highest > 0
      ? stats.filter((player) => Number(player[category.field] || 0) === highest)
      : [];
    return { ...category, highest, winners };
  });
}

function hallAwardCard(category, featured = false) {
  const names = category.winners.map((winner) => winner.displayName).join(" & ");
  return `<button class="hall-award-card ${featured ? "featured" : ""} ${category.winners.length ? "has-winner" : "awaiting"}" type="button" data-hall-category="${escapeHtml(category.id)}" ${category.winners.length ? "" : "disabled"}>
    <span class="hall-trophy" aria-hidden="true"><span>🏆</span><small>${category.trophy}</small></span>
    <span class="hall-award-copy"><span class="hall-category-label">${escapeHtml(category.subtitle)}</span><strong>${escapeHtml(category.title)}</strong><span class="hall-winner-name">${category.winners.length ? escapeHtml(names) : "The trophy is waiting…"}</span></span>
    <span class="hall-record-value">${category.winners.length ? escapeHtml(formatHallValue(category, category.highest)) : "No record yet"}</span>
    ${category.winners.length ? `<span class="hall-tap-hint">Tap to celebrate ✨</span>` : ""}
  </button>`;
}

function showHallCelebration(category) {
  if (!category?.winners?.length) return;
  document.querySelector("#hall-celebration")?.remove();
  const names = category.winners.map((winner) => winner.displayName).join(" & ");
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop hall-celebration" id="hall-celebration">
    ${celebrationPieces(68, "hall-confetti")}
    <div class="modal hall-winner-modal center-text">
      <div class="hall-modal-rays" aria-hidden="true"></div>
      <div class="hall-modal-trophy" aria-hidden="true">🏆</div>
      <p class="eyebrow">Hall of Fame Champion</p>
      <h2>${escapeHtml(category.title)}</h2>
      <div class="hall-modal-winner">${escapeHtml(names)}</div>
      <p>${escapeHtml(formatHallValue(category, category.highest))}</p>
      ${category.winners.length > 1 ? `<p class="muted">A legendary tie—every co-champion keeps the trophy.</p>` : `<p class="muted">This record belongs in the spotlight.</p>`}
      <button class="btn btn-main" id="close-hall-celebration" type="button">BACK TO THE TROPHY ROOM</button>
    </div>
  </div>`);
  soundEffects.finale();
  const close = () => document.querySelector("#hall-celebration")?.remove();
  document.querySelector("#close-hall-celebration").onclick = close;
  document.querySelector("#hall-celebration").addEventListener("click", (event) => {
    if (event.target.id === "hall-celebration") close();
  });
}

function showLifetimePlayerCard(player, returnFocus = document.activeElement) {
  document.querySelector("#lifetime-player-modal")?.remove();
  const roundsPlayed = Number(player.roundsPlayed || 0);
  const winRate = roundsPlayed ? (Number(player.roundsWon || 0) / roundsPlayed * 100).toFixed(1) : "0.0";
  const roleLabel = player.accountRole ? accountRoleLabel(player.accountRole) : "";
  const roleClass = roleLabel.toLowerCase();
  const lifetimeRank = Number(player.lifetimeRank || 0);
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop" id="lifetime-player-modal">
    <div class="modal lifetime-player-modal" role="dialog" aria-modal="true" aria-labelledby="lifetime-card-name">
      <div class="lifetime-card-content" role="region" aria-label="Lifetime statistics" tabindex="0">
      <div class="lifetime-card-heading">${playerAvatar(player.displayName)}<div class="lifetime-card-title"><p class="eyebrow">Lifetime Player Card</p><h2 id="lifetime-card-name">${escapeHtml(player.displayName)}</h2>${roleLabel ? `<span class="lifetime-role-badge ${roleClass}-lifetime-role">${escapeHtml(roleLabel)}</span>` : ""}</div></div>
      <div class="lifetime-rank-banner"><span class="lifetime-rank-crown" aria-hidden="true">🏆</span><div><small>All-Time Points Ranking</small><strong>${lifetimeRank ? `#${lifetimeRank}` : "Unranked"}</strong></div><span>${Number(player.totalPoints || 0)} lifetime points</span></div>
      <div class="lifetime-stat-grid">
        <div><strong>${Number(player.totalPoints || 0)}</strong><span>Total points</span></div>
        <div><strong>${Number(player.gamesPlayed || 0)}</strong><span>Games played</span></div>
        <div><strong>${roundsPlayed}</strong><span>Rounds played</span></div>
        <div><strong>${Number(player.roundsWon || 0)}</strong><span>Rounds won</span></div>
        <div><strong>${Number(player.averagePointsPerRound || 0).toFixed(2)}</strong><span>Avg. points / round</span></div>
        <div><strong>${winRate}%</strong><span>Round win rate</span></div>
        <div><strong>${Number(player.bestGameScore || 0)}</strong><span>Best game</span></div>
        <div><strong>${Number(player.bestRoundWinStreak || 0)}</strong><span>Best win streak</span></div>
      </div>
      <div id="cross-game-stats" class="cross-game-stats"></div>
      <div class="lifetime-card-footer"><span>${player.bestGameNumber ? `Best in Game #${Number(player.bestGameNumber)}` : "No best game yet"}</span><span>Last played ${escapeHtml(formatDate(player.lastPlayedAt))}</span></div>
      </div>
      <div class="lifetime-card-actions"><button class="btn btn-main" id="close-lifetime-card" type="button">CLOSE PLAYER CARD</button></div>
    </div>
  </div>`);
  if (player.uid) state.service.getCrossGameStats(player.uid).then((stats) => {
    const target = document.querySelector("#cross-game-stats");
    if (!target || target.closest(".modal").querySelector("#lifetime-card-name")?.textContent !== player.displayName) return;
    target.innerHTML = `<h3>Across Your Games</h3><div class="table-scroll"><table><thead><tr><th>Game</th><th>Played</th><th>Rounds</th><th>Points</th></tr></thead><tbody>${[["Google Feud", stats.googlefeud], ["Same Slate", stats.sameSlate]].map(([name, item]) => `<tr><td>${name}</td><td>${Number(item.gamesPlayed || 0)}</td><td>${Number(item.roundsPlayed || 0)}</td><td>${Number(item.totalPoints || 0)}</td></tr>`).join("")}</tbody></table></div>`;
  }).catch(() => {});
  const modal = document.querySelector("#lifetime-player-modal");
  const closeButton = modal.querySelector("#close-lifetime-card");
  const content = modal.querySelector(".lifetime-card-content");
  const close = () => {
    modal.remove();
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  };
  closeButton.onclick = close;
  modal.addEventListener("click", (event) => {
    if (event.target === modal) close();
  });
  modal.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    } else if (event.key === "Tab") {
      // The scrollable stats and the close button are the card's two tab stops.
      event.preventDefault();
      (document.activeElement === closeButton ? content : closeButton).focus({ preventScroll: true });
    }
  });
  closeButton.focus({ preventScroll: true });
}

async function renderQuestionSubmissions() {
  if (!requireAuth("questions")) return;
  if (state.myQuestionSubmissions === null) {
    try {
      state.myQuestionSubmissions = await state.service.listMyQuestionSubmissions();
      state.questionSubmissionsError = "";
    } catch (error) {
      console.error("Could not load question submissions.", error);
      state.myQuestionSubmissions = [];
      state.questionSubmissionsError = "Question submissions need the latest Firebase Database Rules. Ask the master to publish the repository rules file, then refresh.";
    }
  }
  const submissions = state.myQuestionSubmissions || [];
  layout(
    `<section class="section-heading"><div><p class="eyebrow">Help build the show</p><h1>Submit a Card</h1><p>Send a new word card to the master. Approved ideas become available in future games.</p></div>${modeBadge()}</section>
    ${state.questionSubmissionsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.questionSubmissionsError)}</span></div><div class="spacer"></div>` : ""}
    <div class="form-row question-submit-layout">
      <section class="panel glow"><div class="panel-header"><h2>Your Card Idea</h2><p>Place the blank before or after your word. Other players supply the missing part.</p></div>
        <form id="question-submission-form" class="form-grid">
          <div class="field"><label for="question-starter">Card prompt</label><input class="input" id="question-starter" name="query" maxlength="100" required placeholder="Elbow ____" /><p class="field-help">Or try “____ Field”</p></div>
          <div class="field"><label for="question-category">Category</label><input class="input" id="question-category" name="category" maxlength="40" value="Community Pick" placeholder="Community Pick" /></div>
          <div class="question-prompt-preview"><span>Players will see</span><strong id="question-prompt-preview">Your question ____</strong></div>
          <button class="btn btn-main" type="submit" ${state.questionSubmissionsError ? "disabled" : ""}>SEND TO THE MASTER</button>
        </form>
      </section>
      <section class="panel"><div class="panel-header"><h2>Your Submissions</h2><p>The master can polish a question before approving it.</p></div>
        ${submissions.length ? `<div class="question-submission-list">${submissions.map((submission) => `<article class="question-submission-summary"><div><span class="question-status ${escapeHtml(submission.status || "pending")}">${escapeHtml(submission.status || "pending")}</span><strong>${escapeHtml(submission.prompt || promptFromQuery(submission.query))}</strong><small>${escapeHtml(submission.category || "Community Pick")} · Submitted ${escapeHtml(formatDate(submission.submittedAt))}</small></div></article>`).join("")}</div>` : `<div class="empty-state"><strong>No questions submitted yet</strong>Your first idea will appear here after you send it.</div>`}
      </section>
    </div>
    <div class="button-row center"><a class="btn btn-ghost" href="#/host">BACK TO DASHBOARD</a></div>`,
    "compact"
  );
  const starter = document.querySelector("#question-starter");
  const preview = document.querySelector("#question-prompt-preview");
  starter?.addEventListener("input", () => {
    preview.textContent = promptFromQuery(starter.value) || "Your question ____";
  });
  document.querySelector("#question-submission-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    runAction(event.submitter, async () => {
      await state.service.submitQuestion(values);
      state.myQuestionSubmissions = await state.service.listMyQuestionSubmissions();
      toast("Your question was sent to the master!", "success");
      renderQuestionSubmissions();
    }, "Sending…");
  });
}

async function openInGamePlayerCard(playerUid, displayName, button, accountRole = null) {
  if (!playerUid) return;
  const wasDisabled = button?.disabled;
  if (button) {
    button.disabled = true;
    button.classList.add("is-busy");
  }
  try {
    if (state.lifetimeStats === null) {
      state.lifetimeStats = await state.service.listLifetimeStats();
    }
    const lifetime = state.lifetimeStats.find((entry) => entry.uid === playerUid);
    showLifetimePlayerCard({
      ...(lifetime || {}),
      uid: playerUid,
      displayName: lifetime?.displayName || displayName || state.game?.players?.[playerUid]?.displayName || "Player",
      ...(accountRole ? { accountRole } : {})
    }, button);
  } catch (error) {
    console.error("Could not open the player card.", error);
    toast(error.message || "That player card could not be loaded.", "error");
  } finally {
    if (button && document.body.contains(button)) {
      button.disabled = Boolean(wasDisabled);
      button.classList.remove("is-busy");
    }
  }
}

function canChooseTeamColor(game, teamId) {
  return Boolean(game && (
    isHost()
    || game.players?.[uid()]?.teamId === teamId
  ));
}

function showTeamColorPicker(teamId) {
  const game = state.game;
  if (!canChooseTeamColor(game, teamId)) {
    toast("You can choose a color only for your own team.", "error");
    return;
  }
  const teamName = game.teams?.[teamId] || "Team";
  const selected = getTeamColor(game, teamId).id;
  document.querySelector("#team-color-modal")?.remove();
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop" id="team-color-modal">
    <div class="modal team-color-modal">
      <p class="eyebrow">Team colors</p>
      <h2>Choose ${escapeHtml(teamName)}'s Color</h2>
      <p>Everyone will see this color update immediately.</p>
      <div class="team-color-palette">${TEAM_COLOR_PALETTE.map((color) => `<button class="team-color-swatch ${color.id === selected ? "selected" : ""}" type="button" data-team-color="${escapeHtml(color.id)}" style="--swatch-color:${color.value}" aria-pressed="${color.id === selected}"><span aria-hidden="true"></span><strong>${escapeHtml(color.label)}</strong>${color.id === selected ? "<small>Current</small>" : ""}</button>`).join("")}</div>
      <button class="btn btn-ghost" id="close-team-color" type="button">Cancel</button>
    </div>
  </div>`);
  const close = () => document.querySelector("#team-color-modal")?.remove();
  document.querySelector("#close-team-color").onclick = close;
  document.querySelector("#team-color-modal").addEventListener("click", (event) => {
    if (event.target.id === "team-color-modal") close();
  });
  document.querySelectorAll("[data-team-color]").forEach((button) => button.addEventListener("click", async (event) => {
    await runAction(event.currentTarget, async () => {
      await state.service.setTeamColor(game.gameId, teamId, button.dataset.teamColor);
      close();
      toast(`${teamName}'s color is updated.`, "success");
    }, "Saving…");
  }));
}

function loadLifetimeStats() {
  if (state.lifetimeStatsLoading) return;
  state.lifetimeStatsLoading = true;
  (async () => {
    try {
      if (!state.lifetimeStatsSynced && ["host", "master", "admin"].includes(state.profile?.role)) {
        await state.service.syncLifetimeStats();
        state.lifetimeStatsSynced = true;
      }
      state.lifetimeStats = await state.service.listLifetimeStats();
      state.lifetimeStatsError = "";
    } catch (error) {
      console.error("Could not load the Hall of Fame.", error);
      state.lifetimeStats = [];
      state.lifetimeStatsError = "The Hall of Fame needs the latest Firebase Database Rules. Publish the repository's rules file in Firebase, then refresh this page.";
    } finally {
      state.lifetimeStatsLoading = false;
      if (window.location.hash.startsWith("#/hall-of-fame")) renderHallOfFame();
    }
  })();
}

function renderHallOfFame() {
  if (!requireAuth("hall-of-fame")) return;
  if (state.lifetimeStats === null) loadLifetimeStats();
  const stats = state.lifetimeStats || [];
  const categories = buildHallCategories(stats);
  const [points, ...otherCategories] = categories;
  layout(
    `${celebrationPieces(20, "hall-ambient")}<section class="hall-hero">
      <div class="hall-hero-crown" aria-hidden="true">🏆</div>
      <p class="eyebrow">The eternal trophy room</p>
      <h1>HALL OF <span>FAME</span></h1>
      <p>Every completed game adds to these lifetime records. Tap a champion to give them the celebration they deserve.</p>
    </section>
    ${state.lifetimeStats === null ? `<section class="panel hall-loading center-text"><div class="hall-loading-trophy">🏆</div><h2>Polishing the trophies…</h2><p class="muted">Completed games and lifetime records are being synchronized.</p></section>` : state.lifetimeStatsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.lifetimeStatsError)}</span></div>` : !stats.length ? `<section class="panel empty-state"><strong>The trophy room is ready</strong>Complete a game to create the first lifetime player cards and records.</section>` : `
      <section class="hall-section"><div class="hall-section-heading"><div><p class="eyebrow">The main event</p><h2>All-Time Points Champion</h2></div><span>${stats.length} player${stats.length === 1 ? "" : "s"} ranked</span></div>${hallAwardCard(points, true)}</section>
      <section class="hall-section"><div class="hall-section-heading"><div><p class="eyebrow">Lifetime leaders</p><h2>Championship Categories</h2></div></div><div class="hall-category-grid">${otherCategories.slice(0, 3).map((category) => hallAwardCard(category)).join("")}</div></section>
      <section class="hall-section"><div class="hall-section-heading"><div><p class="eyebrow">Record book</p><h2>Single-Game & Streak Records</h2></div></div><div class="hall-record-grid">${otherCategories.slice(3).map((category) => hallAwardCard(category)).join("")}</div></section>
      <section class="hall-section"><div class="hall-section-heading"><div><p class="eyebrow">Contestant collection</p><h2>Lifetime Player Cards</h2><p>Tap any contestant for their complete career snapshot.</p></div></div><div class="lifetime-player-grid">${stats.map((player, index) => `<button class="lifetime-player-card" type="button" data-player-uid="${escapeHtml(player.uid)}"><span class="lifetime-rank">#${index + 1}</span>${playerAvatar(player.displayName)}<span class="lifetime-player-copy"><strong>${escapeHtml(player.displayName)}</strong><span>${Number(player.totalPoints || 0)} points · ${Number(player.roundsWon || 0)} round wins</span></span><span class="lifetime-card-arrow">›</span></button>`).join("")}</div></section>
      ${["host", "master", "admin"].includes(state.profile?.role) ? `<div class="notice"><span>✓</span><span>Completed games you host are automatically synchronized when this page opens.${["master", "admin"].includes(state.profile?.role) ? " Master access also recovers records from every previously completed game." : ""}</span></div>` : ""}
    `}
    <div class="button-row center hall-footer-actions"><a class="btn btn-main" href="#/host">BACK TO DASHBOARD</a><a class="btn btn-ghost" href="#/home">Home</a></div>`,
    ""
  );
  document.querySelectorAll("[data-hall-category]").forEach((button) => button.addEventListener("click", () => {
    showHallCelebration(categories.find((category) => category.id === button.dataset.hallCategory));
  }));
  document.querySelectorAll("[data-player-uid]").forEach((button) => button.addEventListener("click", () => {
    const player = stats.find((entry) => entry.uid === button.dataset.playerUid);
    if (player) showLifetimePlayerCard(player);
  }));
}

async function renderCreateGame() {
  if (!requireAuth("create")) return;
  if (!["host", "master", "admin"].includes(state.profile?.role)) return renderHostDashboard();
  const sourceMode = "matching";
  if (sourceMode === "matching" && state.approvedQuestions === null) {
    try {
      state.approvedQuestions = await state.service.listApprovedQuestions();
      state.approvedQuestionsError = "";
    } catch (error) {
      console.error("Could not load approved custom questions.", error);
      state.approvedQuestions = [];
      state.approvedQuestionsError = "Approved custom questions need the newest Firebase Database Rules. The original bank is still available.";
    }
  }
  const customQuestionCount = state.approvedQuestions?.length || 0;
  layout(
    `<div class="panel glow">
      <div class="panel-header"><p class="eyebrow">New room</p><h1>Create a Game</h1><p>You can edit the nickname and individual scores later from Host Settings.</p></div>
      <form id="create-game-form" class="form-grid">
        <div class="field"><label for="nickname">Game nickname</label><input class="input" id="nickname" name="nickname" maxlength="40" required placeholder="Sommer Family Showdown" /></div>
        <div class="field"><label for="rounds">Number of rounds</label><input class="input" id="rounds" name="totalRounds" type="number" min="${APP_CONFIG.minRounds}" max="${APP_CONFIG.maxRounds}" value="5" required /><p class="field-help">Choose between ${APP_CONFIG.minRounds} and ${APP_CONFIG.maxRounds} rounds.</p></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Round timer</strong><span>Automatically lock answers when time runs out. Turn this off for a relaxed, untimed game.</span></div><label class="switch"><input id="timer-enabled" name="roundTimerEnabled" type="checkbox" checked /><span class="switch-ui"></span></label></div>
        <div class="field timer-duration-control" id="timer-duration-control"><label for="round-timer">Answer timer (seconds)</label><input class="input" id="round-timer" name="roundTimerSeconds" type="number" min="${APP_CONFIG.minRoundSeconds}" max="${APP_CONFIG.maxRoundSeconds}" value="${APP_CONFIG.defaultRoundSeconds}" required /><p class="field-help">Defaults to ${APP_CONFIG.defaultRoundSeconds} seconds. This setting is ignored when the timer is off.</p></div>
        <fieldset class="victory-mode-field"><legend>How is the winner decided?</legend><div class="victory-mode-grid">
          <label class="victory-mode-card"><input type="radio" name="victoryMode" value="${VICTORY_MODES.POINTS}" checked /><span class="victory-mode-icon" aria-hidden="true">★</span><strong>Total Points</strong><small>Highest combined score after every round wins.</small></label>
          <label class="victory-mode-card"><input type="radio" name="victoryMode" value="${VICTORY_MODES.ROUNDS}" /><span class="victory-mode-icon" aria-hidden="true">🏆</span><strong>Most Rounds Won</strong><small>Win the most individual rounds to take the game.</small></label>
        </div></fieldset>
        <div class="toggle-row"><div class="toggle-copy"><strong>Host plays too</strong><span>Add this host account to the contestant list.</span></div><label class="switch"><input name="hostPlays" type="checkbox" checked /><span class="switch-ui"></span></label></div>
        <div class="toggle-row"><div class="toggle-copy"><strong>Teams mode</strong><span>Players still compete individually, but their points also build a team total.</span></div><label class="switch"><input id="team-mode" name="teamMode" type="checkbox" /><span class="switch-ui"></span></label></div>
        <section class="team-setup hidden" id="team-setup">
          <div class="team-setup-heading"><div><p class="eyebrow">Build the squads</p><h2>Team Setup</h2></div><div class="field team-count-field"><label for="team-count">Teams</label><select class="select" id="team-count" name="teamCount"><option value="2">2</option><option value="3">3</option><option value="4">4</option></select></div></div>
          <p class="field-help">Everyone chooses a team in the lobby. Teams can rename themselves and choose their own stage color throughout the game.</p>
          <div class="team-name-grid">${Array.from({ length: 4 }, (_, index) => `<div class="field team-name-field" data-team-position="${index + 1}"><label for="team-name-${index + 1}">Team #${index + 1} name</label><input class="input" id="team-name-${index + 1}" name="teamName${index + 1}" maxlength="30" value="Team #${index + 1}" required /></div>`).join("")}</div>
        </section>
        ${sourceMode === "matching" ? `<fieldset class="question-source-field"><legend>Choose the card banks</legend><div class="question-source-grid">
          <div class="toggle-row question-source-toggle"><div class="toggle-copy"><strong>Original Card Bank</strong><span>Use the built-in collection of 1,000 word cards (500 of each type).</span></div><label class="switch"><input id="original-question-bank" name="includeOriginal" type="checkbox" checked /><span class="switch-ui"></span></label></div>
          <div class="toggle-row question-source-toggle ${customQuestionCount ? "" : "disabled-control"}"><div class="toggle-copy"><strong>Approved Custom Cards</strong><span>${customQuestionCount ? `${customQuestionCount} master-approved question${customQuestionCount === 1 ? "" : "s"} available.` : "No custom questions have been approved yet."}</span></div><label class="switch"><input id="custom-question-bank" name="includeCustom" type="checkbox" ${customQuestionCount ? "checked" : "disabled"} /><span class="switch-ui"></span></label></div>
        </div><p class="field-help">Turn either bank on or off. At least one bank must remain enabled.</p></fieldset>` : ""}
        ${state.approvedQuestionsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.approvedQuestionsError)}</span></div>` : ""}
        <fieldset class="question-source-field"><legend>Choose your card types</legend><div class="question-source-grid">
        <label class="slate-type-card"><input type="checkbox" name="cardsAfter" checked /><strong>Example <span>____</span></strong><small>Fill in the end · 500 cards</small></label>
        <label class="slate-type-card"><input type="checkbox" name="cardsBefore" checked /><strong><span>____</span> Example</strong><small>Fill in the beginning · 500 cards</small></label>
        </div><p class="field-help">Choose either type or both.</p></fieldset>
        <fieldset class="victory-mode-field"><legend>How are matches scored?</legend><div class="victory-mode-grid">
        <label class="victory-mode-card"><input type="radio" name="matchScoring" value="one" checked /><strong>One Point for a Match</strong><small>Match at least one other player: earn 1 point.</small></label>
        <label class="victory-mode-card"><input type="radio" name="matchScoring" value="matches" /><strong>One Point per Player</strong><small>Match three other players: earn 3 points.</small></label>
        </div></fieldset>
        <input type="hidden" name="suggestionMode" value="matching" />
        <div class="notice"><span>✓</span><span>Scores are calculated automatically from the room’s answers. Up to 32 players can join.</span></div>
        <button class="btn btn-main" type="submit">CREATE GAME</button>
        <a class="btn btn-ghost" href="#/host">Cancel</a>
      </form>
    </div>`,
    "narrow"
  );
  const teamModeInput = document.querySelector("#team-mode");
  const teamSetup = document.querySelector("#team-setup");
  const teamCount = document.querySelector("#team-count");
  const timerEnabledInput = document.querySelector("#timer-enabled");
  const timerDurationControl = document.querySelector("#timer-duration-control");
  const roundTimerInput = document.querySelector("#round-timer");
  const updateTimerSetup = () => {
    const enabled = timerEnabledInput.checked;
    timerDurationControl.classList.toggle("disabled-control", !enabled);
    roundTimerInput.disabled = !enabled;
  };
  const updateTeamSetup = () => {
    const enabled = teamModeInput.checked;
    const count = Number(teamCount.value);
    teamSetup.classList.toggle("hidden", !enabled);
    document.querySelectorAll(".team-name-field").forEach((field) => {
      const active = enabled && Number(field.dataset.teamPosition) <= count;
      field.classList.toggle("hidden", !active);
      field.querySelector("input").disabled = !active;
    });
  };
  teamModeInput.addEventListener("change", updateTeamSetup);
  teamCount.addEventListener("change", updateTeamSetup);
  timerEnabledInput.addEventListener("change", updateTimerSetup);
  updateTimerSetup();
  updateTeamSetup();
  document.querySelector("#create-game-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const values = Object.fromEntries(new FormData(form));
    const totalRounds = Math.max(APP_CONFIG.minRounds, Math.min(APP_CONFIG.maxRounds, Number(values.totalRounds)));
    const roundTimerSeconds = Math.max(APP_CONFIG.minRoundSeconds, Math.min(APP_CONFIG.maxRoundSeconds, Number(roundTimerInput.value)));
    const teamMode = form.teamMode.checked;
    const teamNames = teamMode
      ? Array.from({ length: Number(values.teamCount) }, (_, index) => values[`teamName${index + 1}`])
      : [];
    await runAction(event.submitter, async () => {
      const recentQuestionIds = sessionStore.getRecentQuestionIds();
      const includeOriginal = sourceMode !== "matching" || form.includeOriginal.checked;
      const includeCustom = sourceMode === "matching" && form.includeCustom && form.includeCustom.checked;
      const directions = [form.cardsBefore.checked ? "before" : null, form.cardsAfter.checked ? "after" : null].filter(Boolean);
      const questionQueue = buildQuestionQueue(totalRounds, {
        directions,
        sourceMode: values.suggestionMode,
        excludedIds: recentQuestionIds,
        includeOriginal,
        includeCustom,
        customQuestions: state.approvedQuestions || []
      });
      const game = await state.service.createGame({
        directions,
        matchScoring: values.matchScoring,
        nickname: values.nickname.trim(),
        totalRounds,
        roundTimerEnabled: form.roundTimerEnabled.checked,
        roundTimerSeconds,
        hostPlays: form.hostPlays.checked,
        victoryMode: values.victoryMode,
        teamMode,
        teamNames,
        questionQueue,
        suggestionMode: values.suggestionMode,
        questionSources: { original: includeOriginal, custom: includeCustom }
      });
      sessionStore.setActiveGame(game.gameId);
      state.myGames = null;
      state.highScores = null;
      state.highScoresError = "";
      toast(`Game ${game.code} is ready!`, "success");
      navigate(`/game/${game.gameId}/lobby`);
    }, "Building room…");
  });
}

function renderJoinGame() {
  if (!requireAuth("join")) return;
  layout(
    `<div class="panel glow">
      <div class="panel-header center-text"><p class="eyebrow">Find your room</p><h1>Join Game</h1><p>Ask the host for the six-character code shown in their lobby.</p></div>
      <form id="join-form" class="form-grid">
        <div class="field"><label for="game-code">Game code</label><input class="input code-input" id="game-code" name="code" minlength="6" maxlength="6" required autocomplete="off" placeholder="ABC123" /></div>
        <button class="btn btn-main" type="submit">JOIN THE ROOM</button>
        <a class="btn btn-ghost" href="#/home">Back Home</a>
      </form>
    </div>`,
    "narrow"
  );
  const input = document.querySelector("#game-code");
  input.addEventListener("input", () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
  document.querySelector("#join-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    await runAction(event.submitter, async () => {
      const game = await state.service.joinGame(input.value);
      sessionStore.setActiveGame(game.gameId);
      state.myGames = null;
      navigate(`/game/${game.gameId}/lobby`);
    }, "Joining…");
  });
}

function gameHeading(game, extra = "") {
  return `<div class="game-kicker"><span class="pill">${escapeHtml(formatGameNumber(game))}</span><span class="pill">Code ${escapeHtml(game.code)}</span><span class="pill victory-mode-pill">${escapeHtml(victoryModeLabel(game))}</span>${extra}</div>
    <div class="section-heading"><div><h1>${escapeHtml(game.nickname)}</h1><p>Hosted by ${escapeHtml(game.hostDisplayName)}${game.teamMode ? " · Teams mode" : ""} · Winner by ${escapeHtml(victoryModeLabel(game).toLowerCase())}</p></div>${modeBadge()}</div>
    ${game.teamMode ? teamScoreboard(game) : ""}`;
}

function teamScoreboard(game, roundNumber = null) {
  const standings = calculateTeamStandings(game, roundNumber);
  const scoreField = roundNumber == null && getVictoryMode(game) === VICTORY_MODES.ROUNDS
    ? "roundWins"
    : roundNumber == null ? "totalScore" : "roundScore";
  const topScore = Math.max(0, ...standings.map((team) => Number(team[scoreField] || 0)));
  return `<section class="team-scoreboard ${roundNumber == null ? "" : "round-team-scoreboard"}">
    <div class="team-scoreboard-heading"><span>${roundNumber == null ? `Team standings · ${victoryModeLabel(game)}` : `Round ${roundNumber} team points`}</span><small>Tap a team name to rename it or the color dot to recolor your team</small></div>
    <div class="team-score-grid">${standings.map((team, index) => {
      const score = Number(team[scoreField] || 0);
      const leading = topScore > 0 && score === topScore;
      const members = team.members.map((member) => member.displayName).join(", ") || "Waiting for players";
      const scoreLabel = scoreField === "roundWins" ? `round ${score === 1 ? "win" : "wins"}` : "pts";
      const secondary = roundNumber == null
        ? scoreField === "roundWins" ? `${team.totalScore} total points` : `${team.roundWins} round ${team.roundWins === 1 ? "win" : "wins"}`
        : `${team.roundWins} game round ${team.roundWins === 1 ? "win" : "wins"}`;
      return `<article class="team-score-card ${leading ? "leading" : ""}" style="--team-color:${team.colorValue}"><span class="team-place">${leading ? "★" : `#${index + 1}`}</span><div class="team-score-copy"><div class="team-score-actions"><button type="button" class="team-name-button" data-team-id="${escapeHtml(team.teamId)}" data-team-name="${escapeHtml(team.name)}">${escapeHtml(team.name)} ✎</button>${canChooseTeamColor(game, team.teamId) ? `<button type="button" class="team-color-button" data-team-id="${escapeHtml(team.teamId)}" aria-label="Choose ${escapeHtml(team.name)} color" title="Choose team color"><span style="--team-color:${team.colorValue}"></span></button>` : ""}</div><span>${escapeHtml(members)} · ${escapeHtml(secondary)}</span></div><div class="team-score-value"><strong>${score}</strong><span>${scoreLabel}</span></div></article>`;
    }).join("")}</div>
  </section>`;
}

function playerAvatar(name = "?") {
  const initials = name.split(/\s+/).map((part) => part[0]).join("").slice(0, 2).toUpperCase();
  return `<span class="player-avatar">${escapeHtml(initials)}</span>`;
}

function playerCardName(playerUid, displayName, suffix = "") {
  return `<button class="player-card-trigger" type="button" data-player-uid="${escapeHtml(playerUid)}" data-player-name="${escapeHtml(displayName)}" title="View ${escapeHtml(displayName)}'s lifetime stats">${escapeHtml(displayName)}${suffix}</button>`;
}

function playerList(game, options = {}) {
  const players = Object.entries(game.players || {});
  if (!players.length) return `<div class="empty-state"><strong>No contestants yet</strong>Share the room code to fill the stage.</div>`;
  return `<div class="player-list">${players.map(([playerUid, player]) => {
    const ready = options.readyMap?.[playerUid];
    const current = playerUid === uid();
    const teamName = game.teamMode ? game.teams?.[player.teamId] : "";
    return `<div class="player-row">${playerAvatar(player.displayName)}<div class="player-copy"><strong>${playerCardName(playerUid, player.displayName, current ? " (You)" : "")}</strong><span>${game.teamMode ? teamName ? `Playing for ${escapeHtml(teamName)}` : "Choosing a team…" : player.locked ? "Locked contestant" : "In the lobby"}</span></div><span class="player-status">${ready ? "READY" : options.readyMap ? "WAITING" : "JOINED"}</span></div>`;
  }).join("")}</div>`;
}

function teamSelection(game) {
  if (!game.teamMode || !isPlayer()) return "";
  const selectedTeamId = game.players?.[uid()]?.teamId;
  return `<section class="panel team-selection-panel"><div class="panel-header"><p class="eyebrow">Choose your side</p><h2>${selectedTeamId ? `You joined ${escapeHtml(game.teams[selectedTeamId])}` : "Pick a Team Before Starting"}</h2><p>You can switch teams until the host starts the game. Your personal points will also count toward this team.</p></div><div class="team-choice-grid">${Object.entries(game.teams || {}).map(([teamId, name], index) => {
    const members = Object.values(game.players || {}).filter((player) => player.teamId === teamId).length;
    const selected = teamId === selectedTeamId;
    const color = getTeamColor(game, teamId, index);
    return `<button type="button" class="team-choice ${selected ? "selected" : ""}" style="--team-color:${color.value}" data-select-team="${escapeHtml(teamId)}"><span>${selected ? "✓" : index + 1}</span><strong>${escapeHtml(name)}</strong><small>${members} member${members === 1 ? "" : "s"}</small></button>`;
  }).join("")}</div></section>`;
}

function contestantStatusList(game, getStatus) {
  const playerIds = lockedPlayerIds(game);
  return `<div class="contestant-status-list">${playerIds.map((playerUid) => {
    const player = game.players[playerUid];
    const status = getStatus(playerUid, player);
    return `<div class="contestant-status-row ${status.complete ? "complete" : "waiting"}">
      ${playerAvatar(player.displayName)}
      <div class="player-copy"><strong>${playerCardName(playerUid, player.displayName, playerUid === uid() ? " (You)" : "")}</strong><span>${escapeHtml(status.detail)}</span></div>
      <span class="status-badge">${status.complete ? "✓ " : "• "}${escapeHtml(status.label)}</span>
    </div>`;
  }).join("")}</div>`;
}

function statusPanel(game, title, description, getStatus) {
  return `<section class="panel status-panel"><div class="panel-header"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div>${contestantStatusList(game, getStatus)}</section>`;
}

function roundTimer(round) {
  if (round?.timerEnabled === false || !round?.deadlineAt) {
    return `<section class="timer-card timer-disabled" aria-label="This round has no timer">
      <div class="timer-ring"><span>∞</span></div>
      <div><p class="eyebrow">Untimed round</p><strong>Take your time and lock in your best answer.</strong></div>
    </section>`;
  }
  const duration = Number(round?.durationSeconds || APP_CONFIG.defaultRoundSeconds);
  return `<section class="timer-card" aria-label="Round timer">
    <div class="timer-ring" id="round-timer-ring" style="--timer-progress:360deg"><span id="round-timer-value">${duration}</span></div>
    <div><p class="eyebrow">Time remaining</p><strong id="round-timer-message">Answer before the buzzer!</strong></div>
  </section>`;
}

function armRoundTimer(game) {
  const round = getRound(game);
  if (round?.timerEnabled === false) return;
  const deadlineAt = Number(round?.deadlineAt || 0);
  if (!deadlineAt || game.phase !== "answering") return;
  const durationMs = Math.max(1000, Number(round.durationSeconds || APP_CONFIG.defaultRoundSeconds) * 1000);
  const timerValue = document.querySelector("#round-timer-value");
  const timerRing = document.querySelector("#round-timer-ring");
  const timerMessage = document.querySelector("#round-timer-message");
  const actionKey = `${game.gameId}:${game.currentRound}:expired`;

  const expire = async () => {
    if (state.timerActions.has(actionKey)) return;
    state.timerActions.add(actionKey);
    const answer = getRound(state.game)?.answers?.[uid()];
    const input = document.querySelector("#answer");
    if (isPlayer() && !answer?.locked) {
      input?.setAttribute("disabled", "");
      document.querySelector("#answer-form button")?.setAttribute("disabled", "");
      const currentText = input?.value || sessionStore.readDraft(game.gameId, game.currentRound);
      try {
        await state.service.submitAnswer(game.gameId, game.currentRound, currentText, true);
        sessionStore.clearDraft();
      } catch (error) {
        console.error("Could not auto-submit the timed answer.", error);
      }
    }
    if (isHost()) {
      setTimeout(() => {
        state.service.expireAnsweringRound(game.gameId, game.currentRound).catch((error) => {
          console.error(error);
          toast(error.message || "The timer could not close the round.", "error");
        });
      }, 1200);
    }
  };

  const update = () => {
    const remainingMs = Math.max(0, deadlineAt - Date.now());
    const seconds = Math.ceil(remainingMs / 1000);
    if (timerValue) timerValue.textContent = String(seconds);
    if (timerRing) {
      timerRing.style.setProperty("--timer-progress", `${Math.max(0, Math.min(360, remainingMs / durationMs * 360))}deg`);
      timerRing.classList.toggle("urgent", seconds <= 10 && seconds > 0);
      timerRing.classList.toggle("expired", seconds === 0);
    }
    if (timerMessage && seconds === 0) timerMessage.textContent = "Time's up—locking the board…";
    if (remainingMs <= 0) {
      clearInterval(state.roundTimerInterval);
      state.roundTimerInterval = null;
      expire();
    }
  };

  update();
  if (!state.timerActions.has(actionKey)) state.roundTimerInterval = setInterval(update, 250);
}

function leaderboard(game) {
  const rows = sortGameLeaderboard(game);
  const roundsMode = getVictoryMode(game) === VICTORY_MODES.ROUNDS;
  return `<div class="leaderboard">${rows.map((player, index) => `<div class="leader-row"><span class="rank">${index + 1}</span>${playerAvatar(player.displayName)}<div class="player-copy"><strong>${playerCardName(player.uid, player.displayName)}</strong><span>${roundsMode ? `${player.totalScore || 0} total points` : `${player.highRoundCount || 0} round ${player.highRoundCount === 1 ? "win" : "wins"}`}${game.teamMode && game.teams?.[player.teamId] ? ` · ${escapeHtml(game.teams[player.teamId])}` : ""}</span></div><div class="score"><strong>${roundsMode ? player.highRoundCount || 0 : player.totalScore || 0}</strong><span>${roundsMode ? "round wins" : "points"}</span></div></div>`).join("")}</div>`;
}

function answerBoard(round) {
  const results = Object.values(round?.results || {});
  if (!results.length) return "";
  const groups = new Map();
  for (const result of results) {
    const key = result.match?.normalized || `empty:${result.uid}`;
    groups.set(key, [...(groups.get(key) || []), result]);
  }
  return `<div class="slate-match-board">${[...groups.values()].sort((a,b) => b.length-a.length).map((group) => `<article class="slate-match-group ${group.length > 1 ? "matched" : "solo"}"><div class="slate-match-heading"><strong>“${escapeHtml(group[0].answer)}”</strong><span class="pill">${group.length > 1 ? `${group.length} matched` : "No match"}</span></div><p>${group.map((r) => escapeHtml(r.displayName)).join(" · ")}</p><small>${group.map((r) => `${escapeHtml(r.displayName)}: ${r.points} ${r.points === 1 ? "point" : "points"}`).join(" · ")}</small></article>`).join("")}</div>`;
}

function questionCard(round, game) {
  const question = escapeHtml(round?.prompt || "Get ready…").replace(/_+/g, `<span class="blank">____</span>`);
  return `<div class="round-header"><span class="round-number">Round ${game.currentRound} of ${game.totalRounds}</span></div><div class="question-card"><div class="question-category">${escapeHtml(round?.category || "Mystery")}</div><h1>${question}</h1></div>`;
}

async function prepareRound(game, roundNumber) {
  const card = game.questionQueue?.[roundNumber - 1];
  if (!card) throw new Error("This room has no card prepared for that round.");
  return { questionId: card.id, category: card.category, word: card.word, direction: card.direction, prompt: card.prompt, query: card.query, source: "Same Slate card bank" };
}

function renderLobby(game) {
  const readyMap = game.lobbyReady || {};
  const players = Object.keys(game.players || {});
  const readyCount = players.filter((playerUid) => readyMap[playerUid]).length;
  const teamsReady = allPlayersAssignedToTeams(game);
  const currentPlayerHasTeam = !game.teamMode || Boolean(game.teams?.[game.players?.[uid()]?.teamId]);
  layout(
    `${gameHeading(game, `<span class="pill">Lobby</span>`)}
    ${teamSelection(game)}
    <div class="form-row">
      <section class="panel glow">
        <div class="panel-header"><h2>Welcome to the game!</h2><p>${players.length} of ${APP_CONFIG.maxPlayers} player slots filled · ${game.totalRounds} rounds</p></div>
        <div class="game-code-card"><span>Join with code</span><strong class="game-code">${escapeHtml(game.code)}</strong></div>
        <div class="progress-track"><div class="progress-bar" style="width:${players.length ? (readyCount / players.length) * 100 : 0}%"></div></div>
        <div class="progress-copy"><span>${readyCount} ready</span><span>${players.length} contestants</span></div>
        <div class="spacer"></div>
        ${game.teamMode && !teamsReady ? `<div class="notice warning"><span>⚑</span><span>Every contestant must choose a team before the game can start.</span></div><div class="spacer"></div>` : ""}
        ${isHost() ? `<button id="start-game" class="btn btn-main" ${players.length < 2 || !teamsReady ? "disabled" : ""}>START GAME</button>` : readyMap[uid()] ? `<div class="notice"><span>✓</span><span>You're ready. Waiting for the host to start the show.</span></div>` : `<button id="lobby-ready" class="btn btn-main" ${currentPlayerHasTeam ? "" : "disabled"}>I'M READY, LET'S GO!</button>`}
        ${isHost() ? `<div class="button-row"><a class="btn btn-secondary" href="#/game/${game.gameId}/settings">Host Settings</a><a class="btn btn-ghost" href="#/game/${game.gameId}/details">Game Details</a></div>` : ""}
      </section>
      <section class="panel"><div class="panel-header"><h2>Contestants</h2><p>Games need at least two players. Starting locks this list.</p></div>${playerList(game, { readyMap })}</section>
    </div>`,
    ""
  );
  document.querySelectorAll("[data-select-team]").forEach((button) => button.addEventListener("click", (event) => runAction(event.currentTarget, () => state.service.selectTeam(game.gameId, button.dataset.selectTeam), "Joining…")));
  document.querySelector("#lobby-ready")?.addEventListener("click", (event) => runAction(event.currentTarget, () => state.service.markLobbyReady(game.gameId), "Ready…"));
  document.querySelector("#start-game")?.addEventListener("click", (event) => runAction(event.currentTarget, async () => {
    const payload = await prepareRound(game, 1);
    await state.service.startGame(game.gameId, payload);
    sessionStore.rememberQuestionIds([payload.questionId]);
    navigate(`/game/${game.gameId}/play`);
  }, "Opening round…"));
}

function finalAnswerModal(answer, onConfirm) {
  document.body.insertAdjacentHTML("beforeend", `<div class="modal-backdrop" id="final-modal"><div class="modal center-text"><p class="eyebrow">Lock it in</p><h2>“${escapeHtml(answer)}”</h2><p>Is this your final answer? You cannot change it after submitting.</p><div class="button-stack"><button class="btn btn-main" id="confirm-final">YES, FINAL ANSWER</button><button class="btn btn-ghost" id="edit-final">Let me edit it</button></div></div></div>`);
  document.querySelector("#edit-final").onclick = () => document.querySelector("#final-modal")?.remove();
  document.querySelector("#confirm-final").onclick = async (event) => {
    await runAction(event.currentTarget, onConfirm, "Locking…");
    document.querySelector("#final-modal")?.remove();
  };
}

function renderAnswering(game) {
  const round = getRound(game);
  const answer = round?.answers?.[uid()];
  const submittedCount = lockedPlayerIds(game).filter((playerUid) => round?.answers?.[playerUid]?.locked).length;
  const totalPlayers = lockedPlayerIds(game).length;
  layout(
    `${gameHeading(game, `<span class="pill live">Answers open${round?.timerEnabled === false ? " · No timer" : ""}</span>`)}${roundTimer(round)}
    <div class="round-stage">${questionCard(round, game)}
      <section class="panel">
        <div class="progress-track"><div class="progress-bar" style="width:${totalPlayers ? submittedCount / totalPlayers * 100 : 0}%"></div></div>
        <div class="progress-copy"><span>${submittedCount} submitted</span><span>${totalPlayers} contestants</span></div>
        <div class="spacer"></div>
        ${!isPlayer() ? `<div class="notice"><span>🎙️</span><span>Host view: answers stay hidden until everyone locks in. Scores appear automatically at the reveal.</span></div>` : answer?.locked ? `<div class="center-text"><p class="eyebrow">Final answer locked</p><h2 class="answer-preview">${escapeHtml(answer.text || "Locked in")}</h2><p class="muted">Waiting for ${Math.max(0, totalPlayers - submittedCount)} more player${totalPlayers - submittedCount === 1 ? "" : "s"}.</p></div>` : `<form id="answer-form" class="answer-entry"><div class="field"><label for="answer">Fill the blank</label><input class="input answer-input" id="answer" name="answer" maxlength="90" required autocomplete="off" placeholder="Type only the missing words…" value="${escapeHtml(sessionStore.readDraft(game.gameId, game.currentRound))}" /></div><button class="btn btn-main" type="submit">SUBMIT ANSWER</button></form>`}
      </section>
      ${statusPanel(game, "Contestant Answers", "See who has locked in and who is still working.", (playerUid) => {
        const locked = Boolean(round?.answers?.[playerUid]?.locked);
        return { complete: locked, label: locked ? "LOCKED IN" : "ANSWERING", detail: locked ? "Final answer submitted" : "Still choosing an answer" };
      })}
    </div>`,
    "compact"
  );
  const input = document.querySelector("#answer");
  input?.addEventListener("input", () => sessionStore.saveDraft(game.gameId, game.currentRound, input.value));
  document.querySelector("#answer-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    finalAnswerModal(text, async () => {
      await state.service.submitAnswer(game.gameId, game.currentRound, text);
      sessionStore.clearDraft();
      soundEffects.lockIn();
    });
  });
  armRoundTimer(game);
  maybeRevealRound(game);
}

function renderScoring(game) {
  renderRoundRecap(game);
}

function roundPlayerResults(game, roundNumber = game.currentRound) {
  const round = getRound(game, roundNumber);
  const results = round?.results ? Object.values(round.results) : calculateRoundResults(game, roundNumber);
  return `<div class="round-player-list">${results.sort((a,b) => b.points - a.points).map((result) => `<div class="round-player-row">${playerAvatar(result.displayName)}<div class="player-copy"><strong>${playerCardName(result.uid, result.displayName)}</strong><span>“${escapeHtml(result.answer || "No answer")}"${result.match?.manual && result.match?.suggestion ? ` · Referenced #${result.match.rank}` : ""}${game.teamMode && game.teams?.[game.players?.[result.uid]?.teamId] ? ` · ${escapeHtml(game.teams[game.players[result.uid].teamId])}` : ""}</span></div><div class="score"><strong>${result.points}</strong><span>points</span></div></div>`).join("")}</div>`;
}

function celebrationPieces(count = 48, className = "") {
  const colors = ["#ffd166", "#20dbc8", "#f8fafc", "#0fa99c", "#5eead4", "#ffe7aa"];
  return `<div class="confetti ${className}">${Array.from({ length: count }, (_, index) =>
    `<i style="--left:${(index * 37) % 100}%;--delay:-${(index % 9) * .24}s;--duration:${2.4 + (index % 6) * .32}s;--mobile-duration:${4.8 + (index % 6) * .38}s;--drift:${((index * 13) % 19) - 9}vw;--rotation:${index * 29}deg;--confetti-color:${colors[index % colors.length]}"></i>`
  ).join("")}</div>`;
}

function getRoundWinners(game, roundNumber = game.currentRound) {
  const round = getRound(game, roundNumber);
  const results = Object.values(round?.results || {});
  const highestScore = Math.max(0, ...results.map((result) => Number(result.points || 0)));
  return {
    highestScore,
    winners: highestScore > 0 ? results.filter((result) => Number(result.points || 0) === highestScore) : []
  };
}

function renderRoundRecap(game) {
  const round = getRound(game);
  const { winners, highestScore } = getRoundWinners(game);
  const winnerNames = winners.map((winner) => winner.displayName).join(" & ");
  const currentPlayerWon = winners.some((winner) => winner.uid === uid());
  const winnerShowcase = winners.length
    ? `<section class="round-winner-showcase">
        <div class="winner-emblem" aria-hidden="true"><span>★</span></div>
        <p class="eyebrow">${winners.length > 1 ? "Round champions" : currentPlayerWon ? "You won the round!" : "Round champion"}</p>
        <h2>${escapeHtml(winnerNames)}</h2>
        <p>${highestScore} points at the top of the board</p>
        <div class="winner-rays" aria-hidden="true"></div>
      </section>`
    : `<section class="round-draw"><p class="eyebrow">No matches this round</p><h2>No points scored this round</h2></section>`;
  layout(
    `${winners.length ? celebrationPieces(52, "round-confetti") : ""}${gameHeading(game, `<span class="pill">Round ${game.currentRound} complete</span>`)}
    ${winnerShowcase}${game.teamMode ? `<div class="spacer"></div>${teamScoreboard(game, game.currentRound)}` : ""}<div class="spacer"></div>
    <div class="form-row"><section>${questionCard(round, game)}<div class="spacer"></div>${answerBoard(round)}</section><section class="panel"><div class="panel-header"><h2>Round Scores</h2><p>Scores are automatic. The highest score earns a round win, including ties.</p></div>${roundPlayerResults(game)}</section></div>
    <div class="spacer"></div><div class="button-row center"><a class="btn btn-main" href="#/game/${game.gameId}/recap">GO TO GAME RECAP</a><a class="btn btn-ghost" href="#/game/${game.gameId}/round-details">Round Details</a></div>`,
    ""
  );
  if (winners.length) playOnce(`${game.gameId}:${game.currentRound}:winner`, () => soundEffects.roundWin());
}

function renderGameRecap(game) {
  const summary = summarizeGame(game);
  const nextRound = game.currentRound + 1;
  const complete = game.currentRound >= game.totalRounds;
  layout(
    `${gameHeading(game, `<span class="pill">${summary.roundsPlayed} of ${game.totalRounds} rounds</span>`)}
    <div class="panel glow"><div class="panel-header"><h2>Game Recap</h2><p>${escapeHtml(victoryModeLabel(game))} standings after Round ${game.currentRound}. Tap any contestant to view their lifetime card.</p></div>${leaderboard(game)}</div>
    <div class="spacer"></div><section class="panel"><div class="panel-header"><h2>Everyone’s Answers · Round ${game.currentRound}</h2><p>Compare answers and round points together.</p></div>${roundPlayerResults(game)}</section>
    <div class="spacer"></div>
    <div class="panel center-text">
      ${complete ? `<h2>The game is complete!</h2><p class="muted">One more tap sends everyone to the finale.</p>${isHost() ? `<button id="finish-game" class="btn btn-main">SHOW THE WINNER</button>` : `<div class="notice"><span>🏆</span><span>Waiting for the host to open the finale.</span></div>`}` : `<h2>Round ${nextRound} is next</h2><p class="muted">The host starts the next round when everyone is ready.</p>${isHost() ? `<button id="start-next-round" class="btn btn-main">START ROUND ${nextRound}</button>` : `<div class="notice"><span>✓</span><span>You're in. The next round opens automatically when the host starts it.</span></div>`}`}
      <div class="spacer"></div><div class="button-row center"><a class="btn btn-ghost" href="#/game/${game.gameId}/details">Game Details</a><a class="btn btn-ghost" href="#/game/${game.gameId}/round-details">Round Details</a></div>
    </div>`,
    "compact"
  );
  document.querySelector("#start-next-round")?.addEventListener("click", (event) => runAction(event.currentTarget, async () => {
    const payload = await prepareRound(game, nextRound);
    await state.service.startNextRound(game.gameId, nextRound, payload);
    sessionStore.rememberQuestionIds([payload.questionId]);
    navigate(`/game/${game.gameId}/play`);
  }, "Opening round…"));
  document.querySelector("#finish-game")?.addEventListener("click", (event) => runAction(event.currentTarget, async () => {
    await state.service.finishGame(game.gameId);
    state.highScores = null;
    state.lifetimeStats = null;
    state.lifetimeStatsSynced = false;
    navigate(`/game/${game.gameId}/finale`);
  }, "Opening finale…"));
}

function renderFinale(game) {
  const summary = summarizeGame(game);
  const { winners } = summary;
  const winnerNames = winners.map((winner) => winner.displayName).join(" & ");
  const teamResult = getTeamWinners(game);
  const teamWinnerNames = teamResult.winners.map((team) => team.name).join(" & ");
  const roundsMode = summary.victoryMode === VICTORY_MODES.ROUNDS;
  const teamMetricCopy = teamResult.victoryMode === VICTORY_MODES.ROUNDS
    ? `${teamResult.highestScore} round ${teamResult.highestScore === 1 ? "win" : "wins"}`
    : `${teamResult.highestScore} combined points`;
  const teamFinale = game.teamMode ? `<section class="team-finale">
    <div class="team-finale-trophy" aria-hidden="true">🏆</div>
    <p class="eyebrow">${teamResult.winners.length > 1 ? "Co-champion teams" : "Ultimate team champion"}</p>
    <h1>${escapeHtml(teamWinnerNames)}</h1>
    <p>${teamMetricCopy} · ${teamResult.winners.map((team) => `${team.totalScore} total points`).join(" · ")}</p>
    <div class="winner-rays" aria-hidden="true"></div>
  </section><div class="spacer"></div>` : "";
  layout(
    `${celebrationPieces(72, "finale-confetti")}${gameHeading(game, `<span class="pill">Finale</span>`)}
    ${teamFinale}<section class="panel glow finale"><div class="finale-crown" aria-hidden="true"><span>★</span></div><p class="eyebrow">${game.teamMode ? "Individual standings · " : ""}${winners.length > 1 ? "Co-champions" : "Tonight's champion"} by ${escapeHtml(victoryModeLabel(game))}</p><h1 class="winner-name">${escapeHtml(winnerNames)}</h1><p class="winner-copy">${roundsMode ? `${winners[0]?.highRoundCount || 0} round wins · ${winners[0]?.totalScore || 0} total points` : `${winners[0]?.totalScore || 0} points · ${winners[0]?.highRoundCount || 0} round wins`}</p><div class="divider"></div><div class="finale-board">${leaderboard(game)}</div><div class="spacer"></div><div class="button-row center"><a class="btn btn-main" href="#/create">PLAY AGAIN</a><a class="btn btn-ghost" href="#/game/${game.gameId}/details">Full Game Details</a></div></section>`,
    "compact"
  );
  playOnce(`${game.gameId}:finale`, () => soundEffects.finale());
}

function roundCarousel(game, roundNumber, targetView) {
  const round = getRound(game, roundNumber);
  return `<div class="carousel"><button id="round-prev" class="btn btn-ghost btn-icon" ${roundNumber <= 1 ? "disabled" : ""} aria-label="Previous round">←</button><div class="carousel-card"><span class="round-number">Round ${roundNumber}</span><h3>${escapeHtml(round?.prompt || "Not played yet")}</h3><p>${round?.finalized ? `Completed ${formatDate(round.finalizedAt)}` : "Not completed"}</p></div><button id="round-next" class="btn btn-ghost btn-icon" ${roundNumber >= game.currentRound ? "disabled" : ""} aria-label="Next round">→</button></div><div class="spacer"></div><div class="button-row center"><a class="btn ${targetView === "round-details" ? "btn-primary" : "btn-ghost"}" href="#/game/${game.gameId}/round-details">Round Details</a><a class="btn ${targetView === "details" ? "btn-primary" : "btn-ghost"}" href="#/game/${game.gameId}/details">Game Summary</a></div>`;
}

function bindCarousel(game, view) {
  document.querySelector("#round-prev")?.addEventListener("click", () => { state.carouselRound = Math.max(1, state.carouselRound - 1); renderGameView(view); });
  document.querySelector("#round-next")?.addEventListener("click", () => { state.carouselRound = Math.min(game.currentRound, state.carouselRound + 1); renderGameView(view); });
}

function renderGameDetails(game) {
  const summary = summarizeGame(game);
  const roundsMode = summary.victoryMode === VICTORY_MODES.ROUNDS;
  const leader = summary.leaderboard[0];
  state.carouselRound = Math.min(Math.max(1, state.carouselRound), Math.max(1, game.currentRound));
  layout(
    `${gameHeading(game, `<span class="pill">Game details</span>`)}
    <div class="stats-grid"><div class="stat"><span class="stat-value">${summary.roundsPlayed}</span><span class="stat-label">Rounds played</span></div><div class="stat"><span class="stat-value">${Object.keys(game.players || {}).length}</span><span class="stat-label">Players</span></div><div class="stat"><span class="stat-value">${roundsMode ? leader?.highRoundCount || 0 : leader?.totalScore || 0}</span><span class="stat-label">${roundsMode ? "Leading round wins" : "Top score"}</span></div></div><div class="spacer"></div>
    <div class="form-row"><section class="panel"><div class="panel-header"><h2>Standings</h2><p>Ranked for ${escapeHtml(victoryModeLabel(game))}. Tap a contestant for their lifetime card.</p></div>${leaderboard(game)}</section><section class="panel"><div class="panel-header"><h2>Round Carousel</h2><p>Scroll through every played question.</p></div>${roundCarousel(game, state.carouselRound, "details")}</section></div><div class="spacer"></div><div class="button-row center"><a class="btn btn-main" href="#/game/${game.gameId}/${game.phase === "finished" ? "finale" : game.phase === "lobby" ? "lobby" : game.phase === "recap" ? "recap" : "play"}">RETURN TO GAME</a>${isHost() ? `<a class="btn btn-secondary" href="#/game/${game.gameId}/settings">Host Settings</a>` : ""}</div>`,
    ""
  );
  bindCarousel(game, "details");
}

function renderRoundDetails(game) {
  state.carouselRound = Math.min(Math.max(1, state.carouselRound), Math.max(1, game.currentRound));
  const round = getRound(game, state.carouselRound);
  layout(
    `${gameHeading(game, `<span class="pill">Round details</span>`)}${roundCarousel(game, state.carouselRound, "round-details")}
    ${round ? `<div class="form-row"><section>${questionCard(round, { ...game, currentRound: state.carouselRound })}<div class="spacer"></div>${answerBoard(round)}</section><section class="panel"><div class="panel-header"><h2>Player Answers</h2><p>${escapeHtml(round.source || "Same Slate card")} · ${formatDate(round.openedAt)}</p></div>${roundPlayerResults(game, state.carouselRound)}</section></div>` : `<div class="panel empty-state"><strong>No round data yet</strong>Start the game to create the first round.</div>`}
    <div class="spacer"></div><div class="button-row center"><a class="btn btn-main" href="#/game/${game.gameId}/${game.phase === "finished" ? "finale" : game.phase === "recap" ? "recap" : game.phase === "lobby" ? "lobby" : "play"}">RETURN TO GAME</a></div>`,
    ""
  );
  bindCarousel(game, "round-details");
}

function renderSettings(game) {
  if (!isHost()) return renderGameDetails(game);
  const completedRounds = Object.entries(game.rounds || {}).filter(([, round]) => round.finalized);
  layout(
    `${gameHeading(game, `<span class="pill">Host settings</span>`)}
    <section class="panel"><div class="panel-header"><h2>Game Settings</h2><p>Changes appear for every connected player. Timer changes apply when the next round opens.</p></div><form id="settings-form" class="form-grid"><div class="field"><label for="settings-nickname">Game nickname</label><input class="input" id="settings-nickname" name="nickname" maxlength="40" value="${escapeHtml(game.nickname)}" required /></div><div class="toggle-row"><div class="toggle-copy"><strong>Round timer</strong><span>Automatically lock answers when time runs out.</span></div><label class="switch"><input id="settings-timer-enabled" name="roundTimerEnabled" type="checkbox" ${game.roundTimerEnabled === false ? "" : "checked"} /><span class="switch-ui"></span></label></div><div class="field timer-duration-control ${game.roundTimerEnabled === false ? "disabled-control" : ""}" id="settings-timer-control"><label for="settings-timer">Answer timer (seconds)</label><input class="input" id="settings-timer" name="roundTimerSeconds" type="number" min="${APP_CONFIG.minRoundSeconds}" max="${APP_CONFIG.maxRoundSeconds}" value="${Number(game.roundTimerSeconds || APP_CONFIG.defaultRoundSeconds)}" ${game.roundTimerEnabled === false ? "disabled" : ""} required /><p class="field-help">Used when the timer is enabled.</p></div><button class="btn btn-primary" type="submit">SAVE GAME SETTINGS</button></form></section>
    <section class="panel"><div class="panel-header"><h2>Contestants</h2><p>Tap a name for lifetime stats. Removing a player is permanent and also removes them from the current round's waiting gates.</p></div><div class="player-list">${Object.entries(game.players || {}).map(([playerUid, player]) => `<div class="player-row">${playerAvatar(player.displayName)}<div class="player-copy"><strong>${playerCardName(playerUid, player.displayName)}</strong><span>${player.totalScore || 0} points</span></div><button class="btn btn-danger btn-small remove-player" data-uid="${escapeHtml(playerUid)}">Remove</button></div>`).join("")}</div></section>
    <section class="panel"><div class="panel-header"><h2>Edit Round Scores</h2><p>Host changes update the player's total score immediately.</p></div>${completedRounds.length ? completedRounds.map(([roundNumber, round]) => `<div class="match-card"><strong>Round ${roundNumber}: ${escapeHtml(round.prompt)}</strong><div class="spacer"></div><div class="form-grid">${Object.values(round.results || {}).map((result) => `<div class="toggle-row"><div class="toggle-copy"><strong>${escapeHtml(result.displayName)}</strong><span>“${escapeHtml(result.answer)}”${result.hostEdited ? " · Host edited" : ""}</span></div><select class="select score-edit" style="width:100px" data-round="${roundNumber}" data-uid="${escapeHtml(result.uid)}">${Array.from({length: game.matchScoring === "matches" ? 32 : 2}, (_, points) => points).map((points) => `<option value="${points}" ${Number(result.points) === points ? "selected" : ""}>${points}</option>`).join("")}</select></div>`).join("")}</div></div><div class="spacer"></div>`).join("") : `<div class="empty-state"><strong>No completed rounds</strong>Score editing appears here after Round 1.</div>`}</section>
    <div class="button-row center"><a class="btn btn-main" href="#/game/${game.gameId}/${game.phase === "lobby" ? "lobby" : game.phase === "recap" ? "recap" : game.phase === "finished" ? "finale" : "play"}">RETURN TO GAME</a></div>`,
    "compact"
  );
  const settingsTimerEnabled = document.querySelector("#settings-timer-enabled");
  const settingsTimer = document.querySelector("#settings-timer");
  const settingsTimerControl = document.querySelector("#settings-timer-control");
  settingsTimerEnabled.addEventListener("change", () => {
    settingsTimer.disabled = !settingsTimerEnabled.checked;
    settingsTimerControl.classList.toggle("disabled-control", !settingsTimerEnabled.checked);
  });
  document.querySelector("#settings-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const roundTimerSeconds = Math.max(APP_CONFIG.minRoundSeconds, Math.min(APP_CONFIG.maxRoundSeconds, Number(settingsTimer.value)));
    runAction(event.submitter, () => state.service.updateGameSettings(game.gameId, { nickname: document.querySelector("#settings-nickname").value.trim(), roundTimerEnabled: settingsTimerEnabled.checked, roundTimerSeconds }), "Saving…");
  });
  document.querySelectorAll(".remove-player").forEach((button) => button.addEventListener("click", () => {
    if (window.confirm("Remove this player from the game? This also removes them from the current round.")) runAction(button, () => state.service.removePlayer(game.gameId, button.dataset.uid), "Removing…");
  }));
  document.querySelectorAll(".score-edit").forEach((select) => select.addEventListener("change", () => runAction(select, () => state.service.editFinalScore(game.gameId, Number(select.dataset.round), select.dataset.uid, Number(select.value)), "Saving…")));
}

function adminUserRow([userUid, user]) {
  const role = user.role || "player";
  const protectedRole = ["master", "admin"].includes(role);
  const roleLabel = role === "admin" ? "Master" : `${role.charAt(0).toUpperCase()}${role.slice(1)}`;
  return `<div class="player-row admin-user-row" data-search-name="${escapeHtml(normalizeNickname(user.displayName || ""))}">
    ${playerAvatar(user.displayName)}
    <div class="player-copy"><strong>${escapeHtml(user.displayName || "Unnamed player")}</strong><span>${escapeHtml(roleLabel)} · ${escapeHtml(user.hostNumber || (protectedRole ? "Master access" : "No host number"))}</span></div>
    ${protectedRole ? `<span class="role-badge master-role">MASTER</span>` : `<select class="select role-select" data-uid="${escapeHtml(userUid)}" data-current-role="${escapeHtml(role)}"><option value="player" ${role === "player" ? "selected" : ""}>Player</option><option value="host" ${role === "host" ? "selected" : ""}>Host</option></select>`}
  </div>`;
}

function adminUserGroup(title, roleClass, entries) {
  if (!entries.length) return "";
  return `<section class="admin-role-group ${roleClass}" data-role-group><div class="admin-role-heading"><h3>${escapeHtml(title)}</h3><span>${entries.length}</span></div><div class="player-list">${entries.map(adminUserRow).join("")}</div></section>`;
}

function adminQuestionSubmissionCard(submission) {
  const status = submission.status || "pending";
  const prompt = submission.prompt || promptFromQuery(submission.query);
  return `<form class="question-review-card ${escapeHtml(status)}" data-question-owner="${escapeHtml(submission.ownerUid)}" data-question-id="${escapeHtml(submission.questionId)}" data-current-status="${escapeHtml(status)}">
    <div class="question-review-heading"><div><span class="question-status ${escapeHtml(status)}">${escapeHtml(status)}</span><strong>${escapeHtml(submission.submittedByName || "Player")}</strong><small>Submitted ${escapeHtml(formatDate(submission.submittedAt))}</small></div><span class="question-review-prompt">${escapeHtml(prompt)}</span></div>
    <div class="question-review-fields"><div class="field"><label>Card prompt</label><input class="input question-review-query" name="query" maxlength="100" value="${escapeHtml(submission.query || "")}" required /></div><div class="field"><label>Category</label><input class="input" name="category" maxlength="40" value="${escapeHtml(submission.category || "Community Pick")}" required /></div></div>
    <div class="question-review-actions"><button class="btn btn-ghost btn-small question-review-action" type="button" data-question-status="${escapeHtml(status)}">Save Edits</button><button class="btn btn-primary btn-small question-review-action" type="button" data-question-status="approved">${status === "approved" ? "Keep Approved" : "Approve"}</button><button class="btn btn-danger btn-small question-review-action" type="button" data-question-status="declined">Decline</button></div>
  </form>`;
}

function adminSectionSummary(title, description, count, countLabel) {
  return `<summary class="admin-section-summary"><div><h2>${escapeHtml(title)}</h2><p>${escapeHtml(description)}</p></div><span class="admin-summary-count" aria-label="${Number(count)} ${escapeHtml(countLabel)}">${Number(count)}</span><span class="admin-summary-chevron" aria-hidden="true">⌄</span></summary>`;
}

function approvedQuestionEditor(question, index) {
  return `<form class="approved-question-card" data-question-id="${escapeHtml(question.questionId)}">
    <div class="approved-question-heading"><span class="approved-question-number">${index + 1}</span><div><span class="question-status approved">Approved</span><strong class="approved-question-prompt">${escapeHtml(question.prompt || promptFromQuery(question.query))}</strong></div></div>
    <div class="question-review-fields"><div class="field"><label>Card prompt</label><input class="input approved-question-query" name="query" maxlength="100" value="${escapeHtml(question.query || "")}" required /></div><div class="field"><label>Category</label><input class="input" name="category" maxlength="40" value="${escapeHtml(question.category || "Community Pick")}" required /></div></div>
    <div class="approved-question-meta"><span>Updated ${escapeHtml(formatDate(question.updatedAt || question.approvedAt))}</span><div class="question-review-actions"><button class="btn btn-primary btn-small save-approved-question" type="submit">Save Changes</button><button class="btn btn-danger btn-small delete-approved-question" type="button">Delete</button></div></div>
  </form>`;
}

async function renderCustomQuestionBank() {
  if (!requireAuth("admin/questions")) return;
  if (!["master", "admin"].includes(state.profile?.role)) return renderHostDashboard();
  if (state.approvedQuestions === null) {
    try {
      state.approvedQuestions = await state.service.listApprovedQuestions();
      state.approvedQuestionsError = "";
    } catch (error) {
      console.error("Could not load approved questions.", error);
      state.approvedQuestions = [];
      state.approvedQuestionsError = "The custom question bank could not be loaded. Publish the latest Firebase Database Rules, then refresh.";
    }
  }
  const approvedQuestions = state.approvedQuestions || [];
  layout(
    `<section class="section-heading"><div><p class="eyebrow">Master controls</p><h1>Custom Card Bank</h1><p>Add, edit, and remove every approved community question.</p></div><span class="admin-bank-total"><strong>${approvedQuestions.length}</strong><small>approved</small></span></section>
    ${state.approvedQuestionsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.approvedQuestionsError)}</span></div><div class="spacer"></div>` : ""}
    <section class="panel custom-question-add"><div class="panel-header"><h2>Add a Custom Question</h2><p>Master-created questions enter the approved bank immediately.</p></div>
      <form id="add-approved-question" class="form-grid"><div class="question-review-fields"><div class="field"><label for="new-approved-query">Card prompt</label><input class="input" id="new-approved-query" name="query" maxlength="100" placeholder="____ Field" required /></div><div class="field"><label for="new-approved-category">Category</label><input class="input" id="new-approved-category" name="category" maxlength="40" value="Community Pick" required /></div></div><div class="question-prompt-preview"><span>Player-facing preview</span><strong id="new-approved-preview">Elbow ____</strong></div><button class="btn btn-main" type="submit">ADD TO CUSTOM BANK</button></form>
    </section>
    <section class="panel"><div class="panel-header"><h2>Approved Custom Cards</h2><p>Changes here affect future games; questions already used in completed rounds stay unchanged.</p></div>
      ${approvedQuestions.length ? `<div class="approved-question-list">${approvedQuestions.map(approvedQuestionEditor).join("")}</div>` : `<div class="empty-state"><strong>No approved custom questions yet</strong>Add one above or approve a player submission from Master Controls.</div>`}
    </section>
    <div class="button-row center"><a class="btn btn-main" href="#/admin">BACK TO MASTER CONTROLS</a></div>`,
    "compact"
  );
  const addQuery = document.querySelector("#new-approved-query");
  addQuery?.addEventListener("input", () => {
    document.querySelector("#new-approved-preview").textContent = promptFromQuery(addQuery.value) || "Elbow ____";
  });
  document.querySelector("#add-approved-question")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    runAction(event.submitter, async () => {
      await state.service.createApprovedQuestion(values);
      state.approvedQuestions = await state.service.listApprovedQuestions();
      toast("Custom question added to the approved bank.", "success");
      renderCustomQuestionBank();
    }, "Adding…");
  });
  document.querySelectorAll(".approved-question-query").forEach((input) => input.addEventListener("input", () => {
    const preview = input.closest(".approved-question-card")?.querySelector(".approved-question-prompt");
    if (preview) preview.textContent = promptFromQuery(input.value) || "Elbow ____";
  }));
  document.querySelectorAll(".approved-question-card").forEach((form) => form.addEventListener("submit", (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(form));
    runAction(event.submitter, async () => {
      await state.service.updateApprovedQuestion(form.dataset.questionId, values);
      state.approvedQuestions = await state.service.listApprovedQuestions();
      toast("Custom question updated.", "success");
      renderCustomQuestionBank();
    }, "Saving…");
  }));
  document.querySelectorAll(".delete-approved-question").forEach((button) => button.addEventListener("click", () => {
    const form = button.closest(".approved-question-card");
    const prompt = form.querySelector(".approved-question-prompt")?.textContent || "this custom question";
    if (!window.confirm(`Delete “${prompt}” from the custom question bank?\n\nIt will not be selected for future games. Completed round records will not change.`)) return;
    runAction(button, async () => {
      await state.service.deleteApprovedQuestion(form.dataset.questionId);
      state.approvedQuestions = await state.service.listApprovedQuestions();
      toast("Custom question deleted.", "success");
      renderCustomQuestionBank();
    }, "Deleting…");
  }));
}

async function renderAdmin() {
  if (!requireAuth("admin")) return;
  if (!["master", "admin"].includes(state.profile?.role)) return renderHostDashboard();
  if (state.users === null || state.hostRequests === null || state.adminGames === null || state.adminQuestionSubmissions === null || state.approvedQuestions === null) {
    const [users, hostRequests, games, questionSubmissions, approvedQuestions] = await Promise.all([
      state.users === null ? state.service.listUsers() : state.users,
      state.hostRequests === null ? state.service.listHostRequests() : state.hostRequests,
      state.adminGames === null ? state.service.listAllGames() : state.adminGames,
      state.adminQuestionSubmissions === null ? state.service.listQuestionSubmissions().then((submissions) => {
        state.questionSubmissionsError = "";
        return submissions;
      }).catch((error) => {
        console.error("Could not load submitted questions.", error);
        state.questionSubmissionsError = "Question review needs the latest Firebase Database Rules. Publish the repository rules file, then refresh.";
        return [];
      }) : state.adminQuestionSubmissions,
      state.approvedQuestions === null ? state.service.listApprovedQuestions().then((questions) => {
        state.approvedQuestionsError = "";
        return questions;
      }).catch((error) => {
        console.error("Could not load approved questions.", error);
        state.approvedQuestionsError = "The custom question bank needs the latest Firebase Database Rules. Publish the repository rules file, then refresh.";
        return [];
      }) : state.approvedQuestions
    ]);
    state.users = users;
    state.hostRequests = hostRequests;
    state.adminGames = games;
    state.adminQuestionSubmissions = questionSubmissions;
    state.approvedQuestions = approvedQuestions;
  }
  const games = state.adminGames || [];
  const questionSubmissions = state.adminQuestionSubmissions || [];
  const pendingQuestionSubmissions = questionSubmissions.filter((submission) => submission.status === "pending");
  const pendingQuestionCount = pendingQuestionSubmissions.length;
  const approvedQuestionCount = (state.approvedQuestions || []).length;
  const sortedUsers = sortProfilesByRoleThenName(state.users || {});
  const masterUsers = sortedUsers.filter(([, user]) => ["master", "admin"].includes(user.role));
  const hostUsers = sortedUsers.filter(([, user]) => user.role === "host");
  const playerUsers = sortedUsers.filter(([, user]) => !["master", "admin", "host"].includes(user.role));
  const pendingRequests = Object.entries(state.hostRequests || {})
    .filter(([requestUid, request]) => request?.status === "pending" && state.users?.[requestUid]?.role === "player")
    .sort(([uidA], [uidB]) => String(state.users?.[uidA]?.displayName || "").localeCompare(String(state.users?.[uidB]?.displayName || ""), undefined, { sensitivity: "base", numeric: true }));
  layout(
    `<section class="section-heading"><div><p class="eyebrow">Master controls</p><h1>Players, Hosts & Games</h1><p>Manage account roles and the complete game archive.</p></div>${modeBadge()}</section>
    <div class="notice"><span>✓</span><span>Email addresses stay private. Only nicknames, roles, and host numbers appear here.</span></div><div class="spacer"></div>
    <details class="panel admin-collapsible host-request-panel">${adminSectionSummary("Host Requests", "Players waiting for host approval or decline.", pendingRequests.length, "pending host requests")}
      <div class="admin-collapsible-body">${pendingRequests.length ? `<div class="player-list">${pendingRequests.map(([requestUid, request]) => {
        const player = state.users[requestUid];
        return `<div class="player-row host-request-row">${playerAvatar(player.displayName)}<div class="player-copy"><strong>${escapeHtml(player.displayName)}</strong><span>Requested ${formatDate(request.requestedAt)}</span></div><div class="request-actions"><button class="btn btn-primary btn-small approve-host-request" type="button" data-uid="${escapeHtml(requestUid)}">Approve</button><button class="btn btn-ghost btn-small decline-host-request" type="button" data-uid="${escapeHtml(requestUid)}">Decline</button></div></div>`;
      }).join("")}</div>` : `<div class="empty-state"><strong>No pending host requests</strong>New requests will be collected here automatically.</div>`}</div>
    </details>
    <details class="panel admin-collapsible question-review-panel">${adminSectionSummary("Card Submissions", "Player ideas still waiting for approval or decline.", pendingQuestionCount, "pending question submissions")}
      <div class="admin-collapsible-body">${state.questionSubmissionsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.questionSubmissionsError)}</span></div>` : pendingQuestionSubmissions.length ? `<div class="question-review-list">${pendingQuestionSubmissions.map(adminQuestionSubmissionCard).join("")}</div>` : `<div class="empty-state"><strong>No questions waiting for review</strong>Approved and declined requests leave this queue automatically.</div>`}</div>
    </details>
    <a class="panel admin-section-link" href="#/admin/questions"><span class="admin-section-link-icon" aria-hidden="true">💡</span><div><h2>Custom Card Bank</h2><p>Add, edit, or delete every approved custom question.</p></div><span class="admin-summary-count" aria-label="${approvedQuestionCount} approved custom questions">${approvedQuestionCount}</span><span class="admin-section-link-arrow" aria-hidden="true">›</span></a>
    ${state.approvedQuestionsError ? `<div class="notice warning"><span>!</span><span>${escapeHtml(state.approvedQuestionsError)}</span></div><div class="spacer"></div>` : ""}
    <details class="panel admin-collapsible">${adminSectionSummary("User & Host Setup", "Master first, then alphabetized hosts and players.", sortedUsers.length, "total people")}
      <div class="admin-collapsible-body">
      <div class="field admin-user-search"><label for="admin-user-search">Search by nickname</label><div class="search-input-wrap"><span aria-hidden="true">⌕</span><input class="input" id="admin-user-search" type="search" placeholder="Start typing a display name…" autocomplete="off" /></div></div>
      <div class="admin-user-groups">
        ${adminUserGroup("Master", "master-group", masterUsers)}
        ${adminUserGroup("Hosts", "host-group", hostUsers)}
        ${adminUserGroup("Players", "player-group", playerUsers)}
      </div>
      <div class="empty-state admin-user-no-results" hidden><strong>No nickname found</strong>Try a different spelling or clear the search.</div>
      </div>
    </details>
    <details class="panel admin-collapsible admin-game-records">${adminSectionSummary("Game Records", "Every active and completed game still stored in the archive.", games.length, "game records")}
      <div class="admin-collapsible-body"><p class="admin-section-detail">Only the master can permanently delete a game. Completed-game deletion also rolls that game back out of lifetime points, rounds played, rounds won, streaks, and high scores.</p>
      <div class="notice danger"><span>!</span><span>Deleting an active game immediately closes its room. This cannot be undone.</span></div><div class="spacer"></div>
      ${games.length ? `<div class="admin-game-list">${games.map((game) => {
        const roundsPlayed = Object.values(game.rounds || {}).filter((round) => round?.finalized).length;
        const playerCount = Object.keys(game.players || {}).length;
        return `<article class="admin-game-row"><div class="admin-game-number">#${Number(game.gameNumber || 0)}</div><div class="admin-game-copy"><strong>${escapeHtml(game.nickname || "Untitled Game")}</strong><span>Code ${escapeHtml(game.code || "—")} · ${escapeHtml(game.status || "unknown")} · ${playerCount} player${playerCount === 1 ? "" : "s"} · ${roundsPlayed} round${roundsPlayed === 1 ? "" : "s"} · ${escapeHtml(victoryModeLabel(game))}${game.teamMode ? " · Teams" : ""}</span></div><button class="btn btn-danger btn-small delete-game" type="button" data-game-id="${escapeHtml(game.gameId)}" data-game-number="${Number(game.gameNumber || 0)}" data-game-name="${escapeHtml(game.nickname || "Untitled Game")}">Delete</button></article>`;
      }).join("")}</div>` : `<div class="empty-state"><strong>No games to manage</strong>New rooms will appear here.</div>`}</div>
    </details>
    <div class="button-row center"><a class="btn btn-main" href="#/host">BACK TO HOST CENTER</a></div>`,
    "compact"
  );
  document.querySelector("#admin-user-search")?.addEventListener("input", (event) => {
    const query = normalizeNickname(event.currentTarget.value);
    let visibleCount = 0;
    document.querySelectorAll(".admin-user-row").forEach((row) => {
      const matches = !query || row.dataset.searchName.includes(query);
      row.hidden = !matches;
      if (matches) visibleCount += 1;
    });
    document.querySelectorAll("[data-role-group]").forEach((group) => {
      group.hidden = !Array.from(group.querySelectorAll(".admin-user-row")).some((row) => !row.hidden);
    });
    document.querySelector(".admin-user-no-results").hidden = visibleCount > 0;
  });
  document.querySelectorAll(".approve-host-request").forEach((button) => button.addEventListener("click", async () => {
    await runAction(button, async () => {
      await state.service.approveHostRequest(button.dataset.uid);
      [state.users, state.hostRequests] = await Promise.all([
        state.service.listUsers(),
        state.service.listHostRequests()
      ]);
      toast("Host request approved and host access assigned.", "success");
      renderAdmin();
    }, "Approving…");
  }));
  document.querySelectorAll(".decline-host-request").forEach((button) => button.addEventListener("click", async () => {
    await runAction(button, async () => {
      await state.service.dismissHostRequest(button.dataset.uid);
      state.hostRequests = await state.service.listHostRequests();
      toast("Host request declined.", "success");
      renderAdmin();
    }, "Declining…");
  }));
  document.querySelectorAll(".role-select").forEach((select) => select.addEventListener("change", async () => {
    const previousRole = select.dataset.currentRole;
    await runAction(select, async () => {
      await state.service.setUserRole(select.dataset.uid, select.value);
      [state.users, state.hostRequests] = await Promise.all([
        state.service.listUsers(),
        state.service.listHostRequests()
      ]);
      toast("Account role updated.", "success");
      renderAdmin();
    }, "Saving…");
    if (document.body.contains(select) && state.users?.[select.dataset.uid]?.role !== select.value) {
      select.value = previousRole;
    }
  }));
  document.querySelectorAll(".question-review-query").forEach((input) => input.addEventListener("input", () => {
    const preview = input.closest(".question-review-card")?.querySelector(".question-review-prompt");
    if (preview) preview.textContent = promptFromQuery(input.value) || "Elbow ____";
  }));
  document.querySelectorAll(".question-review-action").forEach((button) => button.addEventListener("click", async () => {
    const form = button.closest(".question-review-card");
    const values = Object.fromEntries(new FormData(form));
    await runAction(button, async () => {
      await state.service.reviewQuestionSubmission(
        form.dataset.questionOwner,
        form.dataset.questionId,
        { ...values, status: button.dataset.questionStatus }
      );
      state.adminQuestionSubmissions = await state.service.listQuestionSubmissions();
      state.approvedQuestions = null;
      state.myQuestionSubmissions = null;
      const action = button.dataset.questionStatus === "approved" ? "approved" : button.dataset.questionStatus === "declined" ? "declined" : "updated";
      toast(`Question ${action}.`, "success");
      renderAdmin();
    }, "Saving…");
  }));
  document.querySelectorAll(".delete-game").forEach((button) => button.addEventListener("click", async () => {
    const gameLabel = `Game #${button.dataset.gameNumber} “${button.dataset.gameName}”`;
    const confirmed = window.confirm(`Permanently delete ${gameLabel}?\n\nThis removes the room, rounds, answers, scores, player history links, and rolls the game out of every lifetime total and high score. This cannot be undone.`);
    if (!confirmed) return;
    await runAction(button, async () => {
      const deletedGameId = button.dataset.gameId;
      await state.service.deleteGame(deletedGameId);
      state.adminGames = await state.service.listAllGames();
      state.myGames = null;
      state.highScores = null;
      state.lifetimeStats = null;
      state.lifetimeStatsSynced = false;
      if (state.gameId === deletedGameId) {
        state.unsubscribeGame?.();
        state.unsubscribeGame = null;
        state.game = null;
        state.gameId = null;
        sessionStore.clearActiveGame();
      }
      toast(`${gameLabel} was permanently deleted and lifetime records were recalculated.`, "success");
      renderAdmin();
    }, "Deleting…");
  }));
}

function maybeRevealRound(game) {
  if (!isHost() || game.phase !== "answering" || !allPlayersSubmitted(game)) return;
  const key = `${game.gameId}:${game.currentRound}:revealing`;
  if (state.timerActions.has(key)) return;
  state.timerActions.add(key);
  queueMicrotask(() => state.service.revealRound(game.gameId).catch((error) => {
    state.timerActions.delete(key);
    toast(error.message || "Could not reveal this round. Try Refresh.", "error");
  }));
}

function patchRoundStatus(game) {
  const round = getRound(game);
  const ids = lockedPlayerIds(game);
  const answering = game.phase === "answering";
  const count = ids.filter((id) => answering ? round?.answers?.[id]?.locked : round?.scoreClaims?.[id] != null).length;
  if (answering) {
    const bar = document.querySelector(".round-stage .progress-bar");
    if (bar) bar.style.width = `${ids.length ? count / ids.length * 100 : 0}%`;
    const label = document.querySelector(".round-stage .progress-copy span");
    if (label) label.textContent = `${count} submitted`;
  }
  const status = document.querySelector(".status-panel");
  if (status) {
    const heading = status.querySelector(".panel-header")?.outerHTML || "";
    status.innerHTML = heading + contestantStatusList(game, (id) => {
      const complete = answering ? Boolean(round?.answers?.[id]?.locked) : round?.scoreClaims?.[id] != null;
      return { complete, label: answering ? complete ? "LOCKED IN" : "ANSWERING" : complete ? "SCORE LOCKED" : "REVIEWING", detail: answering ? complete ? "Final answer submitted" : "Still choosing an answer" : complete ? "Final points submitted" : "Choosing final points" };
    });
    status.querySelectorAll(".player-card-trigger").forEach((button) => button.addEventListener("click", () => openInGamePlayerCard(button.dataset.playerUid, button.dataset.playerName, button)));
  }
  const finalize = document.querySelector("#finalize-round");
  if (finalize) finalize.disabled = !allScoresConfirmed(game);
  maybeRevealRound(game);
}

async function ensureGame(gameId) {
  if (state.gameId === gameId && state.game) return true;
  state.unsubscribeGame?.();
  state.gameId = gameId;
  state.game = await state.service.getGame(gameId);
  if (!state.game) return false;
  state.unsubscribeGame = state.service.watchGame(gameId, (game) => {
    const previous = state.game;
    state.game = game;
    if (window.location.hash.includes(`/game/${gameId}/`)) {
      const view = getHashParts().segments[2] || "play";
      if (canPatchRound(previous, game, view, uid())) patchRoundStatus(game);
      else render();
    }
  });
  sessionStore.setActiveGame(gameId);
  return true;
}

function renderGameView(view) {
  const game = state.game;
  if (!game) return;
  view = viewForPhase(view, game.phase);
  if (view === "details") return renderGameDetails(game);
  if (view === "round-details") return renderRoundDetails(game);
  if (view === "settings") return renderSettings(game);
  if (view === "recap") return renderGameRecap(game);
  if (view === "finale") return renderFinale(game);
  if (view === "lobby") return renderLobby(game);
  if (game.phase === "answering" || game.phase === "waiting") return renderAnswering(game);
  if (game.phase === "scoring") return renderScoring(game);
  if (game.phase === "recap") return renderRoundRecap(game);
  if (game.phase === "finished") return renderFinale(game);
  return renderLobby(game);
}

async function render() {
  const { segments, params } = getHashParts();
  const [page = "home", gameId, gameView = "play"] = segments;
  state.unsubscribeMessages?.(); state.unsubscribeMessages = null;
  if (page === "messages") {
    if (!requireAuth("messages")) return;
    layout(messageCenterMarkup());
    state.unsubscribeMessages = bindMessageCenter(state.service, runAction, toast);
    return;
  }
  if (page === "home") return renderHome();
  if (page === "instructions") return renderInstructions();
  if (page === "auth") return renderAuth(params);
  if (page === "host") return renderHostDashboard();
  if (page === "create") return renderCreateGame();
  if (page === "join") return renderJoinGame();
  if (page === "hall-of-fame") return renderHallOfFame();
  if (page === "questions") return renderQuestionSubmissions();
  if (page === "admin" && gameId === "questions") return renderCustomQuestionBank();
  if (page === "admin") return renderAdmin();
  if (page === "game") {
    if (!requireAuth(`game/${gameId}/${gameView}`)) return;
    if (state.gameId !== gameId || !state.game) root.innerHTML = `<div class="boot-screen"><div class="logo-mark"><span>?</span></div><p>Loading the game room…</p></div>`;
    if (!(await ensureGame(gameId))) {
      layout(`<div class="panel center-text"><h1>Game not found</h1><p class="muted">This room may have been removed or the link may be incorrect.</p><a class="btn btn-main" href="#/join">ENTER A GAME CODE</a></div>`, "narrow");
      return;
    }
    return renderGameView(gameView);
  }
  navigate("/home");
}

function renderConnectionError(error) {
  console.error("Live Firebase initialization failed.", error);
  root.innerHTML = `<div class="app-shell"><main class="page narrow"><section class="panel glow center-text connection-error">
    <div class="connection-mark" aria-hidden="true">!</div>
    <p class="eyebrow">Live connection unavailable</p>
    <h1>The game could not reach Firebase.</h1>
    <p class="muted">No demo game was loaded. Check the internet connection and confirm Anonymous Authentication and the Realtime Database are enabled.</p>
    <button class="btn btn-main" id="retry-live">TRY AGAIN</button>
  </section></main></div>`;
  document.querySelector("#retry-live")?.addEventListener("click", () => window.location.reload());
}

async function init() {
  applyNightMode();
  soundEffects.installUnlockHandlers();

  try {
    if (!isFirebaseConfigured()) throw new Error("Firebase configuration is incomplete.");
    state.service = new FirebaseGameService();
    await state.service.init();
  } catch (error) {
    renderConnectionError(error);
    return;
  }

  state.service.onAuth((user, profile) => {
    if (state.user?.uid !== user?.uid) {
      state.users = null;
      state.hostRequests = null;
      state.myHostRequest = null;
      state.myQuestionSubmissions = null;
      state.adminQuestionSubmissions = null;
      state.questionSubmissionsError = "";
      state.approvedQuestions = null;
      state.approvedQuestionsError = "";
      state.adminGames = null;
      state.myGames = null;
    }
    state.user = user;
    state.profile = profile;
    render();
  });
  window.addEventListener("hashchange", render);
  if (!window.location.hash) navigate("/home");
  else await render();
  if ("serviceWorker" in navigator && location.protocol.startsWith("http")) {
    navigator.serviceWorker.register("./service-worker.js").catch(() => {});
  }
}

init();
