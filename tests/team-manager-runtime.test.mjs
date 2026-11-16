import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {JSDOM} from "jsdom";

const root=path.resolve(import.meta.dirname,"../website/teams");
const page=fs.readFileSync(path.join(root,"index.html"),"utf8");
const app=fs.readFileSync(path.join(root,"teams.mjs"),"utf8")
  .replace(/^import [^\n]*;\n/gm,"");

async function boot({initialSnapshot,organizer=false,organizerRoster=[]}={}){
  const dom=new JSDOM(page,{
    url:"https://test.local/teams/",
    runScripts:"outside-only"
  });
  const calls=[];
  dom.window.confirm=()=>true;
  let snapshot=initialSnapshot||{active:false};
  dom.window.__fakeClient={
    auth:{
      getUser:async()=>({data:{user:organizer?{id:"organizer-id"}:null}})
    },
    from(table){
      return {
        select:()=>({
          eq:()=>({
            maybeSingle:async()=>({data:table==="organizers"?{user_id:"organizer-id"}:null}),
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
      if(name==="tm_public_snapshot")return {data:snapshot,error:null};
      if(name==="tm_org_roster")return {data:organizerRoster,error:null};
      if(name==="tm_org_stats")return {data:[],error:null};
      return {data:null,error:null};
    }
  };
  const errs=[];
  dom.window.addEventListener("error",e=>errs.push(e.message));
  dom.window.eval("const createClient=()=>window.__fakeClient;\n"+
    "const generateBalancedTeams=()=>({teams:[],qualityScore:0});\n"+
    app+"\nwindow.__tm={refresh};");
  await new Promise(resolve=>setTimeout(resolve,40));
  return {
    dom,calls,errs,
    setSnapshot(value){snapshot=value;},
    refresh:()=>dom.window.__tm.refresh(),
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

test("five-team page exposes rotation-long public transfer and not temporary subs",async()=>{
  const teams=makeTeams(5);
  const t=await boot({initialSnapshot:{
    active:true,session_id:"session",format:5,revision:2,
    rotation_id:"rot",rotation_status:"published",event_title:"Open gym",teams,
    games:[{id:"game1",round:1,court:1,status:"ready",
      team_a_id:"team1",team_b_id:"team2",winner_team_id:null}]
  }});
  try{
    const doc=t.dom.window.document;
    assert(doc.querySelector("#tm-transfer-player"));
    assert.equal(doc.querySelector('[data-sub-player="game1"]'),null);
    doc.querySelector("#tm-transfer-player").value="person1";
    doc.querySelector("#tm-transfer-target").value="team2";
    doc.querySelector('[data-tm-game-action="transfer"]').click();
    await pause();
    assert(t.calls.some(c=>c.name==="tm_public_transfer"&&
      c.args?.p_rotation_id==="rot"&&c.args?.p_session_player_id==="person1"));
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
