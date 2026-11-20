/**
 * Real Chromium smoke tests for the feature-branch Teams Manager page.
 * Entirely mocked network: NO Supabase project (hosted or local) contacted.
 * Checks mobile public interactions, five-team rules and organizer roster UX.
 */
import assert from "node:assert/strict";
import {createServer} from "node:http";
import {readFile} from "node:fs/promises";
import path from "node:path";
import {chromium,webkit} from "playwright";

const root=path.resolve(import.meta.dirname,"../..");
const types={".html":"text/html; charset=utf-8",
  ".mjs":"text/javascript; charset=utf-8",
  ".js":"text/javascript; charset=utf-8",
  ".css":"text/css; charset=utf-8",
  ".svg":"image/svg+xml",".png":"image/png"};

const server=createServer(async (req,res)=>{
  try{
    const address=new URL(req.url,"http://localhost").pathname;
    let file=path.resolve(root,"."+decodeURIComponent(address));
    if(file!==root && !file.startsWith(root+path.sep)){
      res.writeHead(403).end("Forbidden");
      return;
    }
    if(address.endsWith("/"))file=path.join(file,"index.html");
    const bytes=await readFile(file);
    res.writeHead(200,{"Content-Type":types[path.extname(file)]||"application/octet-stream"});
    res.end(bytes);
  }catch{
    res.writeHead(404).end("Not found");
  }
});
await new Promise(resolve=>server.listen(0,"127.0.0.1",resolve));
const port=server.address().port;
const site="http://127.0.0.1:"+port+"/website/teams/";

function teams(count){
  return Array.from({length:count},(_,i)=>({
    id:"t"+(i+1),seed:i+1,label:"Team "+(i+1),
    court:count===6?(i<3?1:2):null,
    players:[{id:"p"+(i+1),name:"Fictional Player "+(i+1)}]
  }));
}
function sample(count){
  const all=teams(count);
  return {
    active:true,session_id:"synthetic-session",event_title:"Fictional Open Gym",
    revision:1,format:count===5?5:6,
    allowed_formats:[4,5,6],rotation_id:"synthetic-rotation",
    rotation_status:"published",teams:all,
    games:[
      {id:"g1",round:1,court:1,status:"ready",
        team_a_id:"t1",team_b_id:"t2",winner_team_id:null},
      {id:"g2",round:1,court:2,status:"ready",
        team_a_id:count===6?"t4":"t3",
        team_b_id:count===6?"t5":"t4",winner_team_id:null}
    ]
  };
}
const fakeModule="export function createClient(){return window.__teamsBrowserClient;}";
const engine=process.env.TM_BROWSER || "chromium";
if(!["chromium","webkit"].includes(engine))throw new Error("Unsupported test browser");
const browser=await ({chromium,webkit}[engine]).launch({headless:true,
  ...(engine==="chromium"?{args:["--no-sandbox"]}:{})});

