/* Wires the page together: identity, the session list, the open transcript, the composer, and the event stream. */

import { api, connect } from "./lib/api.js";
import { avatarFor } from "./lib/avatar.js";
import { $, clear, setHidden } from "./lib/dom.js";
import { store } from "./lib/store.js";
import { toast } from "./lib/toast.js";
import { mountComposer } from "./views/composer.js";
import { mountSessions, titleOf } from "./views/sessions.js";
import { mountTranscript } from "./views/transcript.js";

const statusEl = $("status");
const transcript = mountTranscript($("transcript"), { onNew: createConversation });

/* Which turn the open transcript has drawn up to, so a live event that the session record already
 * carried is not drawn twice. `seq` numbers events within a turn; a new turn id starts over. */
let drawn = { turn: null, seq: 0 };

function setStatus(state) {
  store.set({ connection: state });
  statusEl.className = `status is-${state === "online" ? "online" : state === "offline" ? "offline" : "busy"}`;
  statusEl.textContent = state === "online" ? "connected" : state === "offline" ? "offline" : "connecting";
}

async function refreshList() {
  try {
    store.set({ sessions: await api("/api/sessions") });
  } catch (err) {
    if (err.status !== 401) toast(err.message, { tone: "error" });
  }
}

let listTimer = null;
function scheduleList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(refreshList, 250);
}

async function openConversation(id) {
  if (!id) {
    store.set({ current: null });
    transcript.showEmpty("none");
    drawn = { turn: null, seq: 0 };
    return;
  }
  store.set({ current: id });
  closeSidebar();
  try {
    const record = await api(`/api/sessions/${id}`);
    if (store.get("current") !== id) return;
    transcript.restore(record);
    drawn = record.turn ? { turn: record.turn.turn || "pending", seq: record.turn.events.at(-1)?.seq ?? 0 } : { turn: null, seq: 0 };
    store.mark("running", id, Boolean(record.turn));
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
  composer.focus();
}

async function createConversation() {
  if (store.get("creating")) return;
  store.set({ creating: true });
  try {
    const { id } = await api("/api/sessions", { method: "POST" });
    await refreshList();
    await openConversation(id);
  } catch (err) {
    toast(err.message, { tone: "error" });
  } finally {
    store.set({ creating: false });
  }
}

async function send(text) {
  let id = store.get("current");
  if (!id) {
    await createConversation();
    id = store.get("current");
    if (!id) return;
  }
  store.mark("pending", id, true);
  transcript.addLocal(text);
  try {
    await api(`/api/sessions/${id}/send`, { method: "POST", body: { text } });
    store.mark("running", id, true);
  } catch (err) {
    transcript.failLocal();
    toast(err.status === 409 ? "That conversation is still working on the last message." : err.message, { tone: "error" });
    composer.restore(text);
  } finally {
    store.mark("pending", id, false);
  }
}

async function stop() {
  const id = store.get("current");
  if (!id) return;
  try {
    await api(`/api/sessions/${id}/cancel`, { method: "POST" });
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

async function archive(id, archived) {
  try {
    await api(`/api/sessions/${id}/archive`, { method: "POST", body: { archived } });
    await refreshList();
    if (archived) {
      sessions.openArchive();
      toast("Conversation archived.", { action: { label: "Undo", run: () => archive(id, false) } });
    } else toast("Conversation restored.");
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

const composer = mountComposer({ onSend: (text) => { void send(text); }, onStop: stop });
const sessions = mountSessions({ onOpen: openConversation, onNew: createConversation, onArchive: archive });

// --- the header over the transcript ---

function drawHeader() {
  const id = store.get("current");
  $("chat-title").textContent = id ? titleOf(store.session(id)) : "";
  setHidden($("chat-state"), !(id && store.isRunning(id)));
  $("chat-state").textContent = "working";
  document.title = id ? `${titleOf(store.session(id))} — Thetis` : "Thetis";
}
for (const key of ["current", "sessions", "running"]) store.watch(key, drawHeader);

// --- identity ---

store.watch("user", (user) => {
  $("user-name").textContent = user?.user || "";
  const face = clear($("user-face"));
  if (user?.user) face.append(avatarFor("person", user.user));
});

// --- the narrow-screen sidebar ---

function closeSidebar() {
  $("sidebar").classList.remove("is-open");
  setHidden($("sidebar-veil"), true);
  $("toggle-sidebar").setAttribute("aria-expanded", "false");
}
$("toggle-sidebar").addEventListener("click", () => {
  const open = !$("sidebar").classList.contains("is-open");
  $("sidebar").classList.toggle("is-open", open);
  setHidden($("sidebar-veil"), !open);
  $("toggle-sidebar").setAttribute("aria-expanded", String(open));
});
$("sidebar-veil").addEventListener("click", closeSidebar);

// --- the event stream ---

function applyTurn(message) {
  const { session, event, input } = message;
  if (event.type === "turn.start") store.mark("running", session, true);
  if (event.type === "turn.end") {
    store.mark("running", session, false);
    scheduleList();
  }
  if (session !== store.get("current")) return;
  const turn = message.turn || "pending";
  if (turn === drawn.turn && message.seq <= drawn.seq) return;
  if (turn !== drawn.turn) drawn = { turn, seq: 0 };
  drawn.seq = message.seq;
  transcript.applyEvent(event, input);
}

let opened = false;
connect({
  onStatus: setStatus,
  onSnapshot: async (snapshot) => {
    store.set({ running: new Set(snapshot.running.map((r) => r.session)) });
    await refreshList();
    const current = store.get("current");
    if (current) {
      // A reconnect may have missed events; the record carries the turn in progress, so rebuild from it.
      if (opened) await openConversation(current);
    } else if (!opened) {
      const first = store.get("sessions").find((s) => !s.archived);
      if (first) await openConversation(first.id);
    }
    opened = true;
  },
  onTurn: applyTurn,
});

api("/api/me").then((me) => store.set({ user: me })).catch(() => {});
setStatus("connecting");
composer.focus();
