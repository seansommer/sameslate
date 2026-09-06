// A same-round update must not replace an input, its caret, or an open keyboard.
export function canPatchRound(previous, next, view, playerUid) {
  if (!previous || !next || previous.gameId !== next.gameId
      || previous.currentRound !== next.currentRound || previous.phase !== next.phase
      || !["play", "lobby"].includes(view)
      || !["answering", "scoring"].includes(next.phase)) return false;
  const oldRound = previous.rounds?.[previous.currentRound] || {};
  const newRound = next.rounds?.[next.currentRound] || {};
  return JSON.stringify(oldRound.answers?.[playerUid] || null) === JSON.stringify(newRound.answers?.[playerUid] || null)
    && JSON.stringify(oldRound.scoreClaims?.[playerUid] || null) === JSON.stringify(newRound.scoreClaims?.[playerUid] || null)
    && JSON.stringify(previous.players || {}) === JSON.stringify(next.players || {});
}

export function viewForPhase(view, phase) {
  if (["details", "round-details", "settings"].includes(view)) return view;
  if (phase === "finished") return "finale";
  if (phase === "lobby") return "lobby";
  if (phase === "answering" || phase === "scoring") return "play";
  return view === "recap" ? "recap" : "play";
}
