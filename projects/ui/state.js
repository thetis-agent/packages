/* What the page holds about projects: the list from `list`, the session-to-project map, and the chosen
 * project, remembered in localStorage under `thetis.project` (wrapped in try/catch: storage may be
 * missing or blocked). Choosing a project narrows the sidebar through `ext.sessions.filter`; the filter
 * reads the live map, so a new assignment shows as soon as the filter is set again. The shell's local
 * creation event assigns a conversation to the chosen project before opening or sending to it. A list
 * update may come from another browser tab, so it never assigns anything. Watchers are told after every
 * change; the switcher and the place redraw from here. */

const KEY = "thetis.project";
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
  let known = false;
  let reading = null;
  let revision = 0;
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

  function applyFilter() {
    ext.sessions.filter(chosen ? (s) => assignments[s.id] === chosen : null);
  }

  /** Reads the list again. Errors go to the console: the switcher shows what it last knew. */
  function refresh() {
    if (!reading) reading = readList().finally(() => { reading = null; });
    return reading;
  }

  async function readList() {
    const startedAt = revision;
    try {
      const out = await ext.request("list", { session: ext.conversation.current ?? undefined });
      if (startedAt !== revision) return;
      projects = Array.isArray(out?.data?.projects) ? out.data.projects : [];
      assignments = out?.data?.assignments && typeof out.data.assignments === "object" ? out.data.assignments : {};
      if (chosen && !projects.some((p) => p.id === chosen)) {
        chosen = null;
        remember(null);
      }
      known = true;
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
    revision += 1;
    if (project) assignments[session] = project;
    else delete assignments[session];
    applyFilter();
    try {
      await ext.request("assign", { session, args: { session, project } });
      revision += 1;
      // A list fetched while the write was pending may have read the previous server map.
      if (project) assignments[session] = project;
      else delete assignments[session];
      for (const item of projects) item.conversations = Object.values(assignments).filter((id) => id === item.id).length;
      applyFilter();
      notify();
    } catch (err) {
      revision += 1;
      if (before) assignments[session] = before;
      else delete assignments[session];
      applyFilter();
      throw err;
    }
  }

  ext.sessions.onCreate(async (session) => {
    const project = chosen;
    if (!project) return;
    if (!known) await refresh();
    if (!known) throw new Error("The projects could not be read for this conversation.");
    if (project && projects.some((p) => p.id === project)) await assign(session, project);
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
