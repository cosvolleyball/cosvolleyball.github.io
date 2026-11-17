/** Verify Teams Manager against an unlinked, disposable local Supabase. */
import assert from "node:assert/strict";
import {execFileSync} from "node:child_process";
import {subscribeToPublicTeams} from "./local_realtime.mjs";
const api=process.env.API_URL, db=process.env.DB_URL;
const anon=process.env.ANON_KEY, svc=process.env.SERVICE_ROLE_KEY;
if(!api||!db||!anon||!svc)throw Error("Missing local Supabase status env");
if(!["127.0.0.1","localhost","::1"].includes(new URL(api).hostname)||
   !["127.0.0.1","localhost","::1"].includes(new URL(db).hostname))
  throw Error("REFUSING any API or SQL against non-local Supabase");
async function req(path,{method="GET",body,token,admin=false}={}){
  const key=admin?svc:anon;
  const response=await fetch(new URL(path,api),{
    method,headers:{apikey:key,Authorization:"Bearer "+(token||key),
      ...(body===undefined?{}:{"Content-Type":"application/json"})},
    ...(body===undefined?{}:{body:JSON.stringify(body)})
  });
  const raw=await response.text();
  let result;try{result=JSON.parse(raw)}catch{result=raw}
  return {ok:response.ok,status:response.status,result};
}
const rpc=(name,params={},token)=>req("/rest/v1/rpc/"+name,{
  method:"POST",body:params,token});
function good(out,label){
  assert(out.ok,label+" failed: HTTP "+out.status+" "+
    JSON.stringify(out.result).slice(0,220));
  return out.result;
}
function denied(out,label){
  assert(!out.ok,label+" unexpectedly succeeded");
  assert(out.status>=400&&out.status<500,
    label+" returned server error "+out.status);
}
async function newUser(name){
  const email=name+"@teams-local.invalid",password="LocalOnly-2026-Testing-919!";
  const result=good(await req("/auth/v1/admin/users",{
    method:"POST",admin:true,body:{email,password,email_confirm:true}
  }),"Create synthetic Auth user");
  const id=result.id||result.user?.id;
  assert.match(id,/^[0-9a-f-]{36}$/i);
  const login=good(await req("/auth/v1/token?grant_type=password",{
    method:"POST",body:{email,password}
  }),"Login local synthetic user");
  return {id,token:login.access_token};
}
function assertSanitized(value){
  const body=JSON.stringify(value);
  for(const bad of ['"email"','"skill"','"gender"','"positions"',
    '"registration_id"','@example.invalid'])
    assert(!body.includes(bad),"Private data in public snapshot: "+bad);
}
const organizer=await newUser("organizer");
const nonOrganizer=await newUser("ordinary");
execFileSync("psql",[db,"-X","-v","ON_ERROR_STOP=1","-c",
  "insert into public.organizers(user_id) values ('"+organizer.id+"')"],{
  stdio:"pipe",timeout:10000
});
denied(await req("/rest/v1/tm_profiles?select=email"),"Anon private profiles");
denied(await req("/rest/v1/tm_sessions?select=*"),"Anon private sessions");
denied(await rpc("tm_org_roster",{
  p_session_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
}),"Anon organizer roster");
denied(await rpc("tm_org_start_session",{
  p_event_id:"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",p_format:4
},nonOrganizer.token),"Non-organizer start session");

// Subscribe anonymously BEFORE the session starts to verify that a
// database trigger actually reaches connected Realtime users.
const realtime=await subscribeToPublicTeams(api,anon);
const firstNotice=realtime.waitFor(p=>p.active===true);
const event="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const session=good(await rpc("tm_org_start_session",{
  p_event_id:event,p_format:4,p_balance_skill:true,
  p_balance_gender:false,p_balance_positions:false
},organizer.token),"Start real local session");
const opened=await firstNotice;
assert.equal(opened.active,true);
assert(Number.isInteger(opened.revision));
assert(opened.revision>=1);
let roster=good(await rpc("tm_org_roster",{
  p_session_id:session
},organizer.token),"Read imported event roster");
assert.equal(roster.length,2);
const alice=roster.find(p=>p.email==="alice-local@example.invalid");
const bob=roster.find(p=>p.email==="bob-local@example.invalid");
assert(alice&&bob);
assert.equal(alice.source_status,"registered");
assert.equal(alice.attendance,"present",
  "Registered players should be INCLUDED without individual check-in");
