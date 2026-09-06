export const APP_CONFIG = {
  gameKind: "sameSlate",
  title: "Same Slate",
  tagline: "Fill the blank. Find your match.",
  officialDisclaimer:
    "An original family word-matching game.",
  funnyDisclaimer:
    "Great minds don’t always think alike. That’s half the fun.",
  repositoryUrl: "https://github.com/seansommer/sameslate",
  scoreByRank: [10, 7, 5, 4, 3, 2, 1],
  maxPlayers: 32,
  minRounds: 1,
  maxRounds: 20,
  defaultRoundSeconds: 30,
  minRoundSeconds: 10,
  maxRoundSeconds: 300,
  firebase: {
    apiKey: "AIzaSyB-kX4n1D_ps1RN5asq4fyuvEWEXRd6fbk",
    authDomain: "fued-728c4.firebaseapp.com",
    databaseURL: "https://fued-728c4-default-rtdb.firebaseio.com",
    projectId: "fued-728c4",
    appId: "1:725218404048:web:4213999a77be57a59ca0d5"
  },
  // A Cloudflare Worker URL can protect a live suggestion-provider API key.
  // Example: https://googlefeud-suggestions.YOUR-NAME.workers.dev
  suggestionEndpoint: ""
};

export const isFirebaseConfigured = () =>
  APP_CONFIG.firebase.apiKey && !APP_CONFIG.firebase.apiKey.includes("REPLACE_ME");

export const isLiveSuggestionsConfigured = () => Boolean(APP_CONFIG.suggestionEndpoint);
