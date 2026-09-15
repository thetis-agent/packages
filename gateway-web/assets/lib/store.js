/* One observable object for the page's state. Views watch keys and redraw. */

const state = {
  user: null,          // { user, role }
  sessions: [],        // SessionSummary[] from the server
  current: null,       // the active tab's session id
  tabs: [],            // open session ids, in tab order
  sessionFilter: null, // a package's narrowing of the sidebar list: (session) => boolean, or null
  running: new Set(),  // session ids with a turn in progress
  pending: new Set(),  // session ids with a send awaiting the server's 202
  activity: new Map(), // session id -> { state, step, tool, since, steps, cost, outcome }
  plan: new Map(),     // session id -> parsed todo plan (see views/plan.js), or absent if never used
  choices: null,       // { model, models } from /api/models, once loaded
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
  /** Replaces one session's activity record, replacing the map so watchers fire. */
  activityOf: (id) => state.activity.get(id) ?? null,
  setActivity(id, record) {
    const next = new Map(state.activity);
    if (record) next.set(id, record);
    else next.delete(id);
    this.set({ activity: next });
  },
  /** Replaces one session's parsed plan, replacing the map so watchers fire. */
  planOf: (id) => state.plan.get(id) ?? null,
  setPlan(id, plan) {
    const next = new Map(state.plan);
    if (plan) next.set(id, plan);
    else next.delete(id);
    this.set({ plan: next });
  },
  isRunning: (id) => state.running.has(id),
  isPending: (id) => state.pending.has(id),
  session: (id) => state.sessions.find((s) => s.id === id) || null,
  /** The model in force for a session: the chosen one, else the configured default. */
  modelFor(id) {
    return store.session(id)?.model || state.choices?.model || "";
  },
};
