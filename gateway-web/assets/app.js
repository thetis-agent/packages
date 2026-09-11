/* Wires the page together: the socket, the store, and every view.
 *
 * This is a from-scratch rewrite of the legacy app.js rather than a trim. The
 * legacy file's ~1600 lines were mostly the handler chain for frames this
 * wire does not send — catalog, history, settings, plan, todo, participants,
 * system-status, user-avatar, the whole admin-* and skills/tools/branch/
 * workspace/terminal/debug-request/resync families. What this wire actually
 * speaks (wire.ts) is eight inbound frame types and six outbound commands;
 * this file is sized to that.
 *
 * One conversation is a tab, and several can be open — and, since `#turns` is
 * keyed by conversation id, several can each have a turn running — so state
 * that used to be one flag apiece (`busy`, `pending`) is a set keyed by
 * conversation id instead. See lib/store.js.
 */

import { avatarFor } from "./lib/avatar.js";
import { clear, $, setHidden } from "./lib/dom.js";
import { Connection } from "./lib/socket.js";
import { store } from "./lib/store.js";
import { toast } from "./lib/toast.js";
import { mountAdmin } from "./views/admin.js";
import { mountComposer } from "./views/composer.js";
import { mountEnvironment } from "./views/environment.js";
import { mountRail } from "./views/rail.js";
import { mountSessions } from "./views/sessions.js";
import { mountStage, transcriptFor } from "./views/stage.js";
import { mountStatusbar } from "./views/statusbar.js";
import { answer, attach, deliver } from "./lib/surface.js";
import { applyActivity, cancelled, mergeSessions, sortSessions } from "./lib/activity.js";
import { createCursors } from "./lib/cursors.js";
import { addCall, addTurn, blankTurn, turnSummary } from "./lib/usage.js";

const statusEl = $("status");

function setStatus(state, text) {
  statusEl.className = `status is-${state}`;
  statusEl.textContent = text;
}

const connection = new Connection({ onStatus: setStatus });
const sendFrame = (frame) => connection.send(frame);
/* Where each open conversation got to, so that a connection which drops mid-turn comes back to the
 * same transcript rather than to a hole. lib/cursors.js holds the rule; the two places it is
 * consulted are the `opened` handler and `applyFrame`. */
const cursors = createCursors();

// The one thing a contributed panel may originate, and the only way it reaches the socket; ADR 0051.
attach(sendFrame);

/** Switches to a conversation's tab, opening one if it has none yet. A tab
 *  click always hits the first branch — stage.js only ever offers ids already
 *  in `store.tabs` — so this one function serves both the stage's tab clicks
 *  and the sidebar's row clicks, which may name a conversation with no tab at
 *  all yet. */
function openConversation(id) {
  if (store.tabs.includes(id)) {
    store.set({ current: id });
    return;
  }
  sendFrame(cursors.openFrame(id));
}

/** Starts a new conversation. Guarded by `store.creating` so a second click
 *  before the host replies cannot fire two `new` commands — used by both the
 *  sidebar's "+" and the stage's own "+" tab. */
function createConversation() {
  if (store.creating) return;
  store.set({ creating: true });
  if (!sendFrame({ type: "new" })) {
    store.set({ creating: false });
    toast("Not connected — try again once the connection is back.", { tone: "error" });
  }
}

mountStage({ onOpen: openConversation, onClose: (id) => store.closeTab(id), onNew: createConversation });
const railEnvironment = mountEnvironment({ sendFrame });
mountRail([railEnvironment]);
mountStatusbar();

const composer = mountComposer({
  /* `files` are the tray's own entries: each carries the descriptor the host answered the upload with,
   * which is the only part the frame may name, and the `data:` picture the page already drew, which is
   * what the optimistic row shows until the turn's own `user` event arrives with a served URL. */
  onSend(text, files = []) {
    const id = store.current;
    if (!id) return false;
    const attachments = files.map((file) => file.descriptor).filter(Boolean);
    if (!sendFrame({ type: "send", id, text, attachments })) return false;
    store.setPending(id, true);
    transcriptFor(id)?.addLocal(text, files.map((file) => ({ name: file.name, bytes: file.size, url: file.preview })));
    return true;
  },
  onStop() {
    if (store.current) sendFrame({ type: "turn-cancel", id: store.current });
  },
  /* Which model answers this conversation, and how much it may do. An ask, not a change: the
   * environment refuses a model it does not have, so the pill moves when `chosen` comes back rather
   * than the moment it is clicked. */
  onChoose(id, choice) {
    return sendFrame({ type: "choose", id, ...choice });
  },
});

