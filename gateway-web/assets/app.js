/* Wires the page together: identity, the session list, the conversation tabs, the composer, the places,
 * the rail and dock, the event stream, and the built-in pieces registered through the same seam a
 * package uses. Everything that draws lives in views/; this file only connects them. */

import { applyActivity, countWorking } from "./lib/activity.js";
import { api, connect } from "./lib/api.js";
import { avatarFor } from "./lib/avatar.js";
import { $, clear, setHidden } from "./lib/dom.js";
import { bindShell, broadcastTurn, createExt } from "./lib/ext.js";
import { loadExtensions } from "./lib/loader.js";
import * as registry from "./lib/registry.js";
import { store } from "./lib/store.js";
import { toast } from "./lib/toast.js";
import { mountComposer } from "./views/composer.js";
import { mountDock } from "./views/dock.js";
import { installPanel, PANEL_PLACE, PANEL_SECTIONS } from "./views/panel.js";
import { mountPlaces } from "./views/places.js";
import { mountSessions } from "./views/sessions.js";
import { mountShelf } from "./views/shelf.js";
import { mountStatusbar } from "./views/statusbar.js";
import { mountTabs } from "./views/tabs.js";

// --- the built-in declaration: what the shell itself registers, checked like a package's ---

registry.declare({
  package: registry.BUILTIN,
  version: "",
  dock: [],
  panel: PANEL_SECTIONS.map(({ id, label, note }) => ({ id, label, note })),
  places: [PANEL_PLACE],
  sidebar: [],
  chips: [],
  composer: [{ id: "model", label: "Model" }],
  shelf: [],
  statusbar: [],
  commands: [],
});

const statusEl = $("status");

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
  places.close();
  closeSidebar();
  await tabs.open(id);
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

/** Sends to the active conversation, creating one when none is open. An ask form's answers come through here too. */
async function send(text) {
  let id = store.get("current");
  if (!id) {
    await createConversation();
    id = store.get("current");
    if (!id) return;
  }
  const transcript = tabs.transcriptOf(id);
  store.mark("pending", id, true);
  transcript?.addLocal(text);
  try {
    await api(`/api/sessions/${id}/send`, { method: "POST", body: { text } });
    store.mark("running", id, true);
  } catch (err) {
    transcript?.failLocal();
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
    toast(model ? `This conversation now answers with ${model.split("/").pop()}.` : "This conversation now answers with the default model.", { tone: "good" });
  } catch (err) {
    toast(`The model was not changed: ${err.message}`, { tone: "error" });
  }
}

// --- the views ---

const composer = mountComposer({ onSend: (text) => { void send(text); }, onStop: stop, onModel: chooseModel });
const sessions = mountSessions({ onOpen: openConversation, onNew: createConversation, onArchive: archive, onRename: rename });
const tabs = mountTabs({
  onNew: createConversation,
  onArchive: (id) => { const s = store.session(id); if (s) void archive(id, !s.archived); },
  onRename: (id) => sessions.rename(id),
  onModel: () => composer.openModelPicker(),
});
const places = mountPlaces();
const dock = mountDock();
const shelf = mountShelf();
mountStatusbar();

bindShell({
  send,
  openConversation,
  openDock: (key) => { places.close(); dock.open(key); },
  openPlace: (key, params) => places.open(key, params),
  openShelf: (key) => { places.close(); shelf.open(key); },
  openPanel: (key) => places.open(registry.keyOf(registry.BUILTIN, PANEL_PLACE.id), { section: key }),
});

// --- the built-in pieces, through the seam ---

const builtin = createExt(registry.declared(registry.BUILTIN));
builtin.composer("model", { mount: composer.mountModelPicker });
installPanel(builtin);

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
store.watch("activity", () => drawFavicon(countWorking()));

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
  const { session, event } = message;
  applyActivity(session, event, message.startedAt);
  if (event.type === "turn.start") store.mark("running", session, true);
  if (event.type === "turn.end") {
    store.mark("running", session, false);
    scheduleList();
  }
  tabs.applyTurn(message);
  broadcastTurn(message);
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
    if (opened) {
      // A reconnect may have missed events; each open pane's record carries its turn in progress, so rebuild from it.
      await tabs.reload();
    } else {
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
void loadExtensions();
