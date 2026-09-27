/* What the page holds about canvases: the list, kept live through one `watch` subscription for the whole
 * page (the sidebar and every open tab read from it), the project the person chose, and the calls. The
 * subscription is reopened with a backoff when it drops, and each reopening's snapshot resyncs the list.
 * Echoes are told apart by revision: a save from this page records the revision it produced, and a
 * `changed` event with that revision is this page's own (`own: true`), so a tab does not re-read a layout
 * it just wrote. The chosen project is `@thetis/projects`' own, read from the key it keeps in localStorage
 * (`thetis.project`) — a coupling in one function, watched by the storage event and a slow poll, and
 * swapped for a shell seam in one place when there is one. */

const PROJECT_KEY = "thetis.project";
const POLL_MS = 1000;
const RETRY_MAX_MS = 15_000;

export function createModel(ext) {
  let canvases = []; // rows as `list` and the watcher's snapshot answer them
  let projects = []; // [{ id, name }]
  let status = "connecting"; // connecting | live | lost
  let active = null; // the canvas on screen, told by its tab
  let stop = null;
  let timer = null;
  let poll = null;
  let retries = 0;
  let closed = false;
  const watchers = new Set();
  const perCanvas = new Map(); // id -> Set of fn(event)
  const ownRevs = new Map(); // id -> the revision this page last wrote

  const notify = () => {
    for (const fn of watchers) {
      try {
        fn();
      } catch (err) {
        console.error("a canvases watcher threw:", err);
      }
    }
  };
  const tell = (id, event) => {
    for (const fn of perCanvas.get(id) ?? []) {
      try {
        fn(event);
      } catch (err) {
        console.error("a canvas watcher threw:", err);
      }
    }
  };
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? null;
  const sortRows = () => canvases.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.title).localeCompare(String(b.title)));

  function onEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.ev === "snapshot") {
      canvases = Array.isArray(event.canvases) ? event.canvases : [];
      projects = Array.isArray(event.projects) ? event.projects : [];
      sortRows();
      retries = 0;
      status = "live";
      notify();
      for (const row of canvases) tell(row.id, { kind: "snapshot", row });
    } else if (event.ev === "changed" && typeof event.canvas === "string") {
      const project = typeof event.project === "string" ? event.project : null;
      const row = { id: event.canvas, title: String(event.title ?? ""), project, projectName: project ? nameOf(project) : null, projectMissing: Boolean(project) && !projects.some((p) => p.id === project), boards: Object.keys(event.files ?? {}).length, updatedAt: String(event.updatedAt ?? ""), rev: Number(event.rev) || 0 };
      const at = canvases.findIndex((c) => c.id === row.id);
      if (at >= 0) canvases[at] = row;
      else canvases.push(row);
      sortRows();
      notify();
      tell(row.id, { kind: "changed", rev: row.rev, files: event.files ?? {}, assets: Array.isArray(event.assets) ? event.assets : [], own: ownRevs.get(row.id) === row.rev, row });
    } else if (event.ev === "removed" && typeof event.canvas === "string") {
      canvases = canvases.filter((c) => c.id !== event.canvas);
      notify();
      tell(event.canvas, { kind: "removed" });
    }
  }

  function open() {
    if (closed || stop) return;
    status = "connecting";
    try {
      stop = ext.subscribe("watch", {
        onEvent,
        onClose: (err) => {
          stop = null;
          if (closed) return;
          status = "lost";
          if (err) console.warn("canvases: the watch ended:", err.message);
          notify();
          timer = setTimeout(open, Math.min(RETRY_MAX_MS, 1000 * 2 ** retries++));
        },
      });
    } catch (err) {
      status = "lost";
      console.error("canvases: the watch could not open:", err);
      notify();
    }
  }

  /** The project the sidebar's switcher chose, as `@thetis/projects` keeps it; null for all. */
  function project() {
    try {
      return localStorage.getItem(PROJECT_KEY) || null;
    } catch {
      return null;
    }
  }
  let lastProject = project();
  const onStorage = (event) => {
    if (event.key !== PROJECT_KEY && event.key !== null) return;
    lastProject = project();
    notify();
  };

  async function refresh() {
    try {
      const out = await ext.request("list");
      canvases = Array.isArray(out?.data?.canvases) ? out.data.canvases : [];
      projects = Array.isArray(out?.data?.projects) ? out.data.projects : [];
      sortRows();
      notify();
    } catch (err) {
      console.error("canvases: the list could not be read:", err);
    }
  }

  const data = async (verb, args) => (await ext.request(verb, { args })).data ?? {};

  return {
    get canvases() {
      return canvases;
    },
    get projects() {
      return projects;
    },
    get status() {
      return status;
    },
    get active() {
      return active;
    },
    project,
    projectName: nameOf,
    row: (id) => canvases.find((c) => c.id === id) ?? null,
    refresh,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    onCanvas(id, fn) {
      if (!perCanvas.has(id)) perCanvas.set(id, new Set());
      perCanvas.get(id).add(fn);
      return () => perCanvas.get(id)?.delete(fn);
    },
    /** A tab says which canvas is on screen (null when none), so the sidebar can mark its row. */
    setActive(id) {
      if (active === id) return;
      active = id;
      notify();
    },
    async create({ title } = {}) {
      const { canvas } = await data("create", { title: title ?? "Untitled canvas", project: project() });
      if (canvas && !canvases.some((c) => c.id === canvas.id)) {
        canvases.push({ id: canvas.id, title: canvas.title, project: canvas.project, projectName: canvas.project ? nameOf(canvas.project) : null, projectMissing: false, boards: 0, updatedAt: canvas.updatedAt, rev: canvas.rev });
        sortRows();
        notify();
      }
      return canvas;
    },
    get: (id) => data("get", { id }),
    async save(id, patch, base) {
      const out = await data("save", { id, patch, ...(base !== undefined ? { base } : {}) });
      if (typeof out.rev === "number") ownRevs.set(id, out.rev);
      return out;
    },
    rename: (id, title) => data("save", { id, patch: { title } }),
    assign: (id, project) => data("assign", { id, project }),
    remove: (id, board) => data("remove", { id, ...(board ? { board } : {}) }),
    start() {
      open();
      void refresh();
      window.addEventListener("storage", onStorage);
      poll = setInterval(() => {
        const now = project();
        if (now !== lastProject) {
          lastProject = now;
          notify();
        }
      }, POLL_MS);
    },
    stop() {
      closed = true;
      clearTimeout(timer);
      clearInterval(poll);
      window.removeEventListener("storage", onStorage);
      stop?.();
      stop = null;
    },
  };
}
