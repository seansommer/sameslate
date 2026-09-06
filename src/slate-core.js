export const MATCH_SCORING = Object.freeze({ ONE: "one", MATCHES: "matches" });

export function normalizeSlateAnswer(value = "") {
  return String(value).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("en-US").replace(/[’']/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

export function calculateSlateResults(game, roundNumber = game.currentRound) {
  const round = game.rounds?.[roundNumber];
  if (!round) return [];
  const players = Object.entries(game.players || {}).filter(([, p]) => p.locked);
  const groups = new Map();
  for (const [uid] of players) {
    const answer = round.answers?.[uid];
    const key = answer?.locked && !answer.empty ? normalizeSlateAnswer(answer.text || "") : "";
    if (key) groups.set(key, [...(groups.get(key) || []), uid]);
  }
  return players.map(([uid, player]) => {
    const answer = round.answers?.[uid];
    const key = answer?.locked && !answer.empty ? normalizeSlateAnswer(answer.text || "") : "";
    const partnerUids = key ? (groups.get(key) || []).filter((id) => id !== uid) : [];
    const points = game.matchScoring === MATCH_SCORING.MATCHES ? partnerUids.length : Number(partnerUids.length > 0);
    return { uid, displayName: player.displayName, answer: answer?.empty ? "No answer" : answer?.text || "No answer", suggestedPoints: points, points,
      matchCount: partnerUids.length, match: { matched: partnerUids.length > 0, partnerUids, normalized: key }, confirmed: true };
  });
}

export function applySlateResults(game, timestamp) {
  const round = game.rounds?.[game.currentRound];
  if (!round || round.finalized) return game;
  const results = calculateSlateResults(game);
  const best = Math.max(0, ...results.map((r) => r.points));
  for (const result of results) {
    const player = game.players[result.uid];
    player.totalScore = Number(player.totalScore || 0) + result.points;
    if (best > 0 && result.points === best) player.highRoundCount = Number(player.highRoundCount || 0) + 1;
  }
  round.results = Object.fromEntries(results.map((r) => [r.uid, r]));
  round.finalized = true; round.finalizedAt = timestamp;
  game.phase = "recap"; game.updatedAt = timestamp;
  return game;
}
