import test from "node:test";
import assert from "node:assert/strict";
import {
  fourTeamRoundRobin,
  openingGames,
  fiveTeamRotation,
  sixTeamRotation,
  teamGameCounts,
  assertNoConcurrentMatches
} from "../website/teams/scheduling.mjs";

function checkThreeRounds(games) {
  assert.equal(games.length, 6, "two matches per round, three rounds");
  assertNoConcurrentMatches(games);
  for (const round of [1, 2, 3]) {
    assert.deepEqual(
      games.filter(match => match.round === round).map(match => match.court).sort(),
      [1, 2]
    );
  }
}

function uniqueOpponents(games) {
  const pairs = games.map(match => [...match.teams].sort().join("/"));
  assert.equal(new Set(pairs).size, pairs.length, "no unnecessary rematches");
}

test("four teams: every team plays every other team once over three rounds", () => {
  const teams = ["A", "B", "C", "D"];
  const games = fourTeamRoundRobin(teams);
  checkThreeRounds(games);
  uniqueOpponents(games);
  assert.deepEqual([...teamGameCounts(games, teams).values()], [3, 3, 3, 3]);
});

test("six teams: any opening winners still give every team exactly two games", () => {
  const teams = ["A", "B", "C", "D", "E", "F"];
  for (const w1 of ["A", "B"]) {
    for (const w2 of ["D", "E"]) {
      const games = sixTeamRotation(teams, w1, w2);
      checkThreeRounds(games);
      uniqueOpponents(games);
      assert.deepEqual([...teamGameCounts(games, teams).values()], [2, 2, 2, 2, 2, 2]);
      // Court membership is fixed for six-team sessions.
      for (const match of games) {
        assert(match.teams.every(id => match.court === 1 ? ["A","B","C"].includes(id) : ["D","E","F"].includes(id)));
      }
    }
  }
});

test("five teams: opening winners earn three games, all others play two", () => {
  const teams = ["A", "B", "E", "C", "D"];
  for (const w1 of ["A", "B"]) {
    for (const w2 of ["C", "D"]) {
      const games = fiveTeamRotation(teams, w1, w2);
      checkThreeRounds(games);
      uniqueOpponents(games);
      const counts = teamGameCounts(games, teams);
      for (const team of teams) {
        assert.equal(counts.get(team), team === w1 || team === w2 ? 3 : 2);
      }
    }
  }
});

test("invalid input cannot create duplicate teams, wrong winners or self-games", () => {
  assert.throws(() => fourTeamRoundRobin(["A", "B", "C", "C"]), /unique/);
  assert.throws(() => fiveTeamRotation(["A", "B", "E", "C", "D"], "C", "D"), /winner/);
  assert.throws(() => sixTeamRotation(["A", "B", "C", "D", "E", "F"], "A", "F"), /winner/);
  assert.throws(() => openingGames(["A", "B", "C", "D"]), /five or six/);
});

test("concurrent game checker rejects assigning the same team twice in a round", () => {
  assert.throws(
    () => assertNoConcurrentMatches([
      { round: 1, court: 1, teams: ["A", "B"] },
      { round: 1, court: 2, teams: ["A", "C"] }
    ]),
    /Team double-booked/
  );
});
