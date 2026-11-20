import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {JSDOM} from "jsdom";

const root=path.resolve(import.meta.dirname,"../website/teams");
const page=fs.readFileSync(path.join(root,"index.html"),"utf8");
const app=fs.readFileSync(path.join(root,"teams.mjs"),"utf8")
  .replace(/^import [^\n]*;\n/gm,"");
const optionsCode=fs.readFileSync(path.join(root,"rotation-options.mjs"),"utf8")
  .replace("export function rotationOptions","function rotationOptions");
const profileCode=fs.readFileSync(path.join(root,"profile-options.mjs"),"utf8").replace(/^export /gm,"");

async function boot({initialSnapshot,organizer=false,organizerRoster=[],
  lineupByGame={},organizerAppearances={},transferHistory=[],
  staging=true,rpcOverride=null}={}){
  const dom=new JSDOM(page,{
    url:"https://test.local/teams/",
    runScripts:"outside-only",
    pretendToBeVisual:true
  });
  const calls=[];
  dom.window.confirm=()=>true;
  if(staging)dom.window.TEAMS_MANAGER_STAGING_CONFIG={
    url:"https://staging.example.supabase.co",publishableKey:"sb_publishable_test_only"
  };
  let snapshot=initialSnapshot||{active:false};
  let signedIn=organizer,allowed=organizer,authCallback=null;
  let broadcastListener=null;
  let subscribed=false;
  const channel={
    on(type,selector,callback){
      if(type==="broadcast"&&selector?.event==="changed")
        broadcastListener=callback;
      return this;
    },
    subscribe(callback){
      subscribed=true;
      callback?.("SUBSCRIBED");
      return this;
    }
  };
  dom.window.__fakeClient={
    channel(name,options){
      calls.push({name:"__subscribe",topic:name,options});
      return channel;
    },
    removeChannel:async()=>{},
    auth:{
      getUser:async()=>({data:{user:signedIn?{id:"organizer-id"}:null}}),
      onAuthStateChange(callback){authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};}
    },
    from(table){
      return {
        select:()=>({
          eq:()=>({
            maybeSingle:async()=>({data:table==="organizers"&&allowed?{user_id:"organizer-id"}:null}),
            order:async()=>({data:table==="events"?[{
              id:"a-event",title:"Example session",status:"published",
              starts_at:"2026-11-16T22:00:00Z",visibility:"public"
            }]:[]})
          })
        })
      };
    },
    rpc:async(name,args)=>{
      calls.push({name,args});
      if(rpcOverride){const result=await rpcOverride(name,args);if(result!==undefined)return result;}
      if(name==="tm_public_snapshot")return {data:snapshot,error:null};
      if(name==="tm_public_transfer_options")return {data:snapshot.eligibleTransfers || [],error:null};
      if(name==="tm_org_save_profile"){
        const player=organizerRoster.find(p=>p.email===args.p_email);
        if(player)Object.assign(player,{skill:args.p_skill,gender:args.p_gender,positions:args.p_positions});
        return {data:"profile",error:null};
      }
      if(name==="tm_org_set_attendance"){
        const player=organizerRoster.find(p=>p.id===args?.p_session_player_id);
        if(player)player.attendance=args.p_attendance;
        snapshot={...snapshot,revision:(snapshot.revision||0)+1};
        return {data:null,error:null};
      }
      if(name==="tm_org_roster")return {data:organizerRoster,error:null};
      if(name==="tm_public_game_lineup")
        return {data:lineupByGame[args?.p_game_id]||[],error:null};
      if(name==="tm_org_game_appearances")
        return {data:organizerAppearances[args?.p_game_id]||[],error:null};
      if(name==="tm_org_transfers")return {data:transferHistory,error:null};
      if(name==="tm_org_stats")return {data:[],error:null};
      return {data:null,error:null};
    }
  };
  const errs=[];
  dom.window.addEventListener("error",e=>errs.push(e.message));
  dom.window.eval("const createClient=()=>window.__fakeClient;\n"+
    "const generateBalancedTeams=()=>({teams:[],qualityScore:0});\n"+
    "const scoreBalancedDraft=()=>0;\n"+
    "const suggestSharedRolePairs=()=>[];\n"+
    profileCode+"\n"+optionsCode+"\n"+app+"\nwindow.__tm={refresh};");
  await new Promise(resolve=>setTimeout(resolve,40));
  return {
    dom,calls,errs,
    setSnapshot(value){snapshot=value;},
    signOut(){signedIn=false;authCallback?.("SIGNED_OUT",null);},
    revokeRole(){allowed=false;},
    refresh:()=>dom.window.__tm.refresh(),
    emitBroadcast:()=>broadcastListener?.({payload:{revision:42,active:true}}),
    isSubscribed:()=>subscribed,
    close:()=>dom.window.close()
  };
}

