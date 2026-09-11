/* Client state.
 *
 * One object, one change notification. Views subscribe to what they care about
 * and re-render; nothing mutates the DOM behind the store's back.
 *
 * Deliberately small: the wire this UI now speaks (wire.ts) carries a person's
 * name, a conversation list, N conversations' streams of turn events, and the
 * environment's health — nothing about roles, branches, files, skills, tools,
 * models, or other people's conversations. There is no `denied()` helper here
 * the way the legacy store had one: the `user` frame is frozen to `{name}`, so
 * there is no role for anything to withhold.
 *
 * `busyIds`/`pendingIds` are sets rather than one flag apiece because
 * `wire.ts`'s `#streams`/`#turns` are keyed by conversation id — several tabs
 * can each have a turn running at once, so "the open conversation's turn is
 * running" (the legacy store's only question) is not enough here.
 */

import { IDLE } from "./activity.js";
import { pageAgent } from "./brand.js";

export const store = {
  /** The signed-in person's conversations, as last replied by `list`. */
  sessions: [],
  /** Conversation ids with an open tab, in stage-tab order. */
  tabs: [],
  /** The tab id showing in the stage, or null. */
  current: null,
  /** The `user` frame's name — who this socket is for. Null until it arrives,
   *  which is the first thing the host sends. */
  user: null,
  /** What the agent is called and the colour it is drawn in — configuration,
   *  not anything this browser chose. Seeded from the page, which was served
   *  with both already filled in, so views built before the connection opens
   *  have the right word; the `user` frame replaces it with the same answer
   *  from the same process a moment later. lib/brand.js says why twice. */
  agent: pageAgent(),
  /** The last `env-status` frame, or null before one has arrived (the
   *  environment predates `env.status`, or none has landed yet). Not keyed by
   *  conversation: wire.ts's `#envStatus` is a property of the socket's own
   *  environment, not of any one stream. */
  env: null,
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
