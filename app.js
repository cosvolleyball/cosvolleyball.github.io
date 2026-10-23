import {
  createClient
} from "https://esm.sh/@supabase/supabase-js@2";

// Public browser configuration. Replace only the two placeholders below.
// These values are safe to expose to a browser: Supabase Row Level Security
// and our audited RPC functions enforce access. NEVER paste service_role
// credentials, database passwords, or Gmail tokens into this file.
const SUPABASE_URL = "https://mfumtentefcuysibknyl.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_JGD9JifuMwGF37U2SCxRig_PvgA8psg";
const configured = SUPABASE_URL.startsWith("https://") && !SUPABASE_URL.includes("PASTE_") && !SUPABASE_ANON_KEY.includes("PASTE_");
const supabase = configured ? createClient(SUPABASE_URL, SUPABASE_ANON_KEY) : null;

// ── Shared display helpers and state ───────────────────────────────────────
const $ = (id) => document.getElementById(id);
const esc = (s="") => String(s).replace(/[&<>"']/g, c => ({
  "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"
}
[c]));
const money = cents => new Intl.NumberFormat("en-US",{
  style:"currency",currency:"USD"
}).format(cents/100);
const dateTime = s => new Date(s).toLocaleString("en-US",{
  weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"
});
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
const inviteUrl = token => `${window.location.origin}${window.location.pathname}?invite=${encodeURIComponent(token)}`;
const publicEventUrl = id => `${window.location.origin}${window.location.pathname}?event=${encodeURIComponent(id)}`;
// GitHub Pages hosts a single document; ?dashboard=1 is a separate organizer view.
// Existing ?event=, ?invite=, and ?manage= links remain unchanged.
const organizerLink = $("organizer-link");
const dashboardRequested = query.get("dashboard") === "1" && !detailRequested;
let isOrganizer = false;
let eventLoadEpoch = 0;
let adminRefreshEpoch = 0;
if (dashboardRequested) {
  document.body.classList.add("organizer-view");
  document.title = "Organizer Dashboard | Colorado Springs Pickup Volleyball";
}
// Detail pages should return home for their Events / About navigation.
if (detailRequested) {
  $("events-nav").href = "./#events";
  $("about-nav").href = "./#about";
}

