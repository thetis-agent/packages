/* The one model the place, the Files dock and the chat links share. It owns the caches (the roots per
 * session, one listing per folder), every request to the package's commands, what the explorer remembers
 * (which folders are open, whether dotfiles show, the filter, the selection, the explorer's width) and the
 * tabs with their unsaved buffers. Everything goes to the server through `ext.request(verb, { args,
 * session })`; a large file's bytes come through the raw route when the gateway has one (`ext.raw`), and
 * the model says so in a sentence when it does not. Storage is remembered, never required: every
 * localStorage and sessionStorage access is wrapped, and a browser without it just forgets.
 *
 * `watch(fn)` hands out `{ kind, path? }` events: `roots` (the roots were read again), `list` (a listing
 * changed or was dropped), `tabs` (a tab opened, closed, moved, or turned dirty), `selection`, `explorer`
 * (open folders, dotfiles, filter). A listener throwing never stops the others. */

/* Every stored key is scoped to the person: `thetis.workspace.<user>.<name>`, so two people on one browser
 * never see each other's open folders, tabs or unsaved text. The user id comes from the first `roots` answer;
 * until it is known the state lives in memory, and when it arrives the stored state is read once and merged
 * with what was done meanwhile. The old unscoped keys are never read. */
const PREFIX = "thetis.workspace.";
export const storageKey = (user, name) => (user ? `${PREFIX}${user}.${name}` : null);

/** Whether a key is one of the old unscoped ones (`thetis.workspace.expanded`, `.mode:<lang>`, `.buffer:<path>` …). */
export function isUnscopedKey(store, key) {
  if (typeof key !== "string" || !key.startsWith(PREFIX)) return false;
  const rest = key.slice(PREFIX.length);
  if (store === "session") return rest === "tabs" || rest.startsWith("buffer:");
  return rest === "expanded" || rest === "hidden" || rest === "explorer" || rest.startsWith("mode:");
}
const DEFAULT_WIDTH = 280;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

const local = () => (typeof localStorage === "undefined" ? null : localStorage);
const session = () => (typeof sessionStorage === "undefined" ? null : sessionStorage);

