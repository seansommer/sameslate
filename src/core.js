import { calculateSlateResults } from "./slate-core.js";
import { completionKey } from "./services/suggestion-quality.js";
import { APP_CONFIG } from "./config.js";

export const GAME_PHASES = Object.freeze({
  LOBBY: "lobby",
  WAITING: "waiting",
  ANSWERING: "answering",
  SCORING: "scoring",
  RECAP: "recap",
  FINISHED: "finished"
});

export const VICTORY_MODES = Object.freeze({
  POINTS: "points",
  ROUNDS: "rounds"
});

export const TEAM_COLOR_PALETTE = Object.freeze([
  { id: "cyan", label: "Electric Cyan", value: "#20d7f0" },
  { id: "coral", label: "Showtime Coral", value: "#ff5d8f" },
  { id: "gold", label: "Trophy Gold", value: "#ffcb48" },
  { id: "violet", label: "Spotlight Violet", value: "#8d66ff" },
  { id: "green", label: "Victory Green", value: "#39dda0" },
  { id: "blue", label: "Stage Blue", value: "#4c8dff" },
  { id: "pink", label: "Party Pink", value: "#ff82dc" },
  { id: "orange", label: "Buzzer Orange", value: "#ff8b45" }
]);

export function backgroundThemeForRoute(hash = "", gamePhase = "") {
  const route = String(hash).replace(/^#/, "").split("?")[0].replace(/\/+$/, "");
  if (!route || route === "/home") return "home";
  if (route.startsWith("/game/") && gamePhase === GAME_PHASES.ANSWERING) return "game";
  return null;
}

export function getVictoryMode(game) {
  return game?.victoryMode === VICTORY_MODES.ROUNDS
    ? VICTORY_MODES.ROUNDS
    : VICTORY_MODES.POINTS;
}

export function victoryModeLabel(game) {
  return getVictoryMode(game) === VICTORY_MODES.ROUNDS ? "Most Rounds Won" : "Total Points";
}

export function getTeamColor(game, teamId, fallbackPosition = 0) {
  const selectedId = game?.teamColors?.[teamId];
  return TEAM_COLOR_PALETTE.find((color) => color.id === selectedId)
    || TEAM_COLOR_PALETTE[fallbackPosition % TEAM_COLOR_PALETTE.length];
}

export function normalizeText(value = "") {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9' ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeEmail(value = "") {
  return String(value).trim().toLowerCase();
}

export function normalizeNickname(value = "") {
  return String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]/g, "");
}

export function sortProfilesByRoleThenName(profiles = {}) {
  const rolePriority = { master: 0, admin: 0, host: 1, player: 2 };
  return Object.entries(profiles).sort(([uidA, profileA], [uidB, profileB]) => {
    const priorityA = rolePriority[profileA?.role] ?? 3;
    const priorityB = rolePriority[profileB?.role] ?? 3;
    if (priorityA !== priorityB) return priorityA - priorityB;
    const nameOrder = String(profileA?.displayName || "").localeCompare(
      String(profileB?.displayName || ""),
      undefined,
      { sensitivity: "base", numeric: true }
    );
    return nameOrder || uidA.localeCompare(uidB);
  });
}

export function rankLifetimeStats(stats = []) {
  let previousPoints = null;
  let previousRank = 0;
  return [...stats]
    .sort((a, b) => Number(b.totalPoints || 0) - Number(a.totalPoints || 0)
      || String(a.displayName || "").localeCompare(String(b.displayName || ""), undefined, { sensitivity: "base", numeric: true }))
    .map((player, index) => {
      const points = Number(player.totalPoints || 0);
      const lifetimeRank = previousPoints === points ? previousRank : index + 1;
      previousPoints = points;
      previousRank = lifetimeRank;
      return { ...player, lifetimeRank };
    });
}

export function isSelectedAnswerIndex(selectedIndex, answerIndex) {
  return selectedIndex !== null
    && selectedIndex !== undefined
    && Number.isInteger(Number(selectedIndex))
    && Number(selectedIndex) === answerIndex;
}

export function answerSuffix(query, suggestion) {
  const cleanQuery = normalizeText(query);
  const cleanSuggestion = normalizeText(suggestion);
  return cleanSuggestion.startsWith(cleanQuery)
    ? cleanSuggestion.slice(cleanQuery.length).trim()
    : cleanSuggestion;
}

