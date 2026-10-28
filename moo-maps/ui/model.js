/* What the page holds about maps: the list, kept live by one `watch` subscription for the whole page (the
 * sidebar and every open map tab read from it), and the calls. The subscription reopens with a backoff
 * when it drops, and each reopening's snapshot resyncs the list. A save from this page records the
 * revision it produced, so a `changed` event carrying it is known as this page's own echo. */

const RETRY_MAX_MS = 15_000;

export function createModel(ext) {
  let maps = [];
  let status = "connecting";
  let active = null;
  let stop = null;
  let timer = null;
  let retries = 0;
  let closed = false;
  const watchers = new Set();
  const perMap = new Map();
  const ownRevs = new Map();

  const safe = (fn, arg) => {
    try {
      fn(arg);
    } catch (err) {
      console.error("moo-maps: a watcher threw:", err);
    }
  };
  const notify = () => watchers.forEach((fn) => safe(fn));
  const tell = (id, event) => (perMap.get(id) ?? []).forEach((fn) => safe(fn, event));
  const sort = () => maps.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)) || String(a.title).localeCompare(String(b.title)));
  const isOwn = (id, rev) => ownRevs.get(id)?.has(rev) ?? false;

  function onEvent(event) {
    if (!event || typeof event !== "object") return;
    if (event.ev === "snapshot") {
      maps = Array.isArray(event.maps) ? [...event.maps] : [];
      sort();
      retries = 0;
      status = "live";
      notify();
      for (const row of maps) tell(row.id, { kind: "snapshot", row, rev: row.rev });
    } else if (event.ev === "changed" && event.row) {
      const at = maps.findIndex((m) => m.id === event.map);
      if (at >= 0) maps[at] = event.row;
      else maps.push(event.row);
      sort();
      notify();
      tell(event.map, { kind: "changed", rev: event.rev, by: event.by, what: event.what, own: isOwn(event.map, event.rev), row: event.row });
    } else if (event.ev === "removed") {
      maps = maps.filter((m) => m.id !== event.map);
      notify();
      tell(event.map, { kind: "removed" });
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
          if (err) console.warn("moo-maps: the watch ended:", err.message);
          notify();
          timer = setTimeout(open, Math.min(RETRY_MAX_MS, 1000 * 2 ** retries++));
        },
      });
    } catch (err) {
      status = "lost";
      console.error("moo-maps: the watch could not open:", err);
      notify();
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

  async function refresh() {
    try {
      maps = (await data("list")).maps ?? [];
      sort();
      notify();
    } catch (err) {
      console.error("moo-maps: the list could not be read:", err);
    }
  }

  return {
    get maps() {
      return maps;
    },
    get status() {
      return status;
    },
    get active() {
      return active;
    },
    row: (id) => maps.find((m) => m.id === id) ?? null,
    isOwn,
    refresh,
    watch(fn) {
      watchers.add(fn);
      return () => watchers.delete(fn);
    },
    onMap(id, fn) {
      if (!perMap.has(id)) perMap.set(id, new Set());
      perMap.get(id).add(fn);
      return () => perMap.get(id)?.delete(fn);
    },
    setActive(id) {
      if (active === id) return;
      active = id;
      notify();
    },
    /** The map's document whole, through the raw seam: a big map is more than a JSON answer may carry. */
    async doc(id) {
      const res = await fetch(ext.raw.url("doc", { map: id }), { cache: "no-store", credentials: "same-origin" });
      let body = null;
      try {
        body = await res.json();
      } catch {
        body = null;
      }
      if (!res.ok) throw new Error(body?.error || `the map could not be read (${res.status})`);
      return body;
    },
    async save(id, patch, base) {
      const blob = new Blob([JSON.stringify(patch)], { type: "application/json" });
      const out = (await ext.raw.put("save", { map: id, base }, blob))?.data ?? {};
      remember(id, out.rev);
      return out;
    },
    async create(name) {
      const { map } = await data("create", { name });
      if (map && !maps.some((m) => m.id === map.id)) {
        maps.push(map);
        sort();
        notify();
      }
      return map;
    },
    rename: async (id, name) => {
      const out = await data("rename", { map: id, name });
      remember(id, out.rev);
      return out;
    },
    remove: (id) => data("remove", { map: id }),
    focus: (id, focus) => data("focus", { map: id, focus }).catch(() => {}),
    start() {
      open();
      void refresh();
    },
    stop() {
      closed = true;
      clearTimeout(timer);
      stop?.();
      stop = null;
    },
  };
}
