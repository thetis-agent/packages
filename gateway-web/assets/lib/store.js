/* One observable object for the page's state. Views watch keys and redraw, or watch sessions and
 * touch up one row: `set` tells key watchers at once, and anything that changes what one session is
 * doing (its activity, its agents, whether it runs) also names that session and its conversation to
 * the session watchers. The activity map is changed in place, and its key watchers are told once per
 * burst rather than once per event, because a busy turn produces many events a second and a whole
 * redraw per event is what made the page slow. */

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
const sessionWatchers = new Set();

// Notifications that may coalesce: the keys and sessions named since the last flush, told together a
// moment later. A timer, not an animation frame, so the title's working count still moves in a hidden tab.
const BURST_MS = 16;
const pendingKeys = new Set();
const pendingSessions = new Set();
let flushTimer = null;

function notifyKey(key) {
  for (const fn of watchers.get(key) ?? []) fn(state[key]);
}

function flush() {
  flushTimer = null;
  const keys = [...pendingKeys];
  const ids = [...pendingSessions];
  pendingKeys.clear();
  pendingSessions.clear();
  for (const key of keys) notifyKey(key);
  for (const id of ids) for (const fn of sessionWatchers) fn(id);
}

function later(keys, ids) {
  for (const key of keys) pendingKeys.add(key);
  for (const id of ids) if (id) pendingSessions.add(id);
  if (!flushTimer) flushTimer = setTimeout(flush, BURST_MS);
}

export const store = {
  get: (key) => state[key],
  set(patch) {
    const changed = [];
    for (const [key, value] of Object.entries(patch)) {
      if (state[key] === value) continue;
      state[key] = value;
      changed.push(key);
    }
    for (const key of changed) notifyKey(key);
  },
  watch(key, fn) {
    if (!watchers.has(key)) watchers.set(key, new Set());
    watchers.get(key).add(fn);
    return () => watchers.get(key).delete(fn);
  },
  /** `fn(id)` after anything about one session changed: its activity, its agents, its running or pending mark. Coalesced per burst. */
  watchSession(fn) {
    sessionWatchers.add(fn);
    return () => sessionWatchers.delete(fn);
  },
  /** Sets or clears one id in a set-valued key, replacing the set so watchers fire. */
  mark(key, id, on) {
    if (state[key].has(id) === on) return;
    const next = new Set(state[key]);
    if (on) next.add(id);
    else next.delete(id);
    this.set({ [key]: next });
    later([], [id, this.rootOf(id)]);
  },
  activityOf: (id) => state.activity.get(id) ?? null,
  /** Replaces one session's activity record in place; the `activity` key and the session are told in the next burst. */
  setActivity(id, record) {
    if (record) state.activity.set(id, record);
    else if (!state.activity.delete(id)) return;
    later(["activity"], [id, this.rootOf(id)]);
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
    later([], entries.flatMap(([id]) => [id, this.rootOf(id)]));
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
