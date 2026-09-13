/* One observable object for the page's state. Views watch keys and redraw. */

const state = {
  user: null,          // { user, role }
  sessions: [],        // SessionSummary[] from the server
  current: null,       // open session id
  running: new Set(),  // session ids with a turn in progress
  pending: new Set(),  // session ids with a send awaiting the server's 202
  creating: false,
  connection: "connecting", // connecting | online | offline
};

const watchers = new Map();

export const store = {
  get: (key) => state[key],
  set(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] === value) continue;
      state[key] = value;
      changed.push(key);
    }
    for (const key of changed) for (const fn of watchers.get(key) ?? []) fn(state[key]);
  },
  watch(key, fn) {
    if (!watchers.has(key)) watchers.set(key, new Set());
    watchers.get(key).add(fn);
    return () => watchers.get(key).delete(fn);
  },
  /** Sets or clears one id in a set-valued key, replacing the set so watchers fire. */
  mark(key, id, on) {
    const next = new Set(state[key]);
    if (on) next.add(id);
    else next.delete(id);
    if (next.size === state[key].size && [...next].every((x) => state[key].has(x))) return;
    this.set({ [key]: next });
  },
  isRunning: (id) => state.running.has(id),
  isPending: (id) => state.pending.has(id),
  session: (id) => state.sessions.find((s) => s.id === id) || null,
};
