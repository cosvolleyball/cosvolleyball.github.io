/**
 * Event Day Manager — organizer-only team draft generator.
 *
 * PURE MODULE. Never put full profile objects in a public snapshot.
 * This module only returns session-player IDs, not email/skill/gender.
 *
 * Weights are practical heuristics, not promises of perfect team equality.
 * Organizers can regenerate, swap and review before publishing.
 */
import { coveredPositions, normalizedGender, normalizedPosition } from "./profile-options.mjs";

const pairKey = (a, b) => JSON.stringify([a, b].sort());

function pairedRoles(team) {
  // Prefer a specialist on each side of the pair, then fill either role with Flex.
  const flex=team.filter(p=>p.positions?.some(role=>normalizedPosition(role)==="flex"));
  const front=team.filter(p=>p.positions?.some(role=>normalizedPosition(role)==="middle")).concat(flex);
  const back=team.filter(p=>p.positions?.some(role=>
    ["libero","defensive specialist","ds"].includes(normalizedPosition(role)))).concat(flex);
  for(const a of front)for(const b of back)if(a.id!==b.id)return [a,b];
  return null;
}

/** Organizer-only suggestion; the actual on-court players choose when to rotate. */
export function suggestSharedRolePairs(players, draftTeams, format) {
  if(![4,5,6].includes(format))throw new RangeError("Invalid playing format.");
  const lookup=new Map(players.map(p=>[p.id,p]));
  return draftTeams.flatMap(team=>{
    if(team.playerIds.length<=format)return [];
    const pair=pairedRoles(team.playerIds.map(id=>lookup.get(id)).filter(Boolean));
    return pair ? [{seed:team.seed,playerIds:pair.map(p=>p.id)}] : [];
  });
}

export function seededRandom(seed = 1) {
  let state = (Number(seed) >>> 0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 4294967296;
  };
}

function sample(rng, n) {
  const value = rng();
  if (!Number.isFinite(value) || value < 0 || value >= 1) {
    throw new RangeError("Random generator must return a value in [0,1).");
  }
  return Math.floor(value * n);
}

function shuffle(source, rng) {
  const values = [...source];
  for (let i = values.length - 1; i > 0; i--) {
    const j = sample(rng, i + 1);
    [values[i], values[j]] = [values[j], values[i]];
  }
  return values;
}

function variance(numbers) {
  if (numbers.length < 2) return 0;
  const mean = numbers.reduce((sum, number) => sum + number, 0) / numbers.length;
  return numbers.reduce((sum, number) => sum + (number - mean) ** 2, 0) / numbers.length;
}

function avg(values) {
  return values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
}

function scoreTeams(teams, options, pastPairs) {
  const { balanceSkill, balanceGender, balancePositions, teamCount } = options;
  let score = 0;

  if (balanceSkill) {
    const known = teams.map(team =>
      team.map(p => p.skill).filter(value => Number.isInteger(value) && value >= 1 && value <= 10));
    const averages = known.map(values => avg(values)).filter(value => value !== null);
    // Unknown skill is not assigned a fake 0/1/5 value.
    score += variance(averages) * 12;
    // Avoid placing all the unassessed players on one team.
    score += variance(known.map((values, i) => values.length / teams[i].length)) * 3;
  }

  for (const [enabled, getFeatures, weight] of [
    [balanceGender, p => [normalizedGender(p.gender)].filter(Boolean), 5],
    [balancePositions, coveredPositions, 2.5]
  ]) {
    if (!enabled) continue;
    const features = teams.map(team => team.map(getFeatures));
    const labels = new Set(features.flat(2));
    const totalPlayers = teams.reduce((sum, team) => sum + team.length, 0);
    for (const label of labels) {
      const counts = features.map(team => team.filter(roles => roles.includes(label)).length);
      const total = counts.reduce((sum, count) => sum + count, 0);
      counts.forEach((observed, i) => {
        const size = teams[i].length;
        const expected = total * size / totalPlayers;
        score += weight * (observed - expected) ** 2 / size;
      });
    }
  }

  // Prefer not to repeat teammates from earlier rotations of THIS session.
  for (const team of teams) {
    for (let i = 0; i < team.length; i++) {
      for (let j = i + 1; j < team.length; j++) {
        score += 4 * (pastPairs.get(pairKey(team[i].id, team[j].id)) || 0);
      }
    }
  }

  // A seven-player 6v6 roster can share a front-row / back-row role
  // (for example middle blocker + libero). Encourage complementary pairs
  // only when there is an extra teammate to rotate, without requiring one.
  if (balancePositions && options.format===6) {
    for (const team of teams) {
      if (team.length>options.format && pairedRoles(team))score -= 5;
    }
  }

  if (teamCount === 5) {
    // Teams 1, 2, 4 and 5 play opening matches and may earn a third game.
    // Prefer fewer-played participants in these opening positions.
    const openerGames = teams.flatMap((team, i) =>
      i === 2 ? [] : team.map(p => p.regularGames || 0));
    const restingGames = teams[2].map(p => p.regularGames || 0);
    const delta = (avg(openerGames) || 0) - (avg(restingGames) || 0);
    score += 5 * Math.max(0, delta) ** 2;
  }
  return score;
}