if (detailRequested) {
  document.body.classList.add("event-detail-view");
  document.querySelector(".brand")?.setAttribute("href", "./");
}
// The private link should not appear in search engine results.
if (inviteToken !== null || manageToken !== null) {
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
const dateLabel = value => new Date(value).toLocaleDateString("en-US", {
  weekday:"long",month:"long",day:"numeric",year:"numeric"
});
const timeLabel = value => new Date(value).toLocaleTimeString("en-US", {
  hour:"numeric",minute:"2-digit"
});
const eventTimeRange = event => {
  const first = new Date(event.starts_at), last = new Date(event.ends_at);
  return first.toDateString() === last.toDateString()
  ? `${timeLabel(event.starts_at)} – ${timeLabel(event.ends_at)}`
  : `${timeLabel(event.starts_at)} – ${dateLabel(event.ends_at)}, ${timeLabel(event.ends_at)}`;
};

function notice(message, error=false) {
  const n=$("notice");
  n.hidden=!message;
  n.textContent=message;
  n.classList.toggle("error",error);
}

function unavailable() {
  $("events").innerHTML = `<div class="empty-state"><h3>Almost ready to play</h3><p>Connect your Supabase project to load live events. Follow the setup guide included with this website.</p></div>`;
}

// ── Upcoming events and private organizer listings ────────────────────────
async function loadEvents() {
  const loadId=++eventLoadEpoch;
  if (!supabase) return unavailable();
  const { data, error } = await  supabase.rpc("public_open_gym_events");
  if (loadId!==eventLoadEpoch) return;
  if (error) {
    const message = "Could not load events. Check the Supabase setup and SQL installation.";
    $("events").textContent = message;
    if (publicEventId !== null) {
      $("invitation-section").hidden = false;
      $("invitation-event").textContent=message;
    }
    console.error(error);
    return;
  }
  // Public RPC remains public-only; the organizer's private events are
  // fetched separately through existing authenticated RLS policies.
  let privateEvents=[];
  if (isOrganizer && !detailRequested) {
    const { data:privateRows, error:privateError } = await  supabase.from("events")
    .select("id,title,venue,starts_at,ends_at,price_cents,capacity,description,host_name,payment_instructions,visibility,invite_token")
    .eq("status","published").eq("visibility","private")
    .gt("ends_at",new Date().toISOString()).order("starts_at",{
      ascending:true
    });
    if (privateError) console.error("Could not load organizer-only events:",privateError);
    else if (privateRows?.length) {
      const ids=privateRows.map(e=>e.id);
      const { data:registrations, error:regError } = await  supabase.from("registrations")
      .select("event_id,registration_status").in("event_id",ids);
      if (regError) console.error("Could not load organizer-only event capacities:",regError);
      privateEvents=privateRows.map(e=>{
        const members=(registrations||[]).filter(r=>r.event_id===e.id);
        return {
          ...e,spots_remaining:Math.max(0,e.capacity-members.filter(r=>r.registration_status==="registered").length),waitlist_count:members.filter(r=>r.registration_status==="waitlisted").length
        };
      });
    }
  }
  if (loadId!==eventLoadEpoch) return;
  const listed=[...(data||[]),...privateEvents].sort((a,b)=>new Date(a.starts_at)-new Date(b.starts_at));
  eventCache=[...listed];
  if (invitedEvent && !eventCache.some(e=>e.id===invitedEvent.id)) eventCache.push(invitedEvent);
  if (publicEventId !== null) renderPublicEventDetail(data||[]);
  if (!listed.length) {
    $("events").innerHTML='<div class="empty-state"><span class="pill">Coming soon</span><h3>No sessions posted yet</h3><p>Check back soon for the next open gym.</p></div>';
    return;
  }
  $("events").innerHTML=listed.map(eventCard).join("");
  $("events").querySelectorAll("[data-copy-card-invite]").forEach(button=>button.addEventListener("click",()=>{
    const e=privateEvents.find(e=>e.id===button.dataset.copyCardInvite);
    if (e?.invite_token) void copyLink(inviteUrl(e.invite_token),button);
  }));
}

async function copyLink(url,button){
  try {
    await navigator.clipboard.writeText(url);
    const previous=button.innerHTML;
    button.textContent="✓ Copied!";
    setTimeout(()=>{
      if(button.isConnected) button.innerHTML=previous;
    },1800);
  } catch {
    window.prompt("Copy this invitation link:",url);
  }
}

function eventCard(e) {
  const capacity = Math.max(1, Number(e.capacity) || 1);
  const remaining = Math.max(0, Number(e.spots_remaining) || 0);
  const filled = Math.min(capacity, capacity - remaining);
  const percent = Math.round(filled / capacity * 100);
  const full = remaining === 0;
  const start = new Date(e.starts_at);
  const day = start.toLocaleDateString("en-US", {
    weekday:"short"
  }).toUpperCase();
  const month = start.toLocaleDateString("en-US", {
    month:"short"
  }).toUpperCase();
  const date = start.getDate();
  const privateEvent=e.visibility === "private";
  const url = privateEvent && e.invite_token ? inviteUrl(e.invite_token) : publicEventUrl(e.id);
  const desc = e.description ? `<p class="event-row-description">${esc(e.description)}</p>` : "";
  return `<article class="event-row">
    <div class="event-date-tile" aria-label="${esc(dateLabel(e.starts_at))}"><span>${esc(day)}</span><strong>${esc(month)} ${date}</strong></div>
    <div class="event-row-main">
      <h3><a href="${esc(url)}">${esc(e.title)}</a></h3>
      ${privateEvent ? `<span class="pill private-pill event-row-private-label">Private · Link only</span>` : ""}
      <p><svg class="icon"><use href="#i-clock"/></svg> ${esc(eventTimeRange(e))}</p>
      <p><svg class="icon"><use href="#i-pin"/></svg> ${esc(e.venue)}</p>
      ${desc}
    </div>
    <div class="event-row-availability">
      <strong>${money(e.price_cents)} <span>per player</span></strong>
      <p>${full ? `${filled} / ${capacity} spots filled · Waitlist open` : `${filled} / ${capacity} spots filled`}</p>
      <div class="capacity-track" role="progressbar" aria-label="Spots filled" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${filled}"><span style="width:${percent}%"></span></div>
    </div>
    <div class="event-card-actions"><a class="button view-detail-btn" href="${esc(url)}">View details <svg class="icon"><use href="#i-arrow"/></svg></a>
    ${privateEvent ? `<button class="button secondary copy-invite-card" type="button" data-copy-card-invite="${esc(e.id)}" aria-label="Copy invitation link for ${esc(e.title)}"><svg class="icon"><use href="#i-link"/></svg> Copy link</button>` : ""}</div>
  </article>`;
}

// ── Full event pages and player rosters ────────────────────────────────────
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
        <div class="invite-fact">
      <span class="invite-fact-icon" aria-hidden="true">$</span>
      <div><span class="invite-fact-label">PLAYER CONTRIBUTION</span>
        <strong>${money(e.price_cents)} per player</strong>
        <span>Pay the organizer directly</span>
      </div>
    </div>
      </div>
      <div class="invite-about">
        <span class="invite-section-label">THE DETAILS</span>
        <h2>About this session</h2>
        <p>${esc(description)}</p>
      </div>
      ${e.host_name || e.payment_instructions ? `<div class="invite-host-payment" aria-label="Hosting and payment details">
        ${e.host_name ? `<div><span class="invite-section-label">HOSTED BY</span><p>${esc(e.host_name)}</p></div>` : ""}
        ${e.payment_instructions ? `<div><span class="invite-section-label">PAYMENT INSTRUCTIONS</span><p>${esc(e.payment_instructions)}</p></div>` : ""}
      </div>` : ""}
      <section id="event-roster" class="roster-section" aria-label="Player roster" aria-live="polite">
        <div class="roster-head"><div><span class="invite-section-label">WHO'S PLAYING</span><h2>Player roster</h2></div><span class="roster-count">Loading…</span></div>
        <p class="roster-loading">Loading registered and waitlisted players…</p>
      </section>
      <div class="invite-disclosure">
        <span aria-hidden="true">◈</span>
        <p>${isPrivate
          ? "<strong>Shared by invitation.</strong> This event doesn't appear in public listings. Anyone with the link can register without an account."
          : "<strong>Everyone is welcome to register.</strong> This event is publicly listed, and you can share this page with friends. No account is needed."}</p>
      </div>
    </div>
    <aside class="invite-aside" aria-label="Registration information">
      <div class="invite-booking-card">
        <div class="invite-booking-heading"><span>YOUR SPOT</span><span class="invite-live-dot">${full?"WAITLIST OPEN":"REGISTRATION OPEN"}</span></div>
        <p class="invite-booking-price">${money(e.price_cents)} <span>/ player</span></p>
        <div class="invite-availability"><strong>${esc(spotsText)}</strong><span>${occupied} of ${capacity} places reserved</span></div>
        <div class="invite-progress" role="progressbar" aria-label="Registered spots" aria-valuemin="0" aria-valuemax="${capacity}" aria-valuenow="${occupied}"><div style="width:${percent}%"></div></div>
        ${full?`<p class="invite-waitlist-note">${Number(e.waitlist_count)||0} on the waitlist. You'll be added to it when you register.</p>`:`<p class="invite-reassurance">Your spot is reserved when you register.</p>`}
        <button class="button invite-register-button" data-register="${esc(e.id)}">${buttonText} <span aria-hidden="true">→</span></button>
        <p class="invite-booking-footnote">No account required · Pay by Venmo or cash</p>
      </div>
      <div class="invite-aside-note"><strong>What happens next?</strong><p>Enter your contact details, choose how you'll pay, and you're set. Payment happens separately with the organizer.</p></div>
    </aside>
  </article>`;
}
// One database function returns ONLY player_name and registration_status.
// Private events require their invitation token even when the event ID is known.

async function loadEventRoster(event, isPrivate) {
  const root = $("event-roster");
  if (!root || !supabase) return;
  const { data, error } = await  supabase.rpc("event_player_roster", {
    p_event_id: event.id,
    p_invite_token: isPrivate ? validInviteToken : null
  });
  if (error) {
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

function renderPublicEventDetail(events) {
  const section = $("invitation-section");
  section.hidden = false;
  if (!validPublicEventId) {
    $("invitation-event").textContent = "This event link is invalid.";
    return;
  }
  // Public RPC only returns published, upcoming, public events. No new SQL
  // or bypass of private-event access is necessary for public detail URLs.
  const event = events.find(e => e.id === validPublicEventId);
  if (!event) {
    $("invitation-event").textContent = "This public event is unavailable. It may have ended, been unpublished, or become private.";
    document.title = "Event unavailable | Colorado Springs Pickup Volleyball";
    return;
  }
  $("invitation-event").innerHTML = eventDetailPage(event, false);
  void loadEventRoster(event, false);
  document.title = `${event.title} | Colorado Springs Pickup Volleyball`;
  wireRegistrationButtons($("invitation-event"));
}

function wireRegistrationButtons(parent) {
  parent.querySelectorAll("[data-register]").forEach(b=>b.addEventListener("click",()=>openSignup(b.dataset.register)));
}

async function loadInvitedEvent() {
  invitedEvent=null;
  const section=$("invitation-section");
  if (!inviteToken) {
    section.hidden=true;
    invitedEvent=null;
    return;
  }
  section.hidden=false;
  if (!validInviteToken) {
    $("invitation-event").innerHTML='<p>This invitation link is invalid.</p>';
    return;
  }
  const { data, error } = await  supabase.rpc("private_open_gym_event", {
    p_invite_token: validInviteToken
  });
  if (error) {
    console.error(error);
    $("invitation-event").textContent="Unable to load this invitation. Please try again later.";
    return;
  }
  invitedEvent=data?.[0]||null;
  if (!invitedEvent) {
    $("invitation-event").textContent="This private event is unavailable. Check the link with the organizer.";
    return;
  }
  $("invitation-event").innerHTML=eventDetailPage(invitedEvent, true);
  void loadEventRoster(invitedEvent, true);
  document.title = `${invitedEvent.title} | Colorado Springs Pickup Volleyball`;
  wireRegistrationButtons($("invitation-event"));
  await loadEvents();
}

// ── Player registration and email confirmation notice ────────────────────────
function openSignup(id) {
  const e=eventCache.find(x=>x.id===id);
  if(!e)return;
  $("event-id").value=id;
  $("signup-title").textContent=e.title;
  $("signup-summary").textContent=`${dateTime(e.starts_at)} · ${e.venue} · ${money(e.price_cents)}${e.spots_remaining<=0?" · This registration will join the waitlist.":""}`;
  $("signup-error").textContent="";
  $("signup-dialog").showModal();
}
$("close-dialog").addEventListener("click",()=>$("signup-dialog").close());
// Client-side email checks: syntax and likely domain typos. No claim is made
// that the mailbox exists; ownership verification requires sending email.
const knownEmailTypos={
  "gmial.com": "gmail.com",
  "gmai.com": "gmail.com",
  "gmail.con": "gmail.com",
  "gmail.co": "gmail.com",
  "gnail.com": "gmail.com",
  "yaho.com": "yahoo.com",
  "yahoo.con": "yahoo.com",
  "outlok.com": "outlook.com",
  "outlook.con": "outlook.com",
  "hotmial.com": "hotmail.com",
  "hotmail.con": "hotmail.com",
  "icloud.con": "icloud.com"
};

function emailProblem(value) {
  const email=value.trim();
  const parts=email.split("@");
  if (email.length>254 || parts.length!==2 || !parts[0] || !parts[1] || /\s/.test(email)) return "Enter a valid email address.";
  const [local,domain]=parts;
  if (local.length>64 || local.startsWith(".") || local.endsWith(".") || local.includes("..") || !/^[A-Za-z0-9!#$%&'*+\/=?^_`{|}~.-]+$/.test(local)) return "Check the email address before registering.";
  const labels = domain.split(".");
  const hasValidLabels = labels.every(label =>
    label.length >= 1 &&
    label.length <= 63 &&
    /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/i.test(label)
  );
  const hasValidTopLevelDomain = /^[a-z]{2,63}$/i.test(labels.at(-1));

  if (
    domain.length > 253 ||
    !domain.includes(".") ||
    domain.endsWith(".") ||
    domain.includes("..") ||
    !hasValidLabels ||
    !hasValidTopLevelDomain
  ) {
    return "Enter an email with a valid-looking domain (example: gmail.com).";
  }
  return null;
}

