/* What the page holds about projects: the list from `list`, the session-to-project map, and the chosen
 * project, remembered in localStorage under `thetis.project` (wrapped in try/catch: storage may be
 * missing or blocked). Choosing a project narrows the sidebar through `ext.sessions.filter`; the filter
 * reads the live map, so a new assignment shows as soon as the filter is set again. While a project is
 * chosen, a conversation the page has not seen before, created just now, is assigned to it with one
 * `assign` request, so a `+` while a project is open starts a conversation in that project. Watchers
 * are told after every change; the switcher and the place redraw from here. */

const KEY = "thetis.project";
/** A session counts as new only when it was created this recently; the first snapshot is never assigned. */
const FRESH_MS = 120_000;

function restore() {
  try {
    return localStorage.getItem(KEY) || null;
  } catch {
    return null;
  }
}

function remember(id) {
  try {
    if (id) localStorage.setItem(KEY, id);
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: the choice lasts the page */
  }
}

export function createState(ext) {
  let projects = []; // [{ id, name, directories, conversations }]
  let assignments = {}; // session id -> project id
  let chosen = restore();
  const watchers = new Set();
  const seen = new Set((ext.sessions.list() ?? []).map((s) => s.id));

  const notify = () => {
    for (const fn of watchers) {
      try {
        fn();
      } catch (err) {
        console.error("a project watcher threw:", err);
      }
    }
  };

  function applyFilter() {
    ext.sessions.filter(chosen ? (s) => assignments[s.id] === chosen : null);
  }

  /** Reads the list again. Errors go to the console: the switcher shows what it last knew. */
  async function refresh() {
    try {
      const out = await ext.request("list", { session: ext.conversation.current ?? undefined });
      projects = Array.isArray(out?.data?.projects) ? out.data.projects : [];
      assignments = out?.data?.assignments && typeof out.data.assignments === "object" ? out.data.assignments : {};
      if (chosen && !projects.some((p) => p.id === chosen)) chosen = null;
    } catch (err) {
      console.error("projects: the list could not be read:", err);
    }
    applyFilter();
    notify();
  }

  function choose(id) {
    chosen = id && projects.some((p) => p.id === id) ? id : null;
    remember(chosen);
    applyFilter();
    notify();
  }

  /** Puts one conversation in a project (or none). The map is updated first so the sidebar keeps the row. */
  async function assign(session, project) {
    const before = assignments[session];
    if (project) assignments[session] = project;
    else delete assignments[session];
    applyFilter();
    try {
      await ext.request("assign", { session, args: { session, project } });
      const target = projects.find((p) => p.id === project);
      if (target) target.conversations += 1;
      const source = projects.find((p) => p.id === before);
      if (source && before !== project) source.conversations = Math.max(0, source.conversations - 1);
      notify();
    } catch (err) {
      if (before) assignments[session] = before;
      else delete assignments[session];
      applyFilter();
      ext.toast(err?.message || "The conversation could not join the project.", { tone: "error" });
    }
  }

  const isFresh = (s) => !s.createdAt || Date.now() - Date.parse(s.createdAt) < FRESH_MS;

  ext.sessions.watch((list) => {
    for (const s of list ?? []) {
      if (seen.has(s.id)) continue;
      seen.add(s.id);
      if (chosen && !assignments[s.id] && isFresh(s)) assign(s.id, chosen);
    }
  });

  return {
    get projects() {
      return projects;
    },
    get assignments() {
      return assignments;
    },
    get chosen() {
      return chosen;
    },
    project: (id) => projects.find((p) => p.id === id) ?? null,
    refresh,
    choose,
    assign,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
  };
}