function validate(players, options) {
  if (!Array.isArray(players) || ![4,5,6].includes(options.teamCount) ||
      ![4,5,6].includes(options.format)) {
    throw new TypeError("Provide players, 4–6 teams, and a 4v4/5v5/6v6 format.");
  }
  if (players.some(p => !p || typeof p.id !== "string" || !p.id.trim()) ||
      new Set(players.map(p => p.id)).size !== players.length) {
    throw new TypeError("Every available player must have a unique ID.");
  }
  // In 4- and 5-team rotations there is no stable resting teammate to
  // fill the lineup, so every roster must have at least format players.
  // Six-team rotations may borrow from a resting team on the SAME court,
  // with no team roster smaller than four players.
  const minimumPerTeam = options.teamCount === 6 ? 4 : options.format;
  if (players.length < options.teamCount * minimumPerTeam) {
    throw new RangeError("Not enough players for that team count and playing format.");
  }
  if (options.teamCount === 6 &&
      Math.floor(players.length / 6) * 3 < options.format * 2) {
    throw new RangeError("A three-team court group cannot supply a full match.");
  }
  for (const player of players) {
    if (player.skill !== null && player.skill !== undefined &&
        (!Number.isInteger(player.skill) || player.skill < 1 || player.skill > 10)) {
      throw new RangeError("Skill ratings must be 1–10 when provided.");
    }
    if (player.positions !== undefined && player.positions !== null &&
        (!Array.isArray(player.positions) || player.positions.length > 2)) {
      throw new RangeError("Players may have up to two preferred positions.");
    }
    if (player.regularGames !== null && player.regularGames !== undefined &&
        (!Number.isInteger(player.regularGames) || player.regularGames < 0)) {
      throw new RangeError("Regular games must be nonnegative counts.");
    }
  }
}


function historyMap(options) {
  const pairHistory = new Map();
  for (const entry of options.priorTeammates || []) {
    if (!Array.isArray(entry) || entry.length < 2) {
      throw new TypeError("Prior teammate history must contain pairs of IDs.");
    }
    const [a, b, count = 1] = entry;
    if (a === b || !Number.isInteger(count) || count < 0) {
      throw new RangeError("Invalid prior teammate pair.");
    }
    const key = pairKey(a, b);
    pairHistory.set(key, (pairHistory.get(key) || 0) + count);
  }
  return pairHistory;
}

/**
 * Compare a manually edited preview against its generated baseline.
 * Lower scores represent better balance under the selected toggles.
 * Validates the complete assignment before returning a quality score.
 */
