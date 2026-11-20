import test from "node:test";
import assert from "node:assert/strict";
import { rotationOptions } from "../website/teams/rotation-options.mjs";

const find=(items,t,f)=>items.find(x=>x.teamCount===t&&x.format===f);

test("25 check-ins: organizer can choose 4 teams of 6/7 or 6 teams of 4/5",()=>{
  const list=rotationOptions(25);
  assert.deepEqual(find(list,4,6)?.sizes,[7,6,6,6]);
  assert.deepEqual(find(list,6,4)?.sizes,[5,4,4,4,4,4]);
  assert.deepEqual(find(list,5,5)?.sizes,[5,5,5,5,5]);
  assert(find(list,4,6).summary.includes("team of 7"));
  assert(find(list,6,4).summary.includes("team of 5"));
});
test("private events disallow only 5v5 while keeping team-count flexibility",()=>{
  const list=rotationOptions(25,{privateEvent:true});
  assert(!list.some(x=>x.format===5));
  assert(find(list,4,6));
  assert(find(list,6,4));
});
test("35 players: six-team 6v6 stays available with one team of five",()=>{
  const list=rotationOptions(35);
  const option=find(list,6,6);
  assert(option);
  assert.deepEqual(option.sizes,[6,6,6,6,6,5]);
  assert(option.needsBorrowedSubs);
  assert(option.recommended);
});
test("16-person and 36-person options preserve original formats",()=>{
  assert(find(rotationOptions(16),4,4));
  assert(!find(rotationOptions(15),4,4));
  assert(find(rotationOptions(36),6,6));
});
test("reject invalid attendance counts",()=>{
  assert.throws(()=>rotationOptions(-1),/nonnegative/);
  assert.throws(()=>rotationOptions(25.5),/nonnegative/);
});