test("public: inactive page is safe and organizer controls stay hidden",async()=>{
  const t=await boot();
  try{
    assert.deepEqual(t.errs,[]);
    assert.match(t.dom.window.document.querySelector("#tm-public-content").textContent,
      /No active volleyball session/i);
    assert(t.dom.window.document.querySelector("#tm-organizer").hidden);
    assert.equal(t.dom.window.document.querySelector("#tm-organizer-link").textContent,"Organizer Login");
    assert(t.calls.some(c=>c.name==="tm_public_snapshot"));
    assert(!t.calls.some(c=>c.name==="tm_org_roster"),
      "Public sessions must never request private roster RPC");
  }finally{t.close();}
});

test("public: live teams and games render with HTML injection escaped",async()=>{
  const t=await boot({initialSnapshot:{
    active:true,session_id:"session",format:6,revision:2,rotation_id:"rot",
    rotation_status:"published",event_title:"Open gym",
    teams:[
      {id:"t1",seed:1,label:"Team <Unsafe>",players:[
        {id:"p1",name:"<img src=x onerror=alert(1)>"}]},
      {id:"t2",seed:2,label:"Team Blue",players:[{id:"p2",name:"Bob"}]}
    ],
    games:[{id:"g1",round:1,court:1,status:"playing",
      team_a_id:"t1",team_b_id:"t2",winner_team_id:null}]
  }});
  try{
    assert.deepEqual(t.errs,[]);
    const doc=t.dom.window.document;
    const text=doc.querySelector("#tm-public-content").textContent;
    assert.match(text,/Team <Unsafe>/);
    assert.match(text,/<img src=x onerror=alert\(1\)>/);
    assert.equal(doc.querySelector("#tm-public-content img"),null,
      "Untrusted player name inserted into DOM as an image");
    assert.match(text,/Game 1/);
    assert(doc.querySelector("#tm-organizer").hidden);
    assert(!JSON.stringify(t.calls).includes("tm_org_roster"));
  }finally{t.close();}
});

test("organizer: authorized user sees event picker and private management shell",async()=>{
  const t=await boot({organizer:true});
  try{
    assert.deepEqual(t.errs,[]);
    const doc=t.dom.window.document;
    assert(!doc.querySelector("#tm-organizer").hidden);
    const link=doc.querySelector("#tm-organizer-link");
    assert.equal(link.textContent,"Organizer Dashboard");
    assert(link.classList.contains("is-signed-in"));
    assert.equal(link.getAttribute("href"),"../?dashboard=1");
    assert.match(doc.querySelector("#tm-source-event").textContent,/Example session/);
    assert(doc.querySelector("#tm-org-empty")&&!doc.querySelector("#tm-org-empty").hidden);
  }finally{t.close();}
});

test("public: the view updates without a full browser reload",async()=>{
  const t=await boot();
  try{
    t.setSnapshot({active:true,event_title:"Game started",format:4,revision:1,
      rotation_id:null,rotation_status:null,teams:[],games:[]});
    await t.refresh();
    const doc=t.dom.window.document;
    assert.match(doc.querySelector("#tm-public-content").textContent,/Game started/);
    assert(doc.querySelector("#tm-organizer").hidden);
  }finally{t.close();}
});

const makeTeams=(count=6)=>Array.from({length:count},(_,i)=>({
  id:"team"+(i+1),label:"Team "+(i+1),seed:i+1,
  court:count===6?(i<3?1:2):null,
  players:[{id:"person"+(i+1),name:"Person "+(i+1)}]
}));
const pause=()=>new Promise(resolve=>setTimeout(resolve,35));

