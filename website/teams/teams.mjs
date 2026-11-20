import { createClient } from "https://esm.sh/@supabase/supabase-js@2.119.0";
import { generateBalancedTeams, scoreBalancedDraft, suggestSharedRolePairs } from "./balancing.mjs";
import { rotationOptions } from "./rotation-options.mjs";
import { normalizedGender, normalizedPosition, positionChoices } from "./profile-options.mjs";

// Public publishable browser credentials, matching the main site's client.
// Never embed service_role credentials or privileged data in this module.
const PRODUCTION_CONFIG = {
  url: "https://mfumtentefcuysibknyl.supabase.co",
  publishableKey: "sb_publishable_JGD9JifuMwGF37U2SCxRig_PvgA8psg"
};
// A preview served from localhost or any nonproduction domain must NOT
// silently connect to the real COS Volleyball Supabase project.
// Explicitly set window.TEAMS_MANAGER_STAGING_CONFIG before this module
// runs in a temporary preview, using only a STAGING publishable key.
const productionHost = window.location.hostname === "cosvolleyball.github.io";
const selectedConfig = productionHost
  ? PRODUCTION_CONFIG
  : window.TEAMS_MANAGER_STAGING_CONFIG;
const supabase = selectedConfig?.url && selectedConfig?.publishableKey
  ? createClient(selectedConfig.url,selectedConfig.publishableKey)
  : null;
const $ = id => document.getElementById(id);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
}[c]));
const state = {
  isOrganizer: false,
  organizerUserId: null,
  authEpoch: 0,
  retryOrganizerCheck: false,
  publicNeedsRender: false,
  organizerCheckId: 0,
  snapshot: null,
  roster: [],
  stats: [],
  priorTeammates: [],
  transferHistory: [],
  events: [],
  draft: null,
  savedDraftId: null,
  undoStack: [],
  lastPrivateRevision: null,
  lastPrivateSessionId: null,
  adjustRenderKey: null,
  appearanceRenderKey: null,
  choicesKey: null,
  correctionAppearances: [],
  refreshing: false,
  pendingRefresh: false,
  pendingForcePrivate: false
};
const statuses = ["present", "candidate", "absent", "waiting", "break", "departed"];
const readableStatus = s => ({candidate:"Not included",present:"Included",
  absent:"No-show",waiting:"Waiting",break:"On break",departed:"Departed"}[s] || "Unknown");
const sourceLabel = status => ({
  registered:"Registered",waitlisted:"Waitlisted"
}[status] || "Walk-in");

function feedback(message, isError = false) {
  const el = $("tm-feedback");
  el.hidden = false;
  el.classList.toggle("is-error",isError);
  el.textContent = message;
}
async function rpc(method, args = {}) {
  if(!supabase)throw new Error("Teams Manager requires an explicit staging configuration in previews.");
  const { data, error } = await supabase.rpc(method, args);
  if (error) throw new Error(error.message || "Request failed");
  return data;
}
async function action(fn) {
  try { await fn(); }
  catch (e) { console.error("Teams Manager action failed",e);
    feedback(e?.message || "Couldn't complete that action.",true); }
}

