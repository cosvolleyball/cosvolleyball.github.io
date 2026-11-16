import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { JSDOM } from "jsdom";
const root=path.resolve(import.meta.dirname,"../website");
const homepage=fs.readFileSync(path.join(root,"index.html"),"utf8");
const teamsPage=fs.readFileSync(path.join(root,"teams/index.html"),"utf8");
const teamsStyle=fs.readFileSync(path.join(root,"teams/teams.css"),"utf8");

test("main website navigation points to integrated Teams Manager",()=>{
  const dom=new JSDOM(homepage);
  const link=dom.window.document.querySelector('#teams-manager-link');
  assert(link,"Teams Manager navigation link is missing");
  assert.equal(link.getAttribute("href"),"./teams/");
  assert.equal(link.textContent.trim(),"Teams Manager");
  assert(!homepage.includes("farikolninja97.github.io/vb-autosorter"),
    "Legacy external Teams link should be replaced");
});

test("Teams Manager is isolated from existing app.js initialization",()=>{
  const dom=new JSDOM(teamsPage);
  const doc=dom.window.document;
  assert.equal(doc.title,"Teams Manager | Colorado Springs Pickup Volleyball");
  const scripts=[...doc.querySelectorAll("script")].map(s=>s.getAttribute("src"));
  assert.deepEqual(scripts,["./teams.mjs"]);
  assert(doc.querySelector('#tm-public'));
  assert(doc.querySelector('#tm-public-content'));
  assert(doc.querySelector('#tm-status'));
  assert(doc.querySelector('#tm-organizer[hidden]'));
  assert(doc.querySelector('#tm-org-active[hidden]'));
  assert(doc.querySelector('#tm-org-empty'));
  assert(doc.querySelector('#tm-final-stats[hidden]'));
});

test("all Teams Manager organizer actions are named and accessible",()=>{
  const doc=new JSDOM(teamsPage).window.document;
  const ids=[
    "tm-start-form","tm-source-event","tm-format","tm-walkin-form",
    "tm-walkin-name","tm-walkin-email","tm-generate","tm-draft",
    "tm-save-draft","tm-publish","tm-end-rotation","tm-end-session",
    "tm-roster-adjust","tm-arrival-player","tm-arrival-team",
    "tm-replace-player","tm-assign-arrival",
    "tm-appearance-correction","tm-correct-game",
    "tm-incorrect-player","tm-correct-player",
    "tm-correct-appearance-save",
    "tm-draft-balance-skill","tm-draft-balance-gender","tm-draft-balance-positions"
  ];
  for(const id of ids) assert(doc.getElementById(id),"Missing control: "+id);
  assert.equal(doc.querySelectorAll('#tm-start-form select#tm-format option').length,3);
  assert.equal(doc.querySelectorAll('#tm-team-count option').length,3);
  assert(doc.querySelector('#tm-public-content[aria-live]'));
  assert(doc.querySelector('#tm-feedback[role="status"]'));
});

test("page includes a mobile Teams Manager layout",()=>{
  assert(teamsStyle.includes("@media (max-width: 640px)"));
  assert(teamsStyle.includes(".tm-courts"));
  assert(teamsStyle.includes(".tm-roster"));
});