test("anonymous visitor can start a ready game and record winner through public RPCs",async()=>{
  const teams=makeTeams();
  const base={active:true,session_id:"session",format:6,revision:2,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams};
  const t=await boot({initialSnapshot:{...base,games:[{
    id:"game1",round:1,court:1,status:"ready",
    team_a_id:"team1",team_b_id:"team2",winner_team_id:null
  }]}});
  try{
    const doc=t.dom.window.document;
    assert(doc.querySelector('[data-tm-game-action="start"]'));
    doc.querySelector('[data-tm-game-action="start"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_start_game"&&
      c.args?.p_game_id==="game1"));

    t.setSnapshot({...base,revision:3,games:[{
      id:"game1",round:1,court:1,status:"playing",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null
    }]});
    await t.refresh();
    doc.querySelector('[data-report-winner="game1"]').value="team2";
    doc.querySelector('[data-tm-game-action="winner"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_report_winner"&&
      c.args?.p_game_id==="game1"&&c.args?.p_winner_team_id==="team2"));
    assert(t.dom.window.document.querySelector("#tm-organizer").hidden);
  }finally{t.close();}
});

test("six-team public view only offers resting-team substitutes on the same court",async()=>{
  const teams=makeTeams();
  const t=await boot({initialSnapshot:{
    active:true,session_id:"session",format:6,revision:2,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"ready",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  }});
  try{
    const doc=t.dom.window.document;
    const select=doc.querySelector('[data-sub-player="game1"]');
    assert(select);
    assert.match(select.textContent,/Person 3/);
    assert(!select.textContent.includes("Person 6"));
    select.value="person3";
    doc.querySelector('[data-sub-team="game1"]').value="team1";
    doc.querySelector('[data-tm-game-action="sub"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_record_sub"&&
      c.args?.p_session_player_id==="person3"&&
      c.args?.p_target_team_id==="team1"));
  }finally{t.close();}
});

test("five-team page offers only eligible transfers and hides them after the vacancy is filled",async()=>{
  const teams=makeTeams(5);
  const base={
    active:true,session_id:"session",format:5,revision:2,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"ready",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  };
  const t=await boot({initialSnapshot:base});
  try{
    const doc=t.dom.window.document;
    assert.equal(doc.querySelector("#tm-transfer-player"),null);
    t.setSnapshot({...base,revision:3,eligibleTransfers:[{player_id:"person1",target_team_id:"team2"}]});
    await t.refresh();
    assert.deepEqual([...doc.querySelector("#tm-transfer-player").options].map(o=>o.value),["","person1"]);
    assert.deepEqual([...doc.querySelector("#tm-transfer-target").options].map(o=>o.value),["","team2"]);
    assert.equal(doc.querySelector('[data-sub-player="game1"]'),null);
    doc.querySelector("#tm-transfer-player").value="person1";
    doc.querySelector("#tm-transfer-target").value="team2";
    doc.querySelector('[data-tm-game-action="transfer"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_transfer"&&
      c.args?.p_rotation_id==="rot"&&c.args?.p_session_player_id==="person1"));
    t.setSnapshot({...base,revision:4});
    await t.refresh();
    assert.equal(doc.querySelector(".tm-transfer"),null);
  }finally{t.close();}
});

test("organizer has correction control but anonymous visitors do not",async()=>{
  const teams=makeTeams();
  const snapshot={active:true,session_id:"session",format:6,revision:3,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"completed",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:"team1"}]};
  const publicView=await boot({initialSnapshot:snapshot});
  try{
    assert.equal(publicView.dom.window.document.querySelector(
      '[data-tm-game-action="correct-winner"]'),null);
  }finally{publicView.close();}
  const admin=await boot({initialSnapshot:snapshot,organizer:true});
  try{
    const button=admin.dom.window.document.querySelector(
      '[data-tm-game-action="correct-winner"]');
    assert(button,"Organizer correction control is missing");
    button.click();
    await pause();
    assert(admin.calls.some(c=>c.name==="tm_org_correct_winner"&&
      c.args?.p_winner_team_id==="team2"));
  }finally{admin.close();}
});

