/* The space the person is in: one current project that the sidebar list, the tab strip and the draft
 * follow. The shell knows nothing of projects; one package provides the map (`of`: which space a session
 * is in) and the names, and the shell draws by them. With no provider there is one space, `null`, and
 * everything is in it. The current space is kept in localStorage "thetis.space", so a reload comes back to
 * it; it reads as `null` until a provider exists, since a space nobody can name holds nothing.
 *
 * `of(id)` answers a space id, `null` (in no project) or `undefined` (not known yet): an unknown row is
 * hidden until it is known, and an open tab stays where it is. `changed()` is the provider's word that the
 * map or the names moved; the views re-place their tabs and rows on it.
 *
 * The sidebar's groups live here too: `groups` holds what packages claimed through `ext.sessions.group`,
 * the rows of a space drawn as a folder of their own. */

const KEY = "thetis.space";

let provider = null; // { of, name }
let stored = read();
const watchers = new Set(); // fn(spaceId) after the current space changed
const changeWatchers = new Set(); // fn() after the provider's map or names changed, or the provider came or went

function read() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    return typeof raw === "string" && raw ? raw : null;
  } catch {
    return null;
  }
}

function write(id) {
  try {
    if (id) globalThis.localStorage?.setItem(KEY, id);
    else globalThis.localStorage?.removeItem(KEY);
  } catch {
    /* no storage: the space lasts the page */
  }
}

const effective = () => (provider ? stored : null);

function tell(set, ...args) {
  for (const fn of [...set]) {
    try {
      fn(...args);
    } catch (err) {
      console.error("a space watcher threw:", err);
    }
  }
}

/** Runs `fn` and tells the watchers when the current space it leaves behind is a different one. */
function around(fn) {
  const before = effective();
  fn();
  const after = effective();
  if (after !== before) tell(watchers, after);
}

export const space = {
  /** One provider per page: the first wins. Answers the function that withdraws it. */
  provide({ of, name } = {}) {
    if (provider) {
      console.error("a second space provider was refused: the first one stays");
      return () => {};
    }
    if (typeof of !== "function") throw new Error("ext.space.provide needs an `of(sessionId)` function.");
    const mine = { of, name: typeof name === "function" ? name : () => "" };
    around(() => { provider = mine; });
    tell(changeWatchers);
    return () => {
      if (provider !== mine) return;
      around(() => { provider = null; });
      tell(changeWatchers);
    };
  },
  get current() {
    return effective();
  },
  /** Switches the space. A no-op when it is the current one already. */
  enter(id) {
    const next = typeof id === "string" && id ? id : null;
    if (next === stored) return;
    around(() => {
      stored = next;
      write(next);
    });
  },
  /** `fn(spaceId)` after each change of the current space. Answers the function that stops it. */
  watch(fn) {
    watchers.add(fn);
    return () => watchers.delete(fn);
  },
  /** The provider's word that the map or the names changed. */
  changed() {
    tell(changeWatchers);
  },

  // ---- the shell's own readers ----

  /** Whether a package provides the spaces. */
  provided: () => Boolean(provider),
  /** The space a session is in: `null` for every session when nothing provides spaces; `undefined` while the provider does not know. */
  of(id) {
    if (!provider) return null;
    try {
      const out = provider.of(id);
      return out === undefined ? undefined : typeof out === "string" && out ? out : null;
    } catch (err) {
      console.error("the space provider's of() threw:", err);
      return undefined;
    }
  },
  /** A space's name, as the provider says it; "" when nothing provides spaces. */
  name(id) {
    if (!provider) return "";
    try {
      return String(provider.name(id ?? null) ?? "");
    } catch (err) {
      console.error("the space provider's name() threw:", err);
      return "";
    }
  },
  /** `fn()` after `changed()`, and when a provider comes or goes. */
  onChanged(fn) {
    changeWatchers.add(fn);
    return () => changeWatchers.delete(fn);
  },
};

/** The groups packages claimed in the sidebar, keyed `<package>#<id>`. */
const claimed = new Map(); // key -> { key, package, id, label, test, order }
const groupWatchers = new Set();

export const groups = {
  /** Claims (or replaces) a group. Answers the function that drops it. */
  set(pkg, id, { label, test, order } = {}) {
    if (typeof test !== "function") throw new Error("ext.sessions.group needs a `test(session)` function.");
    const key = `${pkg}#${id}`;
    const entry = { key, package: pkg, id: String(id), label: String(label || id), test, order: Number.isFinite(order) ? order : 0 };
    claimed.set(key, entry);
    tell(groupWatchers);
    return () => {
      if (claimed.get(key) !== entry) return;
      claimed.delete(key);
      tell(groupWatchers);
    };
  },
  /** Every group, by declared order, then by key. */
  list: () => [...claimed.values()].sort((a, b) => a.order - b.order || a.key.localeCompare(b.key)),
  has: (pkg) => [...claimed.values()].some((g) => g.package === pkg),
  watch(fn) {
    groupWatchers.add(fn);
    return () => groupWatchers.delete(fn);
  },
};

/** Tests only: back to a page with no provider and nothing remembered. */
export function resetSpace() {
  provider = null;
  stored = read();
  watchers.clear();
  changeWatchers.clear();
  claimed.clear();
  groupWatchers.clear();
}
