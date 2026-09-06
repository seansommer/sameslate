const ACTIVE_GAME_KEY = "sameslate.activeGame";
const DRAFT_ANSWER_KEY = "sameslate.draftAnswer";
const RECENT_QUESTION_KEY = "sameslate.recentQuestions";
const NIGHT_MODE_KEY = "sameslate.nightMode.v1";
const LEGACY_KEYS = {
  activeGame: "sameslate.legacy.activeGame",
  draftAnswer: "sameslate.legacy.draftAnswer",
  recentQuestions: "sameslate.legacy.recentQuestions"
};

function readWithLegacyMigration(key, legacyKey) {
  const current = localStorage.getItem(key);
  if (current !== null) return current;
  const legacy = localStorage.getItem(legacyKey);
  if (legacy !== null) {
    localStorage.setItem(key, legacy);
    localStorage.removeItem(legacyKey);
  }
  return legacy;
}

export const sessionStore = {
  saveScoreDraft(gameId, roundNumber, uid, value) {
    try { localStorage.setItem(`sameslate.scoreDraft:${uid}:${gameId}:${roundNumber}`, JSON.stringify(value)); } catch {}
  },
  readScoreDraft(gameId, roundNumber, uid) {
    try { return JSON.parse(localStorage.getItem(`sameslate.scoreDraft:${uid}:${gameId}:${roundNumber}`)); } catch { return null; }
  },
  clearScoreDraft(gameId, roundNumber, uid) {
    try { localStorage.removeItem(`sameslate.scoreDraft:${uid}:${gameId}:${roundNumber}`); } catch {}
  },
  getNightMode() {
    try {
      return localStorage.getItem(NIGHT_MODE_KEY) === "true";
    } catch {
      return false;
    }
  },
  setNightMode(enabled) {
    // Appearance is optional: blocked storage must not interrupt a live round.
    try {
      localStorage.setItem(NIGHT_MODE_KEY, String(Boolean(enabled)));
    } catch {}
  },
  setActiveGame(gameId) {
    localStorage.setItem(ACTIVE_GAME_KEY, gameId);
    localStorage.removeItem(LEGACY_KEYS.activeGame);
  },
  getActiveGame() {
    return readWithLegacyMigration(ACTIVE_GAME_KEY, LEGACY_KEYS.activeGame);
  },
  clearActiveGame() {
    localStorage.removeItem(ACTIVE_GAME_KEY);
    localStorage.removeItem(LEGACY_KEYS.activeGame);
  },
  saveDraft(gameId, roundNumber, answer) {
    this.memoryDraft = { gameId, roundNumber, answer };
    try {
      localStorage.setItem(DRAFT_ANSWER_KEY, JSON.stringify(this.memoryDraft));
      localStorage.removeItem(LEGACY_KEYS.draftAnswer);
    } catch {}
  },
  readDraft(gameId, roundNumber) {
    if (this.memoryDraft?.gameId === gameId && this.memoryDraft?.roundNumber === roundNumber) return this.memoryDraft.answer;
    try {
      const draft = JSON.parse(readWithLegacyMigration(DRAFT_ANSWER_KEY, LEGACY_KEYS.draftAnswer));
      return draft?.gameId === gameId && draft?.roundNumber === roundNumber ? draft.answer : "";
    } catch {
      return "";
    }
  },
  clearDraft() {
    this.memoryDraft = null;
    try {
      localStorage.removeItem(DRAFT_ANSWER_KEY);
      localStorage.removeItem(LEGACY_KEYS.draftAnswer);
    } catch {}
  },
  getRecentQuestionIds() {
    try {
      const ids = JSON.parse(readWithLegacyMigration(RECENT_QUESTION_KEY, LEGACY_KEYS.recentQuestions));
      return Array.isArray(ids) ? ids.filter((id) => typeof id === "string") : [];
    } catch {
      return [];
    }
  },
  rememberQuestionIds(ids, limit = 250) {
    const combined = [...ids, ...this.getRecentQuestionIds()];
    localStorage.setItem(RECENT_QUESTION_KEY, JSON.stringify([...new Set(combined)].slice(0, limit)));
    localStorage.removeItem(LEGACY_KEYS.recentQuestions);
  }
};