test("organizer replaces a departed roster player with a late arrival between games",async()=>{
  const teams=makeTeams(6);
  const snapshot={active:true,session_id:"session",format:6,revision:6,
    rotation_id:"rot",rotation_status:"published",event_title:"Game day",teams,
    games:[{id:"game1",round:1,court:1,status:"ready",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]};
  const t=await boot({initialSnapshot:snapshot,organizer:true,
    organizerRoster:[
      {id:"person1",name:"Person 1",email:"p1@example.com",
        attendance:"departed",positions:[]},
      {id:"late",name:"Late arrival",email:"late@example.com",
        attendance:"present",positions:[]}
    ]});
  try{
    const doc=t.dom.window.document;
    assert(!doc.querySelector("#tm-roster-adjust").hidden);
    const incoming=doc.querySelector("#tm-arrival-player");
    const target=doc.querySelector("#tm-arrival-team");
    assert(incoming.textContent.includes("Late arrival"));
    incoming.value="late";
    target.value="team1";
    target.dispatchEvent(new t.dom.window.Event("change",{bubbles:true}));
    const outgoing=doc.querySelector("#tm-replace-player");
    assert(outgoing.textContent.includes("Person 1"));
    outgoing.value="person1";
    doc.querySelector("#tm-assign-arrival").click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_org_adjust_roster"&&
      c.args?.p_in_player_id==="late"&&c.args?.p_out_player_id==="person1"&&
      c.args?.p_team_id==="team1"));
  }finally{t.close();}
});

test("six-team emergency injury sub replaces an active participant",async()=>{
  const teams=makeTeams(6);
  const t=await boot({initialSnapshot:{
    active:true,session_id:"session",format:6,revision:3,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"playing",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  },lineupByGame:{game1:[
    {player_id:"person1",name:"Person 1",team_id:"team1",is_substitute:false},
    {player_id:"person2",name:"Person 2",team_id:"team2",is_substitute:false}
  ]}});
  try{
    const doc=t.dom.window.document;
    doc.querySelector('[data-emergency-out="game1"]').value="person1";
    doc.querySelector('[data-emergency-in="game1"]').value="person3";
    doc.querySelector('[data-tm-game-action="emergency"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_emergency_sub"&&
      c.args?.p_out_player_id==="person1"&&
      c.args?.p_in_player_id==="person3"));
  }finally{t.close();}
});

test("organizer participant correction uses a private RPC and never appears publicly",async()=>{
  const teams=makeTeams(6);
  teams[0].players.push({id:"person1b",name:"Second Team 1 Player"});
  const snapshot={active:true,session_id:"session",format:6,revision:3,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"completed",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:"team1"}]};
  const anon=await boot({initialSnapshot:snapshot});
  try{
    assert(anon.dom.window.document.querySelector("#tm-organizer").hidden);
    assert(!anon.calls.some(c=>c.name==="tm_org_game_appearances"));
  }finally{anon.close();}
  const admin=await boot({initialSnapshot:snapshot,organizer:true,
    organizerAppearances:{game1:[
      {player_id:"person1",name:"Person 1",team_id:"team1",is_substitute:false},
      {player_id:"person2",name:"Person 2",team_id:"team2",is_substitute:false}
    ]}});
  try{
    const doc=admin.dom.window.document;
    assert(!doc.querySelector("#tm-appearance-correction").hidden);
    doc.querySelector("#tm-correct-game").value="game1";
    doc.querySelector("#tm-correct-game").dispatchEvent(
      new admin.dom.window.Event("change",{bubbles:true}));
    await pause();
    doc.querySelector("#tm-incorrect-player").value="person1";
    doc.querySelector("#tm-incorrect-player").dispatchEvent(
      new admin.dom.window.Event("change",{bubbles:true}));
    doc.querySelector("#tm-correct-player").value="person1b";
    doc.querySelector("#tm-correct-appearance-save").click();
    await pause();
    assert(admin.calls.some(c=>c.name==="tm_org_correct_appearance"&&
      c.args?.p_wrong_player_id==="person1"&&
      c.args?.p_correct_player_id==="person1b"));
  }finally{admin.close();}
});

