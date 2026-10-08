/* What the page holds about sheets: the list, kept live through one `watch` subscription for the whole page
 * (the sidebar and every open tab read from it), the project the person chose, and the calls. The
 * subscription is reopened with a backoff when it drops, and each reopening's snapshot resyncs the list.
 * Echoes are told apart by revision: a save from this page records the revision it produced, and a
 * `changed` event with that revision is this page's own (`own: true`), so a tab does not re-read a sheet it
 * just wrote. The chosen project is `@thetis/projects`' own, read from the key it keeps in localStorage
 * (`thetis.project`) — a coupling in one function, watched by the storage event and a slow poll, and
 * swapped for a shell seam in one place when there is one. */

const PROJECT_KEY = "thetis.project";
const POLL_MS = 1000;
const RETRY_MAX_MS = 15_000;

export function createModel(ext) {
  let sheets = []; // Summary rows as `list` and the watcher's snapshot answer them
  let projects = []; // [{ id, name }]
  let status = "connecting"; // connecting | live | lost
  let active = null; // the sheet on screen, told by its tab
  let stop = null;
  let timer = null;
  let poll = null;
  let retries = 0;
  let closed = false;
  const watchers = new Set();
  const perSheet = new Map(); // id -> Set of fn(event)
  const ownRevs = new Map(); // id -> Set of the revisions this page wrote

  const notify = () => {
    for (const fn of watchers) {
      try {
        fn();
      } catch (err) {
        console.error("a sheets watcher threw:", err);
      }
    }
  };
  const tell = (id, event) => {
    for (const fn of perSheet.get(id) ?? []) {
      try {
        fn(event);
      } catch (err) {
        console.error("a sheet watcher threw:", err);
      }
    }
  };
  const nameOf = (id) => projects.find((p) => p.id === id)?.name ?? null;
  const sortRows = () => sheets.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.title).localeCompare(String(b.title)));
  const isOwn = (id, rev) => ownRevs.get(id)?.has(rev) ?? false;

  function onEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.ev === "snapshot") {
      sheets = Array.isArray(event.sheets) ? [...event.sheets] : [];
      projects = Array.isArray(event.projects) ? event.projects : [];
      sortRows();
      retries = 0;
      status = "live";
      notify();
      for (const row of sheets) tell(row.id, { kind: "snapshot", row, rev: Number(row.rev) || 0 });
    } else if (event.ev === "changed" && typeof event.sheet === "string") {
      const project = typeof event.project === "string" ? event.project : null;
      const row = {
        id: event.sheet,
        title: String(event.title ?? ""),
        project,
        projectName: project ? nameOf(project) : null,
        projectMissing: Boolean(project) && !projects.some((p) => p.id === project),
        tabs: Number(event.tabs) || 0,
        cells: Number(event.cells) || 0,
        updatedAt: String(event.updatedAt ?? ""),
        rev: Number(event.rev) || 0,
      };
      const at = sheets.findIndex((s) => s.id === row.id);
      if (at >= 0) sheets[at] = row;
      else sheets.push(row);
      sortRows();
      notify();
      tell(row.id, { kind: "changed", rev: row.rev, by: event.by ?? null, session: event.session ?? null, own: isOwn(row.id, row.rev), row });
    } else if (event.ev === "removed" && typeof event.sheet === "string") {
      sheets = sheets.filter((s) => s.id !== event.sheet);
      notify();
      tell(event.sheet, { kind: "removed" });
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
          if (err) console.warn("sheets: the watch ended:", err.message);
          notify();
          timer = setTimeout(open, Math.min(RETRY_MAX_MS, 1000 * 2 ** retries++));
        },
      });
    } catch (err) {
      status = "lost";
      console.error("sheets: the watch could not open:", err);
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
      sheets = Array.isArray(out?.data?.sheets) ? [...out.data.sheets] : [];
      projects = Array.isArray(out?.data?.projects) ? out.data.projects : [];
      sortRows();
      notify();
    } catch (err) {
      console.error("sheets: the list could not be read:", err);
    }
  }

  const data = async (verb, args) => (await ext.request(verb, { args })).data ?? {};
  const remember = (id, rev) => {
    if (typeof rev !== "number") return;
    if (!ownRevs.has(id)) ownRevs.set(id, new Set());
    const set = ownRevs.get(id);
    set.add(rev);
    if (set.size > 64) set.delete(set.values().next().value);
  };

  return {
    get sheets() {
      return sheets;
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
    row: (id) => sheets.find((s) => s.id === id) ?? null,
    refresh,
    isOwn,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    onSheet(id, fn) {
      if (!perSheet.has(id)) perSheet.set(id, new Set());
      perSheet.get(id).add(fn);
      return () => perSheet.get(id)?.delete(fn);
    },
    /** A tab says which sheet is on screen (null when none), so the sidebar can mark its row. */
    setActive(id) {
      if (active === id) return;
      active = id;
      notify();
    },
    async create({ title } = {}) {
      const { sheet } = await data("create", { title: title ?? "Untitled sheet", project: project() });
      if (sheet && !sheets.some((s) => s.id === sheet.id)) {
        sheets.push({ projectName: sheet.project ? nameOf(sheet.project) : null, projectMissing: false, tabs: 1, cells: 0, ...sheet });
        sortRows();
        notify();
      }
      return sheet;
    },
    /**
     * One workbook whole. Through the raw export (`format: "json"`) when the gateway has the raw seam,
     * because a JSON command's answer is capped at 256 KiB and a large sheet is more; else `get`.
     */
    async get(id) {
      if (!ext.raw?.url) return data("get", { id });
      const res = await fetch(ext.raw.url("export", { id, format: "json" }), { cache: "no-store", credentials: "same-origin" });
      if (!res.ok) {
        let message = null;
        try {
          message = (await res.json())?.error ?? null;
        } catch {
          /* not JSON: say what is known */
        }
        throw new Error(message || `the sheet could not be read (${res.status})`);
      }
      return { sheet: await res.json() };
    },
    /** Sends ops; the answered revision is recorded as this page's own before the answer is handed back. */
    async save(id, ops, base) {
      const out = await data("save", { id, ops, ...(typeof base === "number" ? { base } : {}) });
      remember(id, out.rev);
      return out;
    },
    rename: async (id, title) => {
      const out = await data("save", { id, ops: [{ op: "title", title }] });
      remember(id, out.rev);
      return out;
    },
    assign: async (id, project) => {
      const out = await data("assign", { id, project });
      remember(id, out.rev);
      return out;
    },
    remove: (id) => data("remove", { id }),
    /** The download route of one tab, or null when this gateway has no raw seam. */
    exportUrl: (id, tab, format = "csv") => (ext.raw?.url ? ext.raw.url("export", { id, ...(tab ? { tab } : {}), format }) : null),
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
