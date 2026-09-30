/* Wires the page together: identity, the session list, the conversation tabs, the composer, the places,
 * the rail and dock, the event stream, and the built-in pieces registered through the same seam a
 * package uses. Everything that draws lives in views/; this file only connects them. It also keeps the
 * page alive across a restart: the stream reconnects by itself, a changed build refreshes the page on the
 * same conversation with what was typed kept, and a restart of Thetis is announced to everyone. */

import { applyActivity, countWorking } from "./lib/activity.js";
import { agentAvatar, agentName, refreshAgent, setAgent, watchAgent } from "./lib/agent.js";
import { api, apiBytes, connect } from "./lib/api.js";
import { localContent } from "./lib/attachments.js";
import { avatarFor, repaintAgentAvatars, repaintPersonAvatars } from "./lib/avatar.js";
import { contentText } from "./lib/content.js";
import { $, clear, el, setHidden } from "./lib/dom.js";
import { bindShell, broadcastTurn, createExt, notifySessionCreated } from "./lib/ext.js";
import { layers, listenForEscape } from "./lib/layers.js";
import { bindConnection } from "./lib/lifecycle.js";
import { loadExtensions } from "./lib/loader.js";
import { rememberChoice, shortModel } from "./lib/model-choices.js";
import { notice } from "./lib/notice.js";
import * as registry from "./lib/registry.js";
import { store } from "./lib/store.js";
import { watchRestart } from "./lib/restart-notice.js";
import { toast } from "./lib/toast.js";
import { sendTurn } from "./lib/turn-send.js";
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

// Escape closes the top layer — a drawer before the place under it, a place before the dock it hides —
// and is registered before any view, so a popover's own listener still finds the popover in place.
listenForEscape();

const statusEl = $("status");

