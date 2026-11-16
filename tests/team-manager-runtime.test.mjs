import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {JSDOM} from "jsdom";

const root=path.resolve(import.meta.dirname,"../website/teams");
const page=fs.readFileSync(path.join(root,"index.html"),"utf8");
const app=fs.readFileSync(path.join(root,"teams.mjs"),"utf8")
  .replace(/^import [^\n]*;\n/gm,"");

async function boot({initialSnapshot,organizer=false}={}){
  const dom=new JSDOM(page,{
    url:"https://test.local/teams/",
    runScripts:"outside-only"
  });
  const calls=[];
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
      if(name==="tm_org_roster"||name==="tm_org_stats")
        return {data:[],error:null};
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
    assert(!doc.querySelector("#tm-organizer").hidden===false);
  }finally{t.close();}
});