function readJSON(store, key, fallback) {
  if (!key) return fallback;
  try {
    const raw = store()?.getItem(key);
    return raw == null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function writeJSON(store, key, value) {
  if (!key) return;
  try {
    if (value === undefined) store()?.removeItem(key);
    else store()?.setItem(key, JSON.stringify(value));
  } catch {
    /* no storage: the model still works, it just forgets */
  }
}

function readText(store, key) {
  if (!key) return null;
  try {
    return store()?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function writeText(store, key, value) {
  if (!key) return;
  try {
    if (value == null) store()?.removeItem(key);
    else store()?.setItem(key, value);
  } catch {
    /* no storage */
  }
}

// ---- path helpers, pure ----

/** The parent of an absolute path, or null at the root. `~/x` keeps its `~`. */
export function parentOf(path) {
  if (typeof path !== "string" || !path) return null;
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  if (at < 0) return null;
  if (at === 0) return trimmed.length > 1 ? "/" : null;
  return trimmed.slice(0, at);
}

export function nameOf(path) {
  if (typeof path !== "string" || !path) return "";
  const trimmed = path.length > 1 ? path.replace(/\/+$/, "") : path;
  const at = trimmed.lastIndexOf("/");
  return at < 0 ? trimmed : trimmed.slice(at + 1) || trimmed;
}

export function joinPath(dir, name) {
  if (!dir || dir === "/") return `/${name}`;
  return `${dir.replace(/\/+$/, "")}/${name}`;
}

export function isWithin(path, base) {
  if (!path || !base) return false;
  if (path === base) return true;
  const prefix = base.endsWith("/") ? base : `${base}/`;
  return path.startsWith(prefix);
}

/**
 * The root a path sits under, from a `roots` answer: `{ kind: "home"|"shared"|"project", name, path,
 * mode, project? }`, the deepest one when several contain it; null when nothing does.
 */
export function rootOf(roots, path) {
  if (!roots || typeof path !== "string") return null;
  let best = null;
  const consider = (rec) => {
    if (rec?.path && isWithin(path, rec.path) && (!best || rec.path.length > best.path.length)) best = rec;
  };
  if (roots.home?.path) consider({ kind: "home", name: "Home", path: roots.home.path, mode: roots.home.mode ?? "rw" });
  if (roots.shared?.path) consider({ kind: "shared", name: "Shared", path: roots.shared.path, mode: roots.shared.mode ?? "ro" });
  for (const project of roots.projects ?? []) {
    for (const dir of project.directories ?? []) {
      if (dir?.state !== "ready" || !dir.path) continue;
      consider({ kind: "project", name: dir.name || nameOf(dir.path), path: dir.path, mode: dir.mode ?? "rw", project });
    }
  }
  return best;
}

/** `1.2 MB`, `640 KB`, `12 B`: the shape the rows and the confirms use. */
export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value < 10 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[i]}`;
}

// ---- the model ----

export function createModel(ext) {
  const watchers = new Set();
  const rootsCache = new Map(); // session key -> roots data
  const rootsPending = new Map(); // session key -> promise
  const listCache = new Map(); // `${hidden}:${path}` -> listing
  const listPending = new Map();

  function emit(event) {
    for (const fn of [...watchers]) {
      try {
        fn(event);
      } catch (err) {
        console.error("a workspace model listener threw:", err);
      }
    }
  }

  async function call(verb, args = {}, sess) {
    const out = await ext.request(verb, sess ? { args, session: sess } : { args });
    return out?.data ?? {};
  }

  // ---- explorer state (in memory until the user is known, then scoped storage) ----

  let user = null;
  const key = (name) => storageKey(user, name);
  const expanded = new Set();
  let hidden = false;
  let filter = "";
  let selected = null;
  let width = DEFAULT_WIDTH;
  const touched = { hidden: false, width: false }; // changed before the stored state was adopted

  const clampWidth = (px) => {
    const n = Number(px);
    return Number.isFinite(n) ? Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, Math.round(n))) : DEFAULT_WIDTH;
  };
  const rememberExpanded = () => writeJSON(local, key("expanded"), [...expanded]);

  const listKey = (path) => `${hidden ? "h" : "v"}:${path}`;

  // ---- tabs ----

  const memBuffers = new Map(); // path -> text, before the user is known
  const bufferKey = (path) => key(`buffer:${path}`);
  const getBuffer = (path) => (user ? readText(session, bufferKey(path)) : memBuffers.get(path) ?? null);
  const setBuffer = (path, text) => {
    if (!user) {
      if (text == null) memBuffers.delete(path);
      else memBuffers.set(path, text);
      return;
    }
    writeText(session, bufferKey(path), text);
  };

  const tabShape = (t) => ({
    path: t.path,
    name: t.name || nameOf(t.path),
    kind: t.kind === "editor" ? "editor" : "viewer",
    line: Number.isFinite(t.line) ? t.line : null,
    mode: t.mode ?? null,
    root: t.root ?? null,
    dirty: getBuffer(t.path) != null,
  });

  let tabs = [];
  let activePath = null;

  function rememberTabs() {
    writeJSON(session, key("tabs"), { active: activePath, list: tabs.map(({ path, name, kind, line, mode, root }) => ({ path, name, kind, line, mode, root })) });
  }

  /**
   * The first `roots` answer names the person: the state they stored earlier is read once and merged with
   * what was done in memory meanwhile (open folders are united, tabs are appended, a choice made here wins).
   */
  /** The keys of a Storage, read defensively (a blocked store answers nothing). */
  function keysOf(store) {
    try {
      const s = store();
      if (!s) return [];
      const out = [];
      for (let i = 0; i < s.length; i++) out.push(s.key(i));
      return out.filter((k) => typeof k === "string");
    } catch {
      return [];
    }
  }

  /** The old unscoped keys, from before storage was per person: never read, and dropped on the first run with a known user. */
  function purgeUnscoped() {
    const drop = (store, keep) => {
      for (const k of keysOf(store)) if (!keep(k)) writeText(store, k, null);
    };
    drop(local, (k) => !isUnscopedKey("local", k));
    drop(session, (k) => !isUnscopedKey("session", k));
  }

  function adopt(id) {
    if (user || typeof id !== "string" || !id) return;
    user = id;
    purgeUnscoped();
    const before = { expanded: expanded.size, hidden, width, tabs: tabs.length, active: activePath };
    for (const p of readJSON(local, key("expanded"), []) || []) if (typeof p === "string") expanded.add(p);
    if (!touched.hidden) hidden = Boolean(readJSON(local, key("hidden"), false));
    if (!touched.width) width = clampWidth(readJSON(local, key("explorer"), DEFAULT_WIDTH));
    for (const [path, text] of memBuffers) setBuffer(path, text);
    memBuffers.clear();
    const stored = readJSON(session, key("tabs"), null);
    const storedTabs = (stored?.list ?? []).filter((t) => t && typeof t.path === "string").map(tabShape);
    const mine = tabs.map(tabShape);
    tabs = [...storedTabs, ...mine.filter((t) => !storedTabs.some((s) => s.path === t.path))];
    activePath = activePath ?? stored?.active ?? null;
    if (activePath && !tabs.some((t) => t.path === activePath)) activePath = tabs[0]?.path ?? null;
    rememberExpanded();
    writeJSON(local, key("hidden"), hidden);
    writeJSON(local, key("explorer"), width);
    rememberTabs();
    if (expanded.size !== before.expanded || hidden !== before.hidden || width !== before.width) emit({ kind: "explorer", path: null });
    if (tabs.length !== before.tabs || activePath !== before.active || tabs.some((t) => t.dirty)) emit({ kind: "tabs", path: null });
  }

  const tabOf = (path) => tabs.find((t) => t.path === path) ?? null;

  const tabsApi = Object.freeze({
    list: () => tabs.map((t) => ({ ...t })),
    active: () => (activePath ? { ...tabOf(activePath) } : null),
    open(path, { line, activate = true, name, kind, mode, root } = {}) {
      let tab = tabOf(path);
      if (!tab) {
        tab = { path, name: name || nameOf(path), kind: kind === "editor" ? "editor" : "viewer", line: null, mode: mode ?? null, root: root ?? null, dirty: getBuffer(path) != null };
        tabs = [...tabs, tab];
      } else {
        if (name) tab.name = name;
        if (kind) tab.kind = kind === "editor" ? "editor" : "viewer";
        if (mode) tab.mode = mode;
        if (root) tab.root = root;
      }
      if (Number.isFinite(line)) tab.line = line;
      if (activate) activePath = path;
      rememberTabs();
      emit({ kind: "tabs", path });
      return { ...tab };
    },
    close(path) {
      const at = tabs.findIndex((t) => t.path === path);
      if (at < 0) return;
      tabs = tabs.filter((t) => t.path !== path);
      setBuffer(path, null);
      if (activePath === path) activePath = (tabs[at] ?? tabs[at - 1])?.path ?? null;
      rememberTabs();
      emit({ kind: "tabs", path });
    },
    activate(path) {
      if (!tabOf(path) || activePath === path) return;
      activePath = path;
      rememberTabs();
      emit({ kind: "tabs", path });
    },
    markDirty(path, dirty) {
      const tab = tabOf(path);
      if (!tab || tab.dirty === Boolean(dirty)) return;
      tab.dirty = Boolean(dirty);
      if (!tab.dirty) setBuffer(path, null);
      emit({ kind: "tabs", path });
    },
    /** Changes what a tab knows (`kind`, `mode`, `root`, `name`, `line`) once a `stat` has answered. */
    update(path, patch = {}) {
      const tab = tabOf(path);
      if (!tab) return;
      for (const key of ["kind", "mode", "root", "name", "line"]) if (patch[key] !== undefined) tab[key] = patch[key];
      rememberTabs();
      emit({ kind: "tabs", path });
    },
    /** A renamed or moved path: the tab (and every tab under a moved folder) follows it, buffer included. */
    rename(from, to) {
      let changed = false;
      for (const tab of tabs) {
        if (!isWithin(tab.path, from)) continue;
        const next = tab.path === from ? to : `${to}${tab.path.slice(from.length)}`;
        const buffer = getBuffer(tab.path);
        setBuffer(tab.path, null);
        if (buffer != null) setBuffer(next, buffer);
        if (activePath === tab.path) activePath = next;
        tab.path = next;
        tab.name = nameOf(next);
        changed = true;
      }
      if (changed) {
        rememberTabs();
        emit({ kind: "tabs", path: to });
      }
    },
    /** Every tab at or under `path` goes, buffers included. */
    closeUnder(path) {
      const gone = tabs.filter((t) => isWithin(t.path, path));
      if (!gone.length) return;
      for (const t of gone) setBuffer(t.path, null);
      tabs = tabs.filter((t) => !isWithin(t.path, path));
      if (activePath && gone.some((t) => t.path === activePath)) activePath = tabs[0]?.path ?? null;
      rememberTabs();
      emit({ kind: "tabs", path });
    },
    /** The unsaved text of a tab, kept in this browser session until it is saved or reverted. */
    buffer: (path) => getBuffer(path),
    setBuffer(path, text) {
      setBuffer(path, text);
      const tab = tabOf(path);
      if (tab && tab.dirty !== (text != null)) {
        tab.dirty = text != null;
        emit({ kind: "tabs", path });
      }
    },
  });

  // ---- requests ----

  const model = {
    /** The roots for a session, cached until `force`. A `roots` event follows every fresh answer. */
    async roots({ session: sess, force = false } = {}) {
      const cacheKey = sess || "";
      if (!force && rootsCache.has(cacheKey)) return rootsCache.get(cacheKey);
      if (rootsPending.has(cacheKey)) return rootsPending.get(cacheKey);
      const pending = call("roots", sess ? { session: sess } : {}, sess)
        .then((data) => {
          adopt(data?.user);
          rootsCache.set(cacheKey, data);
          emit({ kind: "roots", session: sess ?? null });
          return data;
        })
        .finally(() => rootsPending.delete(cacheKey));
      rootsPending.set(cacheKey, pending);
      return pending;
    },
    /** The roots already read for a session, without asking; null before the first answer. */
    rootsCached: (sess) => rootsCache.get(sess || "") ?? null,
    /** The person the roots named, or null before the first answer. Storage is scoped by it. */
    get user() {
      return user;
    },

    /** A folder's listing, cached per dotfile setting until `force` or `invalidate`. */
    async list(path, { force = false } = {}) {
      const lk = listKey(path);
      if (!force && listCache.has(lk)) return listCache.get(lk);
      if (listPending.has(lk)) return listPending.get(lk);
      const wantHidden = hidden;
      const pending = call("list", wantHidden ? { path, hidden: true } : { path })
        .then((data) => {
          listCache.set(`${wantHidden ? "h" : "v"}:${path}`, data);
          emit({ kind: "list", path });
          return data;
        })
        .finally(() => listPending.delete(lk));
      listPending.set(lk, pending);
      return pending;
    },
    /** The cached listing of a folder for the current dotfile setting, or null. */
    listing: (path) => listCache.get(listKey(path)) ?? null,
    invalidate(path) {
      if (path == null) return;
      listCache.delete(`h:${path}`);
      listCache.delete(`v:${path}`);
      emit({ kind: "list", path });
    },
    invalidateAll() {
      listCache.clear();
      emit({ kind: "list", path: null });
    },

    stat: (path) => call("stat", { path }),

    /**
     * The text of a file with its etag. Small files come inline in the JSON answer; a larger one is
     * fetched from the raw route when the gateway has one, and refused in a sentence when it does not.
     */
    async readText(path, { part } = {}) {
      const data = await call("read", part ? { path, part } : { path });
      if (data.inline && typeof data.text === "string") return data;
      if (typeof ext.raw?.url !== "function") {
        throw new Error(`${nameOf(path)} is ${formatBytes(data.size ?? 0)}, over the 200 KB that comes inline, and reading it needs the raw route, which is not available in this gateway version.`);
      }
      const res = await fetch(ext.raw.url("raw", part ? { path, part } : { path }), { credentials: "same-origin" });
      if (!res.ok) throw new Error(`${nameOf(path)} could not be read: the gateway answered ${res.status}.`);
      const text = await res.text();
      return { ...data, text, etag: res.headers.get("etag") || data.etag, inline: false };
    },

    async write(path, text, { etag, force = false } = {}) {
      const args = { path, text };
      if (etag) args.etag = etag;
      if (force) args.force = true;
      const out = await call("write", args);
      if (out.ok) {
        setBuffer(path, null);
        const tab = tabOf(path);
        if (tab && tab.dirty) {
          tab.dirty = false;
          emit({ kind: "tabs", path });
        }
        model.invalidate(parentOf(path));
        // A relative path (a Copy to Home target) resolves against home on the server, which names the file;
        // the write may have made every directory on the way, so each ancestor's listing is dropped up to the
        // root, and the tree re-lists the open ones.
        if (typeof out.path === "string" && out.path !== path) for (let p = parentOf(out.path); p; p = parentOf(p)) model.invalidate(p);
      }
      return out;
    },

    async mkdir(path) {
      const out = await call("mkdir", { path });
      model.invalidate(parentOf(path));
      return out;
    },

    async rename(path, name) {
      const out = await call("rename", { path, name });
      const next = out.path ?? joinPath(parentOf(path), name);
      tabsApi.rename(path, next);
      if (selected === path) selected = next;
      if (expanded.has(path)) {
        for (const p of [...expanded]) {
          if (!isWithin(p, path)) continue;
          expanded.delete(p);
          expanded.add(p === path ? next : `${next}${p.slice(path.length)}`);
        }
        rememberExpanded();
      }
      for (const k of [...listCache.keys()]) if (isWithin(k.slice(2), path)) listCache.delete(k);
      model.invalidate(parentOf(path));
      return { ...out, path: next };
    },

    async remove(path, { dryRun = false } = {}) {
      const out = await call("delete", dryRun ? { path, dryRun: true } : { path });
      if (!dryRun) {
        tabsApi.closeUnder(path);
        if (selected && isWithin(selected, path)) selected = parentOf(path);
        for (const p of [...expanded]) if (isWithin(p, path)) expanded.delete(p);
        rememberExpanded();
        for (const k of [...listCache.keys()]) if (isWithin(k.slice(2), path)) listCache.delete(k);
        model.invalidate(parentOf(path));
      }
      return out;
    },

    count: (path) => call("count", { path }),

    async resolve(paths, { session: sess } = {}) {
      const list = [...new Set((Array.isArray(paths) ? paths : [paths]).filter((p) => typeof p === "string" && p))].slice(0, 64);
      if (!list.length) return {};
      const out = await call("resolve", sess ? { paths: list, session: sess } : { paths: list }, sess);
      return out.results ?? {};
    },

    async bind(path, mode = "rw") {
      const out = await call("bind", { path, mode });
      rootsCache.clear();
      emit({ kind: "roots", session: null });
      return out;
    },

    // ---- explorer state ----

    expanded,
    isExpanded: (path) => expanded.has(path),
    setExpanded(path, on, { silent = false } = {}) {
      if (!path) return;
      const had = expanded.has(path);
      if (on) expanded.add(path);
      else expanded.delete(path);
      if (had === Boolean(on)) return;
      rememberExpanded();
      if (!silent) emit({ kind: "explorer", path });
    },
    toggleExpanded(path) {
      model.setExpanded(path, !expanded.has(path));
      return expanded.has(path);
    },
    collapseAll() {
      if (!expanded.size) return;
      expanded.clear();
      rememberExpanded();
      emit({ kind: "explorer", path: null });
    },

    get hidden() {
      return hidden;
    },
    setHidden(on) {
      if (hidden === Boolean(on)) return;
      hidden = Boolean(on);
      touched.hidden = true;
      writeJSON(local, key("hidden"), hidden);
      emit({ kind: "explorer", path: null });
    },

    get filter() {
      return filter;
    },
    setFilter(text) {
      const next = String(text ?? "");
      if (next === filter) return;
      filter = next;
      emit({ kind: "explorer", path: null });
    },

    get selected() {
      return selected;
    },
    select(path) {
      const next = path ?? null;
      if (next === selected) return;
      selected = next;
      emit({ kind: "selection", path: next });
    },

    get explorerWidth() {
      return width;
    },
    setExplorerWidth(px) {
      const next = clampWidth(Number(px) || DEFAULT_WIDTH);
      if (next === width) return;
      width = next;
      touched.width = true;
      writeJSON(local, key("explorer"), width);
    },
    explorerWidthRange: Object.freeze({ min: MIN_WIDTH, max: MAX_WIDTH, default: DEFAULT_WIDTH }),

    tabs: tabsApi,

    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },

    /** Whether the gateway has the raw route this build needs for uploads, downloads and large files. */
    get hasRaw() {
      return typeof ext.raw?.url === "function";
    },
    RAW_MISSING: "This needs the raw file route, which is not available in this gateway version.",
  };

  return model;
}