/** connecting (the first time) · online · reconnecting (it dropped, and the page is trying again by itself). */
function setStatus(state) {
  store.set({ connection: state });
  statusEl.className = `status is-${state === "online" ? "online" : "busy"}`;
  statusEl.textContent = state === "online" ? "connected" : state === "reconnecting" ? "Reconnecting…" : "connecting";
  statusEl.title = state === "reconnecting" ? `The connection to ${agentName()} dropped. This page reconnects by itself; nothing you did is lost.` : "";
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

/**
 * `+`: a new conversation that is not created yet. Nothing is kept on the server until the first message,
 * which creates it on the way (`send`), so a `+` nobody types into leaves nothing behind.
 */
function startNew() {
  places.close();
  closeSidebar();
  store.set({ draftModel: undefined });
  tabs.showNew();
  composer.focus();
}

async function createConversation() {
  if (store.get("creating")) return null;
  store.set({ creating: true });
  try {
    await extensionsReady;
    // A model picked in the draft travels with the create; the server remembers it as the next default too.
    const draftModel = store.get("draftModel");
    const { id } = await api("/api/sessions", { method: "POST", body: draftModel === undefined ? {} : { model: draftModel } });
    if (draftModel !== undefined) store.set({ draftModel: undefined, choices: rememberChoice(store.get("choices"), draftModel) });
    await notifySessionCreated(id);
    await refreshList();
    await openConversation(id);
    return id;
  } catch (err) {
    toast(err.message, { tone: "error" });
    return null;
  } finally {
    store.set({ creating: false });
  }
}

/**
 * Sends to the active conversation, creating one when none is open. An ask form's answers and a package's
 * `conversation.send` come through here too, as plain strings. `input` is what travels: a string, or a
 * user message with content parts when the composer had attachments. `draft` is what the composer gives
 * back to itself when the send is refused — the text and the attachment list — so nothing typed or
 * uploaded is lost to a 409.
 */
async function send(input, draft) {
  const text = typeof input === "string" ? input : contentText(input.content);
  const restore = () => composer.restore(text, draft);
  let id = store.get("current");
  if (!id) {
    id = await createConversation();
    if (!id) { restore(); return; }
  }
  const transcript = tabs.transcriptOf(id);
  store.mark("pending", id, true);
  transcript?.addLocal(localContent(input));
  try {
    await sendTurn(id, input);
  } catch (err) {
    transcript?.failLocal();
    toast(err.status === 409 ? "That conversation is still working on the last message." : err.message, { tone: "error" });
    restore();
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

/**
 * Archives or restores a conversation. Archiving one that is open in a tab here closes that tab too:
 * putting a conversation away and still sitting in it is two answers to one question. The tab is
 * closed after the list has been refreshed, so the closed-tab hook sees the archive mark and leaves the
 * record alone. Undo brings the tab back when the archive took one.
 */
async function archive(id, archived, { reopen = false } = {}) {
  try {
    await api(`/api/sessions/${id}/archive`, { method: "POST", body: { archived } });
    await refreshList();
    if (archived) {
      const wasOpen = tabs.list().includes(id);
      if (wasOpen) tabs.close(id);
      sessions.openArchive();
      toast("Conversation archived.", { action: { label: "Undo", run: () => archive(id, false, { reopen: wasOpen }) } });
    } else {
      if (reopen) await openConversation(id);
      toast("Conversation restored.", { tone: "good" });
    }
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
    // The server also made it the person's default for new chats, and the newest of their recent models.
    store.set({ sessions: store.get("sessions").map((s) => (s.id === id ? { ...s, model: model || undefined } : s)), choices: rememberChoice(store.get("choices"), model) });
    toast(model ? `This chat now answers with ${shortModel(model)}. New chats start with it too.` : `This chat now answers with the ${agentName()} default model.`, { tone: "good" });
  } catch (err) {
    toast(`The model was not changed: ${err.message}`, { tone: "error" });
  }
}

// --- the views ---

const composer = mountComposer({ onSend: (input, draft) => { void send(input, draft); }, onStop: stop, onModel: chooseModel });
const sessions = mountSessions({ onOpen: openConversation, onNew: startNew, onArchive: archive, onRename: rename, onAgent: showAgent, onOpenAgent: openAgent });
const tabs = mountTabs({
  onNew: startNew,
  onClosed: (id) => { void discardClosed(id); },
  onArchive: (id) => { const s = store.session(id); if (s) void archive(id, !s.archived); },
  onRename: (id) => sessions.rename(id),
  onModel: () => composer.openModelPicker(),
  onExample: (text) => composer.fill(text),
});
const places = mountPlaces();
const dock = mountDock();
const shelf = mountShelf();
mountStatusbar();
mountSidebarSlot();
// A place chosen from the menu closes the drawer the menu sits in, so on a phone the place is not left under it.
mountMenu({ openPlace: (key) => { closeSidebar(); places.open(key); }, currentPlace: () => places.current() });

bindShell({
  send,
  openConversation,
  openDock: (key) => { places.close(); dock.open(key); },
  openPlace: (key, params) => places.open(key, params),
  openShelf: (key) => { places.close(); shelf.open(key); },
  closeShelf: () => shelf.close(),
  shelfOpen: () => shelf.isOpen(),
  openPanel: (key) => places.open(registry.keyOf(registry.BUILTIN, PANEL_PLACE.id), { section: key }),
  openTab: (key, id, params) => { places.close(); closeSidebar(); return tabs.openKind(key, id, params); },
  closeTab: (key, id) => tabs.closeKind(key, id),
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
 *
 * A package's tab is named the same way, as `#<kind>/<id>` (`#canvas/c_1a2b3c4d`): the tabs are not kept,
 * so without it a refresh on a canvas would land on the newest conversation and lose the thing being looked at.
 */
const CONVERSATION_IN_URL = /^#(s_[a-f0-9]+)$/;
const TAB_IN_URL = /^#([a-z][a-z0-9_-]{0,31})\/([A-Za-z0-9_.-]{1,64})$/;

function conversationInUrl() {
  return CONVERSATION_IN_URL.exec(location.hash)?.[1] ?? null;
}

function tabInUrl() {
  const m = TAB_IN_URL.exec(location.hash);
  return m ? { kind: m[1], id: m[2] } : null;
}

/** Opens a package's tab the address names, once the extensions have loaded. False when no package here declares that kind. */
async function openNamedTab(kind, id) {
  await extensionsReady;
  const entry = registry.entries("tabs").find((e) => e.id === kind);
  if (!entry) return false;
  places.close();
  closeSidebar();
  return tabs.openKind(entry.key, id, { id });
}

/**
 * Opens what an address names: a conversation in the list, or any other session of this person — a
 * subagent, which opens as its own read-only tab, its parent learned from its record. False when there is
 * no such session (it was discarded, or the link was mistyped).
 */
async function openNamed(id) {
  if (store.session(id)) {
    await openConversation(id);
    return true;
  }
  if (!store.isAgent(id)) {
    let record;
    try {
      record = await api(`/api/sessions/${id}`);
    } catch {
      return false;
    }
    if (!record?.parent) {
      // A conversation the list has not caught up with yet.
      await refreshList();
      await openConversation(id);
      return true;
    }
    const first = (record.conversation ?? []).find((m) => m.role === "user");
    store.setAgent(id, { parent: record.parent, task: first ? contentText(first.content) : undefined, createdAt: record.createdAt });
  }
  await openAgent(id);
  return true;
}

// Another conversation typed or pasted into the address bar of an open page switches to it. The page's own
// changes to the hash are `replaceState`, which fires no `hashchange`, so this hears only the person.
addEventListener("hashchange", () => {
  const tab = tabInUrl();
  if (tab) {
    const shown = store.get("activeTab");
    if (shown && shown.kind === tab.kind && shown.id === tab.id) return;
    void openNamedTab(tab.kind, tab.id).then((ok) => {
      if (!ok) toast(`Nothing here opens ${tab.kind} tabs.`, { tone: "error" });
    });
    return;
  }
  const id = conversationInUrl();
  if (!id || id === store.get("current")) return;
  void openNamed(id).then((ok) => {
    if (!ok) toast("There is no conversation with that id here.", { tone: "error" });
  });
});

/** What the address bar says: a conversation's root session, a package's tab as `#<kind>/<id>`, or nothing for a draft. */
function hashFor(shown) {
  if (!shown) return "";
  return shown.kind === "session" ? `#${store.rootOf(shown.id)}` : `#${shown.kind}/${shown.id}`;
}

store.watch("activeTab", (shown) => {
  const hash = hashFor(shown);
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
  const avatar = agentAvatar();
  const state = `${working ? "working" : "idle"} ${avatar ?? ""}`;
  if (state === faviconState) return;
  faviconState = state;
  const accent = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#7c9cff";
  const warn = getComputedStyle(document.documentElement).getPropertyValue("--warn").trim() || "#e8b673";
  const dot = working ? `<circle cx="25" cy="7" r="6" fill="${warn}" stroke="#0b0b0f" stroke-width="2"/>` : "";
  // The agent's picture, when an admin gave it one, cut round; the ring and dot otherwise. The picture is a
  // data: URL, so the icon stays one self-contained image and the working dot still goes on top of it.
  const face = avatar
    ? `<defs><clipPath id="c"><circle cx="16" cy="16" r="15"/></clipPath></defs><image href="${avatar.replace(/"/g, "%22")}" x="1" y="1" width="30" height="30" clip-path="url(#c)" preserveAspectRatio="xMidYMid slice"/>`
    : `<circle cx="16" cy="16" r="9" fill="none" stroke="${accent}" stroke-width="3"/><circle cx="16" cy="16" r="3.5" fill="${accent}"/>`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="0 0 32 32">${face}${dot}</svg>`;
  const link = document.querySelector("link[rel='icon']");
  if (link) link.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}
store.watch("activity", () => drawFavicon(countWorking()));

// --- the agent: its name at the top left and in the tab, its picture beside the name and in the icon ---

watchAgent(({ name, avatar }) => {
  $("brand-name").textContent = name;
  const face = clear($("brand-face"));
  if (avatar) face.append(el("img", { src: avatar, alt: "" }));
  setHidden(face, !avatar);
  repaintAgentAvatars(name, avatar);
  drawFavicon(countWorking());
});
// A page left open learns of a rename when the person comes back to it, at most twice a minute.
let agentAsked = 0;
document.addEventListener("visibilitychange", () => {
  if (document.hidden || Date.now() - agentAsked < 30_000) return;
  agentAsked = Date.now();
  void refreshAgent();
});

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
  // Over everything else while it is open, so Escape closes the drawer before the place under it.
  if (open) layers.open("drawer", closeSidebar);
  else layers.remove("drawer");
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
    restart.pollSoon(); // a restart is most often armed from inside a turn
  }
  tabs.applyTurn(message);
  broadcastTurn(message);
}

// --- the build the page runs, and what was being typed across a refresh ---

/**
 * What is typed is kept for this browser tab whenever the page goes away — a refresh, the page refreshing
 * itself after an update, an extension's "Update all" — and put back when it loads. sessionStorage: it is
 * this tab's, it survives a reload and nothing else, and it never leaves the machine. It can be missing or
 * refuse (a private window, storage blocked), so every touch of it is guarded and the page works without it.
 */
const DRAFT_KEY = `thetis.draft:${location.pathname}`;

function saveDraft() {
  try {
    const text = composer.draftText();
    if (text.trim()) sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ session: store.get("current"), text }));
    else sessionStorage.removeItem(DRAFT_KEY);
  } catch {
    // No storage here: a refresh loses the draft, as it always did.
  }
}

function takeDraft() {
  try {
    const raw = sessionStorage.getItem(DRAFT_KEY);
    sessionStorage.removeItem(DRAFT_KEY);
    const draft = raw ? JSON.parse(raw) : null;
    return draft && typeof draft.text === "string" ? draft : null;
  } catch {
    return null;
  }
}

addEventListener("pagehide", saveDraft);

/** The build id this page was loaded with. A different one on a later snapshot means new code is out. */
function sawBuild(build) {
  const id = typeof build?.id === "string" ? build.id : "";
  if (!id) return;
  const mine = store.get("build")?.id;
  if (!mine) return store.set({ build: { id } });
  if (id !== mine) updated();
}

/**
 * Thetis was updated while this page was open, so it is running old code. It refreshes itself on the same
 * conversation (the address bar names it) with what was typed kept — at once when nothing is typed and no
 * place is open, because then there is nothing to lose and nobody is in the middle of anything; otherwise
 * through a notice, so a half-written message or a page being read is not taken away under the person.
 */
function updated() {
  const busy = composer.draftText().trim() || places.current() || store.get("creating");
  if (!busy) return refreshPage();
  notice("thetis-updated", {
    title: `${agentName()} was updated`,
    body: "Refresh to use the new version. What you typed is kept.",
    tone: "info",
    actions: [{ label: "Refresh", primary: true, run: refreshPage }],
  });
}

function refreshPage() {
  saveDraft();
  location.reload();
}

/** Puts a kept draft back once the conversation it was typed in is on screen. A new conversation's draft reopens a new one. */
async function restoreDraft(draft) {
  if (!draft) return;
  if (draft.session === null) tabs.showNew();
  else if (draft.session !== store.get("current")) return;
  composer.restore(draft.text);
}

const draftAtLoad = takeDraft();

// A restart of Thetis, announced to everyone; the end of any of this person's turns asks at once.
const restart = watchRestart();

let opened = false;
const connection = connect({
  probe: async () => sawBuild((await api("/api/me")).build),
  onStatus: setStatus,
  onSnapshot: async (snapshot) => {
    sawBuild(snapshot.build);
    store.setRunningSnapshot(snapshot.running.map((r) => r.session));
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
      // to where you were is not a judgement about which conversations are interesting — or a subagent,
      // which opens in its own tab. Nothing named, or nothing by that name any more: the newest
      // conversation, as before. A draft kept from a new conversation brings the new conversation back.
      const sessions = store.get("sessions");
      const wantedTab = tabInUrl();
      const wanted = conversationInUrl();
      let named = false;
      if (wantedTab) {
        // A package's tab: the page waits for the extensions, since only the package can draw it.
        named = await openNamedTab(wantedTab.kind, wantedTab.id);
        if (!named) toast(`Nothing here opens ${wantedTab.kind} tabs.`, { tone: "error" });
      } else if (wanted && draftAtLoad?.session !== null) named = await openNamed(wanted);
      const first = !named && draftAtLoad?.session !== null && sessions.find((s) => !s.archived);
      if (first) await openConversation(first.id);
      await restoreDraft(draftAtLoad);
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
bindConnection(connection);

// --- developer details: one switch in the footer, kept per person by the gateway ---

const devToggle = $("developer-toggle");
store.watch("developer", (on) => {
  devToggle.setAttribute("aria-pressed", String(on === true));
  devToggle.classList.toggle("is-on", on === true);
  devToggle.title = on ? "Developer details are shown: raw dumps, problem lists and internal rows. Click to hide them." : "Show developer details: raw dumps, problem lists and internal rows.";
});
devToggle.addEventListener("click", async () => {
  const on = store.get("developer") !== true;
  try {
    const out = await api("/api/me/prefs", { method: "POST", body: { developer: on } });
    store.set({ developer: out?.developer === true });
  } catch (err) {
    toast(`The setting was not changed: ${err.message}`, { tone: "error" });
  }
});

api("/api/me").then((me) => {
  setAgent(me?.agent);
  store.set({ user: me, developer: me?.prefs?.developer === true });
  sawBuild(me?.build);
}).catch(() => {});
setStatus("connecting");
composer.loadChoices();
composer.focus();
const extensionsReady = loadExtensions();