function updateEmailHint() {
  const input=$("player-email"), hint=$("email-hint"), value=input.value.trim();
  if (!value) {
    hint.textContent="We’ll email your registration status. Please enter an address you can access.";
    hint.classList.remove("email-hint-warning");
    return;
  }
  const problem=emailProblem(value);
  const suggestion=knownEmailTypos[value.split("@").at(-1).toLowerCase()];
  hint.textContent=problem || (suggestion ? `Possible typo: did you mean @${suggestion}? Please review your address.` : "Email format looks good. Check your inbox and Spam/Junk after registering.");
  hint.classList.toggle("email-hint-warning",!!problem || !!suggestion);
}
$("player-email").addEventListener("input",updateEmailHint);
$("player-email").addEventListener("blur",updateEmailHint);
$("signup-form").addEventListener("submit",async ev=>{
  ev.preventDefault(); if(!supabase){
    $("signup-error").textContent="The website isn't connected to Supabase yet.";return;
  }
  const emailError=emailProblem($("player-email").value);
  if (emailError){
    $("signup-error").textContent=emailError;$("player-email").focus();return;
  }
  const btn=$("submit-signup");btn.disabled=true;btn.textContent="Registering…";$("signup-error").textContent="";
  const { data, error } = await  supabase.rpc("register_for_open_gym",{
    p_event_id:$("event-id").value,p_name:$("player-name").value.trim(),
    p_email:$("player-email").value.trim(),p_phone:$("player-phone").value.trim()||null,
    p_payment_method:$("payment-method").value,
    // The database validates the token; event IDs cannot bypass private-event access.
    p_invite_token: invitedEvent?.id === $("event-id").value ? validInviteToken : null
  });
  btn.disabled=false;btn.textContent="Confirm registration";
  if (error) {
    $("signup-error").textContent=error.message.includes("duplicate")?"You already have a registration for this event.":error.message;return;
  }
  $("signup-dialog").close();
  // Email delivery happens asynchronously. Do not claim a message was
  // delivered immediately, and never display the bearer management token.
  const submittedEmail = $("player-email").value.trim();
  const emailGuidance =
  "A confirmation email should arrive shortly. Check Spam/Junk if you " +
  "don't see it. For help, email cospickupvolleyball@gmail.com.";
  const registrationMessage = data?.status === "waitlisted"
  ? "You're on the waitlist (not registered yet). "
  : "You're registered! Your spot is reserved. ";
  notice(registrationMessage + emailGuidance);
  $("registration-success-title").textContent = data?.status === "waitlisted" ? "You're on the waitlist!" : "You're registered!";
  $("registration-success-description").textContent = data?.status === "waitlisted"
    ? "You don't have a reserved spot yet. We'll email you if a spot opens."
    : "Your spot has been reserved.";
  $("registration-success-email").textContent = submittedEmail;
  $("registration-success-dialog").showModal();
  $("signup-form").reset();updateEmailHint();
  if (validInviteToken) await loadInvitedEvent();
  else await loadEvents();
});
$("registration-success-dismiss").addEventListener("click", () => $("registration-success-dialog").close());
// The ?manage= route MUST remain available: registration emails include
// each player's unguessable management token. It is deliberately no longer
// displayed on the registration success banner or the organizer dashboard.
// The database RPC validates the bearer token; no player account is required. The database returns only name/event/status.

