import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Never put a service_role key in browser code.
const SUPABASE_URL = "https://mfumtentefcuysibknyl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_JGD9JifuMwGF37U2SCxRig_PvgA8psg";
const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("PASTE_") && !SUPABASE_ANON_KEY.includes("PASTE_");
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

const $ = (id) => document.getElementById(id);
const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const money = cents => new Intl.NumberFormat("en-US",{style:"currency",currency:"USD"}).format(cents/100);
const dateTime = s => new Date(s).toLocaleString("en-US",{weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"});
let eventCache = [];
let currentUser = null;
let invitedEvent = null;

// Public event URLs and private invitation URLs use the same event-page layout.
// The private invitation token is a bearer credential; visitors need no account.
const query = new URLSearchParams(window.location.search);
const inviteToken = query.get("invite");
const manageToken = query.get("manage");
const publicEventId = inviteToken === null && manageToken === null ? query.get("event") : null;
const detailRequested = inviteToken !== null || publicEventId !== null || manageToken !== null;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const validInviteToken = inviteToken && uuidPattern.test(inviteToken) ? inviteToken : null;
const validPublicEventId = publicEventId && uuidPattern.test(publicEventId) ? publicEventId : null;
const validManageToken = manageToken && uuidPattern.test(manageToken) ? manageToken : null;
const manageUrl = token => `${window.location.origin}${window.location.pathname}?manage=${encodeURIComponent(token)}`;
const inviteUrl = token => `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(token)}`;
const publicEventUrl = id => `${window.location.origin}${window.location.pathname}?event=${encodeURIComponent(id)}`;

// Organizer access lives in the header, while the same existing secure dashboard stays below.
const organizerLink = $("organizer-link");
const organizerDetails = $("admin-details");
organizerLink.addEventListener("click", (event) =>
{
  event.preventDefault();
  organizerDetails.open = true;
  $("admin").scrollIntoView({behavior:"smooth",block:"start"});
  if (!currentUser) window.setTimeout(() => $("admin-email").focus({preventScroll:true}), 350);
});

// Detail pages should return home for their Events / About navigation.
if (detailRequested)
{
  $("events-nav").href = "./#events";
  $("about-nav").href = "./#about";
}


if (detailRequested)
{
  document.body.classList.add("event-detail-view");
  document.querySelector(".brand")?.setAttribute("href", "./");
}

// The private link should not appear in search engine results.
if (inviteToken !== null || manageToken !== null)
{
  // Avoid leaking private invitation or management tokens to external sites.
  const referrer = document.createElement("meta");
  referrer.name = "referrer";
  referrer.content = "no-referrer";
  document.head.appendChild(referrer);
  const noindex = document.createElement("meta");
  noindex.name = "robots";
  noindex.content = "noindex,nofollow";
  document.head.appendChild(noindex);
}

const dateLabel = value => new Date(value).toLocaleDateString("en-US", {weekday:"long",month:"long",day:"numeric",year:"numeric"});
const timeLabel = value => new Date(value).toLocaleTimeString("en-US", {hour:"numeric",minute:"2-digit"});
const eventTimeRange = event =>
{
  const first = new Date(event.starts_at), last = new Date(event.ends_at);
  return first.toDateString() === last.toDateString()
    ? `${timeLabel(event.starts_at)} – ${timeLabel(event.ends_at)}`
    : `${timeLabel(event.starts_at)} – ${dateLabel(event.ends_at)}, ${timeLabel(event.ends_at)}`;
};


function notice(message, error=false)
{
  const n=$("notice"); n.hidden=!message; n.textContent=message; n.classList.toggle("error",error);
}

function unavailable()
{
  $("events").innerHTML = `<div class="empty-state"><h3>Almost ready to play</h3><p>Connect your Supabase project to load live events. Follow the setup guide included with this website.</p></div>`;
}

async function loadEvents()
{
  if (!supabase) return unavailable();

  const {data,error}=await supabase.rpc("public_open_gym_events");
  if(error)
  {
    const message = "Could not load events. Check the Supabase setup and SQL installation.";
    $("events").textContent = message;
    if (publicEventId !== null)
    {
      $("invitation-section").hidden = false;
      $("invitation-event").textContent = message;
    }
    console.error(error);return;
  }
  eventCache=[...(data||[])];

  // The invite-only event is deliberately separate from the public listing.
  // Keep it in the local lookup for the registration dialog.
  if (invitedEvent) eventCache.push(invitedEvent);

  if (publicEventId !== null)
  {
    renderPublicEventDetail(data || []);
  }

  if(!(data||[]).length){$("events").innerHTML='<div class="empty-state"><span class="pill">Coming soon</span><h3>No sessions posted yet</h3><p>Check back soon for the next open gym.</p></div>';return;}
  $("events").innerHTML=(data||[]).map(e=>eventCard(e)).join("");
}

function eventCard(e)
{
  const capacity = Math.max(1, Number(e.capacity) || 1);
  const remaining = Math.max(0, Number(e.spots_remaining) || 0);
  const filled = Math.min(capacity, capacity - remaining);
  const percent = Math.round(filled / capacity * 100);
  const full = remaining === 0;
  const start = new Date(e.starts_at);
  const day = start.toLocaleDateString("en-US", {weekday:"short"}).toUpperCase();
  const month = start.toLocaleDateString("en-US", {month:"short"}).toUpperCase();
  const date = start.getDate();
  const url = publicEventUrl(e.id);
  const desc = e.description ? `<p class="event-row-description">${esc(e.description)}</p>` : "";

  return `<article class="event-row">
    <div class="event-date-tile" aria-label="${esc(dateLabel(e.starts_at))}"><span>${esc(day)}</span><strong>${esc(month)} ${date}</strong></div>
    <div class="event-row-main">
      <h3><a href="${esc(url)}">${esc(e.title)}</a></h3>
      <p><svg class="icon"><use href="#i-clock"/></svg> ${esc(eventTimeRange(e))}</p>
      <p><svg class="icon"><use href="#i-pin"/></svg> ${esc(e.venue)}</p>
      ${desc}
    </div>
    <div class="event-row-availability">
      <strong>${money(e.price_cents)} <span>per player</span></strong>
      <p>${full ? `${filled} / ${capacity} spots filled · Waitlist open` : `${filled} / ${capacity} spots filled`}</p>
      <div class="capacity-track" role="progressbar" aria-label="Spots filled" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${filled}"><span style="width:${percent}%"></span></div>
    </div>
    <a class="button view-detail-btn" href="${esc(url)}">View details <svg class="icon"><use href="#i-arrow"/></svg></a>
  </article>`;
}

function eventDetailPage(e, isPrivate) {
  const remaining = Math.max(0, Number(e.spots_remaining) || 0);
  const capacity = Math.max(1, Number(e.capacity) || 1);
  const occupied = Math.min(capacity, capacity - remaining);
  const percent = Math.round((occupied / capacity) * 100);
  const full = remaining === 0;
  const buttonText = full ? "Join the waitlist" : "Reserve my spot";
  const spotsText = full ? "This session is currently full" : `${remaining} ${remaining === 1 ? "spot" : "spots"} remaining`;
  const description = String(e.description || "Bring your gear, get ready for great games, and enjoy a night of pickup volleyball.").trim();

  return `<article class="invite-layout">
    <div class="invite-main-col">
      <div class="invite-hero-panel">
        <div class="invite-badges"><span class="invite-privacy">${isPrivate ? "↗ LINK-ONLY EVENT" : "🏐 PUBLIC EVENT"}</span><span class="invite-badge-accent">${isPrivate ? "YOU'RE INVITED" : "OPEN TO EVERYONE"}</span></div>
        <span class="invite-decoration" aria-hidden="true">🏐</span>
        <div class="invite-hero-copy">
          <p class="invite-overline">A GOOD NIGHT TO GET IN THE GAME</p>
          <h1 id="invite-heading">${esc(e.title)}</h1>
          <p>${isPrivate ? "Colorado Springs pickup volleyball · An open gym shared by invitation." : "Colorado Springs pickup volleyball · Join the next open gym."}</p>
        </div>
      </div>
      <div class="invite-facts" aria-label="Event information">
        <div class="invite-fact"><span class="invite-fact-icon" aria-hidden="true">▦</span><div><span class="invite-fact-label">DATE</span><strong>${esc(dateLabel(e.starts_at))}</strong><span>${esc(eventTimeRange(e))}</span></div></div>
        <div class="invite-fact"><span class="invite-fact-icon" aria-hidden="true">⌖</span><div><span class="invite-fact-label">LOCATION</span><strong>${esc(e.venue)}</strong><span>Colorado Springs area</span></div></div>
        <div class="invite-fact"><span class="invite-fact-icon" aria-hidden="true">$</span><div><span class="invite-fact-label">PLAYER CONTRIBUTION</span><strong>${money(e.price_cents)} per player</strong><span>Pay the organizer directly</span></div></div>
      </div>
      <div class="invite-about">
        <span class="invite-section-label">THE DETAILS</span>
        <h2>About this session</h2>
        <p>${esc(description)}</p>
      </div>
      <section id="event-roster" class="roster-section" aria-label="Player roster" aria-live="polite">
        <div class="roster-head"><div><span class="invite-section-label">WHO'S PLAYING</span><h2>Player roster</h2></div><span class="roster-count">Loading…</span></div>
        <p class="roster-loading">Loading registered and waitlisted players…</p>
      </section>
      <div class="invite-disclosure"><span aria-hidden="true">◈</span><p>${isPrivate ? "<strong>Shared by invitation.</strong> This event doesn't appear in public listings. Anyone who has this link is welcome to register, and no account is needed." : "<strong>Everyone is welcome to register.</strong> This event is publicly listed, and you can share this page with friends. No account is needed."}</p></div>
    </div>
    <aside class="invite-aside" aria-label="Registration information">
      <div class="invite-booking-card">
        <div class="invite-booking-heading"><span>YOUR SPOT</span><span class="invite-live-dot">${full?"WAITLIST OPEN":"REGISTRATION OPEN"}</span></div>
        <p class="invite-booking-price">${money(e.price_cents)} <span>/ player</span></p>
        <div class="invite-availability"><strong>${esc(spotsText)}</strong><span>${occupied} of ${capacity} places reserved</span></div>
        <div class="invite-progress" role="progressbar" aria-label="Registered spots" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${occupied}"><div style="width:${percent}%"></div></div>
        ${full?`<p class="invite-waitlist-note">${Number(e.waitlist_count)||0} on the waitlist. You'll be added to it when you register.</p>`:`<p class="invite-reassurance">Your spot is reserved when you register.</p>`}
        <button class="button invite-register-button" data-register="${esc(e.id)}">${buttonText} <span aria-hidden="true">→</span></button>
        <p class="invite-booking-footnote">No account required · Pay by Venmo, cash, or Apple Cash</p>
      </div>
      <div class="invite-aside-note"><strong>What happens next?</strong><p>Enter your contact details, choose how you'll pay, and you're set. Payment happens separately with the organizer.</p></div>
    </aside>
  </article>`;
}

// One database function returns ONLY player_name and registration_status.
// Private events require their invitation token even when the event ID is known.
async function loadEventRoster(event, isPrivate)
{
  const root = $("event-roster");
  if (!root || !supabase) return;

  const {data, error} = await supabase.rpc("event_player_roster", {
    p_event_id: event.id,
    p_invite_token: isPrivate ? validInviteToken : null
  });

  if (error)
  {
    console.error("Unable to load roster", error);
    root.querySelector(".roster-count").textContent = "Unavailable";
    root.querySelector(".roster-loading").textContent = "The player roster is temporarily unavailable.";
    return;
  }

  const registered = (data || []).filter(p => p.registration_status === "registered");
  const waitlisted = (data || []).filter(p => p.registration_status === "waitlisted");
  const count = root.querySelector(".roster-count");
  count.textContent = `${registered.length} registered · ${waitlisted.length} waitlisted`;
  const names = (players, waitlist) => players.map((p, i) => `
    <li class="roster-player">
      <span class="roster-avatar" aria-hidden="true">${waitlist ? "◷" : "✓"}</span>
      <span class="roster-name">${esc(p.player_name)}</span>
      ${waitlist ? `<span class="roster-status">Waitlisted #${i + 1}</span>` : ""}
    </li>`).join("");
  const registeredHtml = registered.length
    ? `<ul class="roster-list">${names(registered, false)}</ul>`
    : `<p class="roster-empty">No registered players yet. Be the first!</p>`;
  const waitlistHtml = waitlisted.length
    ? `<ul class="roster-list">${names(waitlisted, true)}</ul>`
    : `<p class="roster-empty">No one on the waitlist.</p>`;
  const content = root.querySelector(".roster-loading");
  content.outerHTML = `<div class="roster-groups">
      <div class="roster-group"><h3>Registered players <span>${registered.length}</span></h3>${registeredHtml}</div>
      <div class="roster-group roster-waitlist"><h3>Waitlist <span>${waitlisted.length}</span></h3>${waitlistHtml}</div>
    </div>`;
}

function renderPublicEventDetail(events)
{
  const section = $("invitation-section");
  section.hidden = false;
  if (!validPublicEventId)
  {
    $("invitation-event").textContent = "This event link is invalid.";
    return;
  }
  // Public RPC only returns published, upcoming, public events. No new SQL
  // or bypass of private-event access is necessary for public detail URLs.
  const event = events.find(e => e.id === validPublicEventId);
  if (!event)
  {
    $("invitation-event").textContent = "This public event is unavailable. It may have ended, been unpublished, or become private.";
    document.title = "Event unavailable | Colorado Springs Pickup Volleyball";
    return;
  }
  $("invitation-event").innerHTML = eventDetailPage(event, false);
  void loadEventRoster(event, false);
  document.title = `${event.title} | Colorado Springs Pickup Volleyball`;
  wireRegistrationButtons($("invitation-event"));
}

function wireRegistrationButtons(parent)
{
  parent.querySelectorAll("[data-register]").forEach(b=>b.addEventListener("click",()=>openSignup(b.dataset.register)));
}

async function loadInvitedEvent()
{
  invitedEvent=null;
  const section=$("invitation-section");
  if (!inviteToken) { section.hidden=true; invitedEvent=null; return; }
  section.hidden=false;
  if (!validInviteToken)
  {
    $("invitation-event").innerHTML='<p>This invitation link is invalid.</p>';
    return;
  }
  const {data,error}=await supabase.rpc("private_open_gym_event", {p_invite_token: validInviteToken});
  if (error)
  {
    console.error(error);
    $("invitation-event").textContent="Unable to load this invitation. Please try again later.";
    return;
  }
  invitedEvent=data?.[0]||null;
  if (!invitedEvent)
  {
    $("invitation-event").textContent="This private event is unavailable. Check the link with the organizer.";
    return;
  }
  $("invitation-event").innerHTML=eventDetailPage(invitedEvent, true);
  void loadEventRoster(invitedEvent, true);
  document.title = `${invitedEvent.title} | Colorado Springs Pickup Volleyball`;
  wireRegistrationButtons($("invitation-event"));
  await loadEvents();
}

function openSignup(id)
{
  const e=eventCache.find(x=>x.id===id); if(!e)return;
  $("event-id").value=id;$("signup-title").textContent=e.title;
  $("signup-summary").textContent=`${dateTime(e.starts_at)} · ${e.venue} · ${money(e.price_cents)}${e.spots_remaining<=0?" · This registration will join the waitlist.":""}`;
  $("signup-error").textContent="";$("signup-dialog").showModal();
}

$("close-dialog").addEventListener("click",()=>$("signup-dialog").close());
$("signup-form").addEventListener("submit",async ev=>{
  ev.preventDefault(); if(!supabase){$("signup-error").textContent="The website isn't connected to Supabase yet.";return;}
  const btn=$("submit-signup");btn.disabled=true;btn.textContent="Registering…";$("signup-error").textContent="";
  const {data,error}=await supabase.rpc("register_for_open_gym",{
    p_event_id:$("event-id").value,p_name:$("player-name").value.trim(),
    p_email:$("player-email").value.trim(),p_phone:$("player-phone").value.trim()||null,
    p_payment_method:$("payment-method").value,
    // The database validates the token; event IDs cannot bypass private-event access.
    p_invite_token: invitedEvent?.id === $("event-id").value ? validInviteToken : null
  });
  btn.disabled=false;btn.textContent="Confirm registration";
  if(error){$("signup-error").textContent=error.message.includes("duplicate")?"You already have a registration for this event.":error.message;return;}
  $("signup-dialog").close();
  notice(data?.status==="waitlisted"?"You're on the waitlist! Your name will appear as waitlisted.":"You're registered! Please pay the organizer separately.");
  if (data?.manage_token && uuidPattern.test(data.manage_token)) {
    // Never include the management token in the public roster or event URL.
    const url = manageUrl(data.manage_token);
    const box = $("registration-link-box");
    $("registration-link").href = url;
    $("copy-registration-link").dataset.copyLink = url;
    box.hidden = false;
    box.scrollIntoView({behavior:"smooth",block:"nearest"});
  }
  $("signup-form").reset();
  if (validInviteToken) await loadInvitedEvent();
  else await loadEvents();
});

// Self-service management uses its own bearer token, not event IDs, emails,
// or organizer accounts. The database returns only name/event/status.
async function loadManageRegistration() {
  if (manageToken === null || !supabase) return;
  const root = $("invitation-event");
  $("invitation-section").hidden = false;
  if (!validManageToken)
  {
    root.innerHTML = `<div class="manage-card"><h1>Invalid registration link</h1><p>Please check the link you received.</p></div>`;
    return;
  }
  const {data,error} = await supabase.rpc("my_open_gym_registration", {p_manage_token:validManageToken});
  if (error || !data?.length)
  {
    if (error) console.error(error);
    root.innerHTML = `<div class="manage-card"><h1>Registration not found</h1><p>This link may be invalid, or the event may have been deleted. Ask the organizer for assistance.</p></div>`;
    return;
  }

  const reg = data[0];
  const cancelled = reg.registration_status === "cancelled";
  root.innerHTML = `<article class="manage-card">
    <span class="section-kicker">YOUR REGISTRATION</span>
    <h1>Manage registration</h1>
    <div class="manage-event-summary">
      <h2>${esc(reg.event_title)}</h2>
      <p>${esc(dateTime(reg.starts_at))} · ${esc(reg.event_venue)}</p>
      <p><strong>Player:</strong> ${esc(reg.player_name)}</p>
      <p><strong>Status:</strong> <span class="manage-status ${cancelled?'is-cancelled':''}">${esc(reg.registration_status)}</span></p>
    </div>
    ${cancelled ? `<p class="manage-complete">This registration has been cancelled. Your spot is no longer reserved.</p>` :
      `<p>You can cancel your ${reg.registration_status==='waitlisted'?'waitlist entry':'reserved spot'} here. No account is required.</p>
       <button type="button" class="button button-danger-outline" id="cancel-my-registration">Cancel my registration</button>`}
    <p class="small muted manage-security">Keep this link private. Anyone with this link can cancel this registration. Refunds, if applicable, must be arranged with the organizer.</p>
  </article>`;
  document.title = `Manage registration | Colorado Springs Pickup Volleyball`;
  $("cancel-my-registration")?.addEventListener("click", async () => {
    if (!window.confirm("Are you sure you want to cancel your registration? If you have a reserved spot, the next person on the waitlist may be promoted automatically. This cannot be undone.")) return;
    const button = $("cancel-my-registration"); button.disabled = true;
    const {error:cancelError} = await supabase.rpc("cancel_my_open_gym_registration", {p_manage_token:validManageToken});
    if (cancelError) { alert(cancelError.message); button.disabled = false; return; }
    await loadManageRegistration();
    notice("Your registration has been cancelled.");
  });
}
$("copy-registration-link").addEventListener("click", async ev => {
  const url = ev.currentTarget.dataset.copyLink;
  if (!url) return;
  try
  {
    await navigator.clipboard.writeText(url);
    ev.currentTarget.textContent = "Link copied!";
  }
  catch
  {
    window.prompt("Copy your registration management link:",url);
  }
});

$("login-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(!supabase){$("admin-message").textContent="Connect Supabase first using app.js.";return;}
  const {error}=await supabase.auth.signInWithPassword({email:$("admin-email").value,password:$("admin-password").value});
  $("admin-message").textContent=error?error.message:"";await refreshAdmin();
});
$("signout").addEventListener("click",async()=>{await supabase.auth.signOut();await refreshAdmin();});
supabase?.auth.onAuthStateChange(()=>setTimeout(refreshAdmin,0));

async function refreshAdmin(){
  if(!supabase)return;
  const {data:{session}}=await supabase.auth.getSession();currentUser=session?.user||null;
  $("admin-login").hidden=!!currentUser;$("admin-panel").hidden=!currentUser;
  organizerLink.textContent = currentUser ? "Organizer Dashboard" : "Organizer Login";
  if(currentUser)await loadAdminEvents();
}

// The organizer selects a date (initially blank), hour (6 PM by default),
// quarter-hour minutes, and duration. The end is computed automatically.
function selectedDurationMinutes()
{
  const value = $("event-duration").value === "custom"
    ? Number($("event-duration-custom").value)
    : Number($("event-duration").value);
  return Number.isInteger(value) && value >= 1 && value <= 10080 ? value : null;
}

function calculatedEventTimes()
{
  const date = $("event-date").value;
  if (!date) return null;
  const hour = Number($("event-hour").value);
  const quarter = Number($("event-minute").value);
  const minutes = selectedDurationMinutes();
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 ||
      ![0,15,30,45].includes(quarter) || minutes === null) return null;
  // A local wall-clock start; uses the browser's timezone just as the old editor did.
  const start = new Date(`${date}T${String(hour).padStart(2,"0")}:${String(quarter).padStart(2,"0")}:00`);
  if (Number.isNaN(start.getTime())) return null;
  // Prevent a nonexistent local time (e.g., in the spring DST transition).
  if (start.getHours() !== hour || start.getMinutes() !== quarter ||
      `${start.getFullYear()}-${String(start.getMonth()+1).padStart(2,"0")}-${String(start.getDate()).padStart(2,"0")}` !== date) return null;
  return {start, end: new Date(start.getTime() + minutes * 60_000)};
}

function updateEventEndPreview()
{
  const custom = $("event-duration").value === "custom";
  $("custom-duration-wrap").hidden = !custom;
  $("event-duration-custom").required = custom;
  const times = calculatedEventTimes();
  $("event-end-preview").textContent = times
    ? times.end.toLocaleString("en-US", {weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"})
    : $("event-date").value ? "Choose a valid start time and duration" : "Choose an event date";
}

$("event-date").addEventListener("input",updateEventEndPreview);
$("event-date").addEventListener("change",updateEventEndPreview);
$("event-hour").addEventListener("change",updateEventEndPreview);
$("event-minute").addEventListener("change",updateEventEndPreview);
$("event-duration").addEventListener("change",updateEventEndPreview);
$("event-duration-custom").addEventListener("input",updateEventEndPreview);

function clearEditor()
{
  $("event-form").reset();$("event-date").value="";$("event-hour").value="18";$("event-minute").value="00";$("edit-id").value="";$("event-venue").value="Hillside Community Center";$("event-price").value="5";$("event-capacity").value="24";$("event-status").value="published";$("event-visibility").value="public";$("event-duration").value="180";$("event-duration-custom").value="180";$("editor-heading").textContent="Create an event";$("event-save-message").textContent="";
  updateEventEndPreview();
}

$("reset-event").addEventListener("click",clearEditor);
$("event-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(!supabase||!currentUser)return;
  const id=$("edit-id").value;
  const times = calculatedEventTimes();
  if(!times){$("event-save-message").textContent="Choose an event date, start time, and valid duration.";return;}
  const {start,end}=times;
  const payload={title:$("event-title").value.trim(),venue:$("event-venue").value.trim(),starts_at:start.toISOString(),ends_at:end.toISOString(),price_cents:Math.round(Number($("event-price").value)*100),capacity:Number($("event-capacity").value),payment_instructions:$("payment-instructions").value.trim(),status:$("event-status").value,visibility:$("event-visibility").value,description:$("event-description").value.trim()};
  const result=id?await supabase.from("events").update(payload).eq("id",id).select().single():await supabase.from("events").insert(payload).select().single();
  $("event-save-message").textContent=result.error?result.error.message:"Event saved.";
  if(!result.error){
    clearEditor();
    await loadEvents();
    if (validInviteToken) await loadInvitedEvent();
    await loadAdminEvents();
  }
});

async function loadAdminEvents(){
  const {data:events,error}=await supabase.from("events").select("*").order("starts_at",{ascending:false});
  if(error){$("admin-events").textContent=error.message;return;}
  if(!events?.length){$("admin-events").innerHTML="<p>No events yet. Create your first event above.</p>";return;}
  const parts=await Promise.all(events.map(async e=>{
    const {data:regs,error:rerr}=await supabase.from("registrations").select("id,manage_token,player_name,player_email,player_phone,payment_method,payment_status,registration_status,created_at").eq("event_id",e.id).order("created_at");
    if(rerr)return `<article class="admin-event"><h4>${esc(e.title)}</h4><p>${esc(rerr.message)}</p></article>`;
    const rows=(regs||[]).map(r=>`<tr><td>${esc(r.player_name)}<br><span class="muted small">${esc(r.player_email)}</span></td><td>${esc(r.registration_status)}</td><td>${esc(r.payment_method.replace("_"," "))}</td><td><select data-payment="${r.id}"><option value="unpaid" ${r.payment_status==="unpaid"?"selected":""}>Unpaid</option><option value="paid" ${r.payment_status==="paid"?"selected":""}>Paid</option><option value="refunded" ${r.payment_status==="refunded"?"selected":""}>Refunded</option></select></td><td><div class="admin-reg-actions"><button class="button secondary" data-copy-manage="${esc(r.manage_token||'')}">Copy manage link</button>${r.registration_status==='cancelled'?'<span class="muted small">Cancelled</span>':`<button class="button secondary" data-cancel="${r.id}">Cancel</button>`}</div></td></tr>`).join("");
    return `<article class="admin-event">
      <span class="pill">${esc(e.status)}</span>
      <span class="pill ${e.visibility==="private"?"private-pill":""}">${e.visibility==="private"?"Private · link only":"Public"}</span>
      <h4>${esc(e.title)}</h4>
      <p class="muted small">${esc(dateTime(e.starts_at))} · ${esc(e.venue)} · ${money(e.price_cents)} · Capacity ${e.capacity}</p>
      <div class="admin-actions">
        <button class="button secondary" data-edit="${e.id}">Edit event</button>
        <button class="button secondary" data-toggle="${e.id}" data-status="${e.status}">${e.status==="published"?"Unpublish":e.status==="cancelled"?"Reopen as draft":"Publish"}</button>
        ${e.status!=="cancelled"?`<button class="button button-warn" data-cancel-event="${e.id}">Cancel event</button>`:"<span class='cancelled-hint'>Cancelled · registrations retained</span>"}
        <button class="button button-danger-outline" data-delete-event="${e.id}">Delete permanently</button>
        ${e.visibility==="private"?`<button class="button secondary" data-copy-invite="${e.id}">Copy invitation link</button>`:e.status==="published"?`<button class="button secondary" data-copy-public="${e.id}">Copy event link</button>`:""}
      </div>
      ${e.visibility==="private"&&e.status!=="published"?'<p class="muted small">The invitation link will work once the event is published.</p>':''}
      ${rows?`<table><thead><tr><th>Player</th><th>Registration</th><th>Method</th><th>Payment</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`:"<p class='muted small'>No registrations yet.</p>"}
    </article>`;
  }));
  $("admin-events").innerHTML=parts.join("");
  document.querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>editEvent(events.find(e=>e.id===b.dataset.edit))));
  document.querySelectorAll("[data-toggle]").forEach(b=>b.addEventListener("click",async()=>{
    const status=b.dataset.status==="published"?"draft":b.dataset.status==="cancelled"?"draft":"published";
    b.disabled=true;
    const {error}=await supabase.from("events").update({status}).eq("id",b.dataset.toggle);
    if(error)alert(error.message);
    await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-cancel-event]").forEach(b=>b.addEventListener("click",async()=>{
    const event=events.find(e=>e.id===b.dataset.cancelEvent);
    if(!event)return;
    if(!window.confirm(`Cancel “${event.title}”?\n\nThe event will be removed from public/invitation pages, but every registration and payment record will remain in your dashboard. No emails are sent automatically yet.`))return;
    b.disabled=true;
    const {error}=await supabase.from("events").update({status:"cancelled"}).eq("id",event.id);
    if(error)alert(error.message);
    else notice(`Event cancelled: ${event.title}. Registration and payment records were retained.`);
    await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-delete-event]").forEach(b=>b.addEventListener("click",async()=>{
    const event=events.find(e=>e.id===b.dataset.deleteEvent);
    if(!event)return;
    const count=(await supabase.from("registrations").select("id",{count:"exact",head:true}).eq("event_id",event.id)).count;
    const warning=`Are you absolutely sure you want to permanently delete this event?\n\n${event.title}\n${dateTime(event.starts_at)}\n\nThis will also permanently delete ${count ?? "all associated"} registration records and their payment history. This action cannot be undone.`;
    if(!window.confirm(warning))return;
    b.disabled=true;
    const {error}=await supabase.rpc("organizer_delete_open_gym_event",{p_event_id:event.id});
    if(error){alert(`Could not delete event: ${error.message}\n\nIf the function was not found, run phase2_batch1_upgrade.sql in Supabase first.`);b.disabled=false;return;}
    if($("edit-id").value===event.id) clearEditor();
    notice(`Permanently deleted: ${event.title}. Associated registrations were removed.`);
    await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-copy-invite]").forEach(b=>b.addEventListener("click",async()=>{
    const e=events.find(event=>event.id===b.dataset.copyInvite);
    if (!e?.invite_token) {alert("Invitation link unavailable. Check the database upgrade.");return;}
    const url=inviteUrl(e.invite_token);
    try {
      await navigator.clipboard.writeText(url);
      const old=b.textContent;b.textContent="Copied!";
      setTimeout(()=>b.textContent=old,1800);
    } catch {
      // The fallback lets organizers copy links in browsers without clipboard permission.
      window.prompt("Copy your private event link:",url);
    }
  }));
  document.querySelectorAll("[data-copy-public]").forEach(b=>b.addEventListener("click",async()=>{
    const url=publicEventUrl(b.dataset.copyPublic);
    try {
      await navigator.clipboard.writeText(url);
      const old=b.textContent;b.textContent="Copied!";
      setTimeout(()=>b.textContent=old,1800);
    } catch {
      window.prompt("Copy your public event link:",url);
    }
  }));
  document.querySelectorAll("[data-copy-manage]").forEach(b=>b.addEventListener("click",async()=>{
    if (!uuidPattern.test(b.dataset.copyManage || "")) {alert("This player does not have a management link yet. Check the Batch 3 SQL upgrade.");return;}
    const url = manageUrl(b.dataset.copyManage);
    try
    {
      await navigator.clipboard.writeText(url);
      const label = b.textContent; b.textContent = "Copied!";
      window.setTimeout(()=>b.textContent=label,2000);
    }
    catch
    {
      window.prompt("Copy the private management link:",url);
    }
  }));
  document.querySelectorAll("[data-payment]").forEach(s=>s.addEventListener("change",async()=>{const {error}=await supabase.from("registrations").update({payment_status:s.value}).eq("id",s.dataset.payment);if(error)alert(error.message);}));
  document.querySelectorAll("[data-cancel]").forEach(b=>b.addEventListener("click",async()=>{
    if (!confirm("Cancel this registration? If the player holds a confirmed spot, the next waitlisted player will be promoted automatically.")) return;
    b.disabled = true;
    const {error}=await supabase.from("registrations").update({registration_status:"cancelled"}).eq("id",b.dataset.cancel);
    if(error) alert(error.message);
    await loadEvents(); if(validInviteToken) await loadInvitedEvent(); await loadAdminEvents();
  }));
}

function editEvent(e)
{
  $("edit-id").value=e.id;$("event-title").value=e.title;$("event-venue").value=e.venue;
  const localStart=toLocal(e.starts_at);
  $("event-date").value=localStart.slice(0,10);
  $("event-hour").value=localStart.slice(11,13);
  // Legacy events with non-quarter-hour starts are rounded to the nearest 15
  // minutes when editing; the organizer is told before saving.
  const originalMinute=Number(localStart.slice(14,16));
  const roundedMinute=Math.min(45,Math.round(originalMinute/15)*15);
  $("event-minute").value=String(roundedMinute).padStart(2,"0");
  const durationMinutes=Math.round((new Date(e.ends_at)-new Date(e.starts_at))/60000);
  const select=$("event-duration");
  const available=[...select.options].some(o=>o.value===String(durationMinutes));
  select.value=available ? String(durationMinutes) : "custom";
  $("event-duration-custom").value=String(durationMinutes);
  updateEventEndPreview();
  $("event-price").value=(e.price_cents/100).toFixed(2);$("event-capacity").value=e.capacity;
  $("payment-instructions").value=e.payment_instructions||"";$("event-status").value=e.status;$("event-visibility").value=e.visibility||"public";$("event-description").value=e.description||"";
  $("editor-heading").textContent="Edit event";
  $("event-save-message").textContent=originalMinute!==roundedMinute
    ? "This event used a non-quarter-hour start. The time picker shows the nearest available quarter-hour; review it before saving."
    : "";
  $("event-form").scrollIntoView({behavior:"smooth",block:"start"});
}

function toLocal(s){const d=new Date(s);return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);}

if(!configured)
{
  unavailable();$("admin-message").textContent="Setup required: add the Supabase URL and anon key in app.js.";
}
else
{
  loadEvents();
  if (inviteToken !== null) loadInvitedEvent();
  if (manageToken !== null) loadManageRegistration();
  refreshAdmin();
}