test("organizer can select 25 players as four teams 6v6 or six teams 4v4",async()=>{
  const roster=Array.from({length:25},(_,i)=>({
    id:"available-"+i,name:"Available "+i,
    email:"available-"+i+"@example.com",
    skill:5,gender:null,positions:[],attendance:"present"
  }));
  const t=await boot({organizer:true,organizerRoster:roster,
    initialSnapshot:{active:true,session_id:"session",revision:1,format:6,
      allowed_formats:[4,5,6],rotation_id:null,teams:[],games:[]}});
  try{
    const doc=t.dom.window.document;
    assert.equal(doc.querySelector("#tm-team-count").value,"6");
    assert.equal(doc.querySelector("#tm-draft-format").value,"4");
    assert.match(doc.querySelector("#tm-distribution-summary").textContent,/5 teams of 4/);
    doc.querySelector("#tm-team-count").value="4";
    doc.querySelector("#tm-team-count").dispatchEvent(
      new t.dom.window.Event("change",{bubbles:true}));
    assert.equal(doc.querySelector("#tm-draft-format").value,"6");
    assert.match(doc.querySelector("#tm-distribution-summary").textContent,/1 team of 7/);
  }finally{t.close();}
});

test("another court can start while a player is choosing their game winner", async()=>{
  const teams=makeTeams(4);
  const game=(id,court,status,team_a_id,team_b_id)=>({
    id,court,status,round:1,team_a_id,team_b_id,winner_team_id:null
  });
  const first=game("one",1,"playing","team1","team2");
  const second=game("two",2,"ready","team3","team4");
  const session={active:true,session_id:"session",format:6,revision:2,
    rotation_id:"rotation",rotation_status:"published",teams,games:[first,second]};
  const t=await boot({initialSnapshot:session});
  try {
    const doc=t.dom.window.document;
    const picker=doc.querySelector('[data-report-winner="one"]');
    picker.value="team2";
    picker.focus();
    t.setSnapshot({...session,revision:3,games:[first,{...second,status:"playing"}]});
    await t.refresh();
    assert.equal(doc.querySelector('[data-report-winner="one"]').value,"team2");
    assert.equal(doc.activeElement,picker,"another court's update must leave the open control in place");
    assert(doc.querySelector('[data-report-winner="two"]'));
  } finally { t.close(); }
});

test("anonymous seven-player team can record a normal 6v6 teammate rotation",async()=>{
  const teams=makeTeams(4);
  teams[0].players=Array.from({length:7},(_,i)=>({
    id:"team1-"+i,name:"Team 1 Player "+i
  }));
  const playing=teams[0].players.slice(0,6).map(p=>({
    player_id:p.id,name:p.name,team_id:"team1",is_substitute:false
  }));
  const t=await boot({initialSnapshot:{
    active:true,session_id:"session",format:6,revision:8,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"playing",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  },lineupByGame:{game1:playing}});
  try{
    const doc=t.dom.window.document;
    const key="game1-team1";
    assert(doc.querySelector('[data-tm-game-action="rotate-teammate"]'));
    doc.querySelector('[data-rotate-out="'+key+'"]').value="team1-0";
    doc.querySelector('[data-rotate-in="'+key+'"]').value="team1-6";
    doc.querySelector('[data-tm-game-action="rotate-teammate"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_rotate_teammate"&&
      c.args?.p_out_player_id==="team1-0"&&
      c.args?.p_in_player_id==="team1-6"));
    assert(doc.querySelector("#tm-organizer").hidden);
  }finally{t.close();}
});

test("public Broadcast signal triggers sanitized refetch and does not trust event content",async()=>{
  const initial={active:true,session_id:"session",revision:1,
    rotation_id:null,teams:[],games:[],event_title:"Initial"};
  const t=await boot({initialSnapshot:initial});
  try {
    assert(t.isSubscribed(),"Public channel should subscribe automatically");
    const sub=t.calls.find(c=>c.name==="__subscribe");
    assert.equal(sub.topic,"teams-manager:public");
    assert.equal(sub.options.config.private,false);
    const next={...initial,revision:2,event_title:"Fresh from server"};
    t.setSnapshot(next);
    t.emitBroadcast();
    await new Promise(r=>setTimeout(r,310));
    assert.match(t.dom.window.document.querySelector("#tm-public-content").textContent,
      /Fresh from server/);
    assert(!t.calls.some(c=>c.name==="tm_org_roster"),
      "Receiving live notifications must never read organizer records");
  }finally{t.close();}
});

