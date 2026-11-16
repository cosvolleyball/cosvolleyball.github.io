import test from "node:test";
import assert from "node:assert/strict";
import {generateBalancedTeams, seededRandom} from "../website/teams/balancing.mjs";

function players(count, make = () => ({})) {
  return Array.from({length: count}, (_, i) => ({
    id: "player-" + String(i).padStart(2, "0"),
    email: "private" + i + "@example.com",
    name: "Private player " + i,
    ...make(i)
  }));
}
function build(roster, overrides = {}) {
  return generateBalancedTeams(roster, {
    teamCount: 6, format: 6, balanceSkill: true,
    rng: seededRandom(12345), restarts: 10, swaps: 180,
    ...overrides
  });
}
function assertRoster(draft, roster, expectedTeamSizes) {
  assert.deepEqual(draft.teams.map(team => team.playerIds.length),expectedTeamSizes);
  const ids = draft.teams.flatMap(team => team.playerIds);
  assert.equal(ids.length, roster.length);
  assert.equal(new Set(ids).size, roster.length, "no duplicate assignments");
  assert.deepEqual([...ids].sort(),roster.map(p => p.id).sort());
  assert(!JSON.stringify(draft).includes("@example.com"),"no private email in draft result");
  assert(!JSON.stringify(draft).includes("Private player "),"no private names in draft result");
}
const averageSkill = (team, lookup) =>
  team.playerIds.reduce((sum,id) => sum + lookup.get(id).skill,0) /
  team.playerIds.length;

test("36 players: six unique equal rosters and stable seeded preview", () => {
  const roster = players(36, i => ({skill: i % 10 + 1}));
  const one = build(roster);
  const two = build(roster);
  assertRoster(one, roster, [6,6,6,6,6,6]);
  assert.deepEqual(one,two);
});

test("35 players: distribute everyone into rosters of six or five", () => {
  const roster = players(35);
  assertRoster(build(roster),roster,[6,6,6,6,6,5]);
});

test("25–28 players: six teams of four or five for private 4v4", () => {
  for(let count=25;count<=28;count++){
    const roster=players(count,i=>({positions: i%2?["setter"]:["middle"]}));
    const draft=build(roster,{
      format:4,balancePositions:true,balanceSkill:false
    });
    const base=Math.floor(count/6);
    const expected=Array.from({length:6},(_,i)=>base+(i<count%6?1:0));
    assertRoster(draft,roster,expected);
    assert.equal(draft.appliedOptions.balancePositions,false);
  }
});

test("known skill ratings 1–10 are distributed across teams", () => {
  const roster=players(24,i=>({skill:i<12?1:10}));
  const draft=build(roster,{teamCount:4,format:6});
  assertRoster(draft,roster,[6,6,6,6]);
  const lookup=new Map(roster.map(p=>[p.id,p]));
  const averages=draft.teams.map(team=>averageSkill(team,lookup));
  assert(Math.max(...averages)-Math.min(...averages)<=1.5,
    "Skill balance too uneven: " + averages);
});

test("gender is optional and is not assumed for players with missing data", () => {
  const roster=players(36,i=>({
    gender:i<12?"male":i<24?"female":null,
    skill:null
  }));
  const draft=build(roster,{balanceGender:true});
  assertRoster(draft,roster,[6,6,6,6,6,6]);
  const lookup=new Map(roster.map(p=>[p.id,p]));
  const genders=draft.teams.map(team=>team.playerIds.map(id=>lookup.get(id).gender));
  const counts=genders.map(gs=>gs.filter(g=>g==="female").length);
  assert(Math.max(...counts)-Math.min(...counts)<=1,
    "Gender balance too uneven: " + counts);
});

test("position balancing respects up to two preferences per player", () => {
  const roster=players(24,i=>({positions: i<12?["setter","outside"]:["middle"]}));
  const draft=build(roster,{teamCount:4,format:6,balancePositions:true});
  assertRoster(draft,roster,[6,6,6,6]);
  const lookup=new Map(roster.map(p=>[p.id,p]));
  const setters=draft.teams.map(team=>team.playerIds
    .filter(id=>lookup.get(id).positions.includes("setter")).length);
  assert(Math.max(...setters)-Math.min(...setters)<=1,
    "Too many setters on one team: " + setters);
});

test("prior teammate history discourages repeat pairings", () => {
  const roster=players(24);
  const pairs=Array.from({length:12},(_,i)=>
    [roster[i*2].id,roster[i*2+1].id,3]);
  const draft=build(roster,{teamCount:4,format:6,priorTeammates:pairs});
  assertRoster(draft,roster,[6,6,6,6]);
  const repeated=pairs.filter(([a,b])=>draft.teams.some(team=>
    team.playerIds.includes(a)&&team.playerIds.includes(b)));
  assert(repeated.length<=1,"Repeated " + repeated.length + " known pairs");
});

test("five teams: higher regular-game counts get favored for resting fifth slot", () => {
  const roster=players(25,i=>({regularGames:i<10?0:4}));
  const draft=build(roster,{teamCount:5,format:5,balanceSkill:false});
  assertRoster(draft,roster,[5,5,5,5,5]);
  const lookup=new Map(roster.map(p=>[p.id,p]));
  const games=team=>team.playerIds.map(id=>lookup.get(id).regularGames);
  const resting=games(draft.teams[2]);
  const opening=draft.teams.flatMap((team,i)=>i===2?[]:games(team));
  const avg=values=>values.reduce((a,b)=>a+b,0)/values.length;
  assert(avg(resting)>=avg(opening),
    "Resting group should favor players with more games");
});

test("4v4 disables position scoring even if enabled in incoming settings", () => {
  const roster=players(24,i=>({positions:i%2?["middle"]:["setter"]}));
  const a=build(roster,{teamCount:6,format:4,balanceSkill:false,balancePositions:true});
  const b=build(roster,{teamCount:6,format:4,balanceSkill:false,balancePositions:false});
  assert.deepEqual(a,b);
});

test("refuse insufficient attendance, duplicate IDs, invalid skill, bad RNG, and invalid history", () => {
  assert.throws(()=>build(players(19),{teamCount:5,format:4}),/Not enough/);
  assert.throws(()=>build(players(23),{teamCount:6,format:6}),/Not enough/);
  assert.throws(()=>build(players(24,i=>({skill:i===2?11:6}))),/Skill ratings/);
  const repeated=players(24);repeated[1].id=repeated[0].id;
  assert.throws(()=>build(repeated),/unique ID/);
  assert.throws(()=>build(players(24),{rng:()=>1}),/Random generator/);
  assert.throws(()=>build(players(24),{priorTeammates:[["a","a",1]]}),/Invalid prior/);
  assert.throws(()=>build(players(24,i=>({positions:i===4?["a","b","c"]:[]}))),
    /two preferred/);
});
