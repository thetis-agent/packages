// What the "Updates ready" card is drawn from: one answer per person, computed from real state every time it
// is asked. Nothing here stores an intention. An update is pending because the state says so, and it stops
// being pending when the state stops saying so.
//
// Three lists and one number:
//
// - `items`: the extensions the person has that have a newer version waiting. `install` means a registry holds
//   a newer commit and it has to be fetched first. `apply` means the files are here already and the person's
//   space only has to be started again on them. These are the two kinds of behind that `behind()` calls
//   `install` and `reload`; the person sees one word, Update, for both.
// - `own`: the person's own extensions (copies under their home) whose files changed after their space opened.
//   This is what an agent's edit looks like, including an edit that does not bump a version, which no version
//   comparison can see. The UI command runs inside the fence's agent process, so `process.uptime()` gives the
//   moment the space opened; the files' newest modification time is compared with that.
// - `forks`: the person's copies that carry nothing the official version lacks: `superseded` (every change
//   they made is now in the official version) or `identical` (they never changed anything). A copy that still
//   differs is not listed. It is doing its job, and the marketplace page is where that is said.
// - `shells`: how many terminal sessions are open, because applying closes them.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { behind } from "@thetis/marketplace";
import { titleCase } from "./state.js";

/**
 * The name a person reads. `thetis.label` in the manifest when the author gave one, otherwise the name
 * without its scope, with a `ui-` prefix dropped and dashes as spaces: `@thetis/tool-exec` reads "tool exec".
 */
export function labelOf(info) {
  const given = info?.thetis?.label;
  if (typeof given === "string" && given.trim()) return given.trim();
  const base = String(info?.name ?? "").replace(/^@[^/]+\//, "").replace(/^ui-/, "");
  return base.replace(/[-_.]+/g, " ").trim() || String(info?.name ?? "");
}

/**
 * Directories whose files never need the space started again. `skills` is text read on every turn, `bench`
 * and `test` are never loaded, and `node_modules` and `.git` are not the person's code.
 */
const SKIP = new Set(["node_modules", ".git", "skills", "bench", "test", "tests"]);
/** Files that are loaded. A README or a TypeScript source that is not built yet does not change what runs. */
const LOADED = /\.(?:m?js|cjs|json|css|html)$/;
/** Bounds the walk, so a package with a large tree cannot make the answer slow. */
const WALK_LIMIT = 4000;

/** The newest modification time, in ms, of the loaded files under `root`, or 0 when there are none. */
export function newestChange(root) {
  let newest = 0;
  let seen = 0;
  const walk = (dir, depth) => {
    if (depth > 8 || seen > WALK_LIMIT) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (++seen > WALK_LIMIT) return;
      if (e.isDirectory()) {
        if (!SKIP.has(e.name)) walk(join(dir, e.name), depth + 1);
      } else if (e.isFile() && LOADED.test(e.name) && e.name !== ".thetis-fork-base.json") {
        try {
          newest = Math.max(newest, statSync(join(dir, e.name)).mtimeMs);
        } catch {
          continue;
        }
      }
    }
  };
  if (root) walk(root, 0);
  return newest;
}

/**
 * The fork comparison from `@thetis/runtime/lib/pkg-fs`, when this installation's runtime has it: a copy
 * records its origin's files at fork time, and `forkState(forkRoot, originRoot)` answers `superseded`,
 * `identical`, `diverged` or `unknown`. An older runtime has no such function, and then the kernel's own
 * `identical` flag is all there is to go on.
 */
async function loadForkState() {
  try {
    const mod = await import("@thetis/runtime/lib/pkg-fs");
    return typeof mod.forkState === "function" ? mod.forkState : null;
  } catch {
    return null;
  }
}

/**
 * The answer, from what the kernel and the index say. Pure apart from the two readers it is handed, so a test
 * can give it any state. `newestOf(root)` is the newest change under a package; `forkStateOf(forkRoot,
 * originRoot)` the fork comparison, or null when the runtime has none.
 */