test("bursts of public Broadcast signals are coalesced, avoiding an RPC storm",async()=>{
  const t=await boot();
  try{
    const before=t.calls.filter(c=>c.name==="tm_public_snapshot").length;
    for(let i=0;i<20;i++)t.emitBroadcast();
    await new Promise(r=>setTimeout(r,340));
    const added=t.calls.filter(c=>c.name==="tm_public_snapshot").length-before;
    assert(added<=2,`Unexpected snapshot query storm: ${added}`);
    assert(added>=1,"At least one invalidation should be fetched");
  }finally{t.close();}
});

test("organizers can correct a previously recorded five-team transfer",async()=>{
  const teams=makeTeams(5);
  const snapshot={
    active:true,session_id:"session",format:5,revision:2,
    rotation_id:"rot",rotation_status:"published",
    event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"ready",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  };
  const publicView=await boot({initialSnapshot:snapshot});
  try{
    assert(publicView.dom.window.document.querySelector("#tm-organizer").hidden);
    assert(!publicView.calls.some(c=>c.name==="tm_org_transfers"));
  }finally{publicView.close();}
  const t=await boot({initialSnapshot:snapshot,organizer:true,
    transferHistory:[{
      player_id:"person1",name:"Person 1",
      current_team_id:"team2",previous_team_id:"team1"
    }]
  });
  try{
    const doc=t.dom.window.document;
    const panel=doc.querySelector("#tm-transfer-correction");
    assert(!panel.hidden);
    doc.querySelector("#tm-transfer-correction-player").value="person1";
    doc.querySelector("#tm-transfer-correction-team").value="team1";
    doc.querySelector("#tm-transfer-correction-save").click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_org_correct_transfer"&&
      c.args?.p_session_player_id==="person1"&&
      c.args?.p_to_team_id==="team1"));
  }finally{t.close();}
});

test("nonproduction preview without explicit staging config never opens a database connection",async()=>{
  const t=await boot({staging:false});
  try {
    assert(!t.isSubscribed());
    assert(!t.calls.some(c=>c.name==="tm_public_snapshot"));
    assert.match(t.dom.window.document.querySelector("#tm-public-content").textContent,
      /development preview is not connected/i);
    assert.equal(t.dom.window.document.querySelector("#tm-organizer").hidden,true);
  }finally{t.close();}
});

test("event roster starts with registered players included and waitlist separately labeled",async()=>{
  const t=await boot({organizer:true,initialSnapshot:{
    active:true,session_id:"session",format:6,revision:1,
    allowed_formats:[4,5,6],teams:[],games:[]
  },organizerRoster:[
    {id:"registered",name:"Registered Player",email:"registered@example.invalid",
      source_status:"registered",attendance:"present",positions:[]},
    {id:"waitlisted",name:"Waitlisted Player",email:"waitlisted@example.invalid",
      source_status:"waitlisted",attendance:"candidate",positions:[]},
    {id:"walkin",name:"Walk-in Player",email:"walkin@example.invalid",
      source_status:null,attendance:"present",positions:[]}
  ]});
  try {
    const doc=t.dom.window.document;
    const grid=doc.querySelector("#tm-roster");
    assert.match(grid.textContent,/Registered Player/);
    assert.match(grid.textContent,/Waitlisted Player/);
    assert.match(grid.textContent,/Walk-in Player/);
    assert.equal(doc.querySelector('[data-attendance="registered"]').value,"present");
    assert.equal(doc.querySelector('[data-attendance="waitlisted"]').value,"candidate");
    assert.equal(doc.querySelector("#tm-roster-count").textContent,
      "2 available · 0 no-shows · 1 pending");
    assert.match(grid.textContent,/Registered/);
    assert.match(grid.textContent,/Waitlisted/);
    assert.match(grid.textContent,/Walk-in/);
    assert(!t.calls.some(c=>c.name==="tm_org_set_attendance"),
      "Opening the event roster must NOT require individual check-in calls");
  }finally{t.close();}
});