// ── Private self-service cancellation page (emailed links only) ────────────
async function loadManageRegistration() {
  if (manageToken === null || !supabase) return;
  const root = $("invitation-event");
  $("invitation-section").hidden = false;
  if (!validManageToken) {
    root.innerHTML = `<div class="manage-card"><h1>Invalid registration link</h1><p>Please check the link you received.</p></div>`;
    return;
  }
  const { data, error } = await  supabase.rpc("my_open_gym_registration", {
    p_manage_token:validManageToken
  });
  if (error || !data?.length) {
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
    const { error:cancelError } = await  supabase.rpc("cancel_my_open_gym_registration", {
      p_manage_token:validManageToken
    });
    if (cancelError) {
      alert(cancelError.message); button.disabled = false; return;
    }
    await loadManageRegistration();
    notice("Your registration has been cancelled.");
  });
}
$("login-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(!supabase){
    $("admin-message").textContent="Connect Supabase first using app.js.";return;
  }
  const { error } = await  supabase.auth.signInWithPassword({
    email:$("admin-email").value,password:$("admin-password").value
  });
  $("admin-message").textContent=error?error.message:"";if(!error) await refreshAdmin();
});
$("signout").addEventListener("click",async()=>{
  await supabase.auth.signOut();await refreshAdmin();
});
supabase?.auth.onAuthStateChange(()=>setTimeout(refreshAdmin,0));

