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
  /** The last `env-status` frame, or null before one has arrived (the
   *  environment predates `env.status`, or none has landed yet). Not keyed by
   *  conversation: wire.ts's `#envStatus` is a property of the socket's own
   *  environment, not of any one stream. */
  env: null,
  /** Conversation ids with a turn running (between `turn-started` and
   *  `turn-finished`/`cancelled`). */
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