export function answerEditDistance(left = "", right = "") {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;

  let previousPrevious = null;
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let row = 1; row <= a.length; row += 1) {
    const current = [row];
    for (let column = 1; column <= b.length; column += 1) {
      current[column] = Math.min(
        current[column - 1] + 1,
        previous[column] + 1,
        previous[column - 1] + (a[row - 1] === b[column - 1] ? 0 : 1)
      );
      if (
        previousPrevious
        && row > 1
        && column > 1
        && a[row - 1] === b[column - 2]
        && a[row - 2] === b[column - 1]
      ) {
        current[column] = Math.min(current[column], previousPrevious[column - 2] + 1);
      }
    }
    previousPrevious = previous;
    previous = current;
  }
  return previous[b.length];
}

export function answerSimilarity(left = "", right = "") {
  const a = normalizeText(left);
  const b = normalizeText(right);
  const longest = Math.max(a.length, b.length);
  if (!longest) return 1;
  return Math.max(0, 1 - answerEditDistance(a, b) / longest);
}

export function isCloseAnswerMatch(left = "", right = "", tolerance = 0.2) {
  const a = normalizeText(left);
  const b = normalizeText(right);
  if (!a || !b) return false;
  if (a === b) return true;

  const longest = Math.max(a.length, b.length);
  const shortest = Math.min(a.length, b.length);
  // Very short words become unrelated answers after a single letter change.
  if (shortest < 4) return false;
  const allowedEdits = Math.max(1, Math.floor(longest * tolerance));
  return answerEditDistance(a, b) <= allowedEdits;
}

export function findAnswerMatch(query, answer, suggestions = []) {
  const normalizedAnswer = normalizeText(answer);
  const fullAnswer = normalizeText(`${query} ${answer}`);
  let best = null;

  suggestions.forEach((suggestion, index) => {
    const normalizedSuggestion = normalizeText(suggestion);
    const suffix = answerSuffix(query, suggestion);
    const exact = normalizedSuggestion === fullAnswer || suffix === normalizedAnswer
      || (Boolean(normalizedAnswer) && completionKey(suffix) === completionKey(normalizedAnswer));
    // Fuzzy scoring compares only the player's completion with the answer
    // suffix. Including the shared prompt would make unrelated short answers
    // look artificially similar (for example, "how to cat" / "how to bat").
    const close = exact || isCloseAnswerMatch(normalizedAnswer, suffix);
    if (!close) return;

    const similarity = exact ? 1 : answerSimilarity(normalizedAnswer, suffix);
    if (!best || exact && !best.exact || exact === best.exact && similarity > best.similarity) {
      best = { index, exact, similarity };
    }
  });

  if (!best) {
    return { matched: false, exact: false, similarity: 0, rank: null, points: 0, suggestion: null };
  }

  return {
    matched: true,
    exact: best.exact,
    similarity: best.similarity,
    rank: best.index + 1,
    points: APP_CONFIG.scoreByRank[best.index] ?? 0,
    suggestion: suggestions[best.index]
  };
}

export function safeKey(value = "") {
  return normalizeText(value).replace(/\s/g, "-").slice(0, 80);
}

export function makeGameCode(length = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => alphabet[byte % alphabet.length]).join("");
}

export function makeHostNumber(uid = "") {
  let hash = 2166136261;
  for (const char of uid) {
    hash ^= char.charCodeAt(0);
    hash = Math.imul(hash, 16777619);
  }
  return `H-${String(Math.abs(hash) % 100000).padStart(5, "0")}`;
}

export function sortLeaderboard(players = {}) {
  return Object.entries(players)
    .map(([uid, player]) => ({ uid, ...player }))
    .sort(
      (a, b) =>
        (b.totalScore || 0) - (a.totalScore || 0) ||
        (b.highRoundCount || 0) - (a.highRoundCount || 0) ||
        (a.displayName || "").localeCompare(b.displayName || "")
    );
}

export function sortGameLeaderboard(game) {
  const mode = getVictoryMode(game);
  return Object.entries(game?.players || {})
    .map(([uid, player]) => ({ uid, ...player }))
    .sort((a, b) => {
      if (mode === VICTORY_MODES.ROUNDS) {
        return (b.highRoundCount || 0) - (a.highRoundCount || 0)
          || (b.totalScore || 0) - (a.totalScore || 0)
          || (a.displayName || "").localeCompare(b.displayName || "");
      }
      return (b.totalScore || 0) - (a.totalScore || 0)
        || (b.highRoundCount || 0) - (a.highRoundCount || 0)
        || (a.displayName || "").localeCompare(b.displayName || "");
    });
}

export function getRound(game, roundNumber = game?.currentRound) {
  return game?.rounds?.[roundNumber] || null;
}