async function openPage({snapshot,organizer=false,width=1280,height=850,
  roster=[],lineups={}}={}){
  const context=await browser.newContext({
    viewport:{width,height},deviceScaleFactor:width<500?2:1,
    isMobile:width<500,hasTouch:width<500
  });
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(({snapshot,organizer,roster,lineups})=>{
    window.confirm=()=>true;
    window.TEAMS_MANAGER_STAGING_CONFIG={
      url:"https://invalid-for-browser-tests.example",
      publishableKey:"sb_publishable_browser_test_only"
    };
    window.__teamsSnapshot=snapshot;
    window.__teamsRoster=roster;
    window.__teamsLineups=lineups;
    window.__teamsCalls=[];
    let changedCallback,authCallback;
    let signedIn=organizer;
    window.__teamsSignOut=()=>{signedIn=false;authCallback?.("SIGNED_OUT",null);};
    window.__teamsBrowserClient={
      auth:{getUser:async()=>({
        data:{user:signedIn?{id:"fake-org-id"}:null},error:null
      }),onAuthStateChange(callback){authCallback=callback;return {data:{subscription:{unsubscribe(){}}}};}},
      from(table){
        return {select(){
          return {eq(){
            return {
              maybeSingle:async()=>({
                data:table==="organizers"?{user_id:"fake-org-id"}:null,
                error:null
              }),
              order:async()=>({
                data:table==="events"?[{
                  id:"fake-event",title:"Fictional Open Gym",
                  status:"published",starts_at:"2026-11-16T23:00:00Z",
                  visibility:"public"
                }]:[],error:null
              })
            };
          }};
        }};
      },
      channel(){
        return {
          on(type,details,callback){
            if(type==="broadcast"&&details.event==="changed")
              changedCallback=callback;
            return this;
          },
          subscribe(callback){callback?.("SUBSCRIBED");return this;}
        };
      },
      removeChannel:async()=>{},
      async rpc(name,args){
        window.__teamsCalls.push({name,args});
        const s=window.__teamsSnapshot;
        if(name==="tm_public_snapshot"){
          return {data:structuredClone(s),error:null};
        }
        if(name==="tm_org_roster"){
          return {data:structuredClone(window.__teamsRoster),error:null};
        }
        if(name==="tm_public_game_lineup"){
          return {data:structuredClone(window.__teamsLineups[args.p_game_id]||[]),
            error:null};
        }
        if(name==="tm_org_stats"||name==="tm_org_teammate_pairs"||
           name==="tm_org_transfers"||name==="tm_org_game_appearances"||
           name==="tm_public_game_subs"){
          return {data:[],error:null};
        }
        if(name==="tm_public_start_game"){
          const g=s.games.find(x=>x.id===args.p_game_id);
          g.status="playing";
          s.revision++;
        }
        if(name==="tm_public_report_winner"){
          const g=s.games.find(x=>x.id===args.p_game_id);
          g.status="completed";
          g.winner_team_id=args.p_winner_team_id;
          s.revision++;
        }
        if(name==="tm_org_set_attendance"){
          const p=window.__teamsRoster.find(x=>x.id===args.p_session_player_id);
          if(p)p.attendance=args.p_attendance;
          s.revision++;
        }
        if(name==="tm_public_transfer")s.revision++;
        if(name==="tm_public_record_sub")s.revision++;
        if(name==="tm_public_cancel_sub")s.revision++;
        changedCallback?.({payload:{revision:s.revision,active:true}});
        return {data:null,error:null};
      }
    };
  },{snapshot,organizer,roster,lineups});
  await page.route("https://esm.sh/**",route=>route.fulfill({
    status:200,contentType:"text/javascript",
    headers:{"access-control-allow-origin":"*"},
    body:fakeModule
  }));
  await page.goto(site,{waitUntil:"domcontentloaded"});
  await page.waitForFunction(()=>{
    const status=document.querySelector("#tm-status");
    return status?.textContent==="Session live";
  },{timeout:20000});
  return {page,context,errors};
}
async function verifyNoPageOverflow(page,label){
  const dims=await page.evaluate(()=>({
    viewport:window.innerWidth,
    page:document.documentElement.scrollWidth,
    body:document.body.scrollWidth
  }));
  assert(dims.page<=dims.viewport+2,
    label+" causes horizontal viewport overflow: "+JSON.stringify(dims));
  const buttons=await page.locator("[data-tm-game-action]").all();
  for(const b of buttons.slice(0,5)){
    if(!(await b.isVisible()))continue;
    const size=await b.boundingBox();
    assert(size?.height>=28,label+" has a tiny game-action touch target");
  }
}
try {
  const mobile=await openPage({snapshot:sample(6),width:390,height:844});
  try{
    const page=mobile.page;
    await page.locator('[data-tm-game-action="start"][data-game-id="g1"]').waitFor();
    await verifyNoPageOverflow(page,"390px six-team public view");
    assert.equal(await page.locator("#tm-organizer").isVisible(),false);
    await page.locator('[data-tm-game-action="start"][data-game-id="g1"]').click();
    await page.locator('[data-tm-game-action="winner"][data-game-id="g1"]').waitFor();
    await page.locator('[data-report-winner="g1"]').selectOption("t1");
    await page.locator('[data-tm-game-action="winner"][data-game-id="g1"]').click();
    await page.waitForFunction(()=>
      window.__teamsCalls.some(c=>c.name==="tm_public_report_winner")
    );
    const calls=await page.evaluate(()=>window.__teamsCalls);
    assert(calls.some(c=>c.name==="tm_public_start_game"&&c.args.p_game_id==="g1"));
    assert(calls.some(c=>c.name==="tm_public_report_winner"&&
      c.args.p_game_id==="g1"&&c.args.p_winner_team_id==="t1"));
    await verifyNoPageOverflow(page,"390px completed-game view");
    assert.deepEqual(mobile.errors,[]);
    console.log("PASS "+engine+" mobile 390px six-team game start/winner flow");
  }finally{await mobile.context.close();}

  // A seven-person 6v6 roster shares an on-court spot: the seventh
  // teammate enters mid-game and counts as regular participation, not
  // a resting-team borrowed substitute.
  const sharedRole=sample(4);
  sharedRole.format=6;
  sharedRole.games[0].status="playing";
  sharedRole.teams[0].players=Array.from({length:7},(_,i)=>({
    id:"middle-"+i,name:i===6?"Fictional Libero":"Fictional Middle "+i
  }));
  sharedRole.teams[1].players=Array.from({length:6},(_,i)=>({
    id:"other-"+i,name:"Other teammate "+i
  }));
  const activeLineup=[
    ...sharedRole.teams[0].players.slice(0,6).map(p=>({
      player_id:p.id,name:p.name,team_id:"t1",is_substitute:false
    })),
    ...sharedRole.teams[1].players.map(p=>({
      player_id:p.id,name:p.name,team_id:"t2",is_substitute:false
    }))
  ];
  const seven=await openPage({snapshot:sharedRole,width:390,height:844,
    lineups:{g1:activeLineup}});
  try{
    const page=seven.page;
    await page.locator('[data-rotate-out="g1-t1"]').waitFor();
    await verifyNoPageOverflow(page,"390px seven-player 6v6 lineup rotation");
    await page.locator('[data-rotate-out="g1-t1"]').selectOption("middle-0");
    await page.locator('[data-rotate-in="g1-t1"]').selectOption("middle-6");
    await page.locator(
      '[data-tm-game-action="rotate-teammate"][data-team-id="t1"]').click();
    await page.waitForFunction(()=>
      window.__teamsCalls.some(c=>c.name==="tm_public_rotate_teammate"));
    const calls=await page.evaluate(()=>window.__teamsCalls);
    assert(calls.some(c=>c.name==="tm_public_rotate_teammate"&&
      c.args.p_out_player_id==="middle-0"&&
      c.args.p_in_player_id==="middle-6"));
    assert.deepEqual(seven.errors,[]);
    console.log("PASS "+engine+" mobile seven-player 6v6 regular in-game teammate rotation");
  }finally{await seven.context.close();}

  const five=await openPage({snapshot:sample(5),width:390,height:844});
  try{
    const page=five.page;
    await page.locator("#tm-transfer-player").waitFor();
    await verifyNoPageOverflow(page,"390px five-team view");
    assert.equal(await page.locator('[data-tm-game-action="sub"]').count(),0,
      "Five-team games must not offer temporary borrowed substitutes");
    await page.locator("#tm-transfer-player").selectOption("p1");
    await page.locator("#tm-transfer-target").selectOption("t2");
    await page.locator('[data-tm-game-action="transfer"]').click();
    await page.waitForFunction(()=>
      window.__teamsCalls.some(c=>c.name==="tm_public_transfer")
    );
    const calls=await page.evaluate(()=>window.__teamsCalls);
    assert(calls.some(c=>c.name==="tm_public_transfer"&&
      c.args.p_session_player_id==="p1"&&c.args.p_to_team_id==="t2"));
    assert.deepEqual(five.errors,[]);
    console.log("PASS "+engine+" mobile five-team transfer without temporary subs");
  }finally{await five.context.close();}

  const roster=[
    {id:"registered",name:"Registered Test Player",
      email:"registered@example.invalid",attendance:"present",
      source_status:"registered",positions:[],skill:5,gender:null},
    {id:"waitlist",name:"Waitlisted Test Player",
      email:"waitlist@example.invalid",attendance:"candidate",
      source_status:"waitlisted",positions:[],skill:null,gender:null}
  ];
  const organizerSnapshot={
    active:true,session_id:"synthetic-session",revision:1,
    format:4,allowed_formats:[4,5,6],
    rotation_id:null,rotation_status:null,event_title:"Fictional Open Gym",
    teams:[],games:[]
  };
  const desktop=await openPage({snapshot:organizerSnapshot,organizer:true,
    roster,width:1280,height:850});
  try{
    const page=desktop.page;
    await page.locator('[data-mark-no-show="registered"]').waitFor();
    await verifyNoPageOverflow(page,"Desktop organizer event attendance");
    await page.locator('[data-mark-no-show="registered"]').click();
    await page.waitForFunction(()=>
      window.__teamsRoster.some(p=>p.id==="registered"&&p.attendance==="absent"));
    await page.locator('[data-include-player="registered"]').waitFor();
    await page.locator('[data-include-player="registered"]').click();
    await page.waitForFunction(()=>
      window.__teamsRoster.some(p=>p.id==="registered"&&p.attendance==="present"));
    const calls=await page.evaluate(()=>window.__teamsCalls);
    assert.equal(calls.filter(c=>c.name==="tm_org_set_attendance").length,2);
    assert(!calls.some(c=>/registration/.test(c.name)),
      "One-click attendance may not write to source event registrations");
    assert.deepEqual(desktop.errors,[]);
    console.log("PASS "+engine+" desktop organizer no-show/restore with no registration writes");
  }finally{await desktop.context.close();}

  const organizerPhone=await openPage({snapshot:organizerSnapshot,
    organizer:true,roster,width:390,height:844});
  try{
    const page=organizerPhone.page;
    await page.locator('.tm-attendance-table [data-mark-no-show="registered"]').waitFor();
    await verifyNoPageOverflow(page,"390px organizer attendance roster");
    const layout=await page.locator(".tm-attendance-table tbody").evaluate(el=>
      getComputedStyle(el).display);
    assert.equal(layout,"grid","Mobile attendance should use stacked cards");
    const action=await page.locator('[data-mark-no-show="registered"]').boundingBox();
    assert(action&&action.x>=0&&action.x+action.width<=392,
      "No-show action should fit within the mobile viewport without sideways scrolling");
    await page.locator('[data-mark-no-show="registered"]').click();
    await page.locator('[data-include-player="registered"]').waitFor();
    await page.locator('[data-include-player="registered"]').click();
    await page.waitForFunction(()=>
      window.__teamsRoster.some(p=>p.id==="registered"&&p.attendance==="present"));
    await verifyNoPageOverflow(page,"390px organizer after attendance correction");
    assert.deepEqual(organizerPhone.errors,[]);
    await page.evaluate(()=>window.__teamsSignOut());
    assert(await page.locator("#tm-organizer").isHidden());
    assert.equal(await page.locator("#tm-roster").textContent(),"");
    console.log("PASS mobile organizer attendance and immediate logout privacy cleanup");
  }finally{await organizerPhone.context.close();}
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
