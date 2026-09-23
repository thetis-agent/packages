/* Wires the page together: identity, the session list, the conversation tabs, the composer, the places,
 * the rail and dock, the event stream, and the built-in pieces registered through the same seam a
 * package uses. Everything that draws lives in views/; this file only connects them. */

import { applyActivity, countWorking } from "./lib/activity.js";
import { api, apiBytes, connect } from "./lib/api.js";
import { avatarFor, repaintPersonAvatars } from "./lib/avatar.js";
import { $, clear, setHidden } from "./lib/dom.js";
import { bindShell, broadcastTurn, createExt } from "./lib/ext.js";
import { loadExtensions } from "./lib/loader.js";
import * as registry from "./lib/registry.js";
import { store } from "./lib/store.js";
import { toast } from "./lib/toast.js";
import { mountComposer } from "./views/composer.js";
import { mountDock } from "./views/dock.js";
import { mountMenu } from "./views/menu.js";
import { installPanel, PANEL_PLACE, PANEL_SECTIONS } from "./views/panel.js";
import { mountPlaces } from "./views/places.js";
import { mountSessions } from "./views/sessions.js";
import { mountShelf } from "./views/shelf.js";
import { mountSidebarSlot } from "./views/sidebar.js";
import { mountStatusbar } from "./views/statusbar.js";
import { mountTabs } from "./views/tabs.js";

// --- the built-in declaration: what the shell itself registers, checked like a package's ---