export async function updatesOf({ installed, catalog = [], index, openedAt, newestOf = newestChange, forkStateOf = null }) {
  const byName = new Map(installed.map((p) => [p.name, p]));
  // A space that loaded any version at all tells us which packages it loaded. One of the person's own that it
  // did not load was installed after the space opened, and that is a change to apply as much as an edit is.
  const loadedAny = installed.some((p) => p.loadedVersion);
  const own = [];
  for (const p of installed) {
    if (p.source?.kind !== "local") continue;
    const added = loadedAny && !p.loadedVersion;
    const newest = newestOf(p.root);
    const edited = Number.isFinite(openedAt) && newest > openedAt;
    // `at` is the change's own time, so the page can tell one set of changes from the next one to the same
    // package; `ui` says the change may touch the page itself, which then refreshes after applying.
    if (added || edited) own.push({ name: p.name, label: titleCase(labelOf(p)), ui: !!p.thetis?.ui, at: Math.round(newest) });
  }
  const mine = new Set(own.map((o) => o.name));

  // The name a person reads is the newest version's, Title Case, the same the place's cards say: a registry's
  // entry for what is fetched, the files on disk (the installed manifest) for what is applied.
  const named = (name, info) => {
    const entry = (index?.packages ?? []).filter((e) => e.name === name && typeof e.label === "string" && e.label).sort((a, b) => String(b.version).localeCompare(String(a.version), undefined, { numeric: true }))[0];
    return titleCase(entry?.label ?? labelOf(info ?? { name }));
  };
  const items = [];
  for (const b of behind(installed, index)) {
    if (b.apply === "unfork" || mine.has(b.name)) continue;
    const info = byName.get(b.name);
    // Two versions that are the same are nothing to update, whatever else moved.
    if (b.apply === "install") {
      if (String(b.version) === String(info?.version ?? "") && b.installed === b.available) continue;
      items.push({ name: b.name, label: named(b.name, info), from: info?.version ?? "", to: b.version, apply: "install" });
    } else {
      if (!b.available || String(b.available) === String(b.installed)) continue;
      items.push({ name: b.name, label: titleCase(labelOf(info)), from: b.installed, to: b.available, apply: "apply" });
    }
  }

  const forks = [];
  for (const p of installed) {
    const fork = p.fork ?? (p.forkedFrom ? { name: p.forkedFrom.name, version: p.forkedFrom.version } : null);
    if (!fork) continue;
    const origin = catalog.find((c) => c.name === fork.name);
    let state = null;
    if (forkStateOf && origin?.root) {
      try {
        state = await forkStateOf(p.root, origin.root);
      } catch {
        state = null;
      }
    }
    // Without a recorded base, or without the comparison, the kernel's byte-for-byte flag is the one fact left.
    if (state !== "superseded" && state !== "identical") state = fork.identical && (state === null || state === "unknown") ? "identical" : null;
    if (state) forks.push({ name: p.name, label: titleCase(labelOf(origin ?? p)), origin: fork.name, state });
  }

  return { items, own, forks };
}

/** Rejects after `ms`, so a slow terminal service cannot hold the whole answer. */
function within(ms, promise) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("timed out")), ms)))]).finally(() => clearTimeout(timer));
}

/**
 * How many terminal sessions are open in this space, from `@thetis/terminal`'s own UI command. A soft link:
 * nothing is imported until the terminal is found installed, and a terminal without the command, or one that
 * does not answer in two seconds, counts as none. `sessions-count` answers `{ open }`; an older terminal has
 * only `sessions`, whose list is counted instead.
 */
export async function shellsOf(env, installed) {
  const pkg = installed.find((p) => p.name === "@thetis/terminal");
  const commands = pkg?.thetis?.ui?.commands ?? [];
  const cmd = commands.find((c) => c.verb === "sessions-count") ?? commands.find((c) => c.verb === "sessions");
  if (!pkg?.root || !cmd) return 0;
  try {
    const manifest = JSON.parse(readFileSync(resolve(pkg.root, "package.json"), "utf8"));
    const main = resolve(pkg.root, manifest.main ?? "index.js");
    const fn = (await import(`${pathToFileURL(main).href}?v=${statSync(main).mtimeMs}`))[cmd.export];
    if (typeof fn !== "function") return 0;
    const config = await env.kernel.config.effective(pkg.name).catch(() => ({}));
    const out = await within(2000, Promise.resolve(fn({}, { ...env, config })));
    const data = out?.data ?? out;
    if (Number.isFinite(data?.open)) return Number.isFinite(data?.watched) ? { open: data.open, watched: data.watched } : data.open;
    const list = Array.isArray(data?.sessions) ? data.sessions : [];
    return list.filter((s) => !s?.closed && s?.state !== "closed").length;
  } catch {
    return 0;
  }
}

/** The `updates` verb's body: the three lists, the shell count, and the person's choice about their own changes. */
export async function updatesFor(env, { installed, catalog, index }) {
  const openedAt = Date.now() - process.uptime() * 1000;
  const [lists, shells] = await Promise.all([updatesOf({ installed, catalog, index, openedAt, forkStateOf: await loadForkState() }), shellsOf(env, installed)]);
  const policy = env.config?.applyOwnChanges === "ask" ? "ask" : "auto";
  // `shells` is every open terminal session (an apply closes them all); `watched` the ones a browser is showing.
  // A shell only the agent used is reopened by the agent, so it does not hold an automatic apply back.
  const count = typeof shells === "object" ? shells : { open: shells, watched: shells };
  return { ...lists, shells: count.open, watched: count.watched, applyOwnChanges: policy };
}
