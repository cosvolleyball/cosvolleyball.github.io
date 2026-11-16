import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { generateBalancedTeams } from "./balancing.mjs";

// Public publishable browser credentials, matching the main site's client.
// Never embed service_role credentials or privileged data in this module.
const supabase = createClient("https://mfumtentefcuysibknyl.supabase.co", "sb_publishable_JGD9JifuMwGF37U2SCxRig_PvgA8psg");
const $ = id => document.getElementById(id);
const escapeHtml = (value = "") => String(value).replace(/[&<>"']/g, c => ({
  "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;"
}[c]));
const state = {
  isOrganizer: false,
  snapshot: null,
  roster: [],
  stats: [],
  events: [],
  draft: null,
  savedDraftId: null,
  undoStack: [],
  lastPrivateRevision: null,
  lastPrivateSessionId: null,
  refreshing: false
};
const statuses = ["candidate", "present", "waiting", "break", "departed"];
const readableStatus = s => ({candidate:"Not checked in",present:"Present",
  waiting:"Waiting",break:"On break",departed:"Departed"}[s] || "Unknown");

function feedback(message, isError = false) {
  const el = $("tm-feedback");
  el.hidden = false;
  el.classList.toggle("is-error",isError);
  el.textContent = message;
}
async function rpc(method, args = {}) {
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
        <label>Player<select data-sub-player="${escapeHtml(g.id)}">
          <option value="">Choose player…</option>
          ${options.map(p=>`<option value="${escapeHtml(p.id)}">${escapeHtml(p.name)}</option>`).join("")}
        </select></label>
        <label>Playing for<select data-sub-team="${escapeHtml(g.id)}">
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
      <label>Winner<select data-report-winner="${escapeHtml(g.id)}">
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
  const allPlayers = teams.flatMap(team=>(team.players||[])
    .map(p=>({id:p.id,name:p.name,from:team.label})));
  return `<section class="tm-panel tm-transfer" aria-labelledby="tm-transfer-title">
    <h3 id="tm-transfer-title">Five-team player transfers</h3>
    <p>Move a player between games only. This assignment lasts until the
      next organizer-published reshuffle. No mid-game interruptions or temporary subs.</p>
    <div class="tm-form tm-inline">
      <label>Player<select id="tm-transfer-player">
        <option value="">Choose player…</option>
        ${allPlayers.map(p=>`<option value="${escapeHtml(p.id)}">
          ${escapeHtml(p.name)} (${escapeHtml(p.from)})
        </option>`).join("")}
      </select></label>
      <label>New team<select id="tm-transfer-target">
        <option value="">Choose team…</option>
        ${teams.map(t=>`<option value="${escapeHtml(t.id)}">${escapeHtml(t.label)}</option>`).join("")}
      </select></label>
      <button type="button" class="tm-button tm-secondary"
        data-tm-game-action="transfer"
        data-rotation-id="${escapeHtml(session.rotation_id)}">Transfer until reshuffle</button>
    </div>
  </section>`;
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
        const result = g.status === "completed"
          ? "Winner: " + teamName(teams,g.winner_team_id)
          : g.status === "playing" ? "Game in progress"
          : g.status === "abandoned" ? "Not completed"
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
  container.innerHTML = `<h3>${escapeHtml(s.event_title || "Volleyball session")}</h3>
    <div class="tm-courts">${courts}</div>
    <h3>Team rosters</h3><div class="tm-team-grid">${rosters}</div>
    ${rotationTransferControls(teams,s)}`;
}

function formatStats(stats) {
  if (!Array.isArray(stats) || !stats.length) return '<p class="tm-muted">No participation recorded.</p>';
  return `<div class="tm-roster"><table class="tm-stats-table">
    <thead><tr><th>Player</th><th>Regular games</th><th>Sub games</th><th>Wins</th></tr></thead>
    <tbody>${stats.map(p=>`<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${Number(p.regular_games)||0}</td>
      <td>${Number(p.sub_games)||0}</td>
      <td>${Number(p.wins)||0}</td>
    </tr>`).join("")}</tbody></table></div>`;
}
function renderRoster() {
  const host = $("tm-roster");
  $("tm-roster-count").textContent = state.roster.filter(p=>
    ["present","waiting"].includes(p.attendance)).length + " available";
  if (!state.roster.length) {
    host.innerHTML = '<p class="tm-muted">No registered players were imported. Add walk-ins below.</p>';
    return;
  }
  host.innerHTML = `<table>
    <thead><tr><th>Player</th><th>Attendance</th><th>Skill (1–10)</th>
      <th>Gender</th><th>Preferred positions (max 2)</th><th>Save profile</th></tr></thead>
    <tbody>${state.roster.map(p=>`<tr data-player-row="${escapeHtml(p.id)}">
      <td>${escapeHtml(p.name)}</td>
      <td><label class="tm-sr-only" for="att-${escapeHtml(p.id)}">Attendance for ${escapeHtml(p.name)}</label>
      <select id="att-${escapeHtml(p.id)}" data-attendance="${escapeHtml(p.id)}">
      ${statuses.map(st=>`<option value="${st}" ${st===p.attendance?"selected":""}>${readableStatus(st)}</option>`).join("")}
      </select></td>
      <td><label class="tm-sr-only" for="skill-${escapeHtml(p.id)}">Skill for ${escapeHtml(p.name)}</label>
        <input id="skill-${escapeHtml(p.id)}" class="tm-skill" data-skill type="number"
        min="1" max="10" step="1" value="${p.skill ?? ""}"></td>
      <td><label class="tm-sr-only" for="gender-${escapeHtml(p.id)}">Gender for ${escapeHtml(p.name)}</label>
        <input id="gender-${escapeHtml(p.id)}" data-gender type="text" maxlength="40" value="${escapeHtml(p.gender || "")}"></td>
      <td><label class="tm-sr-only" for="positions-${escapeHtml(p.id)}">Positions for ${escapeHtml(p.name)}</label>
        <input id="positions-${escapeHtml(p.id)}" class="tm-position" data-positions type="text"
        placeholder="Setter, outside" value="${escapeHtml((p.positions||[]).join(", "))}"></td>
      <td><button type="button" class="tm-button tm-secondary tm-roster-save"
        data-save-profile="${escapeHtml(p.id)}">Save</button></td>
    </tr>`).join("")}</tbody></table>`;
}