export function lockedPlayerIds(game) {
  return Object.entries(game?.players || {})
    .filter(([, player]) => player.locked !== false)
    .map(([uid]) => uid);
}

export function allPlayersSubmitted(game) {
  const ids = lockedPlayerIds(game);
  const answers = getRound(game)?.answers || {};
  return ids.length > 0 && ids.every((uid) => answers[uid]?.locked);
}

export function allScoresConfirmed(game) {
  const ids = lockedPlayerIds(game);
  const claims = getRound(game)?.scoreClaims || {};
  return ids.length > 0 && ids.every((uid) => Number.isFinite(Number(claims[uid]?.points)));
}

export function allPlayersReady(game, nextRound = (game?.currentRound || 0) + 1) {
  const ids = lockedPlayerIds(game);
  const ready = game?.ready?.[nextRound] || {};
  return ids.length > 0 && ids.every((uid) => ready[uid] === true);
}

export function allPlayersAssignedToTeams(game) {
  if (!game?.teamMode) return true;
  const teamIds = new Set(Object.keys(game.teams || {}));
  const players = Object.values(game.players || {});
  return players.length > 0 && players.every((player) => teamIds.has(player.teamId));
}

export function calculateTeamStandings(game, roundNumber = null) {
  if (!game?.teamMode) return [];
  const roundResults = roundNumber == null ? null : game.rounds?.[roundNumber]?.results || {};
  const teams = Object.entries(game.teams || {})
    .map(([teamId, name], position) => {
      const members = Object.entries(game.players || {})
        .filter(([, player]) => player.teamId === teamId)
        .map(([uid, player]) => ({ uid, ...player }));
      const totalScore = members.reduce((sum, player) => sum + Number(player.totalScore || 0), 0);
      const roundScore = roundResults
        ? members.reduce((sum, player) => sum + Number(roundResults[player.uid]?.points || 0), 0)
        : 0;
      const color = getTeamColor(game, teamId, position);
      return {
        teamId,
        name,
        position,
        members,
        memberCount: members.length,
        totalScore,
        roundScore,
        roundWins: 0,
        colorId: color.id,
        colorValue: color.value
      };
    })
  ;

  for (const round of Object.values(game.rounds || {})) {
    if (!round?.finalized) continue;
    const scores = teams.map((team) => ({
      team,
      points: team.members.reduce(
        (sum, player) => sum + Number(round.results?.[player.uid]?.points || 0),
        0
      )
    }));
    const highest = Math.max(0, ...scores.map(({ points }) => points));
    if (highest > 0) {
      scores
        .filter(({ team, points }) => team.memberCount > 0 && points === highest)
        .forEach(({ team }) => { team.roundWins += 1; });
    }
  }

  return teams.sort((a, b) => {
    if (roundNumber != null) {
      return Number(b.roundScore || 0) - Number(a.roundScore || 0) || a.position - b.position;
    }
    if (getVictoryMode(game) === VICTORY_MODES.ROUNDS) {
      return Number(b.roundWins || 0) - Number(a.roundWins || 0)
        || Number(b.totalScore || 0) - Number(a.totalScore || 0)
        || a.position - b.position;
    }
    return Number(b.totalScore || 0) - Number(a.totalScore || 0)
      || Number(b.roundWins || 0) - Number(a.roundWins || 0)
      || a.position - b.position;
  });
}

export function getTeamWinners(game) {
  const standings = calculateTeamStandings(game);
  const eligibleTeams = standings.filter((team) => team.memberCount > 0);
  const mode = getVictoryMode(game);
  const metric = mode === VICTORY_MODES.ROUNDS ? "roundWins" : "totalScore";
  const highestScore = Math.max(0, ...eligibleTeams.map((team) => Number(team[metric] || 0)));
  return {
    highestScore,
    metric,
    victoryMode: mode,
    standings,
    winners: eligibleTeams.length
      ? eligibleTeams.filter((team) => Number(team[metric] || 0) === highestScore)
      : []
  };
}

export function calculateRoundResults(game, roundNumber = game?.currentRound) {
  if (game?.gameKind === "sameSlate" || game?.suggestionMode === "matching") return calculateSlateResults(game, roundNumber);
  const round = getRound(game, roundNumber);
  if (!round) return [];
  return lockedPlayerIds(game).map((uid) => {
    const player = game.players[uid];
    const answer = round.answers?.[uid]?.text || "";
    const suggested = findAnswerMatch(round.query, answer, round.suggestions);
    const claim = round.scoreClaims?.[uid];
    const selectedIndex = Number(claim?.selectedAnswerIndex);
    const referenced = Number.isInteger(selectedIndex)
      && selectedIndex >= 0
      && selectedIndex < (round.suggestions || []).length
      ? {
          matched: true,
          manual: true,
          rank: selectedIndex + 1,
          points: APP_CONFIG.scoreByRank[selectedIndex] ?? 0,
          suggestion: round.suggestions[selectedIndex]
        }
      : suggested;
    return {
      uid,
      displayName: player.displayName,
      answer,
      suggestedPoints: suggested.points,
      points: Number(claim?.points ?? suggested.points),
      match: referenced,
      confirmed: claim != null
    };
  });
}