// ── Organizer authorization and dashboard ─────────────────────────────────
async function refreshAdmin(){
  const refreshId=++adminRefreshEpoch;
  if (!supabase) return;
  const {
    data:{
      session
    }
  }
  =await supabase.auth.getSession();
  const user=session?.user||null;
  let organizerAccess=false;
  if (user) {
    const { data:organizer, error } = await  supabase.from("organizers").select("user_id").eq("user_id",user.id).maybeSingle();
    if (error) console.error("Unable to check organizer access:",error);
    organizerAccess=!!organizer;
  }
  if (refreshId!==adminRefreshEpoch) return;
  const previousOrganizer=isOrganizer;
  currentUser=user;
  isOrganizer=organizerAccess;
  $("admin-login").hidden=isOrganizer;
  $("admin-panel").hidden=!isOrganizer;
  if (!isOrganizer){
    $("admin-events").replaceChildren();
    $("admin-stats").replaceChildren();
  }
  organizerLink.textContent = isOrganizer ? "Organizer Dashboard" : "Organizer Login";
  if (user && !isOrganizer) $("admin-message").textContent="This account does not have organizer access.";
  if (isOrganizer && dashboardRequested) await loadAdminEvents();
  // Keep the homepage public-only for visitors; add unlisted events only
  // after we have verified the signed-in user is an organizer.
  if (!dashboardRequested && !detailRequested && previousOrganizer!==isOrganizer) await loadEvents();
}
// The organizer selects a date (initially blank), hour (6 PM by default),
// quarter-hour minutes, and duration. The end is computed automatically.