registry.declare({
  package: registry.BUILTIN,
  version: "",
  dock: [],
  panel: PANEL_SECTIONS.map(({ id, label, note, order }) => ({ id, label, note, order })),
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

/** A sidebar row's click on a subagent: its tab when one is open, else its block in the conversation. */
async function showAgent(id) {
  places.close();
  closeSidebar();
  if (!(await tabs.reveal(id))) toast("That subagent's output is not on screen.");
}

/** The open glyph of a subagent's row: a tab of its own. */
async function openAgent(id) {
  places.close();
  closeSidebar();
  await tabs.open(id);
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

/* --- conversations nobody ever said anything in ---
 *
 * A conversation with nothing in it is not a record of anything; it is the click that made it. Ten of
 * those at the top of the history are ten "New conversation" rows to read past to reach the one that
 * matters. The page discards them, in the two places it can actually be sure of:
 *
 *   - its tab is closed here, which is a person leaving a conversation, said plainly and in time to act on;
 *   - the next load, which sweeps whatever this page never got to see closed — the browser tab shut, the
 *     laptop lid closed, the machine died.
 *
 * Not `beforeunload`, `pagehide` or `visibilitychange`. A request started from there is not reliably sent,
 * so a page built on it would still need the sweep; and those events also fire when a page goes into the
 * back/forward cache, which is not leaving at all — the person presses Back and finds the conversation
 * they were in deleted under them. Catching what can be caught honestly and sweeping the rest is the whole
 * design: an empty conversation harms nothing until it clutters a list, and a list is only read on a load.
 *
 * `untouched` is the whole policy, and it is deliberately narrower than what the server allows. The server
 * refuses (409) anything with words in it or a turn in flight, whatever this page's list says — it is the
 * floor, and it is checked against the record, because the list here is always a moment old. This page
 * also leaves alone one that was named or archived, one open in a tab here, and the one being read: those
 * are conversations something was done to, or that someone is sitting in. And nothing about this is ever
 * shown. It is tidying nobody asked for, so a refusal is an answer, not a fault, and a person who never
 * asked for the discard must not be handed its failure.
 */

/**
 * How long a new conversation is left alone by the sweep. The one this young is the one this page cannot
 * see: another window, or the command line, has opened it and is being typed into right now. Everything
 * older than this was left behind, and a sweep comes round on every load, so waiting costs nothing.
 *
 * Ten minutes rather than two, because the two sides of this are not the same size. Too long and an
 * abandoned conversation lingers until the next load, which is the thing this tidies anyway. Too short and
 * one somebody has open in another window, and has walked away from mid-thought, is swept from under them;
 * they find out by typing into it and being told it is gone, which is a worse day than one stale row. A
 * person is quiet for two minutes constantly and for ten much less often.
 */
const SETTLE_MS = 10 * 60_000;

/** A conversation the page may discard: nothing said in it, nothing done to it, and nobody in it. */
function untouched(id, { settled = false } = {}) {
  const s = store.session(id);
  if (!s || s.turns > 0 || s.preview || s.named || s.archived) return false;
  if (store.isRunning(id) || store.isPending(id)) return false;
  if (id === store.get("current") || store.get("tabs").includes(id)) return false;
  return !settled || Date.now() - Date.parse(s.createdAt) > SETTLE_MS;
}

/** Asks the server to discard one. Answers whether it did; a refusal is swallowed here and nowhere else. */
async function discard(id) {
  try {
    await api(`/api/sessions/${id}`, { method: "DELETE" });
    return true;
  } catch {
    return false;
  }
}

/** A tab was closed: if nothing was ever in that conversation, it goes now, with the tab. */
async function discardClosed(id) {
  if (untouched(id) && (await discard(id))) await refreshList();
}

/** Every conversation left empty and behind, taken together, once the list has been read. */
async function sweep() {
  const leftBehind = store.get("sessions").filter((s) => untouched(s.id, { settled: true }));
  let gone = 0;
  for (const s of leftBehind) if (await discard(s.id)) gone += 1;
  if (gone) await refreshList();
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
const sessions = mountSessions({ onOpen: openConversation, onNew: createConversation, onArchive: archive, onRename: rename, onAgent: showAgent, onOpenAgent: openAgent });
const tabs = mountTabs({
  onNew: createConversation,
  onClosed: (id) => { void discardClosed(id); },
  onArchive: (id) => { const s = store.session(id); if (s) void archive(id, !s.archived); },
  onRename: (id) => sessions.rename(id),
  onModel: () => composer.openModelPicker(),
});
const places = mountPlaces();
const dock = mountDock();
const shelf = mountShelf();
mountStatusbar();
mountSidebarSlot();
mountMenu({ openPlace: (key) => places.open(key), currentPlace: () => places.current() });

bindShell({
  send,
  openConversation,
  openDock: (key) => { places.close(); dock.open(key); },
  openPlace: (key, params) => places.open(key, params),
  openShelf: (key) => { places.close(); shelf.open(key); },
  closeShelf: () => shelf.close(),
  shelfOpen: () => shelf.isOpen(),
  openPanel: (key) => places.open(registry.keyOf(registry.BUILTIN, PANEL_PLACE.id), { section: key }),
});

// --- the conversation on screen is named in the address bar ---

/**
 * A refresh has to come back to the conversation the person was reading. Before this the page opened
 * whichever conversation happened to be first in the sidebar, so a refresh made while a long turn ran in
 * a conversation that was not the most recently touched one landed somewhere else entirely, and the
 * running conversation — its history, its streaming reply and its Stop — was simply not on the page.
 *
 * What is stored to prevent that is one id, in the address bar: the conversation now on screen. It is a
 * fact about the page rather than a preference about it, it is visible where it is kept, each browser tab
 * keeps its own so two windows do not fight, and the link it makes opens the same conversation again. Only
 * the conversation is remembered, not the whole row of tabs: the tabs are a working arrangement, the
 * conversation being read is the thing whose loss is felt. A subagent's pane names its conversation,
 * because that is where the child's block lives and a child cannot be reopened from its id alone.
 */
const CONVERSATION_IN_URL = /^#(s_[a-f0-9]+)$/;

function conversationInUrl() {
  return CONVERSATION_IN_URL.exec(location.hash)?.[1] ?? null;
}

store.watch("current", (id) => {
  const shown = id ? store.rootOf(id) : null;
  const hash = shown ? `#${shown}` : "";
  if (hash === (location.hash || "")) return;
  // replaceState, not a new entry: Back belongs to wherever the person came from, not to every tab they clicked.
  history.replaceState(null, "", `${location.pathname}${location.search}${hash}`);
});

// --- the built-in pieces, through the seam ---

const builtin = createExt(registry.declared(registry.BUILTIN));
builtin.composer("model", { mount: composer.mountModelPicker });
installPanel(builtin, { openPlace: (key, params) => places.open(key, params) });

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

// --- identity, and the picture the person chose for themselves ---

/** What the server accepts. The page holds the same number, so a file it would only refuse is never sent. */
const AVATAR_LIMIT = 512 * 1024;
/** The longest side a stored picture needs: the tile is 22 or 34 pixels, and this leaves room for a dense screen. */
const AVATAR_SIDE = 256;

const faceButton = $("user-face");
const faceInput = $("avatar-file");
const faceClear = $("user-face-clear");

store.watch("user", (user) => {
  $("user-name").textContent = user?.user || "";
  const face = clear(faceButton);
  if (user?.user) face.append(avatarFor("person", user.user, user.avatar));
  setHidden(faceClear, !user?.avatar);
});

/**
 * Shrinks the chosen picture when it is larger than it will ever be drawn. A photo off a phone is several
 * megabytes of pixels nobody will see; doing this here means the size limit almost never reaches anyone,
 * and what ends up in the person's home is close to what the page actually uses. Answers null — keep the
 * file as it is — in the three cases where redrawing it would be wrong or pointless: an animated GIF, which
 * a canvas would silently reduce to one frame; a picture already small enough; and a file this browser
 * cannot decode, which is sent untouched so that the server's own look at the bytes is what refuses it.
 */
async function shrink(file) {
  if (file.type === "image/gif" || typeof createImageBitmap !== "function") return null;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  const scale = Math.min(1, AVATAR_SIDE / Math.max(bitmap.width, bitmap.height));
  if (scale === 1 && file.size <= AVATAR_LIMIT) {
    bitmap.close?.();
    return null;
  }
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d").drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  // A photograph re-encoded as PNG can come out larger than it went in, so a JPEG stays a JPEG; everything
  // else becomes a PNG, which keeps whatever transparency the picture had.
  const type = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
  return new Promise((done) => canvas.toBlob(done, type, 0.9));
}

async function uploadAvatar(file) {
  const body = (await shrink(file)) || file;
  if (body.size > AVATAR_LIMIT) {
    toast(`That image is ${Math.round(body.size / 1024)} KB, and the limit is ${AVATAR_LIMIT / 1024} KB. Pick a smaller one.`, { tone: "error" });
    return;
  }
  try {
    const { avatar } = await apiBytes("/api/me/avatar", body);
    showAvatar(avatar);
    toast("That is your avatar now.", { tone: "good" });
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

async function removeAvatar() {
  try {
    await api("/api/me/avatar", { method: "DELETE" });
    showAvatar(null);
    toast("Your avatar is your initials again.", { tone: "good" });
  } catch (err) {
    toast(err.message, { tone: "error" });
  }
}

/** The store carries it, so the footer redraws and every later transcript row is built with it; the rows
 *  already on screen were built once and are repainted where they stand, because the person who just chose
 *  a picture is looking straight at their own turns. */
function showAvatar(avatar) {
  store.set({ user: { ...store.get("user"), avatar: avatar || null } });
  repaintPersonAvatars(avatar || null);
}

faceButton.addEventListener("click", () => faceInput.click());
faceInput.addEventListener("change", () => {
  const file = faceInput.files?.[0];
  faceInput.value = ""; // so that choosing the same file a second time is still a change the page hears
  if (file) void uploadAvatar(file);
});
faceClear.addEventListener("click", () => void removeAvatar());

// --- the narrow-screen sidebar ---

// Two toggles share the drawer: the one in the tabs bar and the one in a place's head, since a place hides the tabs.
const sidebarToggles = [...document.querySelectorAll(".chat-menu")];
function setSidebar(open) {
  $("sidebar").classList.toggle("is-open", open);
  setHidden($("sidebar-veil"), !open);
  for (const b of sidebarToggles) b.setAttribute("aria-expanded", String(open));
}
function closeSidebar() {
  setSidebar(false);
}
for (const b of sidebarToggles) b.addEventListener("click", () => setSidebar(!$("sidebar").classList.contains("is-open")));
$("sidebar-veil").addEventListener("click", closeSidebar);

// --- the event stream ---

/** A child turn's message names its `parent`: the child is registered as that session's agent before anything draws it. */
function noteAgent(message) {
  const { session, event, parent } = message;
  if (!parent) return;
  const patch = { parent };
  if (!store.agent(session)) patch.createdAt = message.startedAt || new Date().toISOString();
  if (event.type === "turn.start" && typeof message.input === "string") patch.task = message.input;
  if (event.type === "turn.end") {
    // What the child's own events said, kept once its activity record goes.
    const activity = store.activityOf(session);
    patch.outcome = activity?.state === "failed" ? "failed" : activity?.state === "stopped" ? "stopped" : "done";
    patch.cost = (store.agent(session)?.cost ?? 0) + (activity?.cost ?? 0);
  }
  store.setAgent(session, patch);
}

function applyTurn(message) {
  const { session, event, parent } = message;
  noteAgent(message);
  applyActivity(session, event, message.startedAt, parent);
  if (event.type === "turn.start") {
    store.mark("running", session, true);
    // A turn in a conversation this page has never listed (started from the command line, or made in another tab): list again.
    if (!parent && !store.session(session)) scheduleList();
  }
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
    // Conversations before their subagents, so a child's events find its parent's record already open.
    const running = [...snapshot.running].sort((a, b) => Number(Boolean(a.parent)) - Number(Boolean(b.parent)));
    const children = running.filter((r) => r.parent).map((r) => [r.session, { parent: r.parent, task: r.input, createdAt: r.startedAt }]);
    if (children.length) store.setAgents(children);
    for (const r of running) for (const { event } of r.events ?? []) applyActivity(r.session, event, r.startedAt, r.parent);
    for (const [id, record] of store.get("activity")) if (record.state === "working" && !snapshot.running.some((r) => r.session === id)) store.setActivity(id, null);
    await refreshList();
    if (opened) {
      // A reconnect may have missed events; each open pane's record carries its turn in progress, so rebuild from it.
      await tabs.reload();
    } else {
      // The conversation the address bar names, when it still exists — archived or not, because coming back
      // to where you were is not a judgement about which conversations are interesting. Nothing named, or
      // nothing by that name any more: the newest conversation, as before.
      const sessions = store.get("sessions");
      const wanted = conversationInUrl();
      const first = (wanted && sessions.find((s) => s.id === wanted)) || sessions.find((s) => !s.archived);
      if (first) await openConversation(first.id);
    }
    opened = true;
    // Last, and after the conversation being returned to is open: the sweep reads `current` and the tabs
    // to know what is in use, so it cannot take the one the page just came back to, and an id that is
    // about to be opened is never discarded on the way there.
    await sweep();
  },
  onTurn: applyTurn,
  onSessions: scheduleList,
});

api("/api/me").then((me) => store.set({ user: me })).catch(() => {});
setStatus("connecting");
composer.loadChoices();
composer.focus();
void loadExtensions();
