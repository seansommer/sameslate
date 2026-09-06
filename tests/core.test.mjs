import test from "node:test";
import assert from "node:assert/strict";

import {
  accountRoleLabel,
  backgroundThemeForRoute,
  calculateTeamStandings,
  answerEditDistance,
  findAnswerMatch,
  getTeamColor,
  getTeamWinners,
  isCloseAnswerMatch,
  isSelectedAnswerIndex,
  rankLifetimeStats,
  sortProfilesByRoleThenName,
  sortGameLeaderboard,
  summarizeGame
} from "../src/core.js";

test("account classifications use player-card display labels", () => {
  assert.equal(accountRoleLabel("player"), "Player");
  assert.equal(accountRoleLabel("host"), "Host");
  assert.equal(accountRoleLabel("master"), "Master");
  assert.equal(accountRoleLabel("admin"), "Master");
  assert.equal(accountRoleLabel("unknown"), "Player");
});

test("lifetime point rankings share places for tied totals", () => {
  const ranked = rankLifetimeStats([
    { uid: "c", displayName: "Casey", totalPoints: 12 },
    { uid: "a", displayName: "Alex", totalPoints: 20 },
    { uid: "b", displayName: "Blair", totalPoints: 20 },
    { uid: "d", displayName: "Drew", totalPoints: 4 }
  ]);
  assert.deepEqual(ranked.map((player) => [player.uid, player.lifetimeRank]), [
    ["a", 1], ["b", 1], ["c", 3], ["d", 4]
  ]);
});

test("background music follows home and active-answer routes", () => {
  assert.equal(backgroundThemeForRoute("#/home", ""), "home");
  assert.equal(backgroundThemeForRoute("#/game/game-1/play", "answering"), "game");
  assert.equal(backgroundThemeForRoute("#/game/game-1/play", "scoring"), null);
  assert.equal(backgroundThemeForRoute("#/host", ""), null);
});

test("user setup sorts master, hosts, and players alphabetically", () => {
  const sorted = sortProfilesByRoleThenName({
    p2: { displayName: "Zoe", role: "player" },
    h2: { displayName: "Maya", role: "host" },
    p1: { displayName: "Alex", role: "player" },
    m1: { displayName: "Sean", role: "master" },
    h1: { displayName: "Ben", role: "host" }
  });
  assert.deepEqual(sorted.map(([uid]) => uid), ["m1", "h1", "h2", "p1", "p2"]);
});

test("an empty answer selection never highlights the first board result", () => {
  assert.equal(isSelectedAnswerIndex(null, 0), false);
  assert.equal(isSelectedAnswerIndex(undefined, 0), false);
  assert.equal(isSelectedAnswerIndex(0, 0), true);
  assert.equal(isSelectedAnswerIndex("2", 2), true);
});

test("answer matching preserves exact matches and their rank", () => {
  const match = findAnswerMatch("how to", "tie a tie", [
    "how to bake bread",
    "how to tie a tie",
    "how to draw"
  ]);
  assert.equal(match.matched, true);
  assert.equal(match.exact, true);
  assert.equal(match.rank, 2);
  assert.equal(match.points, 7);
});

test("answer matching accepts close spelling within about twenty percent", () => {
  const match = findAnswerMatch("how to", "tie a tei", [
    "how to bake bread",
    "how to tie a tie",
    "how to draw"
  ]);
  assert.equal(answerEditDistance("tie a tei", "tie a tie"), 1);
  assert.equal(match.matched, true);
  assert.equal(match.exact, false);
  assert.equal(match.rank, 2);
});

test("answer matching rejects unrelated short words", () => {
  assert.equal(isCloseAnswerMatch("cat", "bat"), false);
  assert.equal(findAnswerMatch("how to", "cat", ["how to bat"]).matched, false);
});

test("most-rounds-won mode ranks and crowns by round wins", () => {
  const game = {
    victoryMode: "rounds",
    players: {
      alpha: { displayName: "Alpha", totalScore: 30, highRoundCount: 1 },
      beta: { displayName: "Beta", totalScore: 18, highRoundCount: 2 }
    }
  };
  assert.equal(sortGameLeaderboard(game)[0].uid, "beta");
  assert.deepEqual(summarizeGame(game).winners.map((player) => player.uid), ["beta"]);
});

test("team standings use the selected victory rule and custom color", () => {
  const game = {
    teamMode: true,
    victoryMode: "rounds",
    teams: { team1: "Comets", team2: "Rockets" },
    teamColors: { team1: "green" },
    players: {
      alpha: { displayName: "Alpha", teamId: "team1", totalScore: 12 },
      beta: { displayName: "Beta", teamId: "team2", totalScore: 20 }
    },
    rounds: {
      1: { finalized: true, results: { alpha: { points: 10 }, beta: { points: 7 } } },
      2: { finalized: true, results: { alpha: { points: 2 }, beta: { points: 3 } } },
      3: { finalized: true, results: { alpha: { points: 0 }, beta: { points: 10 } } }
    }
  };
  const standings = calculateTeamStandings(game);
  assert.equal(standings[0].teamId, "team2");
  assert.equal(standings[0].roundWins, 2);
  assert.equal(getTeamWinners(game).winners[0].teamId, "team2");
  assert.equal(getTeamColor(game, "team1").id, "green");
});