assert.equal(bob.source_status,"waitlisted");
assert.equal(bob.attendance,"candidate");
assert(!roster.some(p=>p.name==="Canceled Local"));
const prior=good(await req("/rest/v1/registrations?select=id&event_id=eq."+event,{
  token:organizer.token
}),"Read source registration count").length;
good(await rpc("tm_org_set_attendance",{
  p_session_player_id:alice.id,p_attendance:"absent"
},organizer.token),"Mark confirmed no-show");
good(await rpc("tm_org_set_attendance",{
  p_session_player_id:bob.id,p_attendance:"present"
},organizer.token),"Include arriving waitlisted player");
const walkins=[];
for(let i=0;i<15;i++)walkins.push(good(await rpc("tm_org_add_walkin",{
  p_session_id:session,p_name:"Synthetic Walk-in "+i,
  p_email:"synthetic-"+i+"@example.invalid"
},organizer.token),"Add walk-in"));
roster=good(await rpc("tm_org_roster",{p_session_id:session},organizer.token),
  "Review exception-only attendance");
assert.equal(roster.filter(p=>["present","waiting"].includes(p.attendance)).length,16);
assert.equal(roster.find(p=>p.id===alice.id).attendance,"absent");
const after=good(await req("/rest/v1/registrations?select=id&event_id=eq."+event,{
  token:organizer.token
}),"Recheck official registration count").length;
assert.equal(after,prior,"Teams Manager must not change source registrations");
const before=good(await rpc("tm_public_snapshot"),"Public pre-draft state");
assert.equal(before.teams.length,0);
assertSanitized(before);
const available=[bob.id,...walkins].sort();
const teams=Array.from({length:4},(_,i)=>({
  seed:i+1,playerIds:available.slice(i*4,(i+1)*4)
}));
const draft=good(await rpc("tm_org_save_draft",{
  p_session_id:session,p_expected_revision:before.revision,
  p_teams:{playing_format:4,teams}
},organizer.token),"Save private roster");
const privateView=good(await rpc("tm_public_snapshot"),"Unpublished view");
assert.equal(privateView.rotation_id,null);
const published=good(await rpc("tm_org_publish_draft",{
  p_session_id:session,p_expected_revision:privateView.revision
},organizer.token),"Publish rotation");
assert.equal(draft,published);
const snapshot=good(await rpc("tm_public_snapshot"),"Public team roster");
assertSanitized(snapshot);
assert.equal(snapshot.teams.length,4);
const ids=snapshot.teams.flatMap(t=>t.players.map(p=>p.id));
assert(!ids.includes(alice.id),"No-show incorrectly assigned");
assert(ids.includes(bob.id),"Waitlist attendance not respected");
const game=snapshot.games.find(g=>g.round===1&&g.court===1);
good(await rpc("tm_public_start_game",{p_game_id:game.id}),
  "Anonymous game start");
good(await rpc("tm_public_report_winner",{
  p_game_id:game.id,p_winner_team_id:game.team_a_id
}),"Anonymous first winner");
denied(await rpc("tm_public_report_winner",{
  p_game_id:game.id,p_winner_team_id:game.team_b_id
}),"Stale opposing winner");
const lastNotice=realtime.waitFor(p=>p.active===false);
good(await rpc("tm_org_end_session",{p_session_id:session},organizer.token),
  "End isolated session");
const closed=await lastNotice;
assert.equal(closed.active,false);
assert(realtime.received.length>=2,
  "Real database Broadcast must reach anonymous clients on session start/end");
realtime.close();
console.log("PASS local Supabase Auth, RLS, REST, imported COS event roster, no-shows, waitlist, anonymous Realtime Broadcast and game actions");