// ── Event editor: date, time, and duration ────────────────────────────────
function selectedDurationMinutes() {
  const value = $("event-duration").value === "custom"
  ? Number($("event-duration-custom").value)
  : Number($("event-duration").value);
  return Number.isInteger(value) && value >= 1 && value <= 10080 ? value : null;
}

function calculatedEventTimes() {
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
  return {
    start, end: new Date(start.getTime() + minutes * 60_000)
  };
}

function updateEventEndPreview() {
  const custom = $("event-duration").value === "custom";
  $("custom-duration-wrap").hidden = !custom;
  $("event-duration-custom").required = custom;
  const times = calculatedEventTimes();
  $("event-end-preview").textContent = times
  ? times.end.toLocaleString("en-US", {
    weekday:"short",month:"short",day:"numeric",year:"numeric",hour:"numeric",minute:"2-digit"
  })
  : $("event-date").value ? "Choose a valid start time and duration" : "Choose an event date";
}
$("event-date").addEventListener("input",updateEventEndPreview);
$("event-date").addEventListener("change",updateEventEndPreview);
$("event-hour").addEventListener("change",updateEventEndPreview);
$("event-minute").addEventListener("change",updateEventEndPreview);
$("event-duration").addEventListener("change",updateEventEndPreview);
$("event-duration-custom").addEventListener("input",updateEventEndPreview);

function openEventEditor(event=null){
  if (!isOrganizer) return;
  if (event) editEvent(event);
  else clearEditor();
  $("event-editor-dialog").showModal();
  $("event-title").focus();
}
$("create-event").addEventListener("click",()=>openEventEditor());
$("close-event-editor").addEventListener("click",()=>$("event-editor-dialog").close());
$("event-editor-dialog").addEventListener("click",event=>{
  // Native modal backdrop dismissal; clicks inside the content do nothing.
  if (event.target === $("event-editor-dialog")) $("event-editor-dialog").close();
});

function clearEditor(){
  $("event-form").reset();
  $("event-date").value="";
  $("event-hour").value="18";
  $("event-minute").value="00";
  $("edit-id").value="";
  $("event-venue").value="Hillside Community Center";
  $("event-price").value="5";
  $("event-capacity").value="24";
  $("event-status").value="published";
  $("event-visibility").value="public";
  $("event-duration").value="180";
  $("event-duration-custom").value="180";
  $("editor-heading").textContent="Create an event";
  $("event-save-message").textContent="";
  updateEventEndPreview();
}
$("reset-event").addEventListener("click",()=>$("event-editor-dialog").close());
$("event-form").addEventListener("submit",async ev=>{
  ev.preventDefault();if(!supabase||!isOrganizer)return;
  const id=$("edit-id").value;
  const times = calculatedEventTimes();
  if(!times){
    $("event-save-message").textContent="Choose an event date, start time, and valid duration.";return;
  }
  const { start, end } = times;
  const payload={
    title: $("event-title").value.trim(),
    venue: $("event-venue").value.trim(),
    starts_at: start.toISOString(),
    ends_at: end.toISOString(),
    price_cents: Math.round(Number($("event-price").value) * 100),
    capacity: Number($("event-capacity").value),
    payment_instructions: $("payment-instructions").value.trim(),
    host_name: $("event-host").value.trim(),
    status: $("event-status").value,
    visibility: $("event-visibility").value,
    description: $("event-description").value.trim()
  };
  const result=id?await supabase.from("events").update(payload).eq("id",id).select().single():await supabase.from("events").insert(payload).select().single();
  $("event-save-message").textContent=result.error?result.error.message:"Event saved.";
  if(!result.error){
    $("event-editor-dialog").close();
    clearEditor();
    notice(`Event ${id ? "updated" : "created"}: ${result.data.title}.`);
    await loadAdminEvents();
  }
});
$("admin-filter").addEventListener("change",()=>{
  if(isOrganizer) void loadAdminEvents();
});