function teamName(teams, id) {
  return teams.find(t=>t.id===id)?.label || "To be decided";
}
function gameControls(g, teams, session) {
  if (session.rotation_status !== "published") return "";
  if (g.status === "ready") {
    const resting = teams.length === 6
      ? teams.find(t => t.court === g.court &&
          t.id !== g.team_a_id && t.id !== g.team_b_id)
      : null;
    const options = resting?.players || [];
    const borrowed = session.pendingSubs?.[g.id] || [];
    return `<div class="tm-game-actions">
      <button type="button" class="tm-button" data-tm-game-action="start"
        data-game-id="${escapeHtml(g.id)}">Start game</button>
      ${options.length ? `<div class="tm-sub-form">
        <strong>Voluntary substitute from ${escapeHtml(resting.label)}</strong>
        <label>Player<select id="sub-player-${escapeHtml(g.id)}" data-sub-player="${escapeHtml(g.id)}">
          <option value="">Choose player…</option>
          ${options.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
        </select></label>
        <label>Playing for<select id="sub-team-${escapeHtml(g.id)}" data-sub-team="${escapeHtml(g.id)}">
          <option value="">Choose team…</option>
          ${[g.team_a_id,g.team_b_id].map(id=>
            `<option value="${escapeHtml(id)}">${escapeHtml(teamName(teams,id))}</option>`).join("")}
        </select></label>
        <button type="button" class="tm-button tm-secondary"
          data-tm-game-action="sub" data-game-id="${escapeHtml(g.id)}">Record sub</button>
        ${borrowed.length ? `<div class="tm-pending-subs">
          ${borrowed.map(p=>`<div>
            ${escapeHtml(p.name)} → ${escapeHtml(teamName(teams,p.team_id))}
            <button type="button" class="tm-button tm-secondary"
              data-tm-game-action="cancel-sub" data-game-id="${escapeHtml(g.id)}"
              data-player-id="${escapeHtml(p.player_id)}">Remove</button>
          </div>`).join("")}
        </div>` : ""}
      </div>` : ""}
    </div>`;
  }
  if (g.status === "playing") {
    return `<div class="tm-game-actions">
      <label>Winner<select id="report-winner-${escapeHtml(g.id)}" data-report-winner="${escapeHtml(g.id)}">
        <option value="">Select winner…</option>
        ${[g.team_a_id,g.team_b_id].map(id=>
          `<option value="${escapeHtml(id)}">${escapeHtml(teamName(teams,id))}</option>`).join("")}
      </select></label>
      <button type="button" class="tm-button"
        data-tm-game-action="winner" data-game-id="${escapeHtml(g.id)}">Report winner</button>
    </div>`;
  }
  if (g.status === "completed" && state.isOrganizer) {
    const other = [g.team_a_id,g.team_b_id].find(id=>id!==g.winner_team_id);
    return `<div class="tm-game-actions">
      <button type="button" class="tm-button tm-secondary"
        data-tm-game-action="correct-winner" data-game-id="${escapeHtml(g.id)}"
        data-winner-id="${escapeHtml(other)}">
        Correct winner to ${escapeHtml(teamName(teams,other))}
      </button>
    </div>`;
  }
  return "";
}

function rotationTransferControls(teams, session) {
  if (teams.length !== 5 || session.rotation_status !== "published") return "";
  const options = session.transferOptions || [];
  if (!options.length) return "";
  const donorIds = new Set(options.map(o => o.player_id));
  const targetIds = new Set(options.map(o => o.target_team_id));
  const availablePlayers = teams.flatMap(team=>(team.players||[]).filter(p=>donorIds.has(p.id))
    .map(p=>({id:p.id,name:p.name,from:team.label})));
  return `<section class="tm-panel tm-transfer" aria-labelledby="tm-transfer-title">
    <h3 id="tm-transfer-title">Five-team player transfers</h3>
    <p>A team needs another player for this format. An idle team with an extra player
      can lend them until the next reshuffle.</p>
    <div class="tm-form tm-inline">
      <label>Player<select id="tm-transfer-player">
        <option value="">Choose player…</option>
        ${availablePlayers.map(p=>`<option value="${escapeHtml(p.id)}">
          ${escapeHtml(p.name)} (${escapeHtml(p.from)})
        </option>`).join("")}
      </select></label>
      <label>New team<select id="tm-transfer-target">
        <option value="">Choose team…</option>
        ${teams.filter(t=>targetIds.has(t.id)).map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}
      </select></label>
      <button type="button" class="tm-button tm-secondary"
        data-tm-game-action="transfer"
        data-rotation-id="${escapeHtml(session.rotation_id)}">Transfer until reshuffle</button>
    </div>
  </section>`;
}

// The schedule has fixed court and game positions within one rotation. Keep
// unchanged cards attached so another court can update while a picker is open.
function updatePublicSections(current, next) {
  const previous = Array.from(current.children);
  const incoming = Array.from(next.children);
  incoming.forEach((section, index) => {
    const old = previous[index];
    if (!old) {
      current.append(section);
    } else if (!old.isEqualNode(section)) {
      if ((old.matches(".tm-courts") && section.matches(".tm-courts")) ||
          (old.matches(".tm-court") && section.matches(".tm-court"))) {
        updatePublicSections(old, section);
      } else {
        old.replaceWith(section);
      }
    }
  });
  for (const extra of previous.slice(incoming.length)) extra.remove();
}

function renderPublic() {
  const s = state.snapshot;
  const status = $("tm-status");
  const container = $("tm-public-content");
  if (!s?.active) {
    status.textContent = "No active session";
    status.className = "tm-status is-offline";
    container.innerHTML = '<div class="tm-empty">No active volleyball session right now.</div>';
    return;
  }
  status.textContent = "Session live";
  status.className = "tm-status is-live";
  const teams = Array.isArray(s.teams) ? s.teams : [];
  const games = Array.isArray(s.games) ? s.games : [];
  if (!s.rotation_id || !teams.length) {
    container.innerHTML = `<div class="tm-empty">
      <h3>${escapeHtml(s.event_title || "Volleyball session")}</h3>
      <p>Organizer is checking in players and preparing teams.</p>
    </div>`;
    return;
  }
  const courts = [1,2].map(court => {
    const courtGames = games.filter(g=>g.court===court)
      .sort((a,b)=>a.round-b.round);
    const complete = courtGames.length &&
      courtGames.every(g=>["completed","abandoned"].includes(g.status));
    return `<section class="tm-court" aria-label="Court ${court}">
      <h3>Court ${court}</h3>
      ${courtGames.map(g => {
        const statusValue = ["scheduled","ready","playing","completed","abandoned"]
          .includes(g.status) ? g.status : "scheduled";
        const left = teamName(teams,g.team_a_id);
        const right = teamName(teams,g.team_b_id);
        // Five-team matches can be ready on this court but still depend on
        // a result or a team from the other court finishing an earlier game.
        const waitingAcrossCourts = teams.length===5 && g.status==="scheduled" && g.round>1
          && courtGames.filter(previous=>previous.round<g.round).every(previous=>previous.status==="completed");
        const result = g.status === "completed"
          ? "Winner: " + teamName(teams,g.winner_team_id)
          : g.status === "playing" ? "Game in progress"
          : g.status === "abandoned" ? "Not completed"
          : waitingAcrossCourts ? "Waiting for other court"
          : !g.team_a_id || !g.team_b_id ? "Waiting for opening result"
          : "Upcoming";
        return `<div class="tm-game is-${statusValue}">
          <small>Game ${g.round} · ${escapeHtml(statusValue)}</small>
          <strong>${escapeHtml(left)} vs ${escapeHtml(right)}</strong>
          <small>${escapeHtml(result)}</small>
          ${gameControls(g,teams,s)}
        </div>`;
      }).join("")}
      ${complete && s.rotation_status === "published"
        ? '<p class="tm-muted">Rotation complete — waiting for other court / organizer.</p>'
        : ""}
    </section>`;
  }).join("");
  const rosters = teams.map(team => `<article class="tm-team">
    <h3>${escapeHtml(team.label)}</h3>
    <ul>${(team.players || []).map(p=>
      `<li>${escapeHtml(p.name)}</li>`).join("")}</ul>
  </article>`).join("");
  const markup = `<h3>${escapeHtml(s.event_title || "Volleyball session")}</h3>
    <div class="tm-courts">${courts}</div>
    <h3>Team rosters</h3><div class="tm-team-grid">${rosters}</div>
    ${rotationTransferControls(teams,s)}`;
  if (container.dataset.rotation !== s.rotation_id) {
    container.innerHTML = markup;
    container.dataset.rotation = s.rotation_id;
    return;
  }
  const selections = new Map(Array.from(container.querySelectorAll("select[id]"),
    select => [select.id, select.value]));
  const next = document.createElement("template");
  next.innerHTML = markup;
  updatePublicSections(container, next.content);
  // A changed game can still offer the same valid selection. Removed players
  // and completed games must never regain an obsolete value.
  for (const select of container.querySelectorAll("select[id]")) {
    const value = selections.get(select.id);
    if (value && !select.value && Array.from(select.options).some(option => option.value===value))
      select.value=value;
  }
}

function formatStats(stats) {
  if (!Array.isArray(stats) || !stats.length) return '<p class="tm-muted">No participation recorded.</p>';
  return `<div class="tm-roster"><table class="tm-stats-table">
    <thead><tr><th>Player</th><th>Rotations played</th><th>Regular games</th><th>Sub games</th><th>Wins</th></tr></thead>
    <tbody>${stats.map(p=>`<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${Number(p.rotations)||0}</td>
      <td>${Number(p.regular_games)||0}</td>
      <td>${Number(p.sub_games)||0}</td>
      <td>${Number(p.wins)||0}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
const titleCase = word => word.charAt(0).toUpperCase() + word.slice(1);
const skillRatings = Array.from({length:10}, (_, i) => String(i + 1));

function profileSelect(choices, current, placeholder) {
  return `<option value="" disabled hidden${choices.includes(current) ? "" : " selected"}>${escapeHtml(placeholder)}</option>` + choices.map(value =>
    `<option value="${value}"${current === value ? " selected" : ""}>${titleCase(value)}</option>`).join("");
}

function positionPicker(player) {
  const saved = player.positions || [];
  const selected = saved.map(normalizedPosition);
  const isFlex = selected.includes("flex");
  const shown = isFlex ? ["flex"] : positionChoices.filter(p=>selected.includes(p));
  const previous = saved.filter(p => !positionChoices.includes(normalizedPosition(p)));
  const menuId = "positions-" + escapeHtml(player.id);
  return `<div class="tm-position-picker" data-positions>
    <button type="button" class="tm-position-trigger" popovertarget="${menuId}">
      <span class="tm-sr-only">Preferred positions for ${escapeHtml(player.name)}, </span>
      <span data-position-summary>${escapeHtml([...shown.map(titleCase), ...previous].join(", ") || "Choose positions")}</span>
    </button>
    <div class="tm-position-menu" popover="auto" id="${menuId}">
      <fieldset><legend>Choose up to two positions</legend>
        ${positionChoices.map(value => `<label><input type="checkbox" data-position value="${value}"${shown.includes(value) ? " checked" : ""}${shown.length === 2 && value !== "flex" && !shown.includes(value) ? " disabled" : ""}>${value === "flex" ? "Flex (all positions)" : titleCase(value)}</label>`).join("")}
      </fieldset>
      ${previous.length ? `<small>Previous entries: ${escapeHtml(previous.join(", "))}</small><button type="button" data-clear-positions>Clear positions</button>` : ""}
      <button type="button" class="tm-button tm-secondary" popovertarget="${menuId}" popovertargetaction="hide">Done</button>
    </div>
  </div>`;
}

// A native popover floats above the scrolling roster. Anchor it to its own
// button and use the space above when there is little room below.
let openPositionMenu = null;
function placePositionMenu() {
  const menu = openPositionMenu;
  if (!menu?.isConnected) { openPositionMenu = null; return; }
  const anchor = menu.previousElementSibling.getBoundingClientRect();
  const viewport = document.documentElement;
  const gap = 4, margin = 8;
  const height = viewport.clientHeight;
  const top = Math.max(margin, Math.min(anchor.bottom + gap, height - margin));
  const bottom = Math.max(margin, Math.min(height - anchor.top + gap, height - margin));
  const below = height - top - margin;
  const above = height - bottom - margin;
  const opensUp = below < 350 && above > below;
  const width = Math.min(Math.max(232, anchor.width), viewport.clientWidth - margin * 2);
  menu.style.width = width + "px";
  menu.style.left = Math.max(margin, Math.min(anchor.left, viewport.clientWidth - width - margin)) + "px";
  menu.style.top = opensUp ? "auto" : top + "px";
  menu.style.bottom = opensUp ? bottom + "px" : "auto";
  menu.style.maxHeight = Math.max(0, opensUp ? above : below) + "px";
}
$("tm-roster").addEventListener("beforetoggle", event => {
  if (!event.target.matches(".tm-position-menu")) return;
  if (event.newState === "open") {
    openPositionMenu = event.target;
    placePositionMenu();
  } else if (openPositionMenu === event.target) openPositionMenu = null;
}, true);
document.addEventListener("scroll", event => {
  if (openPositionMenu && !openPositionMenu.contains(event.target)) placePositionMenu();
}, true);
window.addEventListener("resize", placePositionMenu);

function updatePositionPicker(picker, changed) {
  picker.dataset.edited = "true";
  const boxes = [...picker.querySelectorAll("[data-position]")];
  if (!changed || changed.checked) {
    for (const box of boxes) {
      if (!changed || (box !== changed && (changed.value === "flex" || box.value === "flex"))) box.checked = false;
    }
  }
  const selected = boxes.filter(box => box.checked).map(box => box.value);
  for (const box of boxes) box.disabled = selected.length >= 2 && !box.checked && box.value !== "flex";
  picker.querySelector("[data-position-summary]").textContent = selected.map(titleCase).join(", ") || "Choose positions";
  picker.querySelector("small")?.remove();
  picker.querySelector("[data-clear-positions]")?.remove();
}

// Keep unrelated profile edits and keyboard focus when another player or court updates.
const savedRosterMarkup = new WeakMap();
function renderRoster() {
  const host = $("tm-roster");
  const available=state.roster.filter(p=>["present","waiting"].includes(p.attendance)).length;
  const excluded=state.roster.filter(p=>p.attendance==="absent").length;
  const pending=state.roster.filter(p=>p.attendance==="candidate").length;
  $("tm-roster-count").textContent=
    available+" available · "+excluded+" no-shows · "+pending+" pending";
  if (!state.roster.length) {
    host.innerHTML = '<p class="tm-muted">No registered players were imported. Add walk-ins below.</p>';
    return;
  }
  const template = document.createElement("template");
  template.innerHTML = `<table class="tm-attendance-table">
    <thead><tr><th>Player</th><th>Event list</th><th>Included for teams?</th>
      <th>Quick action</th><th>Skill (1–10)</th>
      <th>Gender</th><th>Preferred positions (max 2)</th><th>Save profile</th></tr></thead>
    <tbody>${state.roster.map(p=>`<tr data-player-row="${escapeHtml(p.id)}">
      <td data-label="Player">${escapeHtml(p.name)}</td>
      <td data-label="Event list">${escapeHtml(sourceLabel(p.source_status))}</td>
      <td data-label="Available for teams"><label class="tm-sr-only" for="att-${escapeHtml(p.id)}">Attendance for ${escapeHtml(p.name)}</label>
      <select id="att-${escapeHtml(p.id)}" data-attendance="${escapeHtml(p.id)}">
      ${statuses.map(st=>`<option value="${st}" ${st===p.attendance?"selected":""}>${readableStatus(st)}</option>`).join("")}
      </select></td>
      <td data-label="Attendance action">${["present","waiting"].includes(p.attendance) ?
        `<button type="button" class="tm-button tm-secondary tm-roster-save"
          data-mark-no-show="${escapeHtml(p.id)}">Mark no-show</button>` :
        `<button type="button" class="tm-button tm-secondary tm-roster-save"
          data-include-player="${escapeHtml(p.id)}">Include</button>`}</td>
      <td data-label="Skill (1–10)"><label class="tm-sr-only" for="skill-${escapeHtml(p.id)}">Skill for ${escapeHtml(p.name)}</label>
        <select id="skill-${escapeHtml(p.id)}" class="tm-skill" data-skill>${profileSelect(skillRatings, String(p.skill), "Unrated")}</select></td>
      <td data-label="Gender"><label class="tm-sr-only" for="gender-${escapeHtml(p.id)}">Gender for ${escapeHtml(p.name)}</label>
        <select id="gender-${escapeHtml(p.id)}" data-gender>${profileSelect(["male","female"], normalizedGender(p.gender),
          p.gender ? "Previous entry: " + p.gender : "Choose gender")}</select></td>
      <td data-label="Preferred positions">${positionPicker(p)}</td>
      <td data-label="Save profile"><button type="button" class="tm-button tm-secondary tm-roster-save"
        data-save-profile="${escapeHtml(p.id)}">Save</button></td>
    </tr>`).join("")}</tbody></table>`;
  const table = template.content.firstElementChild;
  const nextRows = [...table.tBodies[0].rows];
  const existingBody = host.querySelector("tbody");
  if (!existingBody) {
    for (const row of nextRows) savedRosterMarkup.set(row, row.innerHTML);
    host.replaceChildren(table);
    return;
  }
  const previous = new Map([...existingBody.rows].map(row => [row.dataset.playerRow, row]));
  nextRows.forEach((next, index) => {
    const old = previous.get(next.dataset.playerRow);
    const markup = next.innerHTML;
    const row = savedRosterMarkup.get(old) === markup ? old : next;
    if (old && old !== row) old.replaceWith(row);
    if (existingBody.rows[index] !== row) existingBody.insertBefore(row, existingBody.rows[index] || null);
    savedRosterMarkup.set(row, markup);
    previous.delete(next.dataset.playerRow);
  });
  for (const row of previous.values()) row.remove();
}

function currentDraftTeams() { return state.draft?.teams || []; }
function invalidateSavedDraft() {
  state.savedDraftId = null;
  $("tm-publish").disabled = true;
  $("tm-save-draft").disabled = !state.draft;
}
function openingSlot(seed, teamCount) {
  if (teamCount === 4) return seed <= 2 ? "Court 1" : "Court 2";
  if (seed === 3) return teamCount === 6 ? "Rest on Court 1" : "Rest";
  if (seed === 6) return "Rest on Court 2";
  return seed <= 2 ? "Court 1" : "Court 2";
}

function renderDraft() {
  const host = $("tm-draft");
  const teams = currentDraftTeams();
  $("tm-undo").disabled = state.undoStack.length===0;
  $("tm-save-draft").disabled = !teams.length;
  $("tm-publish").disabled = !state.savedDraftId;
  if (!teams.length) {
    host.innerHTML = '<p class="tm-muted">No draft generated yet.</p>';
    return;
  }
  const lookup = new Map(state.roster.map(p=>[p.id,p]));
  host.innerHTML = `<p class="tm-muted">Private draft — ${state.savedDraftId?"saved, not published":"unsaved preview"}.
      ${state.draft?.qualityScore===null?"Balance score not yet recalculated.":
      "Current balance score (lower is better): " + escapeHtml(state.draft?.qualityScore ?? "N/A")}
      ${Number.isFinite(state.draft?.initialScore) ?
      " · Initial score: " + escapeHtml(state.draft.initialScore) : ""}</p>
    <div class="tm-team-grid">
    ${teams.map((team,teamIndex)=>`<article class="tm-team">
      <h4>Team ${team.seed} <small>(${team.playerIds.length} players)</small></h4>
      <div class="tm-edit-row">
        <span>Opening round · ${openingSlot(team.seed,teams.length)}</span>
        <label class="tm-sr-only" for="slot-${team.seed}">Swap opening slot for Team ${team.seed}</label>
        <select id="slot-${team.seed}"><option value="">Swap slots with…</option>
          ${teams.filter(t=>t.seed!==team.seed).map(t=>
            `<option value="${t.seed}">Team ${t.seed} · ${openingSlot(t.seed,teams.length)}</option>`).join("")}
        </select>
        <button type="button" class="tm-button tm-secondary" data-swap-slot="${team.seed}">Swap team slots</button>
      </div>
      ${team.playerIds.length>state.draft.playingFormat
        ? `<p class="tm-muted">Extra roster player(s) can rotate into games.
          ${(state.draft.sharedRolePairs||[]).filter(p=>p.seed===team.seed).map(p=>
            "Suggested shared-role pair: "+
            p.playerIds.map(id=>escapeHtml(lookup.get(id)?.name||id)).join(" + ")
          ).join("")}</p>`
        : ""}
      ${team.playerIds.map(id=>{
        const player = lookup.get(id);
        const swapTargets=teams.flatMap((other,i)=>i===teamIndex?[]:
          other.playerIds.map(otherId=>({id:otherId,seed:other.seed})));
        return `<div class="tm-edit-row">
          <span>${escapeHtml(player?.name || id)}</span>
          <label class="tm-sr-only" for="swap-${escapeHtml(id)}">Swap player</label>
          <select id="swap-${escapeHtml(id)}" data-swap-target="${escapeHtml(id)}">
          <option value="">Swap with…</option>
          ${swapTargets.map(other=>`<option value="${escapeHtml(other.id)}">T${other.seed}: ${escapeHtml(lookup.get(other.id)?.name || other.id)}</option>`).join("")}
          </select>
          <button type="button" class="tm-button tm-secondary" data-swap-player="${escapeHtml(id)}">Swap</button>
          <label class="tm-sr-only" for="move-${escapeHtml(id)}">Move player</label>
          <select id="move-${escapeHtml(id)}" data-move-target="${escapeHtml(id)}">
            <option value="">Move to…</option>
            ${teams.filter(t=>t.seed!==team.seed).map(t=>`<option value="${t.seed}">Team ${t.seed}</option>`).join("")}
          </select>
          <button type="button" class="tm-button tm-secondary" data-move-player="${escapeHtml(id)}">Move</button>
        </div>`;
      }).join("")}
    </article>`).join("")}</div>`;
}

function scoreCurrentDraft() {
  if(!state.draft)return;
  const byEmail=new Map(state.stats.map(p=>[p.email,Number(p.regular_games)||0]));
  const available=state.roster.filter(p=>
    ["present","waiting"].includes(p.attendance));
  const players=available.map(p=>({
    id:p.id,skill:p.skill,gender:p.gender,positions:p.positions,
    regularGames:byEmail.get(p.email)||0
  }));
  const settings=state.draft.appliedOptions||{
    balanceSkill:$("tm-draft-balance-skill").checked,
    balanceGender:$("tm-draft-balance-gender").checked,
    balancePositions:$("tm-draft-balance-positions").checked
  };
  state.draft.qualityScore=scoreBalancedDraft(players,state.draft.teams,{
    ...settings,
    teamCount:state.draft.teams.length,
    format:state.draft.playingFormat,
    priorTeammates:state.priorTeammates
  });
  state.draft.sharedRolePairs=suggestSharedRolePairs(
    players,state.draft.teams,state.draft.playingFormat);
}
function rememberEdit() {
  state.undoStack.push(JSON.parse(JSON.stringify(state.draft.teams)));
  if (state.undoStack.length>30) state.undoStack.shift();
  state.draft.qualityScore=null;
  invalidateSavedDraft();
}
function editDraft(type,playerId,targetId) {
  const teams=currentDraftTeams();
  const source=teams.find(t=>t.playerIds.includes(playerId));
  if (!source) throw new Error("Player no longer in preview.");
  const sourceIndex=source.playerIds.indexOf(playerId);
  if (type==="swap") {
    const destination=teams.find(t=>t.playerIds.includes(targetId));
    if (!destination || destination===source) throw new Error("Choose a player on another team.");
    rememberEdit();
    const idx=destination.playerIds.indexOf(targetId);
    source.playerIds[sourceIndex]=targetId;
    destination.playerIds[idx]=playerId;
  } else {
    const destination=teams.find(t=>String(t.seed)===String(targetId));
    if (!destination || destination===source) throw new Error("Choose another team.");
    const minimum=teams.length===6?4:state.draft.playingFormat;
    if(source.playerIds.length<=minimum){
      throw new Error("That transfer would leave the source team too small.");
    }
    rememberEdit();
    source.playerIds.splice(sourceIndex,1);
    destination.playerIds.push(playerId);
  }
  scoreCurrentDraft();
  renderDraft();
}
function renderEventPicker() {
  const select=$("tm-source-event");
  const selected=select.value;
  select.innerHTML = '<option value="">Choose event…</option>'+
    state.events.map(e=>`<option value="${escapeHtml(e.id)}">
      ${escapeHtml(e.title)} · ${new Date(e.starts_at).toLocaleDateString()} ${e.visibility==="private"?"(private)":""}
    </option>`).join("");
  if(state.events.some(e=>e.id===selected))select.value=selected;
  constrainFormat();
}
function constrainFormat() {
  const selected=state.events.find(e=>e.id===$("tm-source-event").value);
  const privateEvent=selected?.visibility==="private";
  const five=$("tm-format").querySelector('option[value="5"]');
  five.disabled=privateEvent;
  if(privateEvent&&$("tm-format").value==="5")$("tm-format").value="6";
  const four=$("tm-format").value==="4";
  $("tm-balance-positions").disabled=four;
  if(four)$("tm-balance-positions").checked=false;
}
function updateReplacementOptions() {
  const teams=state.snapshot?.teams||[];
  const selectedTeam=teams.find(t=>t.id===$("tm-arrival-team").value);
  const previous=$("tm-replace-player").value;
  const candidates=(selectedTeam?.players||[]).filter(p=>{
    const profile=state.roster.find(r=>r.id===p.id);
    return ["break","departed"].includes(profile?.attendance);
  });
  $("tm-replace-player").innerHTML=
    '<option value="">No replacement — fill an open spot</option>'+
    candidates.map(p=>`<option value="${escapeHtml(p.id)}">
      ${escapeHtml(p.name)} (${escapeHtml(
        readableStatus(state.roster.find(r=>r.id===p.id)?.attendance))})
    </option>`).join("");
  if(candidates.some(p=>p.id===previous))$("tm-replace-player").value=previous;
}
function renderRosterAdjust() {
  const panel=$("tm-roster-adjust");
  const snapshot=state.snapshot;
  const shown=Boolean(snapshot?.active&&snapshot.rotation_status==="published");
  panel.hidden=!shown;
  if(!shown){
    state.adjustRenderKey=null;
    return;
  }
  const key=snapshot.session_id+":"+snapshot.revision;
  if(state.adjustRenderKey===key)return;
  state.adjustRenderKey=key;
  const teams=snapshot.teams||[];
  const currentPlayer=$("tm-arrival-player").value;
  const currentTeam=$("tm-arrival-team").value;
  const assigned=new Set(teams.flatMap(t=>(t.players||[]).map(p=>p.id)));
  const unassigned=state.roster.filter(p=>
    ["present","waiting"].includes(p.attendance)&&!assigned.has(p.id));
  $("tm-arrival-player").innerHTML='<option value="">Choose player…</option>'+
    unassigned.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
  if(unassigned.some(p=>p.id===currentPlayer))$("tm-arrival-player").value=currentPlayer;
  $("tm-arrival-team").innerHTML='<option value="">Choose team…</option>'+
    teams.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("");
  if(teams.some(t=>t.id===currentTeam))$("tm-arrival-team").value=currentTeam;
  updateReplacementOptions();
  $("tm-assign-arrival").disabled=!unassigned.length;
}

function updateCorrectionCandidateOptions() {
  const wrongId=$("tm-incorrect-player").value;
  const old=state.correctionAppearances.find(p=>p.player_id===wrongId);
  const game=(state.snapshot?.games||[]).find(g=>
    g.id===$("tm-correct-game").value);
  const teamList=state.snapshot?.teams||[];
  const team=old && (old.is_substitute
    ? teamList.find(t=>t.court===game?.court &&
        t.id!==game?.team_a_id && t.id!==game?.team_b_id)
    : teamList.find(t=>t.id===old.team_id));
  const recorded=new Set(state.correctionAppearances.map(p=>p.player_id));
  const choices=(team?.players||[]).filter(p=>!recorded.has(p.id));
  $("tm-correct-player").innerHTML='<option value="">Choose replacement…</option>'+
    choices.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("");
}
async function loadCorrectionGame() {
  const epoch=state.authEpoch,session=state.snapshot?.session_id;
  const id=$("tm-correct-game").value;
  $("tm-incorrect-player").innerHTML='<option value="">Choose recorded player…</option>';
  $("tm-correct-player").innerHTML='<option value="">Choose replacement…</option>';
  state.correctionAppearances=[];
  if(!id)return;
  const current=await rpc("tm_org_game_appearances",{p_game_id:id});
  if(!privateRequestIsCurrent(epoch,session) || $("tm-correct-game").value!==id)return;
  state.correctionAppearances=Array.isArray(current)?current:[];
  $("tm-incorrect-player").innerHTML='<option value="">Choose recorded player…</option>'+
    state.correctionAppearances.map(p=>`<option value="${escapeHtml(p.player_id)}">
      ${escapeHtml(p.name)} — ${escapeHtml(teamName(state.snapshot?.teams||[],p.team_id))}
      ${p.is_substitute?"(substitute)":""}
    </option>`).join("");
}
function renderAppearanceCorrection() {
  const panel=$("tm-appearance-correction");
  const snapshot=state.snapshot;
  const matches=(snapshot?.games||[]).filter(g=>g.status==="completed");
  const visible=Boolean(snapshot?.active&&state.isOrganizer&&matches.length);
  panel.hidden=!visible;
  if(!visible){
    state.appearanceRenderKey=null;
    return;
  }
  const key=snapshot.session_id+":"+snapshot.revision;
  if(state.appearanceRenderKey===key)return;
  state.appearanceRenderKey=key;
  const selected=$("tm-correct-game").value;
  $("tm-correct-game").innerHTML='<option value="">Choose game…</option>'+
    matches.map(g=>`<option value="${escapeHtml(g.id)}">
      Court ${g.court}, game ${g.round} — ${escapeHtml(
        teamName(snapshot.teams||[],g.team_a_id))} vs ${escapeHtml(
        teamName(snapshot.teams||[],g.team_b_id))}
    </option>`).join("");
  if(matches.some(g=>g.id===selected)){
    $("tm-correct-game").value=selected;
    void action(loadCorrectionGame);
  }else{
    state.correctionAppearances=[];
    $("tm-incorrect-player").innerHTML='<option value="">Choose recorded player…</option>';
    $("tm-correct-player").innerHTML='<option value="">Choose replacement…</option>';
  }
}

function selectedRotationChoice() {
  const formats=Array.isArray(state.snapshot?.allowed_formats)
    ? state.snapshot.allowed_formats : [4,5,6];
  const all=rotationOptions(state.roster.filter(p=>
    ["present","waiting"].includes(p.attendance)).length,{
      privateEvent:!formats.includes(5)
    });
  return all.find(choice=>choice.teamCount===Number($("tm-team-count").value)
    &&choice.format===Number($("tm-draft-format").value));
}
function updateRotationChoices(resetFormat = false) {
  const formats=Array.isArray(state.snapshot?.allowed_formats)
    ? state.snapshot.allowed_formats : [4,5,6];
  const count=state.roster.filter(p=>
    ["present","waiting"].includes(p.attendance)).length;
  const all=rotationOptions(count,{privateEvent:!formats.includes(5)});
  const key=state.snapshot?.session_id+":"+count+":"+formats.join(",");
  const teamPicker=$("tm-team-count");
  const formatPicker=$("tm-draft-format");
  const availableTeams=[...new Set(all.map(c=>c.teamCount))].sort((a,b)=>b-a);
  if(key!==state.choicesKey) {
    state.choicesKey=key;
    const oldTeam=Number(teamPicker.value);
    teamPicker.innerHTML=availableTeams.map(n=>
      '<option value="'+n+'">'+n+' teams</option>').join("");
    if(availableTeams.includes(oldTeam))teamPicker.value=String(oldTeam);
    else if(availableTeams.length)teamPicker.value=String(availableTeams[0]);
    resetFormat=true;
  }
  const teamCount=Number(teamPicker.value);
  const eligible=all.filter(c=>c.teamCount===teamCount);
  const oldFormat=Number(formatPicker.value);
  formatPicker.innerHTML=eligible.map(c=>
    '<option value="'+c.format+'">'+c.format+'v'+c.format+
      (c.needsBorrowedSubs?' (borrowed subs needed)':'')+
      (c.recommended?' · recommended':'')+
    '</option>').join("");
  let preferred=eligible.find(c=>c.recommended);
  // Favor the largest sensible playing format for a chosen team count.
  preferred=[...eligible].filter(c=>c.recommended)
    .sort((a,b)=>b.format-a.format)[0]||eligible[0];
  if(eligible.length) {
    formatPicker.value=String(!resetFormat &&
      eligible.some(c=>c.format===oldFormat)?oldFormat:preferred.format);
  }
  teamPicker.disabled=!availableTeams.length;
  formatPicker.disabled=!eligible.length;
  const choice=selectedRotationChoice();
  $("tm-distribution-summary").textContent=choice
    ? count+" checked in and available · "+choice.summary+
      " · "+choice.format+" on court per team"+
      (choice.needsBorrowedSubs
        ?" · Volunteer same-court substitutes needed for short rosters." : "")+
      (choice.sizes.some(n=>n>choice.format)
        ?" · Extra roster members may rotate into a game." : "")
    : count+" available · No supported team distribution at this attendance count.";
  $("tm-draft-balance-positions").disabled=!choice||choice.format===4;
  if(choice?.format===4)$("tm-draft-balance-positions").checked=false;
  if(!choice)$("tm-generate").disabled=true;
}
function renderTransferCorrection() {
  const el=$("tm-transfer-correction");
  const snap=state.snapshot;
  const transfers=state.transferHistory;
  const visible=Boolean(snap?.active &&
    snap.rotation_status==="published" && snap.teams?.length===5 &&
    transfers.length);
  el.hidden=!visible;
  if(!visible)return;
  const player=$("tm-transfer-correction-player");
  const team=$("tm-transfer-correction-team");
  const prevPlayer=player.value,prevTeam=team.value;
  player.innerHTML='<option value="">Choose transferred player…</option>'+
    transfers.map(p=>`<option value="${escapeHtml(p.player_id)}">
      ${escapeHtml(p.name)} (now on ${escapeHtml(
        teamName(snap.teams,p.current_team_id))})
    </option>`).join("");
  team.innerHTML='<option value="">Choose team…</option>'+
    snap.teams.map(t=>`<option value="${escapeHtml(t.id)}">
      ${escapeHtml(t.label)}
    </option>`).join("");
  if(transfers.some(p=>p.player_id===prevPlayer))player.value=prevPlayer;
  if(snap.teams.some(t=>t.id===prevTeam))team.value=prevTeam;
}

function renderOrganizer() {
  if(!state.isOrganizer)return;
  const active=Boolean(state.snapshot?.active);
  $("tm-org-empty").hidden=active;
  $("tm-org-active").hidden=!active;
  if(!active)return;
  const rotation=state.snapshot;
  const activeRotation=rotation.rotation_status==="published";
  updateRotationChoices();
  $("tm-generate").disabled=activeRotation || !selectedRotationChoice();
  const canEnd=activeRotation && (rotation.games||[]).length>0;
  $("tm-end-rotation").disabled=!canEnd;
  const allComplete=canEnd && rotation.games.every(g=>g.status==="completed");
  $("tm-end-rotation").textContent=allComplete?"Complete rotation":"End rotation early";
  renderDraft();
  renderRosterAdjust();
  renderAppearanceCorrection();
  renderTransferCorrection();
}
function showOrganizerAccess(signedIn) {
  const link = $("tm-organizer-link");
  link.textContent = signedIn ? "Organizer Dashboard" : "Organizer Login";
  link.classList.toggle("is-signed-in", signedIn);
  $("tm-organizer").hidden = !signedIn;
}

// Forget private data immediately on logout, lost access or page caching.
// The epoch also invalidates requests that were already in flight.
function clearOrganizer(retryAfterNetworkError = false) {
  state.retryOrganizerCheck = retryAfterNetworkError;
  state.authEpoch++;
  state.organizerCheckId++;
  state.isOrganizer=false;
  state.organizerUserId=null;
  for(const key of ["roster","stats","priorTeammates","transferHistory",
    "events","undoStack","correctionAppearances"])state[key]=[];
  for(const key of ["draft","savedDraftId","lastPrivateRevision",
    "lastPrivateSessionId","adjustRenderKey","appearanceRenderKey","choicesKey"])
    state[key]=null;
  showOrganizerAccess(false);
  $("tm-final-stats").hidden=true;
  for(const id of ["tm-roster","tm-roster-count","tm-draft","tm-stats",
    "tm-final-stats-body"])$(id).replaceChildren();
  for(const id of ["tm-source-event","tm-arrival-player","tm-arrival-team",
    "tm-replace-player","tm-transfer-correction-player","tm-transfer-correction-team",
    "tm-correct-game","tm-incorrect-player","tm-correct-player"])
    $(id).replaceChildren(new Option("Choose…",""));
  $("tm-walkin-form").reset();
  $("tm-feedback").hidden=true;
  $("tm-feedback").textContent="";
  // Public cards may contain organizer-only correction controls.
  if(state.snapshot)renderPublic();
}
function privateRequestIsCurrent(epoch,session) {
  return state.isOrganizer && state.authEpoch===epoch &&
    state.snapshot?.session_id===session;
}
async function loadPrivate() {
  const session=state.snapshot?.session_id;
  const epoch=state.authEpoch;
  if(!session || !state.isOrganizer)return;
  const [roster,stats,remote,pairs,transfers] = await Promise.all([
    rpc("tm_org_roster",{p_session_id:session}),
    rpc("tm_org_stats",{p_session_id:session}),
    rpc("tm_org_draft",{p_session_id:session}),
    rpc("tm_org_teammate_pairs",{p_session_id:session}),
    state.snapshot.rotation_status==="published" &&
      state.snapshot.teams?.length===5
      ? rpc("tm_org_transfers",{p_rotation_id:state.snapshot.rotation_id})
      : Promise.resolve([])
  ]);
  if(!privateRequestIsCurrent(epoch,session))return;
  if(state.lastPrivateSessionId!==session){
    $("tm-final-stats").hidden=true;
    $("tm-final-stats-body").replaceChildren();
    state.draft=null;state.savedDraftId=null;state.undoStack=[];
  }
  state.roster=Array.isArray(roster)?roster:[];
  state.stats=Array.isArray(stats)?stats:[];
  state.priorTeammates=Array.isArray(pairs)?pairs:[];
  state.transferHistory=Array.isArray(transfers)?transfers:[];
  if(remote && (!state.draft || state.savedDraftId)){
    state.draft={teams:remote.teams,qualityScore:null,
      playingFormat:remote.playing_format};
    state.savedDraftId=remote.rotation_id;
    state.undoStack=[];
  }
  state.lastPrivateRevision=state.snapshot.revision;
  state.lastPrivateSessionId=session;
  renderRoster();
  renderOrganizer();
}
async function refresh(forcePrivate = false) {
  // If a broadcast arrives during a network request, guarantee a second
  // server read rather than silently discarding the newest revision.
  if(state.refreshing){
    state.pendingRefresh=true;
    state.pendingForcePrivate ||= forcePrivate;
    return;
  }
  state.refreshing=true;
  try {
    if(state.isOrganizer || state.retryOrganizerCheck)await checkOrganizer();
    const snapshot = await rpc("tm_public_snapshot");
    if (snapshot?.active && snapshot.rotation_status === "published") {
      const ready = (snapshot.games||[]).filter(g=>g.status==="ready");
      if (snapshot.teams?.length === 5) {
        snapshot.transferOptions = await rpc("tm_public_transfer_options", {p_rotation_id:snapshot.rotation_id});
      }
      if(snapshot.teams?.length===6){
        const rows = await Promise.all(ready.map(async g=>({
          id:g.id,subs:await rpc("tm_public_game_subs",{p_game_id:g.id})
        })));
        snapshot.pendingSubs = Object.fromEntries(
          rows.map(row=>[row.id,Array.isArray(row.subs)?row.subs:[]])
        );
      }
    }
    // Avoid resetting a user's form selections on every automatic poll.
    const before = state.snapshot;
    const changes = !before || before.active !== snapshot?.active ||
      before.session_id !== snapshot?.session_id ||
      before.rotation_id !== snapshot?.rotation_id ||
      before.revision !== snapshot?.revision;
    state.snapshot = snapshot;
    if(changes || state.publicNeedsRender){
      renderPublic();
      state.publicNeedsRender=false;
    }
    if(state.isOrganizer){
      if(snapshot?.active && (forcePrivate ||
         state.lastPrivateRevision!==snapshot.revision ||
         state.lastPrivateSessionId!==snapshot.session_id)){
        await loadPrivate();
      }else if(changes || forcePrivate){
        renderOrganizer();
      }
    }
  } catch(err) {
    if(state.isOrganizer)clearOrganizer(true);
    state.publicNeedsRender=true;
    console.error("Teams Manager data refresh failed",err);
    $("tm-status").textContent="Unavailable";
    $("tm-status").className="tm-status is-offline";
    $("tm-public-content").innerHTML =
      '<div class="tm-empty">Teams Manager is temporarily unavailable. Other site features are unaffected.</div>';
  } finally {
    state.refreshing=false;
    if(state.pendingRefresh){
      const pendingPrivate=state.pendingForcePrivate;
      state.pendingRefresh=false;
      state.pendingForcePrivate=false;
      void refresh(pendingPrivate);
    }
  }
}
async function checkOrganizer() {
  const epoch=state.authEpoch;
  const checkId=++state.organizerCheckId;
  const current=()=>epoch===state.authEpoch && checkId===state.organizerCheckId;
  try {
    const {data,error}=await supabase.auth.getUser();
    if(!current())return;
    if(error || !data?.user){
      clearOrganizer(Boolean(error && error.name !== "AuthSessionMissingError"));
      return;
    }
    const {data:row,error:roleError}=await supabase.from("organizers")
      .select("user_id").eq("user_id",data.user.id).maybeSingle();
    if(!current())return;
    if(roleError || !row){clearOrganizer(Boolean(roleError));return;}
    state.retryOrganizerCheck=false;
    if(state.isOrganizer && state.organizerUserId===data.user.id)return;
    const {data:events,error:eventError}=await supabase.from("events")
      .select("id,title,starts_at,status,visibility")
      .eq("status","published").order("starts_at",{ascending:false});
    if(!current())return;
    if(eventError){clearOrganizer(true);feedback("Unable to load organizer events.",true);return;}
    state.isOrganizer=true;
    state.organizerUserId=data.user.id;
    state.events=events||[];
    showOrganizerAccess(true);
    renderEventPicker();
    if(state.snapshot)renderPublic();
  } catch(error) {
    if(current())clearOrganizer(true);
    throw error;
  }
}

// Anonymous player operations never require an account; every RPC enforces
// team/rotation eligibility and atomically rejects stale or competing actions.
$("tm-public-content").addEventListener("click",e=>{
  const btn=e.target.closest("[data-tm-game-action]");
  if(!btn)return;
  void action(async()=>{
    const name=btn.dataset.tmGameAction;
    const gameId=btn.dataset.gameId;
    const games=state.snapshot?.games || [];
    const teams=state.snapshot?.teams || [];
    const game=games.find(g=>g.id===gameId);
    if(name==="start"){
      if(!game || game.status!=="ready")throw new Error("Game is no longer ready.");
      if(!window.confirm("Start "+teamName(teams,game.team_a_id)+
         " vs "+teamName(teams,game.team_b_id)+"?"))return;
      await rpc("tm_public_start_game",{p_game_id:gameId});
      feedback("Game started.");
    }else if(name==="winner"){
      if(!game || game.status!=="playing")throw new Error("Game is no longer in progress.");
      const selected=document.querySelector('[data-report-winner="'+gameId+'"]')?.value;
      if(!selected || ![game.team_a_id,game.team_b_id].includes(selected)){
        throw new Error("Choose the winning team.");
      }
      if(!window.confirm("Confirm "+teamName(teams,selected)+" won this game?"+
          " This cannot be changed by players afterward."))return;
      await rpc("tm_public_report_winner",{
        p_game_id:gameId,p_winner_team_id:selected
      });
      feedback("Winner recorded. The schedule has been updated.");
    }else if(name==="correct-winner"){
      if(!state.isOrganizer)throw new Error("Organizer access required.");
      const selected=btn.dataset.winnerId;
      if(!game || game.status!=="completed" ||
          ![game.team_a_id,game.team_b_id].includes(selected))
        throw new Error("Only completed games can be corrected.");
      if(!window.confirm("Change the winner to "+teamName(teams,selected)+"?"+
          " This may update subsequent matchups."))return;
      await rpc("tm_org_correct_winner",{
        p_game_id:gameId,p_winner_team_id:selected
      });
      feedback("Winner corrected.");
    }else if(name==="sub"){
      if(!game || game.status!=="ready")throw new Error("Game is not ready.");
      const player=document.querySelector('[data-sub-player="'+gameId+'"]')?.value;
      const target=document.querySelector('[data-sub-team="'+gameId+'"]')?.value;
      if(!player||!target)throw new Error("Choose a substitute and a playing team.");
      if(!window.confirm("Record a voluntary substitute for "+
          teamName(teams,target)+" in this game only?"))return;
      await rpc("tm_public_record_sub",{
        p_game_id:gameId,p_session_player_id:player,p_target_team_id:target
      });
      feedback("One-game substitute recorded.");
    }else if(name==="cancel-sub"){
      const player=btn.dataset.playerId;
      if(!game || game.status!=="ready" || !player)
        throw new Error("This substitute can no longer be removed.");
      if(!window.confirm("Remove this planned substitute?"))return;
      await rpc("tm_public_cancel_sub",{
        p_game_id:gameId,p_session_player_id:player
      });
      feedback("Planned substitute removed.");
    }else if(name==="transfer"){
      if(state.snapshot?.teams?.length!==5 ||
          state.snapshot.rotation_status!=="published")
        throw new Error("Five-team transfers only during a published rotation.");
      const player=$("tm-transfer-player")?.value;
      const toTeam=$("tm-transfer-target")?.value;
      if(!player||!toTeam)throw new Error("Choose a player and their new team.");
      if (!state.snapshot.transferOptions?.some(o=>o.player_id===player && o.target_team_id===toTeam))
        throw new Error("This transfer is no longer needed.");
      if(!window.confirm("Transfer this player to "+teamName(teams,toTeam)+
          " until the next reshuffle? Teams must agree and neither can be playing."))return;
      await rpc("tm_public_transfer",{
        p_rotation_id:state.snapshot.rotation_id,
        p_session_player_id:player,p_to_team_id:toTeam
      });
      feedback("Player transferred for the remainder of this rotation.");
    }else{
      return;
    }
    await refresh(true);
  });
});

$("tm-team-count").addEventListener("change",()=>{
  updateRotationChoices(true);
  if(state.draft)feedback("Team count changed. Generate a new preview before publishing.");
});
$("tm-draft-format").addEventListener("change",()=>{
  updateRotationChoices(false);
  if(state.draft)feedback("Playing format changed. Generate a new preview before publishing.");
});
$("tm-source-event").addEventListener("change",constrainFormat);
$("tm-format").addEventListener("change",constrainFormat);
$("tm-start-form").addEventListener("submit",e=>{e.preventDefault();void action(async()=>{
  const eventId=$("tm-source-event").value;
  const selected=state.events.find(ev=>ev.id===eventId);
  if(!selected)throw new Error("Choose an existing event.");
  const format=Number($("tm-format").value);
  if(selected.visibility==="private"&&format===5)
    throw new Error("Private events support 4v4 or 6v6 only.");
  await rpc("tm_org_start_session",{
    p_event_id:eventId,p_format:format,
    p_balance_skill:$("tm-balance-skill").checked,
    p_balance_gender:$("tm-balance-gender").checked,
    p_balance_positions:format!==4&&$("tm-balance-positions").checked
  });
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback("Session started. Registered players are included; mark no-shows and add arrivals.");
  await refresh(true);
});});
$("tm-walkin-form").addEventListener("submit",e=>{e.preventDefault();void action(async()=>{
  await rpc("tm_org_add_walkin",{
    p_session_id:state.snapshot.session_id,
    p_name:$("tm-walkin-name").value.trim(),
    p_email:$("tm-walkin-email").value.trim()
  });
  $("tm-walkin-form").reset();
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback("Walk-in added and checked in.");
  await refresh(true);
});});
$("tm-transfer-correction-save").addEventListener("click",()=>void action(async()=>{
  const playerId=$("tm-transfer-correction-player").value;
  const target=$("tm-transfer-correction-team").value;
  if(!playerId||!target)
    throw new Error("Choose a previously transferred player and the correct team.");
  if(!window.confirm("Correct this player's team until the next reshuffle? Only possible between games."))return;
  await rpc("tm_org_correct_transfer",{
    p_rotation_id:state.snapshot.rotation_id,
    p_session_player_id:playerId,
    p_to_team_id:target
  });
  feedback("Player transfer corrected. Previous game appearances remain unchanged.");
  await refresh(true);
}));
$("tm-correct-game").addEventListener("change",()=>void action(loadCorrectionGame));
$("tm-incorrect-player").addEventListener("change",updateCorrectionCandidateOptions);
$("tm-correct-appearance-save").addEventListener("click",()=>void action(async()=>{
  const gameId=$("tm-correct-game").value;
  const wrong=$("tm-incorrect-player").value;
  const correct=$("tm-correct-player").value;
  if(!gameId||!wrong||!correct)
    throw new Error("Choose a game, incorrect participant and replacement.");
  if(!window.confirm("Correct this player's recorded game appearance?"))return;
  await rpc("tm_org_correct_appearance",{
    p_game_id:gameId,p_wrong_player_id:wrong,p_correct_player_id:correct
  });
  feedback("Game participant record corrected. Organizer statistics are updated.");
  await refresh(true);
}));
$("tm-arrival-team").addEventListener("change",updateReplacementOptions);
$("tm-assign-arrival").addEventListener("click",()=>void action(async()=>{
  if(!state.snapshot?.active||state.snapshot.rotation_status!=="published")
    throw new Error("No active published rotation to adjust.");
  const incoming=$("tm-arrival-player").value;
  const team=$("tm-arrival-team").value;
  const outgoing=$("tm-replace-player").value||null;
  if(!incoming||!team)throw new Error("Choose an unassigned player and a team.");
  if(!window.confirm("Permanently assign this player to the team until the next reshuffle?"))return;
  await rpc("tm_org_adjust_roster",{
    p_rotation_id:state.snapshot.rotation_id,
    p_in_player_id:incoming,p_team_id:team,
    p_out_player_id:outgoing
  });
  feedback("Team roster adjusted. The updated assignment is now public.");
  await refresh(true);
}));
async function updateAttendance(playerId,status) {
  await rpc("tm_org_set_attendance",{
    p_session_player_id:playerId,p_attendance:status
  });
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback(status==="absent" ? "No-show excluded from future team assignments." :
    status==="present" ? "Player included in the available roster." :
    "Attendance updated.");
  await refresh(true);
}
$("tm-roster").addEventListener("change",e=>{
  if (e.target.matches("[data-position]")) updatePositionPicker(e.target.closest("[data-positions]"), e.target);
  if (e.target.matches("[data-gender]")) e.target.dataset.edited = "true";
  const id=e.target.dataset.attendance;
  if(!id)return;
  void action(()=>updateAttendance(id,e.target.value));
});
$("tm-roster").addEventListener("click",e=>{
  if (e.target.closest("[data-clear-positions]")) updatePositionPicker(e.target.closest("[data-positions]"), null);
  const absent=e.target.closest("[data-mark-no-show]");
  const included=e.target.closest("[data-include-player]");
  if(absent)void action(()=>updateAttendance(absent.dataset.markNoShow,"absent"));
  if(included)void action(()=>updateAttendance(included.dataset.includePlayer,"present"));
});
$("tm-roster").addEventListener("click",e=>{
  const id=e.target.closest("[data-save-profile]")?.dataset.saveProfile;
  if(!id)return;
  void action(async()=>{
    const row=e.target.closest("tr");
    const player=state.roster.find(p=>p.id===id);
    if(!player)throw new Error("Player not found.");
    const raw=row.querySelector("[data-skill]").value.trim();
    const gender=row.querySelector("[data-gender]");
    const picker=row.querySelector("[data-positions]");
    // Keep an untouched legacy entry when another field is edited.
    const positions=picker.dataset.edited ? [...picker.querySelectorAll(":checked")].map(box=>box.value) : player.positions || [];
    await rpc("tm_org_save_profile",{
      p_email:player.email,p_name:player.name,
      p_skill:raw===""?null:Number(raw),
      p_gender:gender.dataset.edited ? gender.value || null : player.gender || null,
      p_positions:positions
    });
    state.draft=null;state.savedDraftId=null;state.undoStack=[];
    feedback("Player profile saved. Changes apply at the next reshuffle.");
    await loadPrivate();
  });
});
$("tm-generate").addEventListener("click",()=>void action(async()=>{
  const available=state.roster.filter(p=>["present","waiting"].includes(p.attendance));
  const byEmail=new Map(state.stats.map(p=>[p.email,Number(p.regular_games)||0]));
  const chosen=Number($("tm-team-count").value);
  const format=Number($("tm-draft-format").value);
  if(!selectedRotationChoice())throw new Error("Unsupported team count or playing format.");
  const opts={
    teamCount:chosen,format,priorTeammates:state.priorTeammates,
    balanceSkill:$("tm-draft-balance-skill").checked,
    balanceGender:$("tm-draft-balance-gender").checked,
    balancePositions:format!==4&&$("tm-draft-balance-positions").checked
  };
  state.draft=generateBalancedTeams(available.map(p=>({
    id:p.id,skill:p.skill,gender:p.gender,positions:p.positions,
    regularGames:byEmail.get(p.email)||0
  })),opts);
  state.draft.playingFormat=format;
  state.draft.sharedRolePairs=suggestSharedRolePairs(
    available,state.draft.teams,format);
  state.draft.initialScore=state.draft.qualityScore;
  state.undoStack=[];state.savedDraftId=null;
  feedback("New private team preview generated. Review before publishing.");
  renderDraft();
}));
$("tm-draft").addEventListener("click",e=>{
  const swap=e.target.closest("[data-swap-player]");
  const move=e.target.closest("[data-move-player]");
  const slot=e.target.closest("[data-swap-slot]");
  if(!swap&&!move&&!slot)return;
  void action(async()=>{
    if(slot){
      const seed=Number(slot.dataset.swapSlot);
      const other=Number($("slot-"+seed).value);
      const teams=currentDraftTeams();
      const from=teams.find(t=>t.seed===seed);
      const to=teams.find(t=>t.seed===other);
      if(!from||!to||from===to)throw new Error("Choose another team's opening slot.");
      rememberEdit();
      [from.playerIds,to.playerIds]=[to.playerIds,from.playerIds];
      scoreCurrentDraft();
      renderDraft();
    } else if(swap){
      const id=swap.dataset.swapPlayer;
      editDraft("swap",id,
        $("swap-"+id).value);
    } else {
      const id=move.dataset.movePlayer;
      editDraft("move",id,
        $("move-"+id).value);
    }
  });
});
$("tm-undo").addEventListener("click",()=>{
  if(!state.undoStack.length||!state.draft)return;
  state.draft.teams=state.undoStack.pop();
  scoreCurrentDraft();
  invalidateSavedDraft();
  renderDraft();
});
$("tm-save-draft").addEventListener("click",()=>void action(async()=>{
  if(!state.draft)throw new Error("Generate teams first.");
  if(Number($("tm-team-count").value)!==state.draft.teams.length ||
      Number($("tm-draft-format").value)!==state.draft.playingFormat)
    throw new Error("Choices changed. Generate a new preview before saving.");
  const epoch=state.authEpoch,session=state.snapshot.session_id;
  const savedId=await rpc("tm_org_save_draft",{
    p_session_id:state.snapshot.session_id,
    p_expected_revision:state.snapshot.revision,
    p_teams:{
      playing_format:state.draft.playingFormat,
      teams:state.draft.teams
    }
  });
  if(!privateRequestIsCurrent(epoch,session))return;
  state.savedDraftId=savedId;
  feedback("Draft saved privately. Only publishing makes teams visible.");
  await refresh(true);
  renderDraft();
}));
$("tm-publish").addEventListener("click",()=>void action(async()=>{
  if(!state.savedDraftId)throw new Error("Save your draft first.");
  if(Number($("tm-team-count").value)!==state.draft?.teams?.length ||
     Number($("tm-draft-format").value)!==state.draft?.playingFormat)
    throw new Error("Choices changed. Regenerate and save the selected format first.");
  if(!window.confirm("Publish these teams for everyone to see?"))return;
  await rpc("tm_org_publish_draft",{
    p_session_id:state.snapshot.session_id,
    p_expected_revision:state.snapshot.revision
  });
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback("Teams published.");
  await refresh(true);
}));
$("tm-end-rotation").addEventListener("click",()=>void action(async()=>{
  const games=state.snapshot.games||[];
  const early=games.some(g=>g.status!=="completed");
  if(!window.confirm(early?"End this rotation early and abandon unfinished games?":
    "Mark this rotation complete and allow the next reshuffle?"))return;
  await rpc("tm_org_end_rotation",{
    p_rotation_id:state.snapshot.rotation_id,p_early:early
  });
  feedback("Rotation ended. You may generate the next teams.");
  await refresh(true);
}));
$("tm-end-session").addEventListener("click",()=>void action(async()=>{
  if(!window.confirm("End this entire volleyball session? This will close the public Teams Manager."))return;
  const session=state.snapshot.session_id,epoch=state.authEpoch;
  await rpc("tm_org_end_session",{p_session_id:session});
  // Read after closure so the last accepted game result is included. A
  // realtime notification may already have switched the public view to idle.
  const mayShowSummary=()=>state.isOrganizer && state.authEpoch===epoch &&
    (!state.snapshot?.active || state.snapshot.session_id===session);
  if(!mayShowSummary())return;
  const stats=await rpc("tm_org_stats",{p_session_id:session});
  if(!mayShowSummary())return;
  $("tm-final-stats-body").innerHTML=formatStats(stats);
  $("tm-final-stats").hidden=false;
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback("Session ended. Organizer statistics are shown below.");
  await refresh(true);
}));
// Database-triggered Broadcast messages carry only revision and active flag.
// We NEVER render the untrusted broadcast payload; always fetch the
// server-sanitized tm_public_snapshot(). Rate-limit malicious/noisy
// notifications to at most one refresh per 1.2 seconds.
let publicChangesChannel=null;
let realtimeRefreshTimer=null;
let lastRealtimeRefreshAt=0;
function scheduleRealtimeRefresh() {
  if(document.hidden || realtimeRefreshTimer!==null)return;
  const delay=Math.max(200,1200-(Date.now()-lastRealtimeRefreshAt));
  realtimeRefreshTimer=setTimeout(()=>{
    realtimeRefreshTimer=null;
    lastRealtimeRefreshAt=Date.now();
    void refresh();
  },delay);
}
function connectRealtime() {
  try {
    publicChangesChannel=supabase
      .channel("teams-manager:public",{config:{private:false}})
      .on("broadcast",{event:"changed"},()=>{
        scheduleRealtimeRefresh();
      })
      .subscribe(status=>{
        // Catch anything that changed between our initial snapshot request
        // and joining the channel. Failures fall back to periodic polling.
        if(status==="SUBSCRIBED")scheduleRealtimeRefresh();
        if(["CHANNEL_ERROR","TIMED_OUT"].includes(status)){
          console.warn("Teams Manager live connection interrupted; polling remains enabled");
        }
      });
  } catch(err) {
    console.warn("Teams Manager live connection unavailable; polling remains enabled",err);
  }
}
(async()=>{
  if(!supabase) {
    $("tm-status").textContent="Preview not connected";
    $("tm-status").className="tm-status is-offline";
    $("tm-public-content").innerHTML =
      '<div class="tm-empty">This development preview is not connected to a staging database. The live website is unaffected.</div>';
    return;
  }
  try {
    supabase.auth.onAuthStateChange?.((event,session)=>{
      if(event==="SIGNED_OUT" || !session?.user ||
         (state.organizerUserId && state.organizerUserId!==session.user.id))
        clearOrganizer();
      // Supabase auth callbacks must not await another auth operation.
      if(session?.user)setTimeout(()=>void action(async()=>{
        await checkOrganizer();
        await refresh(true);
      }),0);
    });
    await checkOrganizer();
    await refresh(true);
    connectRealtime();
  } catch(e) {
    console.error("Teams Manager initialization error",e);
    feedback("Teams Manager could not initialize.",true);
  }
})();
// Recovery fallback: a lost WebSocket, suspended mobile tab or missed event
// must never leave the court schedule stale indefinitely.
setInterval(()=>{if(supabase&&!document.hidden)void refresh();},8000);
document.addEventListener("visibilitychange",()=>{
  if(supabase&&!document.hidden)void action(async()=>{
    await checkOrganizer();
    await refresh(true);
  });
});
window.addEventListener("pageshow",event=>{
  if(supabase&&event.persisted)void action(async()=>{
    await checkOrganizer();
    await refresh(true);
    if(!publicChangesChannel)connectRealtime();
  });
});
window.addEventListener("pagehide",()=>{
  clearOrganizer();
  if(realtimeRefreshTimer!==null)clearTimeout(realtimeRefreshTimer);
  realtimeRefreshTimer=null;
  if(publicChangesChannel)void supabase.removeChannel(publicChangesChannel);
  publicChangesChannel=null;
});