/* The sidebar's own commands. Each is an ask, not a change: the row that comes
 * back from the next `list` is the host's answer, since the environment caps
 * and collapses a name and this tab has no business guessing either. */
const sessions = mountSessions({
  onOpen: openConversation,
  onNew: createConversation,
  onRename(id, title) {
    if (!sendFrame({ type: "rename", id, title })) toast("Not connected — the name was not changed.", { tone: "error" });
  },
  onArchive(id, archived) {
    if (!sendFrame({ type: archived ? "archive" : "unarchive", id })) {
      toast("Not connected — try again once the connection is back.", { tone: "error" });
    }
  },
  /* Whose conversations the list holds. The host decides whether this account
   * may ask at all; the switch is only on screen for a role that may. */
  onScope(scope) {
    if (!sendFrame({ type: "list", scope })) return toast("Not connected — the list did not change.", { tone: "error" });
    store.set({ scope });
  },
});
const admin = mountAdmin({ sendFrame });

// --- identity -----------------------------------------------------------------

/* Panels and renderers a package contributed, named by the host in its `user` frame.
 *
 * Imported rather than bundled: each is served from this same origin under its own package's
 * `/surface/<package>/` path, which is what the CSP's `default-src 'self'` permits and nothing wider.
 * A module that fails to load is reported and skipped — one broken contributor must not take the
 * conversation down with it. */
let loaded = false;
/* Event frames that arrived while the contributed modules were still importing.
 *
 * Each `await import` yields, so a frame can land before a contributed renderer or watcher has
 * registered — and that frame would then be drawn only by the built-in table and never reach the
 * contributor at all. Holding them costs a few milliseconds on a same-origin import and is the
 * difference between a panel that is merely late and one that is permanently missing its first
 * turn. Bounded, like every other queue here: past the cap the surface stops waiting and delivers,
 * because a late panel is better than a stalled conversation. */
const queued = [];
const QUEUED_MAX = 512;
let contributionsReady = false;

function releaseQueue() {
  contributionsReady = true;
  while (queued.length) applyFrame(queued.shift());
}

async function loadContributions(frame) {
  if (loaded) return;
  loaded = true;
  const entries = [...(frame.panels || []), ...(frame.renderers || [])];
  for (const descriptor of entries) {
    try { await import(descriptor.entry); }
    catch (error) {
      console.error(`the ${descriptor.id || descriptor.kind} contribution failed to load`, error);
      toast(`A panel this environment offers could not be loaded: ${descriptor.id || descriptor.kind}.`, { tone: "error" });
    }
  }
  releaseQueue();
}

/* The conversation list is the only carrier of a row's title, preview and
 * recency, and the host moves all three at exactly two points: a message sent,
 * and a turn finished (core/session-store.ts `record`). Asking then is what
 * keeps the sidebar current. Coalesced, because a burst of finishing turns
 * should ask once. */
let listTimer = null;
const LIST_DEBOUNCE_MS = 250;
/** Always named with the scope on screen, so the reply can be told apart from
 *  one answered for the other setting and still in flight. */
const requestList = () => sendFrame({ type: "list", scope: store.scope });
function scheduleList() {
  clearTimeout(listTimer);
  listTimer = setTimeout(() => { listTimer = null; requestList(); }, LIST_DEBOUNCE_MS);
}

/* Folds a frame into the conversation's usage ledger, and hands back the finished turn on the frame
 * that ends one.
 *
 * The ledger lives in the store rather than in the transcript because two views read it: the
 * transcript draws one chip per finished turn, and the stage draws the running total in the tab's own
 * bar. Keeping one copy is what stops the two disagreeing — the same reasoning `activity` is derived
 * in one place for. */