function currentDraftTeams() { return state.draft?.teams || []; }
function invalidateSavedDraft() {
  state.savedDraftId = null;
  $("tm-publish").disabled = true;
  $("tm-save-draft").disabled = !state.draft;
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
      ${state.draft?.qualityScore===null?"Balance score requires recalculation after manual edits.":
      "Initial balance score: " + escapeHtml(state.draft?.qualityScore ?? "N/A")} </p>
    <div class="tm-team-grid">
    ${teams.map((team,teamIndex)=>`<article class="tm-team">
      <h4>Team ${team.seed} <small>(${team.playerIds.length} players)</small></h4>
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
    const minimum=teams.length===6?4:Number(state.snapshot.format);
    if(source.playerIds.length<=minimum){
      throw new Error("That transfer would leave the source team too small.");
    }
    rememberEdit();
    source.playerIds.splice(sourceIndex,1);
    destination.playerIds.push(playerId);
  }
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
function renderOrganizer() {
  if(!state.isOrganizer)return;
  const active=Boolean(state.snapshot?.active);
  $("tm-org-empty").hidden=active;
  $("tm-org-active").hidden=!active;
  if(!active)return;
  const rotation=state.snapshot;
  const activeRotation=rotation.rotation_status==="published";
  const isFour=Number(rotation.format)===4;
  $("tm-draft-balance-positions").disabled=isFour;
  if(isFour)$("tm-draft-balance-positions").checked=false;
  $("tm-generate").disabled=activeRotation;
  const canEnd=activeRotation && (rotation.games||[]).length>0;
  $("tm-end-rotation").disabled=!canEnd;
  const allComplete=canEnd && rotation.games.every(g=>g.status==="completed");
  $("tm-end-rotation").textContent=allComplete?"Complete rotation":"End rotation early";
  renderDraft();
}
async function loadPrivate() {
  const session=state.snapshot?.session_id;
  if(!session || !state.isOrganizer)return;
  const [roster,stats,remote] = await Promise.all([
    rpc("tm_org_roster",{p_session_id:session}),
    rpc("tm_org_stats",{p_session_id:session}),
    rpc("tm_org_draft",{p_session_id:session})
  ]);
  state.roster=Array.isArray(roster)?roster:[];
  state.stats=Array.isArray(stats)?stats:[];
  if(remote && (!state.draft || state.savedDraftId)){
    state.draft={teams:remote.teams,qualityScore:null};
    state.savedDraftId=remote.rotation_id;
    state.undoStack=[];
  }
  state.lastPrivateRevision=state.snapshot.revision;
  state.lastPrivateSessionId=session;
  renderRoster();
  renderOrganizer();
}
async function refresh(forcePrivate = false) {
  if(state.refreshing)return;
  state.refreshing=true;
  try {
    const snapshot = await rpc("tm_public_snapshot");
    if (snapshot?.active && snapshot.rotation_status === "published" &&
        snapshot.teams?.length === 6) {
      const ready = (snapshot.games||[]).filter(g=>g.status==="ready");
      const rows = await Promise.all(ready.map(async g=>({
        id:g.id, subs:await rpc("tm_public_game_subs",{p_game_id:g.id})
      })));
      snapshot.pendingSubs = Object.fromEntries(
        rows.map(row=>[row.id,Array.isArray(row.subs)?row.subs:[]])
      );
    }
    // Avoid resetting a user's form selections on every automatic poll.
    const before = state.snapshot;
    const changes = !before || before.active !== snapshot?.active ||
      before.session_id !== snapshot?.session_id ||
      before.rotation_id !== snapshot?.rotation_id ||
      before.revision !== snapshot?.revision;
    state.snapshot = snapshot;
    if(changes)renderPublic();
    if(state.isOrganizer){
      if(snapshot?.active && (forcePrivate ||
         state.lastPrivateRevision!==snapshot.revision ||
         state.lastPrivateSessionId!==snapshot.session_id)){
        await loadPrivate();
      }
      renderOrganizer();
    }
  } catch(err) {
    console.error("Teams Manager data refresh failed",err);
    $("tm-status").textContent="Unavailable";
    $("tm-status").className="tm-status is-offline";
    $("tm-public-content").innerHTML =
      '<div class="tm-empty">Teams Manager is temporarily unavailable. Other site features are unaffected.</div>';
  } finally {state.refreshing=false;}
}
async function checkOrganizer() {
  const {data,error}=await supabase.auth.getUser();
  if(error || !data?.user)return;
  const {data:row,error:roleError}=await supabase.from("organizers")
    .select("user_id").eq("user_id",data.user.id).maybeSingle();
  if(roleError || !row)return;
  state.isOrganizer=true;
  $("tm-organizer").hidden=false;
  const {data:events,error:eventError}=await supabase.from("events")
    .select("id,title,starts_at,status,visibility")
    .eq("status","published").order("starts_at",{ascending:false});
  if(eventError){feedback("Unable to load organizer events.",true);return;}
  state.events=events||[];
  renderEventPicker();
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
  feedback("Session started. Check in the players who are actually present.");
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
$("tm-roster").addEventListener("change",e=>{
  const id=e.target.dataset.attendance;
  if(!id)return;
  void action(async()=>{
    await rpc("tm_org_set_attendance",{
      p_session_player_id:id,p_attendance:e.target.value
    });
    state.draft=null;state.savedDraftId=null;state.undoStack=[];
    feedback("Attendance updated.");
    await refresh(true);
  });
});
$("tm-roster").addEventListener("click",e=>{
  const id=e.target.closest("[data-save-profile]")?.dataset.saveProfile;
  if(!id)return;
  void action(async()=>{
    const row=e.target.closest("tr");
    const player=state.roster.find(p=>p.id===id);
    if(!player)throw new Error("Player not found.");
    const raw=row.querySelector("[data-skill]").value.trim();
    const positions=row.querySelector("[data-positions]").value.split(",")
      .map(x=>x.trim()).filter(Boolean);
    if(positions.length>2)throw new Error("Maximum of two preferred positions.");
    await rpc("tm_org_save_profile",{
      p_email:player.email,p_name:player.name,
      p_skill:raw===""?null:Number(raw),
      p_gender:row.querySelector("[data-gender]").value.trim()||null,
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
  const format=Number(state.snapshot.format);
  const opts={
    teamCount:chosen,format,priorTeammates:[],
    balanceSkill:$("tm-draft-balance-skill").checked,
    balanceGender:$("tm-draft-balance-gender").checked,
    balancePositions:format!==4&&$("tm-draft-balance-positions").checked
  };
  state.draft=generateBalancedTeams(available.map(p=>({
    id:p.id,skill:p.skill,gender:p.gender,positions:p.positions,
    regularGames:byEmail.get(p.email)||0
  })),opts);
  state.undoStack=[];state.savedDraftId=null;
  feedback("New private team preview generated. Review before publishing.");
  renderDraft();
}));
$("tm-draft").addEventListener("click",e=>{
  const swap=e.target.closest("[data-swap-player]");
  const move=e.target.closest("[data-move-player]");
  if(!swap&&!move)return;
  void action(async()=>{
    if(swap){
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
  state.draft.qualityScore=null;
  invalidateSavedDraft();
  renderDraft();
});
$("tm-save-draft").addEventListener("click",()=>void action(async()=>{
  if(!state.draft)throw new Error("Generate teams first.");
  state.savedDraftId=await rpc("tm_org_save_draft",{
    p_session_id:state.snapshot.session_id,
    p_expected_revision:state.snapshot.revision,
    p_teams:state.draft.teams
  });
  feedback("Draft saved privately. Only publishing makes teams visible.");
  await refresh(true);
  renderDraft();
}));
$("tm-publish").addEventListener("click",()=>void action(async()=>{
  if(!state.savedDraftId)throw new Error("Save your draft first.");
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
  const stats=await rpc("tm_org_stats",{p_session_id:state.snapshot.session_id});
  await rpc("tm_org_end_session",{p_session_id:state.snapshot.session_id});
  $("tm-final-stats-body").innerHTML=formatStats(stats);
  $("tm-final-stats").hidden=false;
  state.draft=null;state.savedDraftId=null;state.undoStack=[];
  feedback("Session ended. Organizer statistics are shown below.");
  await refresh(true);
}));
(async()=>{
  try {
    await checkOrganizer();
    await refresh(true);
  } catch(e) {
    console.error("Teams Manager initialization error",e);
    feedback("Teams Manager could not initialize.",true);
  }
})();
setInterval(()=>{if(!document.hidden)void refresh();},8000);
document.addEventListener("visibilitychange",()=>{if(!document.hidden)void refresh();});