export function scoreBalancedDraft(players, draftTeams, options) {
  if (!options || !Array.isArray(draftTeams))
    throw new TypeError("Draft teams and balancing settings are required.");
  validate(players, options);
  if (draftTeams.length !== options.teamCount)
    throw new RangeError("Draft team count does not match settings.");
  const lookup = new Map(players.map(p=>[p.id,p]));
  const seen = new Set();
  const minimum = options.teamCount===6 ? 4 : options.format;
  const ordered = [...draftTeams].sort((a,b)=>a.seed-b.seed);
  if(ordered.some((team,i)=>team.seed!==i+1 ||
      !Array.isArray(team.playerIds) || team.playerIds.length<minimum))
    throw new RangeError("Every team needs a valid seed and playable roster.");
  const teams = ordered.map(team=>team.playerIds.map(id=>{
    if(!lookup.has(id) || seen.has(id))
      throw new RangeError("Draft contains an unknown or duplicate player.");
    seen.add(id);
    return lookup.get(id);
  }));
  if(seen.size!==players.length)
    throw new RangeError("Draft must assign every available player exactly once.");
  const cfg = {
    teamCount:options.teamCount,
    format:options.format,
    balanceSkill:options.balanceSkill!==false,
    balanceGender:options.balanceGender===true,
    balancePositions:options.balancePositions===true&&options.format!==4
  };
  return Number(scoreTeams(teams,cfg,historyMap(options)).toFixed(5));
}

/**
 * @param {Array<{id:string,skill?:number|null,gender?:string|null,positions?:string[],regularGames?:number}>} players
 * @param {{teamCount:4|5|6,format:4|5|6,balanceSkill?:boolean,balanceGender?:boolean,balancePositions?:boolean,
 *          priorTeammates?:Array<[string,string,number?]>,rng?:Function,restarts?:number,swaps?:number}} options
 * @returns {{teams:Array<{seed:number,playerIds:string[]}>,qualityScore:number,appliedOptions:Object}}
 */
export function generateBalancedTeams(players, options) {
  if (!options) throw new TypeError("Team generation options are required.");
  validate(players, options);
  const cfg = {
    teamCount: options.teamCount,
    format: options.format,
    balanceSkill: options.balanceSkill !== false,
    balanceGender: options.balanceGender === true,
    balancePositions: options.balancePositions === true && options.format !== 4
  };
  const rng = options.rng || Math.random;
  const restarts = options.restarts ?? 10;
  const swaps = options.swaps ?? Math.max(120, players.length * 5);
  if (!Number.isInteger(restarts) || restarts < 1 || restarts > 50 ||
      !Number.isInteger(swaps) || swaps < 0 || swaps > 2500) {
    throw new RangeError("Invalid search budget.");
  }

  const pairHistory = historyMap(options);

  // With n players across k teams, rosters differ in size by at most 1.
  const base = Math.floor(players.length / cfg.teamCount);
  const extra = players.length % cfg.teamCount;
  const sizes = Array.from({ length: cfg.teamCount },
    (_, index) => base + (index < extra ? 1 : 0));

  let best = null;
  let bestScore = Infinity;
  for (let restart = 0; restart < restarts; restart++) {
    const order = shuffle(players, rng);
    const teams = [];
    let cursor = 0;
    for (const size of sizes) {
      teams.push(order.slice(cursor, cursor + size));
      cursor += size;
    }
    let currentScore = scoreTeams(teams, cfg, pairHistory);
    for (let step = 0; step < swaps; step++) {
      const firstTeam = sample(rng, cfg.teamCount);
      const secondTeam = (firstTeam + 1 + sample(rng, cfg.teamCount - 1)) % cfg.teamCount;
      const i = sample(rng, teams[firstTeam].length);
      const j = sample(rng, teams[secondTeam].length);
      [teams[firstTeam][i], teams[secondTeam][j]] =
        [teams[secondTeam][j], teams[firstTeam][i]];
      const nextScore = scoreTeams(teams, cfg, pairHistory);
      if (nextScore < currentScore - 1e-8) {
        currentScore = nextScore;
      } else {
        // Never accidentally keep a score-worsening swap.
        [teams[firstTeam][i], teams[secondTeam][j]] =
          [teams[secondTeam][j], teams[firstTeam][i]];
      }
    }
    if (currentScore < bestScore) {
      bestScore = currentScore;
      best = teams.map(team => team.map(p => p.id));
    }
  }
  return {
    teams: best.map((playerIds, index) => ({
      seed: index + 1, playerIds
    })),
    qualityScore: Number(bestScore.toFixed(5)),
    appliedOptions: {
      balanceSkill: cfg.balanceSkill,
      balanceGender: cfg.balanceGender,
      balancePositions: cfg.balancePositions
    }
  };
}
