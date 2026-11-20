/**
 * Chromium and WebKit smoke tests for the feature-branch Teams Manager page.
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
  roster=[]}={}){
  const context=await browser.newContext({
    viewport:{width,height},deviceScaleFactor:width<500?2:1,
    isMobile:width<500,hasTouch:width<500
  });
  const page=await context.newPage();
  const errors=[];
  page.on("pageerror",e=>errors.push(e.message));
  await page.addInitScript(({snapshot,organizer,roster})=>{
    window.confirm=()=>true;
    window.TEAMS_MANAGER_STAGING_CONFIG={
      url:"https://invalid-for-browser-tests.example",
      publishableKey:"sb_publishable_browser_test_only"
    };
    window.__teamsSnapshot=snapshot;
    window.__teamsRoster=roster;
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
        if(name==="tm_public_transfer_options")return {data:s.transferOptions || [],error:null};
        if(name==="tm_org_roster"){
          return {data:structuredClone(window.__teamsRoster),error:null};
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
        if(name==="tm_public_transfer"){s.transferOptions=[];s.revision++;}
        if(name==="tm_public_record_sub")s.revision++;
        if(name==="tm_public_cancel_sub")s.revision++;
        changedCallback?.({payload:{revision:s.revision,active:true}});
        return {data:null,error:null};
      }
    };
  },{snapshot,organizer,roster});
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
    body:document.body.scrollWidth,
    overflowing:[...document.querySelectorAll("body *")].filter(el=>
      el.getBoundingClientRect().right>window.innerWidth+2 &&
      !el.closest(".tm-roster")).slice(0,8).map(el=>({
        tag:el.tagName, id:el.id, className:el.className,
        right:Math.round(el.getBoundingClientRect().right)
      }))
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
async function verifyPositionDropdown(page) {
  const row=page.locator('[data-player-row="registered"]');
  const trigger=row.locator('.tm-position-trigger');
  const menu=row.locator('[popover]');
  const geometry=()=>row.evaluate(el=>{
    const rect=el.getBoundingClientRect();
    return [rect.height,el.nextElementSibling.getBoundingClientRect().top-rect.top];
  });
  // The site swaps in its web fonts after first paint. Measure the settled
  // roster so a font swap cannot be mistaken for movement from the menu.
  await page.evaluate(async()=>{await document.fonts.ready;});
  await trigger.evaluate(el=>el.scrollIntoView({block:'center',inline:'nearest',behavior:'instant'}));
  assert(await menu.isHidden());
  await trigger.focus();
  const before=await geometry();
  await page.keyboard.press('Enter');
  await menu.waitFor();
  assert.equal(await menu.locator("label").first().evaluate(el=>getComputedStyle(el).flexDirection),"row");
  assert.deepEqual(await geometry(),before,"Opening the checkboxes resized or displaced a roster row");
  const bounds=await menu.boundingBox();
  const view=page.viewportSize();
  assert(bounds.x>=0 && bounds.y>=0 && bounds.x+bounds.width<=view.width+1 && bounds.y+bounds.height<=view.height+1,
    "Menu outside the viewport: "+JSON.stringify({bounds,view,placement:await menu.evaluate(el=>({
      trigger:el.previousElementSibling.getBoundingClientRect().toJSON(),styles:el.style.cssText,
      inner:[innerWidth,innerHeight], visual:[visualViewport.width,visualViewport.height,visualViewport.offsetTop,visualViewport.scale]
    }))}));
  await menu.getByLabel('Outside',{exact:true}).check();
  await menu.getByLabel('Setter',{exact:true}).check();
  assert(await menu.getByLabel('Libero',{exact:true}).isDisabled());
  assert.deepEqual(await geometry(),before,"Selecting positions changed the roster layout");
  await page.keyboard.press('Escape');
  await menu.waitFor({state:'hidden'});
  assert.equal(await trigger.evaluate(el=>el===document.activeElement),true);
  await trigger.click();
  await menu.getByLabel('Flex (all positions)',{exact:true}).check();
  assert.equal(await menu.locator('input:checked').count(),1);
  await menu.getByRole('button',{name:'Done'}).click();
  await menu.waitFor({state:'hidden'});
  await trigger.click();
  await page.locator('#tm-roster-heading').click();
  await menu.waitFor({state:'hidden'});
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

  const fullRoster=sample(4);
  fullRoster.games[0].status="playing";
  fullRoster.teams[0].players=Array.from({length:7},(_,i)=>({id:"p-"+i,name:"Player "+i}));
  const seven=await openPage({snapshot:fullRoster,width:390,height:844});
  try{
    const page=seven.page;
    const game=page.locator(".tm-game.is-playing");
    await game.getByRole("button",{name:"Report winner"}).waitFor();
    assert.equal(await game.locator("button").count(),1);
    assert.equal(await game.locator("select").count(),1);
    assert.equal(await page.locator(".tm-team").first().locator("li").count(),7);
    assert(!await page.evaluate(()=>window.__teamsCalls.some(c=>c.name==="tm_public_game_lineup")));
    await verifyNoPageOverflow(page,"390px seven-player 6v6 game");
    assert.deepEqual(seven.errors,[]);
    console.log("PASS "+engine+" mobile team-only game with seven players");
  }finally{await seven.context.close();}

  const five=await openPage({snapshot:{...sample(5),transferOptions:[{player_id:"p1",target_team_id:"t2"}]},width:390,height:844});
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
    await page.locator("#tm-transfer-player").waitFor({state:"detached"});
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
    await verifyPositionDropdown(page);
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
    const nav=page.locator('#tm-organizer-link');
    assert.equal(await nav.innerText(),"Organizer Dashboard");
    const signedInColor=await nav.evaluate(el=>getComputedStyle(el).backgroundColor);
    await verifyNoPageOverflow(page,"390px organizer attendance roster");
    const layout=await page.locator(".tm-attendance-table tbody").evaluate(el=>
      getComputedStyle(el).display);
    assert.equal(layout,"grid","Mobile attendance should use stacked cards");
    await verifyPositionDropdown(page);
    await verifyNoPageOverflow(page,"390px organizer position picker");
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
    assert.equal(await nav.innerText(),"Organizer Login");
    await page.waitForFunction(color => getComputedStyle(document.querySelector("#tm-organizer-link")).backgroundColor !== color, signedInColor);
    assert(await page.locator("#tm-organizer").isHidden());
    assert.equal(await page.locator("#tm-roster").textContent(),"");
    console.log("PASS mobile organizer attendance and immediate logout privacy cleanup");
  }finally{await organizerPhone.context.close();}
}finally{
  await browser.close();
  await new Promise(resolve=>server.close(resolve));
}