export function summarizeGame(game) {
  const victoryMode = getVictoryMode(game);
  const metric = victoryMode === VICTORY_MODES.ROUNDS ? "highRoundCount" : "totalScore";
  const leaderboard = sortGameLeaderboard(game);
  const winningMetric = Number(leaderboard[0]?.[metric] || 0);
  return {
    leaderboard,
    victoryMode,
    metric,
    winningMetric,
    winners: leaderboard.filter((player) => Number(player[metric] || 0) === winningMetric),
    roundsPlayed: Object.values(game?.rounds || {}).filter((round) => round.finalized).length
  };
}

export function buildPlayerGameSummary(game, playerUid) {
  const rounds = Object.entries(game?.rounds || {})
    .filter(([, round]) => round?.finalized && round?.results?.[playerUid])
    .sort(([a], [b]) => Number(a) - Number(b));
  let points = 0;
  let roundsWon = 0;
  let winPattern = "";
  for (const [, round] of rounds) {
    const results = Object.values(round.results || {});
    const highest = Math.max(0, ...results.map((result) => Number(result.points || 0)));
    const playerPoints = Number(round.results[playerUid]?.points || 0);
    const won = highest > 0 && playerPoints === highest;
    points += playerPoints;
    roundsWon += won ? 1 : 0;
    winPattern += won ? "1" : "0";
  }
  return {
    points,
    roundsPlayed: rounds.length,
    roundsWon,
    winPattern,
    finishedAt: Number(game?.finishedAt || game?.updatedAt || game?.createdAt || now()),
    gameNumber: Number(game?.gameNumber || 0)
  };
}

export function aggregateLifetimeStats(gameSummaries = {}) {
  const ordered = Object.entries(gameSummaries).sort(
    ([, a], [, b]) => Number(a.finishedAt || 0) - Number(b.finishedAt || 0)
      || Number(a.gameNumber || 0) - Number(b.gameNumber || 0)
  );
  let totalPoints = 0;
  let roundsPlayed = 0;
  let roundsWon = 0;
  let bestGameScore = 0;
  let bestGameId = "";
  let bestGameNumber = 0;
  let currentRoundWinStreak = 0;
  let bestRoundWinStreak = 0;
  let lastPlayedAt = 0;

  for (const [gameId, summary] of ordered) {
    const gamePoints = Number(summary.points || 0);
    totalPoints += gamePoints;
    roundsPlayed += Number(summary.roundsPlayed || 0);
    roundsWon += Number(summary.roundsWon || 0);
    if (gamePoints >= bestGameScore) {
      bestGameScore = gamePoints;
      bestGameId = gameId;
      bestGameNumber = Number(summary.gameNumber || 0);
    }
    for (const result of String(summary.winPattern || "")) {
      currentRoundWinStreak = result === "1" ? currentRoundWinStreak + 1 : 0;
      bestRoundWinStreak = Math.max(bestRoundWinStreak, currentRoundWinStreak);
    }
    lastPlayedAt = Math.max(lastPlayedAt, Number(summary.finishedAt || 0));
  }

  return {
    totalPoints,
    gamesPlayed: ordered.length,
    roundsPlayed,
    roundsWon,
    averagePointsPerRound: roundsPlayed ? Number((totalPoints / roundsPlayed).toFixed(4)) : 0,
    bestGameScore,
    bestGameId,
    bestGameNumber,
    currentRoundWinStreak,
    bestRoundWinStreak,
    lastPlayedAt
  };
}

export function formatGameNumber(game) {
  return game?.gameNumber ? `Game #${game.gameNumber}` : `Game ${game?.code || ""}`;
}

export function formatDate(value) {
  if (!value) return "—";
  const date = typeof value === "number" ? new Date(value) : new Date(String(value));
  return Number.isNaN(date.getTime())
    ? "—"
    : new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function accountRoleLabel(role = "player") {
  if (["master", "admin"].includes(role)) return "Master";
  if (role === "host") return "Host";
  return "Player";
}

export function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, Number(value)));
}

export function now() {
  return Date.now();
}