function applyLedger(frame) {
  if (frame.kind === "model-end") {
    const ledger = store.usageOf(frame.session);
    store.setUsage(frame.session, { ...ledger, turn: addCall(ledger.turn, frame.usage, frame.stop) });
    return null;
  }
  if (frame.kind !== "turn-finished") return null;
  const ledger = store.usageOf(frame.session);
  store.setUsage(frame.session, { turn: blankTurn(), total: addTurn(ledger.total, ledger.turn) });
  return ledger.turn;
}

/** Draws one event frame and hands it to whoever asked for that kind. */
function applyFrame(frame) {
  // Activity and the working dot are derived in one place from one frame, so
  // they cannot disagree about whether a conversation is working — the class of
  // bug legacy's `rev` merge existed to close, on the half of it that is
  // derived here. See lib/activity.js for the half that still needs a merge.
  const next = applyActivity(store.activity[frame.session], frame, Date.now());
  store.setActivity(frame.session, next);
  store.setBusy(frame.session, next.state === "working");
  if (frame.kind === "user" || frame.kind === "turn-finished") scheduleList();
  const finished = applyLedger(frame);
  transcriptFor(frame.session)?.applyEvent(frame);
  if (finished) transcriptFor(frame.session)?.showUsage(turnSummary(finished, frame));
  // Recorded after the row is on screen, never before: the position this client reports on a
  // reconnect has to be one it has actually drawn, or the replay starts past something nobody saw.
  cursors.drew(frame.session, frame.cursor);
  // Panels read the same frames the transcript does, after it has drawn them.
  deliver(frame);
}

store.watch("user", (user) => {
  $("user-name").textContent = user?.name || "";
  // The same face the transcript puts beside this person's own messages, so the
  // colour in the sidebar and the colour on the rows are visibly one person.
  const face = clear($("user-face"));
  if (user?.name) face.append(avatarFor("person", user.name));
  setHidden($("logout"), !user);
});

// --- inbound frames -------------------------------------------------------------

