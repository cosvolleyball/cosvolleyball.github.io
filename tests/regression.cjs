// Run: cd tests && npm ci && npm test
process.env.TZ = "America/Denver";
// Executes real application JavaScript against the real HTML in JSDOM with an isolated fake backend; never contacts Supabase.
const { JSDOM } = require("jsdom");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const root = path.resolve(__dirname, "../website");
const app = fs.readFileSync(path.join(root, "app.js"), "utf8");
const results = [];
(async () => {
  let dom,
    errors = [];
  const mockInit = () => {
    window.calls = [];
    window.reply = {};
    window.session = null;
    window.fakeSupabase = {
      auth: {
        getSession: async () => ({ data: { session: window.session } }),
        onAuthStateChange: () => {},
        signOut: async () => {
          window.session = null;
          return {};
        },
      },
      rpc: async (name, args) => {
        window.calls.push({ name, args });
        return window.reply[name] || { data: [], error: null };
      },
      from: (table) => {
        const q = { table, ops: [] };
        const chain = new Proxy(
          {},
          {
            get: (_, prop) =>
              prop === "then"
                ? (resolve, reject) => {
                    window.calls.push(q);
                    Promise.resolve(
                      window.queryHandler
                        ? window.queryHandler(q)
                        : { data: [], error: null },
                    ).then(resolve, reject);
                  }
                : (...args) => {
                    q.ops.push([prop, ...args]);
                    return chain;
                  },
          },
        );
        return chain;
      },
    };
  };
  const page = {
    evaluate: async (fn, arg) => {
      dom.window.__arg = arg;
      return dom.window.eval("(" + fn.toString() + ")(__arg)");
    },
    locator: (selector) => ({
      textContent: async () =>
        dom.window.document.querySelector(selector)?.textContent,
      getAttribute: async (key) =>
        dom.window.document.querySelector(selector)?.getAttribute(key),
      isVisible: async () =>
        !dom.window.document.querySelector(selector)?.hidden,
    }),
  };
  async function boot(query = "") {
    dom?.window.close();
    dom = new JSDOM(fs.readFileSync(path.join(root, "index.html"), "utf8"), {
      url: "https://test.local/" + query,
      runScripts: "outside-only",
    });
    dom.window.addEventListener("error", (event) => errors.push(event.message));
    dom.window.eval("(" + mockInit.toString() + ")()");
    dom.window.eval(
      app.replace(
        /^import[\s\S]*?;\n/,
        "const createClient=()=>window.fakeSupabase;\n",
      ) +
        "\nwindow.testing={emailProblem,esc,calculatedEventTimes,selectedDurationMinutes,eventCard,eventDetailPage,fetchAllFinanceTransactions,renderFinances,loadAdminEvents,refreshAdmin,loadFinance,loadEvents,loadInvitedEvent,loadPhase8EventAudit,editEvent,openDuplicateEventEditor,openSignup,phase9RosterRow,phase9RosterPanel,calendarUtc,calendarEventDetails,googleCalendarLink,createIcsCalendar,configureRegistrationCalendar,setOrganizer:v=>isOrganizer=v,setFinance:(h,t)=>{financeHosts=h;financeTransactions=t}};",
    );
    await new Promise((r) => setTimeout(r, 20));
  }
  async function test(name, fn) {
    try {
      await fn();
      results.push({ name, pass: true });
    } catch (e) {
      results.push({ name, pass: false, error: e.message });
    }
  }
  await boot();
  await test("Dashboard batches roster pages and builds controls when an event opens", async () => {
    await boot("?dashboard=1");
    const result = await page.evaluate(async () => {
      const events = Array.from({length: 20}, (_, i) => ({
        id: "event-" + i, title: "Practice " + i, venue: "Gym", status: "published",
        visibility: "public", starts_at: "2027-01-02T12:00Z", ends_at: "2027-01-02T14:00Z"
      }));
      const rows = Array.from({length: 501}, (_, i) => ({
        id: "player-" + i, player_name: "Player " + i, event_id: events[i % 20].id,
        registration_status: "waitlisted"
      }));
      const pages = [];
      window.queryHandler = q => {
        if (q.table === "events") return {data: events};
        if (q.table !== "registrations") return {data: []};
        const [, start, end] = q.ops.find(([op]) => op === "range");
        pages.push(start);
        return {data: rows.slice(start, end + 1)};
      };
      testing.setOrganizer(true);
      await testing.loadAdminEvents();
      const initialRows = document.querySelectorAll("[data-player]").length;
      const card = document.querySelector('[data-admin-collapse-id="event-0"]');
      card.open = true;
      await new Promise(resolve => setTimeout(resolve, 10));
      const toggle = card.querySelector("[data-unpaid-toggle]");
      toggle.click();
      return {pages, initialRows, count: card.querySelectorAll("[data-player]").length,
        last: !!card.querySelector('[data-player="player-500"]'), toggled: toggle.getAttribute("aria-pressed")};
    });
    assert.deepEqual(JSON.parse(JSON.stringify(result)), {pages: [0,500], initialRows: 0, count: 26, last: true, toggled: "true"});
    await boot();
  });
  await test("Initial page loads without JavaScript errors", () =>
    assert.deepEqual(errors, []));
  await test("Valid email formats accepted (8 cases)", async () =>
    assert.equal(
      await page.evaluate(() =>
        [
          "a@example.com",
          "first.last@gmail.com",
          "first+tag@example.org",
          "o\'neal@example.net",
          " USER@EXAMPLE.COM ",
          "x@sub.example.co.uk",
          "x@a-b.example",
          "x@" + "a".repeat(63) + ".com",
        ].every((x) => testing.emailProblem(x) === null),
      ),
      true,
    ));
  await test("Malformed emails rejected (15 cases)", async () =>
    assert.equal(
      await page.evaluate(() =>
        [
          "",
          "a",
          "a@@b.com",
          "a@localhost",
          ".a@b.com",
          "a.@b.com",
          "a..b@c.com",
          "a b@c.com",
          "a@-b.com",
          "a@b-.com",
          "a@b..com",
          "a@b.c",
          "a@b.123",
          "a".repeat(65) + "@b.com",
          "a@" + "b".repeat(64) + ".com",
        ].every((x) => !!testing.emailProblem(x)),
      ),
      true,
    ));
  await test("HTML escaping protects all five special characters", async () =>
    assert.equal(
      await page.evaluate(() => testing.esc(`<>&"'`)),
      "&lt;&gt;&amp;&quot;&#39;",
    ));
  await test("Event cards escape attacker-controlled text", async () =>
    assert.equal(
      await page.evaluate(() => {
        const x = "<img src=x onerror=alert(1)>";
        return !testing
          .eventCard({
            id: "abc",
            title: x,
            description: x,
            venue: x,
            capacity: 12,
            spots_remaining: 10,
            starts_at: "2027-01-01T18:00:00Z",
            ends_at: "2027-01-01T21:00:00Z",
            price_cents: 500,
          })
          .includes("<img");
      }),
      true,
    ));
  await test("Event duration boundaries reject 0, negative, fraction and >7 days", async () =>
    assert.equal(
      await page.evaluate(() => {
        document.getElementById("event-duration").value = "custom";
        return ["0", "-1", "1.5", "10081"].every((v) => {
          document.getElementById("event-duration-custom").value = v;
          return testing.selectedDurationMinutes() === null;
        });
      }),
      true,
    ));
  await test("DST spring-forward nonexistent start rejected", async () =>
    assert.equal(
      await page.evaluate(() => {
        for (const [id, v] of Object.entries({
          "event-date": "2027-03-14",
          "event-hour": "02",
          "event-minute": "30",
          "event-duration": "180",
        }))
          document.getElementById(id).value = v;
        return testing.calculatedEventTimes() === null;
      }),
      true,
    ));
  await test("Cross-midnight duration remains exact", async () =>
    assert.equal(
      await page.evaluate(() => {
        for (const [id, v] of Object.entries({
          "event-date": "2027-01-01",
          "event-hour": "23",
          "event-minute": "45",
          "event-duration": "180",
        }))
          document.getElementById(id).value = v;
        const t = testing.calculatedEventTimes();
        return t.end - t.start === 10800000 && t.end.getDate() === 2;
      }),
      true,
    ));
  for (const count of [0, 499, 500, 501, 1000, 1501])
    await test(`Finance pagination reads exactly ${count} rows`, async () =>
      assert.equal(
        await page.evaluate(async (n) => {
          window.queryHandler = (q) => {
            const r = q.ops.find((o) => o[0] === "range");
            return {
              data: Array.from(
                { length: Math.max(0, Math.min(n - r[1], r[2] - r[1] + 1)) },
                (_, i) => ({ id: r[1] + i }),
              ),
            };
          };
          const rows = await testing.fetchAllFinanceTransactions();
          return rows.length === n && new Set(rows.map((r) => r.id)).size === n;
        }, count),
        true,
      ));
  await test("Finance pagination fails visibly on middle-page error", async () =>
    assert.equal(
      await page.evaluate(async () => {
        window.queryHandler = (q) =>
          q.ops.find((o) => o[0] === "range")[1] === 0
            ? { data: Array(500).fill({}) }
            : { error: { message: "test failure" } };
        try {
          await testing.fetchAllFinanceTransactions();
          return false;
        } catch (e) {
          return e.message === "test failure";
        }
      }),
      true,
    ));
  await test("Finance transfers conserve community balance; voids excluded", async () =>
    assert.equal(
      await page.evaluate(() => {
        testing.setFinance(
          [
            { id: "a", name: "A" },
            { id: "b", name: "B" },
          ],
          [
            { kind: "collection", host_id: "a", amount_cents: 1000 },
            { kind: "expense", host_id: "b", amount_cents: 300 },
            {
              kind: "transfer",
              host_id: "a",
              to_host_id: "b",
              amount_cents: 400,
            },
            {
              kind: "collection",
              host_id: "a",
              amount_cents: 9999,
              voided_at: "now",
            },
          ],
        );
        testing.renderFinances();
        return (
          document
            .getElementById("finance-stats")
            .textContent.includes("$7.00") &&
          document
            .getElementById("finance-host-summary")
            .textContent.includes("Holds $6.00") &&
          document
            .getElementById("finance-host-summary")
            .textContent.includes("Holds $1.00")
        );
      }),
      true,
    ));
  for (const query of ["?event=bad", "?invite=bad", "?manage=bad"])
    await test(`Malformed route ${query} displays invalid-link message`, async () => {
      await boot(query);
      assert.match(
        await page.locator("#invitation-event").textContent(),
        /invalid/i,
      );
    });
  await test("Empty invitation token displays invalid-link message", async () => {
    await boot("?invite=");
    assert.equal(await page.locator("#invitation-section").isVisible(), true);
    assert.match(
      await page.locator("#invitation-event").textContent(),
      /invalid/i,
    );
  });
  await test("Private route sets no-referrer and noindex", async () => {
    await boot("?manage=bad");
    assert.equal(
      await page.locator("meta[name=referrer]").getAttribute("content"),
      "no-referrer",
    );
    assert.equal(
      await page.locator("meta[name=robots]").getAttribute("content"),
      "noindex,nofollow",
    );
  });
  await test("Late dashboard response cannot restore data after logout", async () => {
    await boot("?dashboard=1");
    const state = await page.evaluate(async () => {
      testing.setOrganizer(true);
      let release;
      window.queryHandler = (q) =>
        q.table === "events" ? new Promise((r) => (release = r)) : { data: [] };
      const pending = testing.loadAdminEvents();
      await new Promise((r) => setTimeout(r, 0));
      await testing.refreshAdmin();
      release({
        data: [
          {
            id: "00000000-0000-4000-8000-000000000001",
            title: "PRIVATE TEST EVENT",
            venue: "TEST",
            status: "published",
            visibility: "private",
            capacity: 12,
            price_cents: 500,
            starts_at: "2027-01-01T18:00:00Z",
            ends_at: "2027-01-01T21:00:00Z",
          },
        ],
      });
      await pending;
      return {
        cleared: document.getElementById("admin-events").textContent === "",
        hidden: document.getElementById("admin-panel").hidden,
      };
    });
    assert.equal(state.cleared, true, JSON.stringify(state));
  });
  await test("Late finance response is discarded after logout", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(async () => {
        testing.setOrganizer(true);
        let release;
        window.queryHandler = (q) =>
          q.table === "finance_transactions"
            ? new Promise((r) => (release = r))
            : { data: [] };
        const p = testing.loadFinance();
        await new Promise((r) => setTimeout(r, 0));
        await testing.refreshAdmin();
        release({
          data: [
            { id: "t", kind: "collection", host_id: "h", amount_cents: 1000 },
          ],
        });
        await p;
        return document.getElementById("finance-history").textContent === "";
      }),
      true,
    );
  });

  // Hold requests at each async boundary; no real login or network is used.
  for (const boundary of ["events-error", "roster", "audit"]) {
    await test(`Logout discards delayed ${boundary} response`, async () => {
      await boot("?dashboard=1");
      const cleared = await page.evaluate(async (boundary) => {
        testing.setOrganizer(true);
        let release;
        const fixture = {
          id: "00000000-0000-4000-8000-000000000001",
          title: "PRIVATE FIXTURE",
          venue: "TEST",
          status: "published",
          visibility: "private",
          capacity: 12,
          price_cents: 500,
          starts_at: "2027-01-01T18:00:00Z",
          ends_at: "2027-01-01T21:00:00Z",
        };
        const table =
          boundary === "roster"
            ? "registrations"
            : boundary === "audit"
              ? "event_audit_log"
              : "events";
        window.queryHandler = (query) =>
          query.table === table
            ? new Promise((resolve) => {
                release = resolve;
              })
            : { data: query.table === "events" ? [fixture] : [] };
        const pending =
          boundary === "audit"
            ? testing.loadPhase8EventAudit()
            : testing.loadAdminEvents();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await testing.refreshAdmin();
        // A new login must not revive a response belonging to the previous session.
        testing.setOrganizer(true);
        release(
          boundary === "events-error"
            ? { error: { message: "PRIVATE ERROR" } }
            : { data: [] },
        );
        await pending;
        return ["admin-events", "admin-stats", "phase8-event-audit-view"].every(
          (id) => !document.getElementById(id)?.textContent,
        );
      }, boundary);
      assert.equal(cleared, true);
    });
  }
  await test("New dashboard refresh wins over an older request", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(async () => {
        testing.setOrganizer(true);
        let release;
        window.queryHandler = (q) =>
          q.table === "events"
            ? new Promise((r) => {
                release = r;
              })
            : { data: [] };
        const oldLoad = testing.loadAdminEvents();
        await new Promise((r) => setTimeout(r, 0));
        window.queryHandler = () => ({ data: [] });
        await testing.loadAdminEvents();
        const latest = document.getElementById("admin-events").innerHTML;
        release({ error: { message: "OLD RESPONSE" } });
        await oldLoad;
        return document.getElementById("admin-events").innerHTML === latest;
      }),
      true,
    );
  });
  await test("Logout removes already rendered audit history", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(async () => {
        testing.setOrganizer(true);
        window.queryHandler = () => ({ data: [] });
        await testing.loadPhase8EventAudit();
        document.getElementById("phase8-event-audit-view").textContent =
          "PRIVATE HISTORY";
        await testing.refreshAdmin();
        return (
          document.getElementById("phase8-event-audit-view").textContent === ""
        );
      }),
      true,
    );
  });
  await test("Logged-out dashboard loader issues no private queries", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(async () => {
        window.calls = [];
        await testing.loadAdminEvents();
        return window.calls.length === 0;
      }),
      true,
    );
  });


  // Phase 11: the same organizer event editor must create a NEW draft, not
  // silently edit, publish, or copy confidential details from the source.
  await test("Duplicate button opens a new draft from an organizer event", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(async () => {
        window.sourceEvent = {
          id: "source-event", title: "Thursday Open Gym",
          venue: "Hillside Community Center",
          starts_at: "2027-01-07T01:00:00.000Z",
          ends_at: "2027-01-07T04:45:00.000Z",
          price_cents: 750, capacity: 18,
          payment_instructions: "Venmo: @Example",
          host_name: "Organizer", status: "published", visibility: "private",
          description: "Bring indoor shoes.",
          invite_token: "must-not-copy-me"
        };
        const dialog = document.getElementById("event-editor-dialog");
        dialog.showModal = function () { this.setAttribute("open", ""); };
        dialog.close = function () { this.removeAttribute("open"); };
        testing.setOrganizer(true);
        window.queryHandler = q => q.table === "events"
          ? { data: [window.sourceEvent], error: null }
          : { data: [], error: null };
        await testing.loadAdminEvents();
        const button = document.querySelector('[data-duplicate="source-event"]');
        if (!button) return false;
        window.calls = [];
        button.click();
        return dialog.hasAttribute("open") &&
          document.getElementById("editor-heading").textContent === "Duplicate event" &&
          !document.getElementById("event-duplicate-hint").hidden &&
          window.calls.every(q => !q.table || !q.ops.some(op => ["insert", "update", "delete"].includes(op[0])));
      }),
      true
    );
  });
  await test("Duplicating copies settings but not identity, date or published status", async () =>
    assert.equal(
      await page.evaluate(() => {
        const get = id => document.getElementById(id).value;
        return get("edit-id") === "" &&
          get("event-date") === "" &&
          get("event-title") === "Thursday Open Gym" &&
          get("event-venue") === "Hillside Community Center" &&
          get("event-price") === "7.50" &&
          get("event-capacity") === "18" &&
          get("payment-instructions") === "Venmo: @Example" &&
          get("event-host") === "Organizer" &&
          get("event-visibility") === "private" &&
          get("event-status") === "draft" &&
          get("event-description") === "Bring indoor shoes." &&
          get("event-hour") === "18" &&
          get("event-minute") === "00" &&
          get("event-duration") === "custom" &&
          get("event-duration-custom") === "225" &&
          document.getElementById("event-date").required &&
          document.activeElement.id === "event-date";
      }),
      true
    ));
  await test("A duplicated event cannot save until a new date is chosen", async () =>
    assert.equal(
      await page.evaluate(async () => {
        window.calls = [];
        document.getElementById("event-form").dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
        await new Promise(r => setTimeout(r, 0));
        return document.getElementById("event-save-message").textContent.includes("Choose an event date") &&
          window.calls.every(q => !q.table || !q.ops.some(op => ["insert", "update", "delete"].includes(op[0])));
      }),
      true
    ));
  await test("Saving a duplicate INSERTs one new draft without source ID, token or registrations", async () =>
    assert.equal(
      await page.evaluate(async () => {
        window.calls = [];
        window.queryHandler = q => {
          const insert = q.table === "events" && q.ops.find(op => op[0] === "insert");
          if (insert) return { data: { ...insert[1], id: "new-event" }, error: null };
          if (q.table === "events") return { data: [window.sourceEvent], error: null };
          return { data: [], error: null };
        };
        document.getElementById("event-date").value = "2027-02-04";
        document.getElementById("event-form").dispatchEvent(
          new Event("submit", { bubbles: true, cancelable: true })
        );
        await new Promise(r => setTimeout(r, 40));
        const writes = window.calls.filter(q => q.table && q.ops.some(op => ["insert", "update", "delete"].includes(op[0])));
        const operation = writes[0]?.ops.find(op => op[0] === "insert");
        const payload = operation?.[1] || {};
        return writes.length === 1 && !!operation &&
          payload.title === window.sourceEvent.title &&
          payload.starts_at === new Date("2027-02-05T01:00:00.000Z").toISOString() &&
          payload.status === "draft" && payload.visibility === "private" &&
          !("id" in payload) && !("invite_token" in payload) &&
          !("registrations" in payload) && !("payment_status" in payload) &&
          document.getElementById("edit-id").value === "" &&
          document.getElementById("event-duplicate-hint").hidden;
      }),
      true
    ));
  await test("New-event editor resets duplicate mode and unauthenticated users cannot duplicate", async () =>
    assert.equal(
      await page.evaluate(() => {
        document.getElementById("create-event").click();
        const normal = document.getElementById("editor-heading").textContent === "Create an event" &&
          document.getElementById("event-duplicate-hint").hidden;
        document.getElementById("event-editor-dialog").close();
        testing.setOrganizer(false);
        testing.openDuplicateEventEditor(window.sourceEvent);
        return normal && !document.getElementById("event-editor-dialog").hasAttribute("open");
      }),
      true
    ));


  // Phase 11: calendar integrations must use actual UTC instants and never
  // leak registration emails or bearer invitation / management tokens.
  await test("Google Calendar encodes exact event start/end, title and venue", async () =>
    assert.equal(
      await page.evaluate(() => {
        const source = {
          id: "a039ac22-fad3-4f83-b435-7d1cba2b9ec0",
          title: "Open Gym & Volleyball", venue: "Hillside Community Center",
          starts_at: "2027-03-14T08:30:00.000Z", ends_at: "2027-03-14T10:30:00.000Z",
          invite_token: "private-token-must-not-leak", player_email: "private@example.com"
        };
        const url = new URL(testing.googleCalendarLink(source));
        return url.hostname === "calendar.google.com" &&
          url.searchParams.get("action") === "TEMPLATE" &&
          url.searchParams.get("text") === source.title &&
          url.searchParams.get("location") === source.venue &&
          url.searchParams.get("dates") === "20270314T083000Z/20270314T103000Z" &&
          !url.toString().includes(source.invite_token) &&
          !url.toString().includes(source.player_email);
      }),
      true
    ));
  await test("ICS event preserves DST instant, escapes names and excludes private data", async () =>
    assert.equal(
      await page.evaluate(() => {
        window.TextEncoder = TextEncoder || window.TextEncoder;
        const event = {
          id: "a039ac22-fad3-4f83-b435-7d1cba2b9ec0",
          title: "Volley, \"Night\"; Friday\nSecond line",
          venue: "Gym\\Court; Colorado, Springs",
          starts_at: "2027-11-07T07:30:00.000Z",
          ends_at: "2027-11-07T10:30:00.000Z",
          invite_token: "secret-invite-abc", manage_token: "secret-manage-xyz",
          player_email: "private@example.com", payment_instructions: "secret-payment-handle"
        };
        const ics = testing.createIcsCalendar(event);
        return ics.startsWith("BEGIN:VCALENDAR\r\nVERSION:2.0\r\n") &&
          ics.endsWith("END:VCALENDAR\r\n") &&
          ics.includes("DTSTART:20271107T073000Z\r\n") &&
          ics.includes("DTEND:20271107T103000Z\r\n") &&
          ics.includes("SUMMARY:Volley\\, \"Night\"\\; Friday\\nSecond line") &&
          ics.includes("LOCATION:Gym\\\\Court\\; Colorado\\, Springs") &&
          ![event.invite_token,event.manage_token,event.player_email,event.payment_instructions].some(s=>ics.includes(s)) &&
          ics.split("\r\n").every(line=>new TextEncoder().encode(line).length<=75);
      }),
      true
    ));
  await test("Invalid or reversed event times do not create calendar links", async () =>
    assert.equal(
      await page.evaluate(() =>
        [
          {starts_at: "not-a-time", ends_at: "2027-01-01T12:00Z"},
          {starts_at: "2027-01-01T12:00Z", ends_at: "2027-01-01T11:00Z"},
          {starts_at: "2027-01-01T12:00Z", ends_at: "2027-01-01T12:00Z"}
        ].every(e=>testing.googleCalendarLink(e)===null && testing.createIcsCalendar(e)===null)
      ),true
    ));
  await test("Calendar choices hidden for waitlist and shown only for confirmed signup", async () => {
    await boot();
    assert.equal(
      await page.evaluate(async () => {
        const e = {
          id: "verified-event", title: "Monday Gym", venue: "Hillside Community Center",
          starts_at: "2027-04-13T00:00:00Z", ends_at: "2027-04-13T03:00:00Z",
          status: "published", visibility: "public", capacity: 24, spots_remaining: 10, price_cents: 500
        };
        window.reply.public_open_gym_events = {data:[e],error:null};
        window.reply.register_for_open_gym = {data:{status:"registered"},error:null};
        await testing.loadEvents();
        for(const [id,value] of Object.entries({
          "event-id":e.id,"player-name":"Test Player","player-email":"test@example.com"
        })) document.getElementById(id).value=value;
        document.getElementById("signup-dialog").close = function(){};
        document.getElementById("registration-success-dialog").showModal = function(){};
        const submit = () => document.getElementById("signup-form").dispatchEvent(
          new Event("submit",{bubbles:true,cancelable:true})
        );
        submit();
        await new Promise(r=>setTimeout(r,10));
        const panel = document.getElementById("registration-calendar");
        const google = document.getElementById("calendar-google");
        const download = document.getElementById("calendar-download");
        const okRegistered = !panel.hidden && google.href.includes("calendar.google.com") && !download.disabled;
        window.reply.register_for_open_gym = {data:{status:"waitlisted"},error:null};
        document.getElementById("event-id").value=e.id;
        document.getElementById("player-name").value="Test Player";
        document.getElementById("player-email").value="test@example.com";
        submit();
        await new Promise(r=>setTimeout(r,10));
        return okRegistered && panel.hidden && !google.hasAttribute("href") && download.disabled;
      }),
      true
    );
  });
  await test("Ban popup shows only the current reason as plain text", async () => {
    await boot();
    assert.equal(await page.evaluate(async () => {
      const byId = id => document.getElementById(id);
      const dialog = byId("registration-ban-dialog");
      dialog.showModal = function () { this.open = true; };
      byId("player-email").value = "player@example.com";
      for (const details of ["<b>Missed sessions</b>", "  "]) {
        window.reply.register_for_open_gym = {error: {code: "VB001", details}};
        byId("signup-form").dispatchEvent(new Event("submit", {cancelable: true}));
        await new Promise(resolve => setTimeout(resolve, 0));
        const reason = byId("registration-ban-reason");
        if (!dialog.open || document.activeElement.id !== "registration-ban-title" ||
            reason.hidden !== !details.trim() || reason.children.length ||
            reason.textContent !== (details.trim() ? "Organizer’s reason: " + details : "") ||
            !byId("signup-error").textContent.includes("banned") ||
            byId("registration-success-dialog").open) return false;
        dialog.open = false;
      }
      return true;
    }), true);
  });
  await test("Download button produces a calendar file only on a user click", async () =>
    assert.equal(
      await page.evaluate(() => {
        const e = {id:"calendar-event",title:"Gym",venue:"Court",
          starts_at:"2027-04-13T00:00:00Z",ends_at:"2027-04-13T03:00:00Z"};
        let created=0, filename="";
        URL.createObjectURL = blob => {
          if(blob.type === "text/calendar;charset=utf-8") created++;
          return "blob:https://test.local/calendar-test";
        };
        URL.revokeObjectURL = () => {};
        HTMLAnchorElement.prototype.click = function(){ filename=this.download; };
        testing.configureRegistrationCalendar(e,true);
        if(created!==0) return false;
        document.getElementById("calendar-download").click();
        return created===1 && filename==="cos-volleyball-event.ics";
      }),
      true
    ));


  // Phase 11 accessibility: validate the DOM contract that makes keyboard and
  // assistive-technology navigation possible. CSS layout still needs manual QA.
  await test("Public and organizer views expose working skip links and landmarks", async () => {
    await boot();
    assert.equal(
      await page.evaluate(() => {
        const pub = document.querySelector(".skip-public");
        const org = document.querySelector(".skip-organizer");
        return pub?.getAttribute("href")==="#main-content" &&
          org?.getAttribute("href")==="#admin" &&
          document.getElementById("main-content")?.tagName==="MAIN" &&
          document.getElementById("admin")?.tabIndex===-1 &&
          document.getElementById("main-content")?.tabIndex===-1;
      }), true
    );
  });
  await test("Registration and success dialogs have programmatic names and descriptions", async () =>
    assert.equal(
      await page.evaluate(() => {
        const signup = document.getElementById("signup-dialog");
        const success = document.getElementById("registration-success-dialog");
        const editor = document.getElementById("event-editor-dialog");
        return signup.getAttribute("aria-labelledby")==="signup-title" &&
          signup.getAttribute("aria-describedby")==="signup-summary" &&
          success.getAttribute("aria-labelledby")==="registration-success-title" &&
          success.getAttribute("aria-describedby")==="registration-success-description" &&
          document.getElementById("registration-success-title").tabIndex===-1 &&
          editor.getAttribute("aria-labelledby")==="editor-heading";
      }), true
    ));
  await test("Organizer tabs support keyboard arrows, Home and End with correct aria state", async () => {
    await boot("?dashboard=1");
    assert.equal(
      await page.evaluate(() => {
        testing.setOrganizer(true);
        document.getElementById("admin-panel").hidden = false;
        document.getElementById("admin-login").hidden = true;
        const events = document.getElementById("dashboard-tab-events");
        const finance = document.getElementById("dashboard-tab-finance");
        const press = key => document.activeElement.dispatchEvent(new KeyboardEvent("keydown",{
          key, bubbles:true, cancelable:true
        }));
        if(events.getAttribute("role")!=="tab" || finance.getAttribute("role")!=="tab") return false;
        if(events.tabIndex!==0 || finance.tabIndex!==-1) return false;
        events.focus();
        press("ArrowRight");
        const next = document.activeElement===finance &&
          finance.getAttribute("aria-selected")==="true" &&
          events.getAttribute("aria-selected")==="false" &&
          finance.tabIndex===0 && events.tabIndex===-1 &&
          document.getElementById("dashboard-events-pane").hidden &&
          !document.getElementById("dashboard-finance-pane").hidden;
        press("Home");
        const back = document.activeElement===events &&
          events.getAttribute("aria-selected")==="true" &&
          events.tabIndex===0 && finance.tabIndex===-1 &&
          !document.getElementById("dashboard-events-pane").hidden &&
          document.getElementById("dashboard-finance-pane").hidden;
        press("End");
        press("ArrowRight");
        return next && back && document.activeElement===events;
      }), true
    );
  });
  await test("Roster and finance action buttons identify their specific record", async () =>
    assert.equal(
      await page.evaluate(() => {
        const p = testing.phase9RosterRow({
          id: "registration-7", player_name: "Alex & Sam",
          player_email: "a@example.com",
          registration_status: "registered",
          payment_status: "unpaid",
          payment_method: "cash",
          attendance_status: "not_marked"
        });
        const table = testing.phase9RosterPanel(
          {id:"event-7",title:"Friday & Friends",price_cents:500},
          [{id:"registration-7",player_name:"Alex",player_email:"a@example.com",registration_status:"registered",payment_status:"unpaid",payment_method:"cash",attendance_status:"not_marked"}]
        );
        return p.includes('aria-label="Cancel registration for Alex &amp; Sam"') &&
          table.includes('aria-label="Check-in and payment roster for Friday &amp; Friends"') &&
          table.includes('<th scope="col">Payment</th>');
      }), true
    ));
  await test("Registration opens with focus on name, and success status receives focus", async () => {
    await boot();
    assert.equal(
      await page.evaluate(async () => {
        const event = {
          id:"event-focus",title:"Sunday Volleyball",venue:"Gym",
          starts_at:"2027-01-01T00:00:00Z",ends_at:"2027-01-01T03:00:00Z",
          price_cents:500,capacity:20,spots_remaining:9,visibility:"public"
        };
        window.reply.public_open_gym_events={data:[event],error:null};
        window.reply.register_for_open_gym={data:{status:"registered"},error:null};
        document.getElementById("signup-dialog").showModal = function(){this.open=true;};
        document.getElementById("signup-dialog").close = function(){this.open=false;};
        document.getElementById("registration-success-dialog").showModal = function(){this.open=true;};
        await testing.loadEvents();
        testing.openSignup(event.id);
        if(document.activeElement.id!=="player-name") return false;
        document.getElementById("player-name").value="Test Player";
        document.getElementById("player-email").value="a@example.com";
        document.getElementById("signup-form").dispatchEvent(
          new Event("submit",{bubbles:true,cancelable:true})
        );
        await new Promise(resolve=>setTimeout(resolve,20));
        return document.activeElement.id==="registration-success-title";
      }), true
    );
  });
  await test("Responsive CSS preserves table headings and minimum touch sizes", async () =>
    assert.equal(
      fs.readFileSync(path.join(root,"styles.css"),"utf8").includes(
        ".phase9-roster thead {\n    display: table-header-group;"
      ) && fs.readFileSync(path.join(root,"styles.css"),"utf8").includes(
        ".editor-dialog-close {\n  width: 44px;\n  height: 44px;"
      ),
      true
    ));

  dom.window.close();
  if (process.env.REGRESSION_RESULTS)
    fs.writeFileSync(
      process.env.REGRESSION_RESULTS,
      JSON.stringify(results, null, 2),
    );
  process.exitCode = results.some((r) => !r.pass) ? 1 : 0;
  console.log(
    JSON.stringify(
      {
        passed: results.filter((r) => r.pass).length,
        failed: results.filter((r) => !r.pass),
      },
      null,
      2,
    ),
  );
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
