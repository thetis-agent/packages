/* Wires the page together: identity, the session list, the open transcript, the composer, and the event stream. */

import { applyActivity, countWorking, fmtCost, shortModel } from "./lib/activity.js";
import { api, connect } from "./lib/api.js";
import { avatarFor } from "./lib/avatar.js";
import { $, clear, setHidden } from "./lib/dom.js";
import { store } from "./lib/store.js";
import { toast } from "./lib/toast.js";
import { mountComposer } from "./views/composer.js";
import { mountPanel } from "./views/panel.js";
import { mountPlanChip } from "./views/plan.js";
import { mountSessions, titleOf } from "./views/sessions.js";
import { mountTranscript } from "./views/transcript.js";

const statusEl = $("status");
// An ask form's Submit goes through the same `send` the composer uses: the answers
// are an ordinary user message, so the pending row and failure handling apply for free.
const transcript = mountTranscript($("transcript"), { onNew: createConversation, onAnswer: (text) => send(text) });

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
  panel.close();
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
    } else toast("Conversation restored.", { tone: "good" });
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

async function rename(id, title) {
  try {
    await api(`/api/sessions/${id}/title`, { method: "POST", body: { title } });
    await refreshList();
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

/** The pill only moves once the server has kept the choice. */
async function chooseModel(id, model) {
  if (!id) return;
  try {
    await api(`/api/sessions/${id}/model`, { method: "POST", body: { model } });
    store.set({ sessions: store.get("sessions").map((s) => (s.id === id ? { ...s, model: model || undefined } : s)) });
    toast(model ? `This conversation now answers with ${shortModel(model)}.` : "This conversation now answers with the default model.", { tone: "good" });
  } catch (err) {
    toast(`The model was not changed: ${err.message}`, { tone: "error" });
  }
}

const composer = mountComposer({ onSend: (text) => { void send(text); }, onStop: stop, onModel: chooseModel });
const sessions = mountSessions({ onOpen: openConversation, onNew: createConversation, onArchive: archive, onRename: rename });
const panel = mountPanel();
mountPlanChip($("chip-todo"), () => store.planOf(store.get("current")));

// --- the header over the transcript ---

function drawHeader() {
  const id = store.get("current");
  const session = store.session(id);
  const activity = store.activityOf(id);
  $("chat-title").textContent = id ? titleOf(session) : "";
  $("chat-title").title = id ? "Rename this conversation" : "";
  const working = Boolean(id && store.isRunning(id));
  setHidden($("chat-state"), !working);
  $("chat-state").textContent = activity?.state === "working" ? (activity.tool ? activity.step : activity.step.toLowerCase()) : "working";
  const cost = (session?.cost ?? 0) + (activity?.state === "working" ? activity.cost : 0);
  const spend = $("chip-spend");
  setHidden(spend, !(id && cost > 0));
  spend.textContent = fmtCost(cost);
  spend.title = working ? "Spent in this conversation, counting the running turn" : "Spent in this conversation";
  spend.classList.toggle("is-live", working && activity?.cost > 0);
  const model = $("chip-model");
  setHidden(model, !id);
  model.textContent = shortModel(store.modelFor(id)) || "model";
  model.title = session?.model ? `Answers with ${session.model}` : "Answers with the default model";
  model.classList.toggle("is-set", Boolean(session?.model));
  const archiveBtn = $("archive-chat");
  setHidden(archiveBtn, !id);
  archiveBtn.title = session?.archived ? "Restore this conversation" : "Archive this conversation";
  archiveBtn.setAttribute("aria-label", archiveBtn.title);
  archiveBtn.classList.toggle("is-archived", Boolean(session?.archived));
  const todo = $("chip-todo");
  const plan = id ? store.planOf(id) : null;
  setHidden(todo, !plan);
  if (plan) {
    todo.textContent = `todo ${plan.done}/${plan.total}`;
    todo.classList.toggle("is-done", plan.allSettled);
  }
  drawFavicon(countWorking());
}
for (const key of ["current", "sessions", "running", "activity", "choices", "plan"]) store.watch(key, drawHeader);
$("archive-chat").addEventListener("click", () => {
  const id = store.get("current");
  const session = store.session(id);
  if (session) void archive(id, !session.archived);
});
$("chat-title").addEventListener("click", () => {
  const id = store.get("current");
  if (id) sessions.rename(id);
});
$("chip-model").addEventListener("click", () => {
  composer.loadChoices();
  document.querySelector("#composer-tools .picker-btn")?.click();
});

// --- the favicon says when something is working ---

let faviconState = null;
function drawFavicon(working) {
  const state = working ? "working" : "idle";
  if (state === faviconState) return;
  faviconState = state;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c9cff";
  const warn = getComputedStyle(document.documentElement).getPropertyValue("--warn").trim() || "#e8b673";
  const dot = working ? `<circle cx="25" cy="7" r="6" fill="${warn}" stroke="#0b0b0f" stroke-width="2"/>` : "";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><circle cx="16" cy="16" r="9" fill="none" stroke="${accent}" stroke-width="3"/><circle cx="16" cy="16" r="3.5" fill="${accent}"/>${dot}</svg>`;
  const link = document.querySelector("link[rel='icon']");
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

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
  applyActivity(session, event, message.startedAt);
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
    // Every running turn's events so far, replayed through the activity model, so the sidebar knows the step.
    for (const r of snapshot.running) for (const { event } of r.events ?? []) applyActivity(r.session, event, r.startedAt);
    for (const [id, record] of store.get("activity")) if (record.state === "working" && !snapshot.running.some((r) => r.session === id)) store.setActivity(id, null);
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
composer.loadChoices();
composer.focus();