connection
  /* Two names arrive here and they are not the same kind of thing: `user` is
   * whoever this connection belongs to, `agent` is what the installation calls
   * itself. The window title and the sidebar were filled in when the page was
   * served — they are spent before this frame exists — so what the store's copy
   * is for is text a script builds afterwards: the composer's prompt, and the
   * letter on the agent's face in each turn. */
  .on("user", (frame) => { store.set({ user: frame.user, agent: frame.agent || store.agent }); void loadContributions(frame); })
  .on("sessions", (frame) => {
    // A reply carries the scope it answered. One answered for the other
    // setting is still in flight when the switch is flipped, and membership
    // comes from the reply — so taking it would empty the sidebar of the half
    // it just asked for.
    if ((frame.scope || "mine") !== store.scope) return;
    // Merged rather than replaced: a reply asked for before a turn ended can
    // land after it, and taking whichever arrived last would put the older row
    // back. `updatedMs` is the host's stamp for the row and decides — the same
    // reasoning legacy's `rev` merge was built on. lib/activity.js says why.
    const list = mergeSessions(store.sessions, Array.isArray(frame.sessions) ? frame.sessions : []);
    store.set({ sessions: list });
    // The first time the list arrives with no tab open yet, open whatever was
    // most recently active — an empty stage with conversations sitting
    // unopened in the sidebar is not a useful first screen.
    if (!store.tabs.length && list.length) openConversation(sortSessions(list)[0].id);
  })
  .on("opened", (frame) => {
    const { lost } = cursors.opened(frame.session, frame);
    store.openTab(frame.session);
    // A conversation reopened from scratch arrives with its saved messages and rebuilds from them,
    // which is also how the transcript stays free of duplicates: either the host replays only what
    // this client has not drawn, or it sends the whole saved conversation and the pane starts over.
    if (frame.history) transcriptFor(frame.session)?.restore(frame.history);
    // Said once, where it happened, and in terms of what was lost rather than why.
    if (lost) transcriptFor(frame.session)?.applyEvent({ kind: "note", text: "Some earlier messages could not be restored." });
    store.set({ creating: false });
    composer.focus();
    requestList();
  })
  /* Both are acknowledgements, and the row itself comes from the list they ask
   * for: the host caps and collapses a name, and an archived row belongs in a
   * different section of the sidebar. Archiving offers the way back, because a
   * one-click change is only safe when undoing it is one click too. */
  .on("renamed", () => { requestList(); })
  .on("archived", (frame) => {
    requestList();
    if (!frame.archived) return toast("Conversation restored.");
    // The section the row moved into is opened, so the one thing that changed
    // on screen is visible rather than folded away at the foot of the list.
    sessions.openArchive();
    toast("Conversation archived.", {
      action: { label: "Undo", run: () => sendFrame({ type: "unarchive", id: frame.session }) },
    });
  })
  .on("accepted", (frame) => {
    store.setPending(frame.session, false);
    transcriptFor(frame.session)?.settleLocal();
  })
  .on("cancelled", (frame) => {
    // `cancelled` is the reply to this tab's own stop, and the host may or may
    // not follow it with a `turn-finished`; settling the row here means the
    // sheen stops when the button was pressed rather than whenever a frame
    // happens to arrive. A later `turn-finished` carrying `cancel` lands on the
    // same state, so the two cannot contradict each other.
    store.setActivity(frame.session, cancelled());
    store.setBusy(frame.session, false);
    transcriptFor(frame.session)?.applyEvent({ kind: "note", text: "Turn stopped." });
  })
  .on("event", (frame) => {
    if (contributionsReady) { applyFrame(frame); return; }
    queued.push(frame);
    if (queued.length >= QUEUED_MAX) releaseQueue();
  })
  .on("error", (frame) => {
    // `error` carries no `session` field — it is a fault in the socket
    // itself (budgets, malformed frames), not any one conversation's. The
    // safest reading is that nothing currently waiting on an acknowledgement
    // is going to get one, so every pending send is released rather than
    // left locked against a reply that is not coming.
    store.set({ creating: false });
    for (const id of [...store.pendingIds]) {
      store.setPending(id, false);
      transcriptFor(id)?.failLocal();
    }
    toast(frame.message || "The environment reported an error.", { tone: "error" });
  })
  .on("choices", (frame) => store.set({ choices: { models: frame.models || [], model: frame.model, mode: frame.mode } }))
  /* The environment honoured a choice. Written straight onto the row rather than waited for from the
   * next list, because the row is where every view reads it from and the list is debounced: the pill
   * would otherwise sit on the old answer for a quarter of a second after the host agreed. The list
   * is asked for anyway, so the host's own row is what stands a moment later. */
  .on("chosen", (frame) => {
    store.set({ sessions: store.sessions.map((session) => (session.id === frame.session
      ? { ...session, ...(frame.model === undefined ? {} : { model: frame.model }), ...(frame.mode === undefined ? {} : { mode: frame.mode }) }
      : session)) });
    requestList();
  })
  .on("env-status", (frame) => store.set({ env: frame }))
  .on("surface-answer", (frame) => answer(frame))
  .on("admin", (frame) => admin.apply(frame));

connection.onOpen(() => {
  sendFrame({ type: "hello" });
  // What a conversation here may be set to. Asked on every connection rather than held across one:
  // the models are the environment's provider's, and a reconnect may be to an environment that has
  // been rebuilt since.
  sendFrame({ type: "choices" });
  // The everyone switch lives on this socket's own request, so a reconnect
  // starts personal; the scope is named again before the sidebar draws a list
  // that quietly lost half its rows.
  requestList();
  // Every open tab is its own subscription on the socket (wire.ts's
  // `#streams`), and a reconnect starts with none of them — so all of them,
  // not just the one on screen, need to ask again. Each asks to continue from
  // where it left off, so a turn that ran while the connection was down is
  // still there when it comes back.
  for (const id of store.tabs) sendFrame(cursors.resumeFrame(id));
  admin.reconnected();
});

connection.connect();
composer.focus();
