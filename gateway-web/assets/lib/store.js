/* Client state.
 *
 * One object, one change notification. Views subscribe to what they care about
 * and re-render; nothing mutates the DOM behind the store's back.
 *
 * Deliberately small: the wire this UI now speaks (wire.ts) carries a person's
 * name and role, a conversation list, N conversations' streams of turn events,
 * and the environment's health — nothing about branches, files, skills, tools
 * or models. There is no `denied()` helper here the way the legacy store had
 * one: the role decides exactly one thing on this surface, whether the sidebar
 * may ask for everyone's conversations, and views/sessions.js reads it there.
 *
 * `busyIds`/`pendingIds` are sets rather than one flag apiece because
 * `wire.ts`'s `#streams`/`#turns` are keyed by conversation id — several tabs
 * can each have a turn running at once, so "the open conversation's turn is
 * running" (the legacy store's only question) is not enough here.
 */

import { IDLE } from "./activity.js";
import { pageAgent } from "./brand.js";
import { blankLedger } from "./usage.js";

/** The stand-in for a conversation nothing has been counted for. Shared and never written, the way
 *  activity.js's IDLE is, so every unspent conversation reads as the same object. */
const EMPTY_LEDGER = blankLedger();

export const store = {
  /** The conversations as last replied by `list`: this person's, or everyone's
   *  when `scope` says so, in which case each row carries an `owner`. */
  sessions: [],
  /** Conversation ids with an open tab, in stage-tab order. */
  tabs: [],
  /** The tab id showing in the stage, or null. */
  current: null,
  /** The `user` frame — `{ name, role }`, who this socket is for. Null until it
   *  arrives, which is the first thing the host sends. */
  user: null,
  /** What the agent is called and the colour it is drawn in — configuration,
   *  not anything this browser chose. Seeded from the page, which was served
   *  with both already filled in, so views built before the connection opens
   *  have the right word; the `user` frame replaces it with the same answer
   *  from the same process a moment later. lib/brand.js says why twice. */
  agent: pageAgent(),
  /** Whose conversations `sessions` holds: "mine", or "everyone" once the
   *  sidebar's switch is on. Held here rather than in the view because app.js
   *  has to name it on every `list` it sends, including the ones a reconnect
   *  sends before any view has drawn. */
  scope: "mine",
  /** The last `env-status` frame, or null before one has arrived (the
   *  environment predates `env.status`, or none has landed yet). Not keyed by
   *  conversation: wire.ts's `#envStatus` is a property of the socket's own
   *  environment, not of any one stream. */
  env: null,
  /** The last `system-status` reply, or null before one has arrived. What the machine and this
   *  socket are doing — versions, open conversations, memory and load — as of the last poll
   *  views/statusbar.js made. Separate from `env` because the two have different costs and
   *  different lifetimes: this one is asked for, that one is pushed. */
  system: null,
  /** The last `env-logs` reply, held only while the status bar's activity panel is open and
   *  cleared when it closes. A log is read when it is asked for; keeping one around would mean
   *  showing an hour-old tail the next time somebody opened the panel. */
  logs: null,
  /* What each conversation is doing right now, by conversation id.
   *
   * Unlike the legacy store's field of the same name this is *derived*, not
   * pushed: this wire sends `event` frames only for conversations the socket
   * has subscribed to, so an entry exists only for a conversation with an open
   * tab. lib/activity.js's header says what that costs and why. Written in one
   * place (app.js's `applyFrame`) alongside `busyIds`, so the dot and the step
   * cannot disagree about whether a conversation is working. */
  activity: {},
  /** Conversation ids with a turn running (between `turn-started` and
   *  `turn-finished`/`cancelled`). Kept in step with `activity` by its writer. */
  busyIds: new Set(),
  /** Conversation ids with a submitted message still waiting on `accepted` —
   *  that conversation's composer is locked so a second Enter cannot send it
   *  twice, and its optimistic row keeps its pending mark. */
  pendingIds: new Set(),
  /* What each conversation has spent, by conversation id: `{ turn, total }`, the turn in flight and
   * the running total it will fold into. Derived from `model.end`, which carries the provider's own
   * counters and nothing this surface made up; lib/usage.js does the arithmetic and app.js's
   * `applyFrame` is the only writer. Keyed like `activity`, and like `activity` it exists only for a
   * conversation with an open tab, because those are the only ones this socket streams. */
  usage: {},
  /** True between clicking "New chat" and the conversation opening. */
  creating: false,

  _watchers: new Map(),

  /** Subscribes to one key. Returns an unsubscribe function. */
  watch(key, fn) {
    if (!this._watchers.has(key)) this._watchers.set(key, new Set());
    this._watchers.get(key).add(fn);
    return () => this._watchers.get(key).delete(fn);
  },

  /** Applies a patch and notifies watchers of the keys that actually changed. */
  set(patch) {
    const touched = [];
    for (const [key, value] of Object.entries(patch)) {
      if (this[key] === value) continue;
      this[key] = value;
      touched.push(key);
    }
    for (const key of touched) {
      this._watchers.get(key)?.forEach((fn) => fn(this[key], this));
    }
    return touched;
  },

  /** Forces watchers to run even when the reference is unchanged. */
  touch(...keys) {
    for (const key of keys) {
      this._watchers.get(key)?.forEach((fn) => fn(this[key], this));
    }
  },

  /** What `id` is doing, or the idle stand-in for a conversation nothing is known about. */
  activityOf(id) {
    return (id != null && this.activity[id]) || IDLE;
  },
  /** Replaces one conversation's activity, notifying only when it actually moved. */
  setActivity(id, next) {
    if (id == null || this.activity[id] === next) return;
    this.activity = { ...this.activity, [id]: next };
    this.touch("activity");
  },
  /** What `id` has spent, or an empty ledger for a conversation nothing has been counted for. */
  usageOf(id) {
    return (id != null && this.usage[id]) || EMPTY_LEDGER;
  },
  setUsage(id, next) {
    if (id == null) return;
    this.usage = { ...this.usage, [id]: next };
    this.touch("usage");
  },
  isBusy(id) {
    return id != null && this.busyIds.has(id);
  },
  isPending(id) {
    return id != null && this.pendingIds.has(id);
  },
  setBusy(id, on) {
    if (this.busyIds.has(id) === Boolean(on)) return;
    if (on) this.busyIds.add(id);
    else this.busyIds.delete(id);
    this.touch("busyIds");
  },
  setPending(id, on) {
    if (this.pendingIds.has(id) === Boolean(on)) return;
    if (on) this.pendingIds.add(id);
    else this.pendingIds.delete(id);
    this.touch("pendingIds");
  },

  /** Opens a tab for `id` if it has none yet, and shows it. */
  openTab(id) {
    if (!this.tabs.includes(id)) {
      this.tabs = [...this.tabs, id];
      this.touch("tabs");
    }
    this.set({ current: id });
  },

  /** Closes a tab. The stream it subscribed stays open on the socket (there
   *  is no "unsubscribe" in this wire) — closing is this app's own view onto
   *  an already-open conversation, not the socket's. */
  closeTab(id) {
    const at = this.tabs.indexOf(id);
    if (at === -1) return;
    const remaining = this.tabs.filter((tab) => tab !== id);
    const current = this.current !== id ? this.current : remaining[at] ?? remaining[at - 1] ?? null;
    this.tabs = remaining;
    this.touch("tabs");
    this.set({ current });
  },
};
