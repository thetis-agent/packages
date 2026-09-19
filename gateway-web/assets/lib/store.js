/* One observable object for the page's state. Views watch keys and redraw. */

const state = {
  user: null,          // { user, role }
  sessions: [],        // SessionSummary[] from the server
  current: null,       // the active tab's session id
  tabs: [],            // open session ids, in tab order
  sessionFilter: null, // a package's narrowing of the sidebar list: (session) => boolean, or null
  running: new Set(),  // session ids with a turn in progress
  pending: new Set(),  // session ids with a send awaiting the server's 202
  activity: new Map(), // session id -> { state, step, tool, since, steps, agents, cost, outcome }
  agents: new Map(),   // child session id -> { id, parent, label, task, createdAt, outcome, cost }
                       // outcome: null while never finished, else "done" | "failed" | "stopped"; cost: what its replies reported
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
  isRunning: (id) => state.running.has(id),
  isPending: (id) => state.pending.has(id),
  session: (id) => state.sessions.find((s) => s.id === id) || null,
  /** The model in force for a session: the chosen one, else the configured default. */
  modelFor(id) {
    return store.session(id)?.model || state.choices?.model || "";
  },

  // ---- subagents: a child session is an agent of the session that spawned it ----

  agent: (id) => state.agents.get(id) ?? null,
  isAgent: (id) => state.agents.has(id),
  /** Merges a patch into one agent's record (undefined fields are left alone), replacing the map so watchers fire. */
  setAgent(id, patch) {
    this.setAgents([[id, patch]]);
  },
  /** Several agents at once, one notification. `entries` is `[[id, patch], ...]`. */
  setAgents(entries) {
    const next = new Map(state.agents);
    for (const [id, patch] of entries) {
      const had = next.get(id) ?? { id, parent: null, label: null, task: "", createdAt: null, outcome: null, cost: 0 };
      const merged = { ...had };
      for (const [key, value] of Object.entries(patch ?? {})) if (value !== undefined) merged[key] = value;
      merged.id = id;
      next.set(id, merged);
    }
    this.set({ agents: next });
  },
  /** The agents spawned by `parent`, in creation order. */
  agentsOf(parent) {
    return [...state.agents.values()].filter((a) => a.parent === parent).sort((a, b) => String(a.createdAt || "").localeCompare(String(b.createdAt || "")));
  },
  /** The conversation an id belongs to: `parent` followed up until a session with none. An unknown id is its own root. */
  rootOf(id) {
    let cur = id;
    const seen = new Set();
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const parent = state.agents.get(cur)?.parent;
      if (!parent) return cur;
      cur = parent;
    }
    return id;
  },
};
