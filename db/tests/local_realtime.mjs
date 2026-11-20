/**
 * Local-only native WebSocket test of database-triggered Realtime Broadcast.
 * Supabase Realtime v1.0 protocol: JSON objects, no runtime dependencies.
 * Ref: https://supabase.com/docs/guides/realtime/protocol
 */
import assert from "node:assert/strict";

export async function subscribeToPublicTeams(apiUrl, key) {
  const u = new URL(apiUrl);
  if (!["127.0.0.1", "localhost", "::1"].includes(u.hostname)) {
    throw Error("Refusing Realtime connection to a hosted project");
  }
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/realtime/v1/websocket";
  u.search = "";
  u.searchParams.set("apikey", key);
  u.searchParams.set("vsn", "1.0.0");

  const socket = new WebSocket(u.href);
  const topic = "realtime:teams-manager:public";
  const messages = [];
  const pending = new Set();
  let connected = false;
  let closed = false;
  let accept, reject;
  const ready = new Promise((resolve, fail) => { accept = resolve; reject = fail; });
  const connectTimer = setTimeout(() => reject(Error("Realtime join timed out")), 15000);
  function handleMessage(frame) {
    let msg;
    try { msg = JSON.parse(String(frame.data)); } catch { return; }
    if (msg.topic !== topic) return;
    if (msg.event === "phx_reply" && msg.ref === "1") {
      if (msg.payload?.status === "ok") {
        connected = true;
        clearTimeout(connectTimer);
        accept();
      } else {
        clearTimeout(connectTimer);
        reject(Error("Realtime channel was not accepted: " +
          JSON.stringify(msg.payload).slice(0, 250)));
      }
      return;
    }
    if (msg.event !== "broadcast" || msg.payload?.event !== "changed") return;
    // The Postgres trigger sends only {revision, active}. Supabase
    // Realtime may append its own opaque database-message "id" field.
    // No user-controlled profile data, email or registration fields allowed.
    const body = msg.payload.payload || {};
    const keys = Object.keys(body).sort();
    assert.deepEqual(keys, ["active", "id", "revision"]);
    assert.equal(typeof body.active, "boolean");
    assert(Number.isInteger(body.revision));
    assert(body.id !== null && ["string", "number"].includes(typeof body.id));
    const wire = JSON.stringify(body).toLowerCase();
    for (const forbidden of ["email", "player", "gender", "skill", "position",
      "registration", "@example", "session_id", "user_id"]) {
      assert(!wire.includes(forbidden),
        "Sensitive field leaked into public Broadcast: " + forbidden);
    }
    messages.push(body);
    for (const watcher of pending) watcher();
  }
  socket.addEventListener("open", () => {
    socket.send(JSON.stringify({
      topic, event: "phx_join", ref: "1", join_ref: "1",
      payload: {
        config: {
          broadcast: { ack: false, self: false },
          presence: { enabled: false },
          postgres_changes: [],
          private: false
        }
      }
    }));
  });
  socket.addEventListener("message", handleMessage);
  socket.addEventListener("error", () => {
    if (!connected) reject(Error("Realtime WebSocket failed to connect"));
  });
  socket.addEventListener("close", () => {
    closed = true;
    if (!connected) reject(Error("Realtime WebSocket closed before subscription"));
    for (const notify of pending) notify();
  });
  await ready;
  return {
    received: messages,
    waitFor(predicate, waitMs = 20000) {
      const matching = () => messages.find(predicate);
      if (matching()) return Promise.resolve(matching());
      if (closed) return Promise.reject(Error("Realtime connection closed"));
      return new Promise((resolve, rejectWait) => {
        const timeout = setTimeout(() => {
          pending.delete(check);
          rejectWait(Error("No expected database Broadcast received within " + waitMs + " ms"));
        }, waitMs);
        const check = () => {
          const match = matching();
          if (match) {
            clearTimeout(timeout);
            pending.delete(check);
            resolve(match);
          } else if (closed) {
            clearTimeout(timeout);
            pending.delete(check);
            rejectWait(Error("Realtime connection closed while awaiting change"));
          }
        };
        pending.add(check);
      });
    },
    close() {
      clearTimeout(connectTimer);
      socket.close();
    }
  };
}
