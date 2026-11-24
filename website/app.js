import {
  createClient
} from "https://esm.sh/@supabase/supabase-js@2.119.2/es2022/supabase-js.bundle.mjs";

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
let adminEventsEpoch = 0;
let adminAuditEpoch = 0;
if (dashboardRequested) {
  document.body.classList.add("organizer-view");
  document.title = "Organizer Dashboard | Colorado Springs Pickup Volleyball";
}
// Detail pages should return home for their Events / About navigation.
if (detailRequested) {
  $("events-nav").href = "./#events";
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
  $("events").innerHTML = `<div class="empty-state"><h3>Events are temporarily unavailable</h3><p>Please try again later.</p></div>`;
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
  if (publicEventId !== null) return renderPublicEventDetail(data||[]);
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
          ? "<strong>Shared by invitation.</strong> This event doesn't appear in public listings. Anyone with the invitation link can register."
          : "<strong>Everyone is welcome to register.</strong> This event is publicly listed, and you can share this page with friends. Everyone is welcome!"}</p>
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
        <p class="invite-booking-footnote">Pay by Venmo or cash</p>
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
  if (inviteToken === null) {
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
  eventCache=[invitedEvent];
  wireRegistrationButtons($("invitation-event"));
}

// Calendar files contain only event details, never player emails, invitation
// tokens, or registration management links. UTC dates preserve the event's
// actual instant across time zones and daylight-saving transitions.
const calendarUtc = value => {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z")
    : null;
};
function calendarEventDetails(event) {
  if (!event) return null;
  const start = calendarUtc(event.starts_at), end = calendarUtc(event.ends_at);
  return start && end && end > start ? { start, end } : null;
}
function googleCalendarLink(event) {
  const dates = calendarEventDetails(event);
  if (!dates) return null;
  const url = new URL("https://calendar.google.com/calendar/render");
  url.searchParams.set("action", "TEMPLATE");
  url.searchParams.set("text", String(event.title || "Pickup Volleyball"));
  url.searchParams.set("dates", `${dates.start}/${dates.end}`);
  url.searchParams.set("location", String(event.venue || ""));
  url.searchParams.set("details", "Colorado Springs Pickup Volleyball session. Check your registration email for your current status.");
  return url.toString();
}
// RFC 5545 text escaping and UTF-8 octet-aware folding to 75 bytes per line.
const icsText = value => String(value || "").replace(/\r\n?/g, "\n")
  .replace(/\\/g, "\\\\").replace(/\n/g, "\\n")
  .replace(/,/g, "\\,").replace(/;/g, "\\;");
