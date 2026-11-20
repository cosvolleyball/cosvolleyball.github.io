/**
 * Event Day Manager — deterministic court-rotation primitives.
 *
 * These functions do not read Supabase or modify an active session.
 * Team generation, player balancing, substitution eligibility and match
 * state transitions are separate concerns, validated server-side.
 *
 * A "round" here is a simultaneous set of games on Court 1 and Court 2.
 * A "rotation" is the complete three-round block before team reshuffling.
 */

function assertTeams(teams, expected) {
  if (!Array.isArray(teams) || teams.length !== expected) {
    throw new RangeError(`Expected exactly ${expected} team identifiers.`);
  }
  if (teams.some(team => typeof team !== "string" || !team.trim()) ||
      new Set(teams).size !== teams.length) {
    throw new TypeError("Team identifiers must be nonempty and unique.");
  }
}

function game(round, court, first, second) {
  if (first === second) throw new Error("A team cannot play itself.");
  return { round, court, teams: [first, second] };
}

function openingWinner(match, winner) {
  if (!match.teams.includes(winner)) {
    throw new RangeError("The winner must be one of the opening-match teams.");
  }
  return {
    winner,
    loser: match.teams.find(team => team !== winner)
  };
}

/**
 * Four teams: three rounds, two courts, all six unique pairings.
 * Every team plays three games. This format has no resting team to loan subs.
 */
export function fourTeamRoundRobin(teams) {
  assertTeams(teams, 4);
  const [a, b, c, d] = teams;
  return [
    game(1, 1, a, b), game(1, 2, c, d),
    game(2, 1, a, c), game(2, 2, b, d),
    game(3, 1, a, d), game(3, 2, b, c)
  ];
}

/**
 * Opening two games for five and six teams.
 * Each opening-match winner is needed before later matchups can be finalized.
 */
export function openingGames(teams) {
  if (!Array.isArray(teams) || ![5, 6].includes(teams.length)) {
    throw new RangeError("Opening games require five or six teams.");
  }
  assertTeams(teams, teams.length);
  return [
    game(1, 1, teams[0], teams[1]),
    game(1, 2, teams[3], teams[4])
  ];
}

/**
 * Six teams: two independent three-team courts.
 *
 * Court 1: first pair -> winner vs third -> loser vs third
 * Court 2: fourth/fifth -> winner vs sixth -> loser vs sixth.
 *
 * Each team plays twice, regardless of results.
 */
export function sixTeamRotation(teams, court1Winner, court2Winner) {
  assertTeams(teams, 6);
  const opening = openingGames(teams);
  const c1 = openingWinner(opening[0], court1Winner);
  const c2 = openingWinner(opening[1], court2Winner);
  return [
    ...opening,
    game(2, 1, c1.winner, teams[2]),
    game(2, 2, c2.winner, teams[5]),
    game(3, 1, c1.loser, teams[2]),
    game(3, 2, c2.loser, teams[5])
  ];
}

/**
 * Five teams: opening-match winners each earn a third game.
 * The other three teams play twice.
 *
 * IMPORTANT: Unlike six-team rotation, some teams change courts and
 * downstream games may depend on results from the other court. A court
 * must not start a dependent game before BOTH teams are available.
 * The public UI may show "Waiting for other court" in this format.
 *
 * Only one team is resting during each round. Same-court substitute
 * availability therefore cannot be guaranteed on both courts.
 */
export function fiveTeamRotation(teams, court1Winner, court2Winner) {
  assertTeams(teams, 5);
  const opening = openingGames(teams);
  const c1 = openingWinner(opening[0], court1Winner);
  const c2 = openingWinner(opening[1], court2Winner);
  const fifth = teams[2];
  return [
    ...opening,
    game(2, 1, c1.winner, fifth),
    game(2, 2, c2.winner, c1.loser),
    game(3, 1, c1.winner, c2.loser),
    game(3, 2, c2.winner, fifth)
  ];
}

/** Individual team appearances; substitute appearances are not inferred here. */
export function teamGameCounts(games, teams) {
  const counts = new Map(teams.map(team => [team, 0]));
  for (const match of games) {
    for (const team of match.teams) {
      if (!counts.has(team)) throw new Error("Game references an unknown team.");
      counts.set(team, counts.get(team) + 1);
    }
  }
  return counts;
}

/** Throws if any team is double-booked within a simultaneous round. */
export function assertNoConcurrentMatches(games) {
  for (const round of new Set(games.map(match => match.round))) {
    const scheduled = new Set();
    const courts = new Set();
    for (const match of games.filter(item => item.round === round)) {
      if (courts.has(match.court)) throw new Error("Court double-booked.");
      courts.add(match.court);
      for (const team of match.teams) {
        if (scheduled.has(team)) throw new Error("Team double-booked.");
        scheduled.add(team);
      }
    }
  }
  return true;
}
