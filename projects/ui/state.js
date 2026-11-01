/* What the page holds about projects: the list from `list`, the session-to-project map, and which
 * conversations are working. A project is a space the page is in: this module is the shell's space
 * provider (`ext.space.provide({ of, name })`), and the shell keeps the current space, the sidebar list,
 * the tabs and the draft that follow it. `of(id)` answers a root conversation's project, `null` for none,
 * and `undefined` while the map has not been read with that conversation in it: a workflow's service may
 * have assigned it, so the first time `of` meets an unknown id the map is read again (once per id, and one
 * read for a burst of them). The shell is told `changed()` after every read and every assignment.
 *
 * A conversation created on this page joins the space its draft was in, which the shell passes to
 * `onCreate`; one arriving from another tab or the command line is never assigned here. The current space
 * lives in the shell (localStorage `thetis.space`); the key this package used before, `thetis.project`, is
 * entered once and removed. On a gateway without `ext.space` a small stand-in keeps the old key and narrows
 * the sidebar through `ext.sessions.filter`. Watchers are told after every change; the switcher, the pill
 * and the place redraw from here. */

const SPACE = "thetis.space";
const LEGACY = "thetis.project";

function stored(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function store(key, value) {
  try {
    if (value) localStorage.setItem(key, value);
    else localStorage.removeItem(key);
  } catch {
    /* no storage: the choice lasts the page */
  }
}

/** The space seam of an older gateway: the remembered key, and the sidebar narrowed by a filter. */
function legacySpace(ext) {
  let current = stored(LEGACY) || null;
  let provider = null;
  const watchers = new Set();
  const apply = () => ext.sessions.filter?.(provider ? (s) => provider.of(s.id) === current : null);
  return {
    provide(p) {
      provider = p;
      apply();
      return () => {
        provider = null;
        apply();
      };
    },
    get current() {
      return current;
    },
    enter(id) {
      const next = id ?? null;
      if (next === current) return;
      current = next;
      store(LEGACY, next);
      apply();
      for (const fn of watchers) fn(next);
    },
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    changed: apply,
  };
}

/** `thetis.project` becomes the shell's `thetis.space`, once. A space already set wins. */
function migrate(space) {
  const old = stored(LEGACY);
  if (!old) return;
  if (stored(SPACE) === null) space.enter(old);
  store(LEGACY, null);
}

export function createState(ext) {
  const space = ext.space ?? legacySpace(ext);
  let projects = []; // [{ id, name, directories, conversations }]
  let assignments = {}; // session id -> project id
  let known = false;
  let reading = null;
  let again = null;
  let revision = 0;
  const settled = new Set(); // ids a finished read has seen: absent from the map means no project
  const checked = new Set(); // ids that already asked for a read
  const running = new Set(); // root conversations with a turn going
  const watchers = new Set();

  const notify = () => {
    for (const fn of watchers) {
      try {
        fn();
      } catch (err) {
        console.error("a project watcher threw:", err);
      }
    }
  };
  const changed = () => {
    try {
      space.changed?.();
    } catch (err) {
      console.error("projects: the shell's space change threw:", err);
    }
  };
  const project = (id) => projects.find((p) => p.id === id) ?? null;
  const roots = () => {
    const list = ext.sessions.list?.();
    return Array.isArray(list) ? list.filter((s) => s && !s.parent) : [];
  };

  let recheck = null;
  function unseen(id) {
    if (checked.has(id)) return;
    checked.add(id);
    clearTimeout(recheck);
    recheck = setTimeout(() => void refresh({ fresh: true }), 400);
  }

  /** A root conversation's project id, null for none, undefined while that is not known yet. */
  function of(id) {
    if (typeof id !== "string" || !id) return undefined;
    if (id in assignments) return project(assignments[id]) ? assignments[id] : null;
    if (settled.has(id)) return null;
    unseen(id);
    return undefined;
  }

  // Before the first read a chosen project has no name yet: blank, not "No project", which would be a wrong claim.
  const name = (id) => project(id)?.name ?? (id && !known ? "" : "No project");

  /** Reads the list again; `fresh` waits for a read in flight and then reads once more. */
  function refresh({ fresh = false } = {}) {
    if (fresh && reading) {
      again ??= reading.then(() => {
        again = null;
        return refresh();
      });
      return again;
    }
    if (!reading) reading = readList().finally(() => { reading = null; });
    return reading;
  }

  async function readList() {
    const startedAt = revision;
    const asked = [...roots().map((s) => s.id), ...checked];
    try {
      const out = await ext.request("list", { session: ext.conversation.current ?? undefined });
      if (startedAt !== revision) {
        // An assignment went out meanwhile, and this answer may predate it: read again rather than settle on it.
        void refresh({ fresh: true });
        return;
      }
      projects = Array.isArray(out?.data?.projects) ? out.data.projects : [];
      assignments = out?.data?.assignments && typeof out.data.assignments === "object" ? out.data.assignments : {};
      known = true;
    } catch (err) {
      console.error("projects: the list could not be read:", err);
    }
    // Settled after a failure too: a row hidden until a read that keeps failing would be a row lost.
    for (const id of asked) settled.add(id);
    if (known && typeof space.current === "string" && !project(space.current)) space.enter(null);
    changed();
    notify();
  }

  /** Puts one root conversation in a project (or none). The map is updated first so the row stays put. */
  async function assign(session, to) {
    const before = assignments[session];
    const put = () => {
      if (to) assignments[session] = to;
      else delete assignments[session];
      settled.add(session);
    };
    revision += 1;
    put();
    changed();
    try {
      await ext.request("assign", { session, args: { session, project: to } });
      revision += 1;
      // A list fetched while the write was pending may have read the previous server map.
      put();
      for (const item of projects) item.conversations = Object.values(assignments).filter((id) => id === item.id).length;
      changed();
      notify();
    } catch (err) {
      revision += 1;
      if (before) assignments[session] = before;
      else delete assignments[session];
      changed();
      throw err;
    }
  }

  /** Root conversations in a space (`null` for no project), by the same `of` the sidebar uses. */
  function count(id) {
    const list = roots();
    if (!list.length) return id ? (project(id)?.conversations ?? 0) : 0;
    return list.filter((s) => of(s.id) === id).length;
  }

  const working = (id) => [...running].filter((s) => of(s) === id).length;

  space.provide({ of, name });
  if (ext.space) migrate(ext.space);
  space.watch?.(() => notify());

  // The draft's space comes with the creation; an older gateway passes nothing, and the current space stands in.
  ext.sessions.onCreate(async (session, opts) => {
    const target = opts && "space" in opts ? opts.space : space.current;
    if (!target) {
      settled.add(session);
      return;
    }
    await assign(session, target);
  });

  ext.events?.watch?.((message) => {
    const { session, parent, event } = message ?? {};
    if (!session || parent || !event) return;
    if (event.type === "turn.start") running.add(session);
    else if (event.type === "turn.end") running.delete(session);
    else return;
    notify();
  });
  ext.sessions.watch?.((list) => {
    let moved = false;
    for (const s of Array.isArray(list) ? list : []) {
      if (!s || s.parent) continue;
      const on = s.status === "running";
      if (on !== running.has(s.id)) {
        moved = true;
        if (on) running.add(s.id);
        else running.delete(s.id);
      }
    }
    if (moved) notify();
  });

  return {
    get projects() {
      return projects;
    },
    get assignments() {
      return assignments;
    },
    get known() {
      return known;
    },
    /** The current space: a project id, or null. */
    get chosen() {
      return space.current ?? null;
    },
    project,
    of,
    name,
    count,
    working,
    refresh,
    enter: (id) => space.enter(id && project(id) ? id : null),
    assign,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
}