// ── Organizer event list and registration management ──────────────────────
// Contact details are visible only after organizer authentication. The private
// management token is intentionally not retrieved or displayed here.
function renderRegistrationRow(registration) {
  const r = registration;
  const paymentOptions = ["unpaid", "paid", "refunded"].map(status => {
    const selected = r.payment_status === status ? "selected" : "";
    const label = status.charAt(0).toUpperCase() + status.slice(1);
    return `<option value="${status}" ${selected}>${label}</option>`;
  }).join("");

  const action = r.registration_status === "cancelled"
    ? `<span class="muted small">Cancelled</span>`
    : `<button class="button secondary" data-cancel="${esc(r.id)}">Cancel</button>`;

  return `
    <tr>
      <td>${esc(r.player_name)}<br><span class="muted small">${esc(r.player_email)}</span></td>
      <td>${esc(r.registration_status)}</td>
      <td>${esc(r.payment_method.replace("_", " "))}</td>
      <td><select data-payment="${esc(r.id)}">${paymentOptions}</select></td>
      <td><div class="admin-reg-actions">${action}</div></td>
    </tr>
  `;
}

async function loadAdminEvents(){
  // Chronological order: the next upcoming event should appear first.
  // Keep this ordering for all dashboard filters (including private events).
  const { data:events, error } = await  supabase.from("events").select("*").order("starts_at",{
    ascending:true
  });
  if (error) {
    $("admin-events").textContent=error.message;
    return;
  }
  const all=events||[];
  const countStatus=status=>all.filter(e=>e.status===status).length;
  $("admin-stats").innerHTML = `
    <div class="admin-stat">
      <span>Published events</span><strong>${countStatus("published")}</strong>
    </div>
    <div class="admin-stat">
      <span>Private events</span>
      <strong>${all.filter(e => e.visibility === "private").length}</strong>
    </div>
    <div class="admin-stat">
      <span>Drafts</span><strong>${countStatus("draft")}</strong>
    </div>
    <div class="admin-stat">
      <span>Cancelled</span><strong>${countStatus("cancelled")}</strong>
    </div>
  `;
  const filter=$("admin-filter").value;
  const shown=filter==="all"?all:all.filter(e=>e.status===filter);
  if(!shown.length){
    $("admin-events").innerHTML=`<div class="dashboard-empty">${all.length?"No events match this filter.":"No events yet. Use Create event to add your first session."}</div>`;
    return;
  }
  const parts=await Promise.all(shown.map(async e=>{
    const { data:regs, error:rerr } = await  supabase.from("registrations").select("id,player_name,player_email,player_phone,payment_method,payment_status,registration_status,created_at").eq("event_id",e.id).order("created_at");
    if(rerr)return `<article class="admin-event"><h4>${esc(e.title)}</h4><p>${esc(rerr.message)}</p></article>`;
    const rows = (regs || []).map(renderRegistrationRow).join("");
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
        ${e.status==="published" ? `<a class="button secondary" href="${esc(e.visibility === "private" ? inviteUrl(e.invite_token) : publicEventUrl(e.id))}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(e.title)} event in a new tab">View event ↗</a>` : ""}
      </div>
      ${e.visibility==="private"&&e.status!=="published"?'<p class="muted small">The event link will work once the event is published.</p>':''}
      ${rows?`<table><thead><tr><th>Player</th><th>Registration</th><th>Method</th><th>Payment</th><th>Action</th></tr></thead><tbody>${rows}</tbody></table>`:"<p class='muted small'>No registrations yet.</p>"}
    </article>`;
  }));
  $("admin-events").innerHTML=parts.join("");
  $("admin-events").querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>openEventEditor(shown.find(e=>e.id===b.dataset.edit))));
  document.querySelectorAll("[data-toggle]").forEach(b=>b.addEventListener("click",async()=>{
    const status=b.dataset.status==="published"?"draft":b.dataset.status==="cancelled"?"draft":"published";
    b.disabled=true;
    const { error } = await  supabase.from("events").update({
      status
    }).eq("id",b.dataset.toggle);
    if(error)alert(error.message);
    if (!dashboardRequested) await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-cancel-event]").forEach(b=>b.addEventListener("click",async()=>{
    const event=events.find(e=>e.id===b.dataset.cancelEvent);
    if(!event)return;
    const message = [
      `Cancel “${event.title}”?`,
      "The event will no longer be available on public or invitation pages.",
      "Existing registrations and payment records will remain in your dashboard.",
      "Please contact registered players yourself; full-event cancellation emails aren't implemented."
    ].join("\n\n");

    if (!window.confirm(message)) return;
    b.disabled=true;
    const { error } = await  supabase.from("events").update({
      status:"cancelled"
    }).eq("id",event.id);
    if(error)alert(error.message);
    else notice(`Event cancelled: ${event.title}. Registration and payment records were retained.`);
    if (!dashboardRequested) await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-delete-event]").forEach(b=>b.addEventListener("click",async()=>{
    const event=events.find(e=>e.id===b.dataset.deleteEvent);
    if(!event)return;
    const count=(await supabase.from("registrations").select("id",{
      count:"exact",head:true
    }).eq("event_id",event.id)).count;
    const warning = [
      "Are you absolutely sure you want to permanently delete this event?",
      `${event.title}\n${dateTime(event.starts_at)}`,
      `This will permanently delete ${count ?? "all associated"} registration records ` +
        "and their payment history. This action cannot be undone."
    ].join("\n\n");
    if(!window.confirm(warning))return;
    b.disabled=true;
    const { error } = await  supabase.rpc("organizer_delete_open_gym_event",{
      p_event_id:event.id
    });
    if (error) {
      alert(`Could not delete event: ${error.message}\n\nIf the function was not found, run phase2_batch1_upgrade.sql in Supabase first.`);b.disabled=false;return;
    }
    if($("edit-id").value===event.id) clearEditor();
    notice(`Permanently deleted: ${event.title}. Associated registrations were removed.`);
    if (!dashboardRequested) await loadEvents();if(validInviteToken)await loadInvitedEvent();await loadAdminEvents();
  }));
  document.querySelectorAll("[data-payment]").forEach(s=>s.addEventListener("change",async()=>{
    const { error } = await  supabase.from("registrations").update({
      payment_status:s.value
    }).eq("id",s.dataset.payment);if(error)alert(error.message);
  }));
  document.querySelectorAll("[data-cancel]").forEach(b=>b.addEventListener("click",async()=>{
    if (!confirm("Cancel this registration? If the player holds a confirmed spot, the next waitlisted player will be promoted automatically.")) return;
    b.disabled = true;
    const { error } = await  supabase.from("registrations").update({
      registration_status:"cancelled"
    }).eq("id",b.dataset.cancel);
    if(error) alert(error.message);
    if (!dashboardRequested) await loadEvents(); if(validInviteToken) await loadInvitedEvent(); await loadAdminEvents();
  }));
}

function editEvent(e){
  $("edit-id").value=e.id;
  $("event-title").value=e.title;
  $("event-venue").value=e.venue;
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
  $("event-price").value=(e.price_cents/100).toFixed(2);
  $("event-capacity").value=e.capacity;
  $("payment-instructions").value=e.payment_instructions||"";
  $("event-host").value=e.host_name||"";
  $("event-status").value=e.status;
  $("event-visibility").value=e.visibility||"public";
  $("event-description").value=e.description||"";
  $("editor-heading").textContent="Edit event";
  $("event-save-message").textContent=originalMinute!==roundedMinute
  ? "This event used a non-quarter-hour start. The time picker shows the nearest available quarter-hour; review it before saving."
  : "";

}

function toLocal(s){
  const d=new Date(s);
  return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
if(!configured){
  unavailable();
  $("admin-message").textContent="Setup required: add the Supabase URL and anon key in app.js.";
}
else {
  loadEvents();
  if (inviteToken !== null) loadInvitedEvent();
  if (manageToken !== null) loadManageRegistration();
  refreshAdmin();
}