test("one-click no-show removes a registered player, and Include restores eligibility",async()=>{
  const t=await boot({organizer:true,initialSnapshot:{
    active:true,session_id:"session",format:4,revision:1,
    allowed_formats:[4,5,6],teams:[],games:[]
  },organizerRoster:[{
    id:"registered",name:"Registered Player",
    email:"registered@example.invalid",
    source_status:"registered",attendance:"present",positions:[]
  }]});
  try{
    const doc=t.dom.window.document;
    doc.querySelector('[data-mark-no-show="registered"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_org_set_attendance"&&
      c.args?.p_session_player_id==="registered"&&c.args?.p_attendance==="absent"));
    assert.equal(doc.querySelector("#tm-roster-count").textContent,
      "0 available · 1 no-shows · 0 pending");
    assert.equal(doc.querySelector('[data-attendance="registered"]').value,"absent");

    doc.querySelector('[data-include-player="registered"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_org_set_attendance"&&
      c.args?.p_session_player_id==="registered"&&c.args?.p_attendance==="present"));
    assert.equal(doc.querySelector("#tm-roster-count").textContent,
      "1 available · 0 no-shows · 0 pending");
  }finally{t.close();}
});

test("waitlisted player can be included without altering official registration",async()=>{
  const t=await boot({organizer:true,initialSnapshot:{
    active:true,session_id:"session",format:4,revision:1,
    allowed_formats:[4,5,6],teams:[],games:[]
  },organizerRoster:[{
    id:"waitlisted",name:"Waitlisted Player",
    email:"waiting@example.invalid",source_status:"waitlisted",
    attendance:"candidate",positions:[]
  }]});
  try{
    const doc=t.dom.window.document;
    doc.querySelector('[data-include-player="waitlisted"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_org_set_attendance"&&
      c.args?.p_attendance==="present"));
    assert(!t.calls.some(c=>c.name.includes("registration")),
      "Manager must never write to event registrations");
    assert.equal(doc.querySelector("#tm-roster-count").textContent,
      "1 available · 0 no-shows · 0 pending");
  }finally{t.close();}
});

const privateRosterFixture=[{id:"private-player",profile_id:"private-profile",
  name:"Private Player",email:"sensitive@example.invalid",skill:8,
  gender:"private",positions:[],attendance:"present",source_status:"registered"}];
const activePrivateSession={active:true,session_id:"private-session",revision:1,
  format:6,rotation_id:null,rotation_status:null,teams:[],games:[]};

test("profile dropdowns save skill, one gender, up to two positions or Flex alone",async()=>{
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:[{...privateRosterFixture[0],gender:"F",positions:["Outside hitter"]}]});
  try {
    const doc=t.dom.window.document;
    const select=selector=>doc.querySelector("#tm-roster "+selector);
    const box=role=>select('[data-position][value="'+role+'"]');
    const checked=()=>[...doc.querySelectorAll("[data-position]:checked")].map(b=>b.value);
    const save=async()=>{select("[data-save-profile]").click();await pause();};
    assert.deepEqual([...select("[data-skill]").options].map(o=>o.value),["","1","2","3","4","5","6","7","8","9","10"]);
    assert.deepEqual([...select("[data-gender]").options].map(o=>o.value),["","male","female"]);
    assert(select("[data-gender]").options[0].disabled);
    assert(select("[data-skill]").options[0].disabled);
    assert.equal(select("[data-gender]").value,"female");
    assert.deepEqual(checked(),["outside"]);
    select("[data-skill]").value="10";
    select("[data-gender]").value="male";
    select("[data-gender]").dispatchEvent(new t.dom.window.Event("change",{bubbles:true}));
    box("setter").click();
    assert(box("right side").disabled);
    box("right side").click();
    assert.deepEqual(checked(),["outside","setter"]);
    const openPicker=select("[data-positions]");
    openPicker.open=true;
    t.setSnapshot({...activePrivateSession,revision:2});
    await t.refresh();
    assert.equal(select("[data-positions]"),openPicker);
    assert(openPicker.open);
    assert.deepEqual(checked(),["outside","setter"]);
    await save();
    assert.equal(select("[data-skill]").value,"10");
    assert.equal(select("[data-gender]").value,"male");
    assert.deepEqual(checked(),["outside","setter"]);
    box("flex").click();
    assert.deepEqual(checked(),["flex"]);
    await save();
    assert.equal(select("[data-position-summary]").textContent,"Flex");
    box("right side").click();
    assert.deepEqual(checked(),["right side"]);
    box("right side").click();
    await save();
    assert.deepEqual(checked(),[]);
  } finally {t.close();}
});