function foldIcsLine(line) {
  const encoder = new TextEncoder();
  let output = "", bytes = 0;
  for (const character of line) {
    const size = encoder.encode(character).length;
    if (bytes + size > 75) { output += "\r\n "; bytes = 1; }
    output += character;
    bytes += size;
  }
  return output;
}
function createIcsCalendar(event) {
  const dates = calendarEventDetails(event);
  if (!dates) return null;
  const uid = String(event.id || "session").replace(/[^A-Za-z0-9-]/g, "");
  const lines = [
    "BEGIN:VCALENDAR", "VERSION:2.0",
    "PRODID:-//COS Volleyball//Event Calendar//EN",
    "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "BEGIN:VEVENT",
    `UID:${uid}@cosvolleyball.github.io`,
    `DTSTAMP:${calendarUtc(new Date())}`,
    `DTSTART:${dates.start}`, `DTEND:${dates.end}`,
    `SUMMARY:${icsText(event.title || "Pickup Volleyball")}`,
    `LOCATION:${icsText(event.venue || "")}`,
    `DESCRIPTION:${icsText("Colorado Springs Pickup Volleyball session. Check your registration email for your current status.")}`,
    "END:VEVENT", "END:VCALENDAR"
  ];
  return lines.map(foldIcsLine).join("\r\n") + "\r\n";
}
let registeredCalendarEvent = null;
function configureRegistrationCalendar(event, isRegistered) {
  const container = $("registration-calendar");
  const google = $("calendar-google");
  const download = $("calendar-download");
  const link = isRegistered ? googleCalendarLink(event) : null;
  registeredCalendarEvent = link ? event : null;
  container.hidden = !registeredCalendarEvent;
  download.disabled = !registeredCalendarEvent;
  if (link) google.href = link;
  else google.removeAttribute("href");
}
$("calendar-download").addEventListener("click", () => {
  const event = registeredCalendarEvent;
  const ics = event && createIcsCalendar(event);
  if (!ics) return;
  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const link = document.createElement("a");
  const url = URL.createObjectURL(blob);
  link.href = url;
  link.download = "cos-volleyball-event.ics";
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Allow the browser to start downloading before releasing the blob URL.
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});
// ── Player registration and email confirmation notice ────────────────────────
function openSignup(id) {
  const e=eventCache.find(x=>x.id===id);
  if(!e)return;
  $("event-id").value=id;
  $("signup-title").textContent=e.title;
  $("signup-summary").textContent=`${dateTime(e.starts_at)} · ${e.venue} · ${money(e.price_cents)}${e.spots_remaining<=0?" · This registration will join the waitlist.":""}`;
  $("signup-error").textContent="";
  $("signup-dialog").showModal();
  $("player-name").focus();
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
  const calendarSourceEvent = eventCache.find(e=>e.id===$("event-id").value);
  const btn=$("submit-signup");btn.disabled=true;btn.textContent="Registering…";$("signup-error").textContent="";
  const { data, error } = await  supabase.rpc("register_for_open_gym",{
    p_event_id:$("event-id").value,p_name:$("player-name").value.trim(),
    p_email:$("player-email").value.trim(),p_phone:null,
    p_payment_method:$("payment-method").value,
    // The database validates the token; event IDs cannot bypass private-event access.
    p_invite_token: invitedEvent?.id === $("event-id").value ? validInviteToken : null
  });
  btn.disabled=false;btn.textContent="Confirm registration";
  if (error) {
    if (error.code === "VB001") {
      $("signup-error").textContent = "You’re banned from registering. Contact an organizer if you have questions.";
      const reason = typeof error.details === "string" ? error.details.trim() : "";
      $("registration-ban-reason").textContent = reason ? "Organizer’s reason: " + reason : "";
      $("registration-ban-reason").hidden = !reason;
      $("registration-ban-dialog").showModal();
      $("registration-ban-title").focus();
      return;
    }
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
  // The database controls eligibility; this text only reflects its response.
  const eligibilityNotice = typeof data?.eligibility_notice === "string" ? data.eligibility_notice : "";
  notice(registrationMessage + (eligibilityNotice ? eligibilityNotice + " " : "") + emailGuidance);
  $("registration-success-title").textContent = data?.status === "waitlisted" ? "You're on the waitlist!" : "You're registered!";
  $("registration-success-description").textContent = eligibilityNotice || (data?.status === "waitlisted"
    ? "You don't have a reserved spot yet. We'll email you if a spot opens."
    : "Your spot has been reserved.");
  $("registration-success-email").textContent = submittedEmail;
  configureRegistrationCalendar(calendarSourceEvent, data?.status === "registered");
  $("registration-success-dialog").showModal();
  $("registration-success-title").focus();
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
      `<p>You can cancel your ${reg.registration_status==='waitlisted'?'waitlist entry':'reserved spot'} here.</p>
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
supabase?.auth.onAuthStateChange(event=>{
  if (event !== "INITIAL_SESSION") setTimeout(refreshAdmin,0);
});

// ── Phase 10: organizer-only player access rules ───────────────────────────
// All writes use a SECURITY DEFINER RPC with an independent organizer check.
// Anonymous visitors cannot read the access tables through RLS.
let phase10AccessEpoch = 0;
const phase10Date = value => value ? new Date(value).toLocaleString("en-US") : "—";

async function loadPhase10Access() {
  if (!supabase || !isOrganizer || !dashboardRequested || !$("phase10-access-panel").open) return;
  const epoch = ++phase10AccessEpoch;
  $("phase10-access-list").textContent = "Loading rules…";
  $("phase10-access-history").textContent = "Loading history…";
  const [rulesResult, auditResult] = await Promise.all([
    supabase.from("volleyball_player_access")
      .select("email,rule_type,expires_at,reason,updated_at,updated_by_email")
      .order("updated_at", { ascending: false }).limit(200),
    supabase.from("volleyball_player_access_audit")
      .select("email,action,reason,actor_email,recorded_at")
      .order("id", { ascending: false }).limit(40)
  ]);
  if (!isOrganizer || epoch !== phase10AccessEpoch) return;
  const list = $("phase10-access-list");
  const history = $("phase10-access-history");
  if (rulesResult.error) {
    list.textContent = "Unable to load access rules: " + rulesResult.error.message;
  } else {
    const rules = rulesResult.data || [];
    const now = Date.now();
    const active = rules.filter(r => r.rule_type === "banned" ||
      Date.parse(r.expires_at || "") > now);
    const expired = rules.length - active.length;
    const rows = active.map(r => {
      const state = r.rule_type === "banned"
        ? "Banned"
        : "Restricted until " + phase10Date(r.expires_at);
      return `<tr><td>${esc(r.email)}</td><td>${esc(state)}</td>
        <td>${esc(r.reason)}</td><td>${esc(r.updated_by_email || "Unknown")}</td>
        <td><button type="button" class="button secondary" data-phase10-manage="${esc(r.email)}">Manage</button></td></tr>`;
    }).join("");
    list.innerHTML = active.length ? `<div class="phase10-table-scroll"><table class="phase10-table">
      <thead><tr><th>Email</th><th>Status</th><th>Reason</th><th>Updated by</th><th></th></tr></thead>
      <tbody>${rows}</tbody></table></div>`
      : '<p class="small muted">No active restrictions or bans.</p>';
    if (expired) list.insertAdjacentHTML("beforeend",
      `<p class="small muted">${expired} expired restriction${expired===1?"":"s"} kept in the audit records.</p>`);
    list.querySelectorAll("[data-phase10-manage]").forEach(button =>
      button.addEventListener("click", () => {
        $("phase10-email").value = button.dataset.phase10Manage;
        $("phase10-action").value = "clear";
        $("phase10-action").dispatchEvent(new Event("change"));
        $("phase10-email").focus();
      })
    );
  }
  if (auditResult.error) {
    history.textContent = "Unable to load access history: " + auditResult.error.message;
  } else {
    const changes = auditResult.data || [];
    history.innerHTML = changes.length
      ? `<div class="phase10-table-scroll"><table class="phase10-table">
        <thead><tr><th>When</th><th>Player email</th><th>Action</th><th>Organizer</th><th>Reason</th></tr></thead>
        <tbody>${changes.map(r => `<tr><td>${esc(phase10Date(r.recorded_at))}</td>
          <td>${esc(r.email)}</td><td>${esc(r.action)}</td><td>${esc(r.actor_email || "Unknown")}</td>
          <td>${esc(r.reason || "—")}</td></tr>`).join("")}</tbody></table></div>`
      : '<p class="small muted">No access changes recorded.</p>';
  }
}
$("phase10-access-panel").addEventListener("toggle", () => {
  if ($("phase10-access-panel").open) void loadPhase10Access();
  else ++phase10AccessEpoch;
});
$("phase10-action").addEventListener("change", () => {
  const clearing = $("phase10-action").value === "clear";
  $("phase10-reason-label").textContent = clearing ? "Removal note (optional)" : "Reason shown to the player (optional)";
});
$("phase10-action").dispatchEvent(new Event("change"));
$("phase10-access-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase || !isOrganizer) return;
  const email = $("phase10-email").value.trim();
  const action = $("phase10-action").value;
  const reason = $("phase10-reason").value.trim();
  if (reason.length > 240) {
    $("phase10-feedback").textContent = "Enter up to 240 characters.";
    return;
  }
  if (action === "ban" && !window.confirm(
    "Ban new registrations for " + email + " until an organizer removes the ban? Existing reserved spots are not cancelled."
  )) return;
  if (action === "clear" && !window.confirm(
    "Remove the active restriction or ban for " + email + "? Eligible waitlisted players may be promoted automatically."
  )) return;
  const button = $("phase10-save");
  button.disabled = true;
  $("phase10-feedback").textContent = "Saving…";
  try {
    const { error } = await supabase.rpc("volleyball_organizer_set_access", {
      p_email: email, p_action: action, p_reason: reason || null
    });
    if (error) throw error;
    $("phase10-feedback").textContent = action === "restrict" ? "15-day restriction saved."
      : action === "ban" ? "Permanent ban saved." : "Access rule removed.";
    $("phase10-reason").value = "";
    await loadPhase10Access();
    // Removing a rule may fill vacancies; refresh the event roster too.
    await loadAdminEvents();
  } catch (error) {
    $("phase10-feedback").textContent = error.message;
  } finally {
    button.disabled = false;
  }
});

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
    ++adminEventsEpoch; // Discard event/roster responses started before logout.
    ++adminAuditEpoch;
    $("phase8-event-audit-view")?.replaceChildren();
    ++financeEpoch; // Ignore in-flight finance responses after logout.
    ++phase10AccessEpoch; // Clear sensitive access results after logout.
    $("phase10-access-panel").open = false;
    $("phase10-access-list").replaceChildren();
    $("phase10-access-history").replaceChildren();
    financeHosts = [];
    financeTransactions = [];
    financeEvents = [];
    $("finance-host-summary").replaceChildren();
    $("finance-history").replaceChildren();
    $("finance-stats").replaceChildren();
    $("finance-status").textContent = "";
    showDashboardTab("events", false);
    $("admin-events").replaceChildren();
    $("admin-stats").replaceChildren();
  }
  organizerLink.textContent = isOrganizer ? "Organizer Dashboard" : "Organizer Login";
  if (user && !isOrganizer) $("admin-message").textContent="This account does not have organizer access.";
  if (isOrganizer && dashboardRequested) {
    if (!$("dashboard-finance-pane").hidden) await loadFinance();
    else await loadAdminEvents();
  }
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
// Duplicate only editable event settings. Never reuse the original event ID,
// private invitation token, player registrations, or accounting records.
function openDuplicateEventEditor(source) {
  if (!isOrganizer || !source) return;
  editEvent(source);
  $("edit-id").value = ""; // Submit uses INSERT, not UPDATE.
  $("event-date").value = ""; // Require the organizer to choose a new date.
  $("event-status").value = "draft"; // Do not accidentally publish.
  $("editor-heading").textContent = "Duplicate event";
  $("event-duplicate-hint").hidden = false;
  updateEventEndPreview();
  $("event-editor-dialog").showModal();
  $("event-date").focus();
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
  $("event-duplicate-hint").hidden=true;
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
// ── Phase 9: Event check-in and payment breakdown ───────────────────────────
// Keep the same player row in view after the dashboard refreshes, making it
// practical to mark multiple payments on mobile without losing your place.
async function phase9RefreshRow(control) {
  const row = control.closest(".phase9-player-row");
  const id = row?.dataset.player;
  const top = row?.getBoundingClientRect().top;
  await loadAdminEvents();
  if (id && typeof top === "number") {
    const next = [...document.querySelectorAll(".phase9-player-row")].find(el => el.dataset.player === id);
    if (next) window.scrollBy(0, next.getBoundingClientRect().top - top);
  }
}
// One designated organizer collects payments for an event. Amounts below are
// calculated from marked-paid registrations and the CURRENT event fee; they are
// not a direct Venmo integration or an independent confirmation of payment.
const phase9Method = r => r.actual_payment_method || r.payment_method || "venmo";
const phase9MethodNames = {venmo:"Venmo", cash:"Cash", apple_cash:"Apple Cash (legacy)"};
function phase9RosterRow(r) {
  const paid = r.payment_status === "paid";
  const noShow = r.attendance_status === "no_show";
  const present = r.attendance_status === "present";
  const eligible = r.registration_status === "registered";
  const method = phase9Method(r);
  const options = ["unpaid", "paid", "refunded"].map(status =>
    `<option value="${status}" ${r.payment_status === status ? "selected" : ""}>${status.charAt(0).toUpperCase()+status.slice(1)}</option>`
  ).join("");
  const methods = Object.entries(phase9MethodNames).map(([value,label]) =>
    `<option value="${value}" ${method === value ? "selected" : ""}>${label}</option>`
  ).join("");
  const attendance = [["not_marked", "Not marked"], ["present", "Present"], ["no_show", "No-show"]]
    .map(([value,label])=>`<option value="${value}" ${(r.attendance_status || "not_marked") === value ? "selected" : ""}>${label}</option>`).join("");
  const statusLabel = paid ? "✓ Paid" : r.payment_status === "refunded" ? "↩ Refunded" : "● Unpaid";
  const paymentBadge = paid ? "phase9-badge-paid" : r.payment_status === "refunded" ? "phase9-badge-refunded" : "phase9-badge-unpaid";
  const attendanceBadge = noShow ? '<span class="phase9-badge phase9-badge-no-show">No-show</span>'
    : present ? '<span class="phase9-badge phase9-badge-present">Present</span>' : '';
  const attribution = [
    r.payment_updated_by_email ? `Payment: ${r.payment_updated_by_email}` : null,
    r.attendance_updated_by_email ? `Check-in: ${r.attendance_updated_by_email}` : null
  ].filter(Boolean).join(" · ");
  const cancel = r.registration_status === "cancelled"
    ? '<span class="muted small">Cancelled</span>'
    : `<button class="button secondary" data-cancel="${esc(r.id)}" aria-label="Cancel registration for ${esc(r.player_name)}">Cancel</button>`;
  const actionableUnpaid = eligible && !noShow && r.payment_status === "unpaid";
  return `<tr class="phase9-player-row ${actionableUnpaid ? "phase9-unpaid-row" : ""}" data-player="${esc(r.id)}">
    <td data-label="Player" class="phase9-player-cell"><strong>${esc(r.player_name)}</strong>
      <span class="muted small">${esc(r.player_email)}</span>
      ${attribution ? `<span class="phase9-updated" title="Last action recorded by organizer account">${esc(attribution)}</span>` : ""}</td>
    <td data-label="Registration">${esc(r.registration_status)}</td>
    <td data-label="Payment"><span class="phase9-badge ${paymentBadge}">${statusLabel}</span>
      <select aria-label="Payment status for ${esc(r.player_name)}" data-payment="${esc(r.id)}">${options}</select></td>
    <td data-label="Method"><span class="phase9-method-hint">Selected: ${esc(phase9MethodNames[r.payment_method] || r.payment_method)}</span>
      <select aria-label="Actual payment method for ${esc(r.player_name)}" data-received-method="${esc(r.id)}" ${paid ? "" : "disabled"}>${methods}</select></td>
    <td data-label="Attendance">${attendanceBadge}
      <select aria-label="Attendance for ${esc(r.player_name)}" data-attendance="${esc(r.id)}" ${eligible ? "" : "disabled"}>${attendance}</select></td>
    <td data-label="Action"><div class="admin-reg-actions">${cancel}</div></td>
  </tr>`;
}

function phase9RosterPanel(event, registrations) {
  const fee = Number(event.price_cents) || 0;
  const paid = registrations.filter(r => r.payment_status === "paid");
  const sum = method => paid.filter(r => phase9Method(r) === method).length;
  const venmo = sum("venmo"), cash = sum("cash"), other = paid.length - venmo - cash;
  const unpaid = registrations.filter(r => r.registration_status === "registered" && r.payment_status === "unpaid" && r.attendance_status !== "no_show").length;
  const noShow = registrations.filter(r => r.registration_status === "registered" && r.attendance_status === "no_show").length;
  const present = registrations.filter(r => r.registration_status === "registered" && r.attendance_status === "present").length;
  const box = (title, value, detail, extraClass="") => `<div class="phase9-metric ${extraClass}"><span>${title}</span><strong>${value}</strong><small>${detail}</small></div>`;
  const unpaidFiltered = phase91UnpaidEventIds.has(String(event.id));
  // Registered players: alphabetical for check-in. Waitlisted players retain
  // signup order (promotion priority); cancelled/other entries appear last.
  const displayRegistrations = [
    ...registrations.filter(r => r.registration_status === "registered")
      .sort((a,b) => String(a.player_name || "").localeCompare(
        String(b.player_name || ""), undefined, { sensitivity: "base" })),
    ...registrations.filter(r => r.registration_status === "waitlisted"),
    ...registrations.filter(r => r.registration_status !== "registered" && r.registration_status !== "waitlisted")
  ];
  return `<section class="phase9-checkin ${unpaidFiltered ? "phase9-unpaid-only" : ""}" aria-label="Payment and attendance summary">
    <div class="phase9-summary">
      ${box("Venmo marked paid",money(venmo*fee),`${venmo} player${venmo===1?"":"s"}`,"phase9-venmo")}
      ${box("Cash marked paid",money(cash*fee),`${cash} player${cash===1?"":"s"}`)}
      ${box("Total marked paid",money(paid.length*fee),`${paid.length} player${paid.length===1?"":"s"}`)}
      ${box("Still unpaid",String(unpaid),"Excludes no-shows","phase9-alert")}
      ${box("Present",String(present),"Checked in")}
      ${box("No-shows",String(noShow),"Marked absent")}
    </div>
    ${other ? `<p class="phase9-legacy-note">${other} paid registration${other===1?"":"s"} (${money(other*fee)}) recorded through a legacy/other method and included in the total.</p>` : ""}
    <p class="phase9-summary-note">Totals use marked-paid registrations at the event's listed price; confirm the actual Venmo balance before transferring funds. Attendance does not affect payment totals.</p>
    <div class="phase9-roster-toolbar"><h5>Player check-in</h5>
      <button type="button" class="button secondary phase9-unpaid-toggle" data-unpaid-toggle="${esc(event.id)}" aria-pressed="${unpaidFiltered}">${unpaidFiltered ? "Show all players" : "Show unpaid only"}</button>
    </div>
    ${registrations.length ? `<div class="phase9-table-scroll"><table class="phase9-roster" aria-label="Check-in and payment roster for ${esc(event.title)}"><thead><tr><th scope="col">Player</th><th scope="col">Registration</th><th scope="col">Payment</th><th scope="col">Method received</th><th scope="col">Attendance</th><th scope="col">Action</th></tr></thead><tbody>${displayRegistrations.map(phase9RosterRow).join("")}</tbody></table></div>` : '<p class="muted small">No registrations yet.</p>'}
  </section>`;
}

// Preserve expanded events through roster refreshes and payment/attendance updates.
// All events start collapsed on the initial load.
const adminExpandedEventIds = new Set();
// Phase 9.1: upcoming/past event sections and the roster filter stay open/active
// when recording a payment or attendance causes the dashboard to refresh.
let adminPastEventsExpanded = false;
const phase91UnpaidEventIds = new Set();

async function loadAdminEvents(){
  if (!supabase || !isOrganizer) return;
  const epoch = ++adminEventsEpoch;
  const stillCurrent = () => isOrganizer && epoch === adminEventsEpoch;
  void loadPhase8EventAudit();
  // Phase 9.1: upcoming/past event sections, for all event statuses and filters.
  // An event becomes past after its scheduled end (not at its start).
  const { data:events, error } = await  supabase.from("events").select("*").order("starts_at",{
    ascending:true
  });
  if (!stillCurrent()) return;
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
  const now = Date.now();
  const isPast = e => {
    const endsAt = Date.parse(e.ends_at || e.starts_at || "");
    return Number.isFinite(endsAt) && endsAt <= now;
  };
  const upcoming = shown.filter(e => !isPast(e))
    .sort((a,b) => Date.parse(a.starts_at) - Date.parse(b.starts_at));
  const past = shown.filter(isPast)
    .sort((a,b) => Date.parse(b.starts_at) - Date.parse(a.starts_at));
  const ordered = [...upcoming, ...past];
  if(!shown.length){
    $("admin-events").innerHTML=`<div class="dashboard-empty">${all.length?"No events match this filter.":"No events yet. Use Create event to add your first session."}</div>`;
    return;
  }
  // Keep each filter URL short and page through busy rosters without hitting
  // the API row limit. Each event's players stay in signup order.
  const rosterByEvent = new Map(ordered.map(e => [e.id, []]));
  const rosterErrors = new Map();
  const pageSize = 500;
  for (let start = 0; start < ordered.length; start += 40) {
    const ids = ordered.slice(start, start + 40).map(e => e.id);
    for (let offset = 0; ; offset += pageSize) {
      const {data, error} = await supabase.from("registrations")
        .select("event_id,id,player_name,player_email,payment_method,actual_payment_method,payment_status,registration_status,attendance_status,payment_updated_by_email,attendance_updated_by_email,created_at")
        .in("event_id", ids).order("created_at").order("id").range(offset, offset + pageSize - 1);
      if (!stillCurrent()) return;
      if (error) {
        for (const id of ids) rosterErrors.set(id, error.message);
        break;
      }
      for (const row of data || []) rosterByEvent.get(row.event_id)?.push(row);
      if ((data || []).length < pageSize) break;
    }
  }
  const parts = ordered.map(e => {
    if (rosterErrors.has(e.id)) return `<article class="admin-event"><h4>${esc(e.title)}</h4><p>${esc(rosterErrors.get(e.id))}</p></article>`;
    const regs = rosterByEvent.get(e.id);
    const registeredCount = (regs || []).filter(r => r.registration_status === "registered").length;
    return `<details class="admin-event admin-event-collapsible" data-admin-collapse-id="${esc(e.id)}" ${adminExpandedEventIds.has(String(e.id)) ? "open" : ""}>
      <summary class="admin-event-collapse-summary" aria-label="Expand or collapse ${esc(e.title)}">
        <span class="admin-event-collapse-heading">
          <span class="admin-event-collapse-labels">
            <span class="pill">${esc(e.status)}</span>
            <span class="pill ${e.visibility==="private"?"private-pill":""}">${e.visibility==="private"?"Private · link only":"Public"}</span>
          </span>
          <strong class="admin-event-collapse-title">${esc(e.title)}</strong>
          <span class="muted small admin-event-collapse-meta">${esc(dateTime(e.starts_at))} · ${esc(e.venue)} · ${registeredCount} registered / ${e.capacity} spots</span>
        </span>
        <span class="admin-event-collapse-chevron" aria-hidden="true"></span>
      </summary>
      <div class="admin-event-collapse-content">
      <p class="muted small">${money(e.price_cents)} per player</p>
      <div class="admin-actions">
        <button class="button secondary" data-edit="${e.id}">Edit event</button>
        <button class="button secondary" type="button" data-duplicate="${esc(e.id)}" aria-label="Duplicate ${esc(e.title)}">Duplicate event</button>
        <button class="button secondary" data-toggle="${e.id}" data-status="${e.status}">${e.status==="published"?"Unpublish":e.status==="cancelled"?"Reopen as draft":"Publish"}</button>
        ${e.status!=="cancelled"?`<button class="button button-warn" data-cancel-event="${e.id}">Cancel event</button>`:"<span class='cancelled-hint'>Cancelled · registrations retained</span>"}
        <button class="button button-danger-outline" data-delete-event="${e.id}">Delete permanently</button>
        ${e.status==="published" ? `<a class="button secondary" href="${esc(e.visibility === "private" ? inviteUrl(e.invite_token) : publicEventUrl(e.id))}" target="_blank" rel="noopener noreferrer" aria-label="View ${esc(e.title)} event in a new tab">View event ↗</a>` : ""}
      </div>
      ${e.visibility==="private"&&e.status!=="published"?'<p class="muted small">The event link will work once the event is published.</p>':''}
      <div data-roster-container></div>
      </div>
    </details>`;
  });
  if (!stillCurrent()) return;
  const upcomingCards = parts.slice(0, upcoming.length).join("");
  const pastCards = parts.slice(upcoming.length).join("");
  $("admin-events").innerHTML = `
    <section class="phase91-events-section" aria-label="Upcoming events">
      <div class="phase91-events-heading"><h3>Upcoming Events</h3><span class="phase91-events-count">${upcoming.length}</span></div>
      ${upcoming.length ? upcomingCards : '<p class="muted small phase91-empty">No upcoming events match this filter.</p>'}
    </section>
    ${past.length ? `<details class="phase91-past-section" data-phase91-past ${adminPastEventsExpanded ? "open" : ""}>
      <summary class="phase91-past-heading">
        <span class="phase91-past-title">Past Events <span class="phase91-events-count">${past.length}</span></span>
        <span class="phase91-past-chevron" aria-hidden="true"></span>
      </summary>
      <div class="phase91-past-content">${pastCards}</div>
    </details>` : ""}
  `;
  const pastSection = $("admin-events").querySelector("[data-phase91-past]");
  if (pastSection) pastSection.addEventListener("toggle", () => {
    adminPastEventsExpanded = pastSection.open;
  });
  const eventsById = new Map(ordered.map(event => [String(event.id), event]));
  $("admin-events").querySelectorAll("[data-admin-collapse-id]").forEach(card => {
    const id = card.dataset.adminCollapseId;
    const container = card.querySelector("[data-roster-container]");
    const renderRoster = () => {
      if (container.hasChildNodes()) return;
      container.innerHTML = phase9RosterPanel(eventsById.get(id), rosterByEvent.get(id));
      wireRosterControls(container);
    };
    if (card.open) renderRoster();
    card.addEventListener("toggle", () => {
      if (card.open) {
        adminExpandedEventIds.add(id);
        renderRoster();
      } else adminExpandedEventIds.delete(id);
    });
  });
  $("admin-events").querySelectorAll("[data-edit]").forEach(b=>b.addEventListener("click",()=>openEventEditor(shown.find(e=>e.id===b.dataset.edit))));
  $("admin-events").querySelectorAll("[data-duplicate]").forEach(b=>b.addEventListener("click",()=>
    openDuplicateEventEditor(shown.find(e=>String(e.id)===b.dataset.duplicate))));
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
}

function wireRosterControls(container) {
  // Phase 9: Updates persist immediately under the existing organizer RLS.
  // Database trigger records who last changed payment or attendance fields.
  container.querySelectorAll("[data-payment]").forEach(select => select.addEventListener("change", async () => {
    select.disabled = true;
    const method = container.querySelector(`[data-received-method="${select.dataset.payment}"]`)?.value || "venmo";
    const update = {payment_status: select.value};
    if (select.value === "paid") update.actual_payment_method = method;
    const {error} = await supabase.from("registrations").update(update).eq("id", select.dataset.payment);
    if (error) window.alert(error.message);
    await phase9RefreshRow(select);
  }));
  container.querySelectorAll("[data-received-method]").forEach(select => select.addEventListener("change", async () => {
    select.disabled = true;
    const {error} = await supabase.from("registrations").update({actual_payment_method: select.value}).eq("id", select.dataset.receivedMethod);
    if (error) window.alert(error.message);
    await phase9RefreshRow(select);
  }));
  container.querySelectorAll("[data-attendance]").forEach(select => select.addEventListener("change", async () => {
    select.disabled = true;
    const {error} = await supabase.from("registrations").update({attendance_status: select.value}).eq("id", select.dataset.attendance);
    if (error) window.alert(error.message);
    await phase9RefreshRow(select);
  }));
  container.querySelectorAll("[data-unpaid-toggle]").forEach(button => button.addEventListener("click", () => {
    const panel = button.closest(".phase9-checkin");
    const active = panel.classList.toggle("phase9-unpaid-only");
    const eventId = button.dataset.unpaidToggle;
    if (active) phase91UnpaidEventIds.add(eventId);
    else phase91UnpaidEventIds.delete(eventId);
    button.setAttribute("aria-pressed", String(active));
    button.textContent = active ? "Show all players" : "Show unpaid only";
  }));
  container.querySelectorAll("[data-cancel]").forEach(b=>b.addEventListener("click",async()=>{
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
  $("event-duplicate-hint").hidden=true;
  $("event-save-message").textContent=originalMinute!==roundedMinute
  ? "This event used a non-quarter-hour start. The time picker shows the nearest available quarter-hour; review it before saving."
  : "";

}

function toLocal(s){
  const d=new Date(s);
  return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);
}
// ── Phase 6: organizer-only community finances ────────────────────────────
// Ledger hosts are display names, not login accounts. Supabase RLS is the
// security boundary. Currency is stored and calculated in integer cents.
let financeHosts = [];
let financeTransactions = [];
let financeEvents = [];
let financeEpoch = 0;

function showDashboardTab(which, refresh = true) {
  if (!isOrganizer && which === "finance") return;
  const finance = which === "finance";
  $("dashboard-events-pane").hidden = finance;
  $("dashboard-finance-pane").hidden = !finance;
  for (const [id, selected] of [["dashboard-tab-events", !finance], ["dashboard-tab-finance", finance]]) {
    $(id).setAttribute("aria-selected", String(selected));
    $(id).tabIndex = selected ? 0 : -1;
    $(id).classList.toggle("active", selected);
  }
  if (finance && refresh) void loadFinance();
}
$("dashboard-tab-events").addEventListener("click", () => showDashboardTab("events"));
$("dashboard-tab-finance").addEventListener("click", () => showDashboardTab("finance"));
// Arrow keys, Home and End follow the WAI-ARIA tab keyboard pattern.
$("dashboard-tab-events").parentElement.addEventListener("keydown", event => {
  const tabs = [$("dashboard-tab-events"), $("dashboard-tab-finance")];
  const index = tabs.indexOf(document.activeElement);
  if (index === -1) return;
  let next;
  switch (event.key) {
    case "ArrowRight": next = (index + 1) % tabs.length; break;
    case "ArrowLeft": next = (index + tabs.length - 1) % tabs.length; break;
    case "Home": next = 0; break;
    case "End": next = tabs.length - 1; break;
    default: return;
  }
  event.preventDefault();
  showDashboardTab(next === 0 ? "events" : "finance");
  tabs[next].focus();
});
$("finance-refresh").addEventListener("click", () => void loadFinance());

function financeTypeChanged() {
  const kind = $("finance-kind").value;
  const transfer = kind === "transfer";
  $("finance-host-label").textContent = kind === "collection"
    ? "Who received the money?" : kind === "expense"
      ? "Who paid for the expense?" : "Who sent the money?";
  $("finance-to-wrap").hidden = !transfer;
  $("finance-to-host").required = transfer;
  $("finance-event-wrap").hidden = transfer;
  $("finance-event").disabled = transfer;
}
$("finance-kind").addEventListener("change", financeTypeChanged);
financeTypeChanged();

function financeLocalToday() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}
$("finance-date").value = financeLocalToday();

function populateFinanceChoices() {
  const hostIds = ["finance-host", "finance-to-host"];
  for (const id of hostIds) {
    const select = $(id);
    const previous = select.value;
    select.replaceChildren(new Option(financeHosts.length ? "Choose a host" : "Add a host first", ""));
    for (const host of financeHosts) select.add(new Option(host.name, host.id));
    select.value = financeHosts.some(h => h.id === previous) ? previous : "";
  }
  const events = $("finance-event");
  const previousEvent = events.value;
  events.replaceChildren(new Option("Not linked to an event", ""));
  for (const event of financeEvents) {
    events.add(new Option(`${new Date(event.starts_at).toLocaleDateString()} · ${event.title}`, event.id));
  }
  events.value = financeEvents.some(e => e.id === previousEvent) ? previousEvent : "";
}

// Fetch all pages, rather than silently omitting older rows from balances.
async function fetchAllFinanceTransactions() {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await supabase.from("finance_transactions")
      .select("*")
      .order("occurred_on", { ascending: false })
      .order("created_at", { ascending: false })
      .order("id", { ascending: false })
      .range(offset, offset + pageSize - 1);
    if (error) throw error;
    rows.push(...(data || []));
    if (!data || data.length < pageSize) return rows;
  }
}

async function loadFinance() {
  if (!supabase || !isOrganizer || !dashboardRequested) return;
  const epoch = ++financeEpoch;
  $("finance-status").textContent = "Loading finance records…";
  try {
    const [hostsResult, transactions, eventsResult] = await Promise.all([
      supabase.from("finance_hosts").select("id,name").order("name"),
      fetchAllFinanceTransactions(),
      supabase.from("events").select("id,title,starts_at").order("starts_at", { ascending: false }).limit(500)
    ]);
    if (hostsResult.error) throw hostsResult.error;
    if (eventsResult.error) throw eventsResult.error;
    if (epoch !== financeEpoch || !isOrganizer) return;
    financeHosts = hostsResult.data || [];
    financeTransactions = transactions;
    financeEvents = eventsResult.data || [];
    populateFinanceChoices();
    renderFinances();
    $("finance-status").textContent = `Showing ${transactions.length} recorded transaction${transactions.length === 1 ? "" : "s"}.`;
  } catch (error) {
    if (epoch === financeEpoch) $("finance-status").textContent = `Unable to load finances: ${error.message}`;
  }
}

function renderFinances() {
  const balances = new Map(financeHosts.map(host => [host.id, {
    name: host.name, spent: 0, collected: 0, sent: 0, received: 0
  }]));
  let totalCollected = 0;
  let totalSpent = 0;
  for (const row of financeTransactions) {
    if (row.voided_at) continue;
    const host = balances.get(row.host_id);
    const amount = Number(row.amount_cents);
    if (!host) continue;
    if (row.kind === "collection") {
      host.collected += amount;
      totalCollected += amount;
    } else if (row.kind === "expense") {
      host.spent += amount;
      totalSpent += amount;
    } else if (row.kind === "transfer") {
      host.sent += amount;
      const recipient = balances.get(row.to_host_id);
      if (recipient) recipient.received += amount;
    }
  }
  const surplus = totalCollected - totalSpent;
  $("finance-stats").innerHTML = [
    ["Total collected", totalCollected],
    ["Community expenses", totalSpent],
    ["Community net balance", surplus]
  ].map(([label, cents]) => `<div class="finance-stat"><span>${label}</span><strong>${money(cents)}</strong></div>`).join("");

  const hosts = financeHosts.map(host => {
    const b = balances.get(host.id);
    const position = b.collected + b.received - b.spent - b.sent;
    const className = position > 0 ? "finance-held" : position < 0 ? "finance-owed" : "finance-neutral";
    const status = position > 0 ? `Holds ${money(position)}` : position < 0
      ? `Owed ${money(-position)}` : "Settled";
    return `<tr><td>${esc(b.name)}</td><td class="finance-number">${money(b.spent)}</td>
      <td class="finance-number">${money(b.collected)}</td>
      <td class="finance-number">${money(b.received)}</td>
      <td class="finance-number">${money(b.sent)}</td>
      <td class="finance-number ${className}">${status}</td></tr>`;
  }).join("");
  $("finance-host-summary").innerHTML = financeHosts.length ? `<table class="finance-table">
    <thead><tr><th>Host</th><th class="finance-number">Paid</th><th class="finance-number">Collected</th><th class="finance-number">Transfers in</th><th class="finance-number">Transfers out</th><th class="finance-number">Net position</th></tr></thead>
    <tbody>${hosts}</tbody></table>` : `<p class="finance-empty">No hosts yet. Add a host below to start the ledger.</p>`;

  const hostName = id => balances.get(id)?.name || "Unknown host";
  const kinds = {collection:"Collection",expense:"Expense",transfer:"Transfer"};
  const history = financeTransactions.map(row => {
    const names = row.kind === "transfer"
      ? `${hostName(row.host_id)} → ${hostName(row.to_host_id)}` : hostName(row.host_id);
    const voided = Boolean(row.voided_at);
    return `<tr class="${voided ? "finance-history-void" : ""}">
      <td>${esc(row.occurred_on)}</td>
      <td>${esc(kinds[row.kind] || row.kind)}${voided ? " (voided)" : ""}</td>
      <td>${esc(names)}</td>
      <td class="finance-number ${voided ? "finance-voided" : ""}">${money(Number(row.amount_cents))}</td>
      <td>${row.event_label ? `${esc(row.event_label)} · ` : ""}${esc(row.note || "")}${voided ? `<div>Reason: ${esc(row.void_reason || "")}</div>` : ""}</td>
      <td><div class="small">Recorded by: ${esc(row.created_by_email || row.created_by || "Unknown (older record)")}</div>${voided ? `<div class="small">Voided by: ${esc(row.voided_by_email || row.voided_by || "Unknown")}</div>` : ""}</td>
      <td>${voided ? "—" : `<button class="finance-void-button" type="button" data-finance-void="${esc(row.id)}" aria-label="Void ${esc(kinds[row.kind] || row.kind)} of ${money(Number(row.amount_cents))} on ${esc(row.occurred_on)}">Void</button>`}</td>
    </tr>`;
  }).join("");
  $("finance-history").innerHTML = financeTransactions.length ? `<table class="finance-table">
    <thead><tr><th>Date</th><th>Type</th><th>Host(s)</th><th class="finance-number">Amount</th><th>Event / note</th><th>Accountability</th><th>Correction</th></tr></thead>
    <tbody>${history}</tbody></table>` : `<p class="finance-empty">No transactions yet. Record your first collection or expense above.</p>`;

  $("finance-history").querySelectorAll("[data-finance-void]").forEach(button => button.addEventListener("click", async () => {
    if (!isOrganizer) return;
    const reason = window.prompt("Why should this transaction be voided? (This will remain in the history.)");
    if (reason === null) return;
    if (reason.trim().length < 3 || reason.trim().length > 500) {
      window.alert("Enter a reason between 3 and 500 characters.");
      return;
    }
    if (!window.confirm("Void this entry? It will no longer count toward balances, but its history will remain visible.")) return;
    button.disabled = true;
    const { error } = await supabase.rpc("finance_void_transaction", {
      p_transaction_id: button.dataset.financeVoid, p_reason: reason.trim()
    });
    if (error) { window.alert(error.message); button.disabled = false; return; }
    await loadFinance();
  }));
}

$("finance-host-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase || !isOrganizer) return;
  const input = $("finance-new-host");
  const name = input.value.trim();
  if (!name) return;
  const button = event.currentTarget.querySelector('button[type="submit"]');
  button.disabled = true;
  $("finance-host-feedback").textContent = "Saving…";
  try {
    const { error } = await supabase.from("finance_hosts").insert({ name });
    if (error) throw error;
    input.value = "";
    await loadFinance();
    $("finance-host-feedback").textContent = `Host added: ${name}`;
  } catch (error) { $("finance-host-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});

$("finance-entry-form").addEventListener("submit", async event => {
  event.preventDefault();
  if (!supabase || !isOrganizer) return;
  const kind = $("finance-kind").value;
  const from = $("finance-host").value;
  const to = $("finance-to-host").value;
  const cents = Math.round(Number($("finance-amount").value) * 100);
  if (!from || !Number.isSafeInteger(cents) || cents < 1 || cents > 100000000) {
    $("finance-entry-feedback").textContent = "Select a host and enter a valid positive amount."; return;
  }
  if (kind === "transfer" && (!to || from === to)) {
    $("finance-entry-feedback").textContent = "Choose two different hosts for a transfer."; return;
  }
  const eventId = kind !== "transfer" ? $("finance-event").value : "";
  const eventRecord = financeEvents.find(e => e.id === eventId);
  const entry = {
    kind,
    amount_cents: cents,
    occurred_on: $("finance-date").value,
    host_id: from,
    to_host_id: kind === "transfer" ? to : null,
    event_id: eventId || null,
    event_label: eventRecord ? `${eventRecord.title} (${new Date(eventRecord.starts_at).toLocaleDateString()})`.slice(0, 200) : null,
    note: $("finance-note").value.trim()
  };
  const button = $("finance-save");
  button.disabled = true;
  $("finance-entry-feedback").textContent = "Saving…";
  try {
    const { error } = await supabase.from("finance_transactions").insert(entry);
    if (error) throw error;
    $("finance-amount").value = "";
    $("finance-note").value = "";
    $("finance-event").value = "";
    await loadFinance();
    $("finance-entry-feedback").textContent = "Transaction saved.";
  } catch (error) { $("finance-entry-feedback").textContent = error.message; }
  finally { button.disabled = false; }
});


// ── Phase 8: organizer-only event accountability ───────────────────────────
// Authenticated RLS protects event_audit_log. Actor names are snapshotted in
// the database so they remain readable after an organizer account is removed.
async function loadPhase8EventAudit() {
  if (!supabase || !isOrganizer) return;
  const epoch = ++adminAuditEpoch;
  const hostPane = $("dashboard-events-pane");
  if (!hostPane) return;
  let panel = $("phase8-event-audit-view");
  if (!panel) {
    panel = document.createElement("section");
    panel.id = "phase8-event-audit-view";
    panel.className = "finance-card";
    panel.style.marginTop = "1.5rem";
    hostPane.appendChild(panel);
  }
  panel.innerHTML = '<h3>Recent event activity</h3><p class="muted small">Loading audit history…</p>';
  const { data, error } = await supabase.from("event_audit_log")
    .select("id,event_title,action,actor_user_id,actor_email,recorded_at,changes")
    .order("id", { ascending: false }).limit(50);
  if (!isOrganizer || epoch !== adminAuditEpoch) return;
  if (error) {
    panel.innerHTML = `<h3>Recent event activity</h3><p class="error">${esc(error.message)}</p>`;
    return;
  }
  if (!data?.length) {
    panel.innerHTML = '<h3>Recent event activity</h3><p class="muted small">No event changes recorded since Phase 8 was installed.</p>';
    return;
  }
  const descriptions = data.map(entry => {
    const changes = entry.changes || {};
    const changed = Object.keys(changes).map(key => key.replace(/_/g, " ")).join(", ");
    const actor = entry.actor_email || entry.actor_user_id || "Unknown organizer";
    return `<tr><td>${esc(new Date(entry.recorded_at).toLocaleString())}</td>
      <td>${esc(entry.event_title)}</td><td>${esc(entry.action)}</td>
      <td>${esc(actor)}</td><td>${esc(changed || "—")}</td></tr>`;
  }).join("");
  panel.innerHTML = `<h3>Recent event activity</h3><p class="muted small">Latest 50 changes. Only organizers can see this history.</p>
    <div class="finance-table-wrap"><table class="finance-table">
      <thead><tr><th>When</th><th>Event</th><th>Action</th><th>Organizer account</th><th>Fields changed</th></tr></thead>
      <tbody>${descriptions}</tbody></table></div>`;
}

if(!configured){
  unavailable();
  $("admin-message").textContent="Setup required: add the Supabase URL and anon key in app.js.";
}
else {
  if (!dashboardRequested && inviteToken === null && manageToken === null) loadEvents();
  if (inviteToken !== null) loadInvitedEvent();
  if (manageToken !== null) loadManageRegistration();
  refreshAdmin();
}