test("logout clears private roster, event choices and cached statistics immediately",async()=>{
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:privateRosterFixture});
  try{
    const doc=t.dom.window.document;
    assert.match(doc.querySelector("#tm-roster").innerHTML,/Private Player/);
    doc.querySelector("#tm-final-stats-body").textContent="Sensitive stats";
    t.signOut();
    assert.equal(doc.querySelector("#tm-organizer-link").textContent,"Organizer Login");
    assert(!doc.querySelector("#tm-organizer-link").classList.contains("is-signed-in"));
    assert(doc.querySelector("#tm-organizer").hidden);
    assert(!doc.querySelector("#tm-organizer").innerHTML.includes("Private Player"));
    assert.equal(doc.querySelector("#tm-final-stats-body").textContent,"");
    assert(!doc.querySelector("#tm-source-event").textContent.includes("Example session"));
    await t.refresh();
    assert.equal(doc.querySelector("#tm-roster").textContent,"");
  }finally{t.close();}
});

test("logout discards a private roster response already in flight",async()=>{
  let release,hold=false;
  const delayed=new Promise(resolve=>{release=resolve;});
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:privateRosterFixture,rpcOverride:async name=>{
      if(hold&&name==="tm_org_roster"){await delayed;return {data:privateRosterFixture};}
    }});
  try{
    hold=true;
    t.setSnapshot({...activePrivateSession,revision:2});
    const refreshing=t.refresh();
    await new Promise(resolve=>setTimeout(resolve,10));
    t.signOut();release();await refreshing;
    assert(t.dom.window.document.querySelector("#tm-organizer").hidden);
    assert.equal(t.dom.window.document.querySelector("#tm-roster").textContent,"");
  }finally{release();t.close();}
});

test("polling removes organizer data after membership is revoked without logout",async()=>{
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:privateRosterFixture});
  try{
    t.revokeRole();await t.refresh();
    assert(t.dom.window.document.querySelector("#tm-organizer").hidden);
    assert.equal(t.dom.window.document.querySelector("#tm-roster").textContent,"");
  }finally{t.close();}
});

test("page caching clears private fields before back-navigation restoration",async()=>{
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:privateRosterFixture});
  try{
    t.dom.window.dispatchEvent(new t.dom.window.Event("pagehide"));
    assert(t.dom.window.document.querySelector("#tm-organizer").hidden);
    assert.equal(t.dom.window.document.querySelector("#tm-roster").textContent,"");
  }finally{t.close();}
});

test("an unchanged session returns after an interrupted refresh",async()=>{
  let offline=false;
  const t=await boot({organizer:true,initialSnapshot:activePrivateSession,
    organizerRoster:privateRosterFixture,rpcOverride:async name=>{
      if(offline && name==="tm_public_snapshot")return {error:{message:"Connection interrupted"}};
    }});
  try{
    const doc=t.dom.window.document;
    offline=true;
    await t.refresh();
    assert.equal(doc.querySelector("#tm-status").textContent,"Unavailable");
    assert(doc.querySelector("#tm-organizer").hidden);
    offline=false;
    await t.refresh();
    assert.equal(doc.querySelector("#tm-status").textContent,"Session live");
    assert(!doc.querySelector("#tm-organizer").hidden);
    assert.match(doc.querySelector("#tm-roster").textContent,/Private Player/);
  }finally{t.close();}
});
