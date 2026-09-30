// The people side of the package page and the fleet matrix: where one package runs (every person's copy,
// the workspace it is loaded in, its configuration there), the journal about it, the actions on it
// (update, fork, promote, remove, install for someone), and every package in every workspace at once.
// Everything about another person goes over the operator channel, which the kernel allows to an admin's
// fence alone; a fork lands in the admin's own home the way tool-exec's does, because the page's Fork
// means "fork it and use it". The marketplace library is imported when asked, so an installation without
// it still answers everything but the registry's word.
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { newestMtime } from "@thetis/runtime/lib/freshness";
import { folderPackages, installedPackage } from "./git.js";

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const DIR_NAME = /^[a-z0-9._-]+$/;
const SYSTEM = "_system";
const EVERYONE = "*";

function fail(message) {
  throw new Error(message);
}

const userId = (value, what = "user") => (typeof value === "string" && USER_ID.test(value) ? value : fail(`${what} must be lowercase letters, digits and dashes, up to 32 characters`));
const packageName = (value) => (typeof value === "string" && PACKAGE_NAME.test(value) ? value : fail("a package name looks like @scope/name"));
const call = (env, method, args = {}) => env.kernel.operator.call(method, args);
const isSystem = (name) => name.startsWith("@thetis/");
const scopeOf = (name) => /^@([^/]+)\//.exec(String(name ?? ""))?.[1] ?? null;

// ---- what a person reads about an extension, from its record ----

/** How many places, docks and panels a manifest adds to the page. */
const pageCount = (ui) => (ui && typeof ui === "object" ? ["places", "dock", "panel", "sidebar", "shelf"].reduce((n, slot) => n + (Array.isArray(ui[slot]) ? ui[slot].length : 0), 0) : 0);

/**
 * The facts the one state and the publisher line read (`ui/state.js`), taken from a package's record: its
 * label and audience, whether everyone gets it and why, whether it is someone's copy and how that copy stands
 * against its official version, where it came from, and what it brings. The same shape as the Extensions
 * place's rows, so both surfaces say the same thing about the same extension.
 */
export function factsOf(p) {
  const t = p?.thetis ?? {};
  return {
    label: typeof t.label === "string" && t.label.trim() ? t.label.trim() : null,
    // The manifest's one plain sentence, which every card and page opens with when there is one.
    summary: typeof t.summary === "string" && t.summary.trim() ? t.summary.trim() : null,
    audience: typeof t.audience === "string" ? t.audience : null,
    everyone: Boolean(p?.everyone),
    everyoneBy: p?.everyoneBy ?? null,
    forkedFrom: p?.forkedFrom ? { name: p.forkedFrom.name, version: p.forkedFrom.version } : null,
    // What a person's own package went out as when a registry's scope renamed its publish (`thetis.publishedAs`).
    publishedAs: typeof t.publishedAs === "string" && t.publishedAs ? t.publishedAs : null,
    fork: p?.fork ? { name: p.fork.name, version: p.fork.version, shipped: p.fork.shipped ?? null, identical: Boolean(p.fork.identical), everyone: Boolean(p.fork.everyone) } : null,
    source: p?.source ? { kind: p.source.kind, ref: p.source.ref } : null,
    tools: Array.isArray(t.tools) ? t.tools.map((x) => x?.name).filter(Boolean) : [],
    hasSkills: typeof t.skills === "string" && Boolean(t.skills),
    pages: pageCount(t.ui),
    service: Boolean(t.service),
    steps: Array.isArray(t.steps) ? t.steps.length : 0,
  };
}

/**
 * A configuration report as the one state reads it: broken or not, the kernel's summary, how many keys, and the
 * missing ones, from which the one state works out whose they are to fix (a `${VAR}` the server's environment
 * lacks or a system-scoped key is an admin's; a person reads it as "Waiting for your admin").
 */
export function setupOf(report) {
  if (!report) return null;
  const keys = Array.isArray(report.keys) ? report.keys : [];
  // The missing keys travel with what the one state reads about them, never a value: the key, where it would
  // come from, the variables the server's environment lacks, its scope and its help.
  const missing = keys.filter((k) => k?.state === "missing").map((k) => ({ key: k.key, state: k.state, ...(k.scope ? { scope: k.scope } : {}), ...(Array.isArray(k.missing) ? { missing: k.missing } : {}), ...(k.source ? { source: k.source } : {}), ...(k.help ? { help: k.help } : {}), secret: Boolean(k.secret) }));
  return { broken: Boolean(report.broken), summary: report.summary ?? "", keys: keys.length, missing };
}

/**
 * Where each promoted copy came from, by its name: the person's extension it was made from, whose that was
 * (the scope), when, and who shared it. The journal is the only record of it -- the copy's own manifest names
 * only itself -- so a journal that cannot be read answers an empty map and the page says less, not wrong.
 */
export async function promotions(env) {
  let rows = [];
  try {
    rows = await call(env, "journal.tail", { limit: 1000, kind: "package.promote" });
  } catch {
    rows = [];
  }
  const out = new Map();
  const sorted = (Array.isArray(rows) ? rows : []).filter((e) => e?.data?.promoted && e.data.name).sort((a, b) => String(b.at).localeCompare(String(a.at)));
  for (const e of sorted) if (!out.has(e.data.promoted)) out.set(e.data.promoted, { name: e.data.name, by: scopeOf(e.data.name), at: e.at ?? null, actor: e.actor ?? null });
  return out;
}

/** The marketplace library, or null where it is not installed: the registry's word is then unknown, not wrong. */
async function marketplace() {
  try {
    return await import("@thetis/marketplace");
  } catch {
    return null;
  }
}

/** Everyone but the system account, which has no page of its own. */
async function people(env) {
  const list = await call(env, "users.list");
  return (Array.isArray(list) ? list : []).filter((u) => u.role !== "system");
}

/** One person's installed packages; a refusal (a person with no workspace yet) is an empty list. */
async function installedFor(env, user) {
  try {
    const list = await call(env, "packages.list", { user });
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** The daemon's status: the workspaces by person, and whether the daemon itself runs older code than the disk. */
async function statusOf(env) {
  try {
    const status = await call(env, "status");
    return { spaces: new Map((status?.workspaces ?? []).map((w) => [w.user, w])), daemonStale: Boolean(status?.daemon?.stale) };
  } catch {
    return { spaces: new Map(), daemonStale: false };
  }
}

// ---- drift: three words, worked out here ----
//
// A copy is one of three things, and the browser draws the word it is given: `current` (Up to date),
// `update` (Update ready: applying it to that workspace puts the new code into service) and, for the daemon
// alone, `restart` (Restart needed). Code the fence re-reads on every call (a tool's entry, a step, a
// browser file) is never "older": it is live on its next call. Only what a workspace reads once, when it
// opens, can be behind: every package whose version moved since (its manifest and the modules its entry
// imports), and a provider or a running service whose files changed without a version bump.

/** Whether the workspace reads this package once, when it opens: a provider, or a service it runs. */
export function readOnce(copy, space) {
  return copy?.type === "provider" || (Array.isArray(space?.services) && space.services.includes(copy?.name));
}

/**
 * Whether a person's copy's files are newer than the moment their workspace opened. A root the fence cannot
 * read (another person's home) has no newest time, so it is never called newer.
 */
function filesNewer(copy, space) {
  const opened = space?.openedAt ? Date.parse(space.openedAt) : 0;
  if (!opened) return false;
  let root = typeof copy?.root === "string" ? copy.root : null;
  try {
    if (root) root = realpathSync(root);
  } catch {
    /* the link may not resolve from here: the walk below then finds nothing */
  }
  const mtime = root ? newestMtime([root]) : 0;
  return mtime > opened;
}

/**
 * The word for one person's copy: `update` when the version their workspace loaded is not the one on disk,
 * or when it reads the package once and the files changed since it opened; otherwise `current`. A workspace
 * that is not open is current by definition: it opens on whatever is on disk.
 */
export function copyState(copy, space, { newer = filesNewer } = {}) {
  const loaded = typeof copy?.loadedVersion === "string" ? copy.loadedVersion : null;
  if (loaded && loaded !== copy.version) return "update";
  if (readOnce(copy, space) && newer(copy, space)) return "update";
  return "current";
}

// ---- where one package runs ----

/** Folder copies marked with whether the admin has each installed under its own name. */
async function withInstalled(env, copies) {
  const mine = await env.kernel.packages.list().catch(() => []);
  return copies.map((f) => ({ ...f, installed: (Array.isArray(mine) ? mine : []).some((p) => p.name === f.name) }));
}

/**
 * The copies in the asking admin's own folder (`<home>/packages/*`) made from any of `origins`, installed or
 * not: `notion-read` made from `@bitmuse/notion` is a copy of the shared Notion too. Another person's folder is
 * not readable from here, so only the admin's own are counted this way; installed copies anyone runs come from
 * the lists. A folder that cannot be read has none.
 */
export function folderCopies(home, origins, user) {
  if (!home) return [];
  let entries = [];
  try {
    entries = readdirSync(resolve(home, "packages"), { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith(".")) continue;
    try {
      const m = JSON.parse(readFileSync(resolve(home, "packages", e.name, "package.json"), "utf8"));
      const from = m?.thetis?.forkedFrom?.name;
      if (typeof m?.name === "string" && from && origins.has(from)) out.push({ user, name: m.name, version: String(m.version ?? ""), label: typeof m.thetis.label === "string" ? m.thetis.label : null, folder: `packages/${e.name}` });
    } catch {
      /* not a package: skipped */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * package-where: every person's copy of one package, the workspace it is loaded in and whether that
 * workspace runs older code than the disk, the services that workspace runs, and the configuration's
 * state at that person's layer; plus the forks of it anyone runs.
 */
export async function packageWhere(args, env) {
  const name = packageName(args.name);
  const [everyone, { spaces }] = await Promise.all([people(env), statusOf(env)]);
  const rows = await Promise.all(
    everyone.map(async (person) => {
      const list = await installedFor(env, person.id);
      // A fork that replaced the package stands in for it: that person has it, as the fork.
      const copy = list.find((p) => p.name === name) ?? list.find((p) => p.replaced === name) ?? null;
      const space = spaces.get(person.id) ?? null;
      // `state` is the one word: whether this person's workspace has applied the copy on disk.
      const loaded = space?.openedAt ? { openedAt: space.openedAt, state: copy ? copyState(copy, space) : "current" } : null;
      let config = null;
      if (copy) {
        try {
          // A fork's configuration is kept under the fork's name at that person's layer.
          const report = await call(env, "config.show", { name: copy.name, user: person.id });
          config = report ? { broken: Boolean(report.broken), summary: report.summary ?? "" } : null;
        } catch {
          config = null;
        }
      }
      const forks = list.filter((p) => p.forkedFrom?.name === name).map((p) => ({ user: person.id, name: p.name, version: p.version }));
      return {
        row: {
          user: person.id,
          role: person.role,
          status: person.status,
          installed: Boolean(copy),
          version: copy?.version ?? null,
          forkedFrom: copy?.forkedFrom ?? null,
          replaced: copy?.replaced ?? null,
          source: copy?.source ?? null,
          loaded,
          services: space?.services ?? [],
          config,
        },
        forks,
      };
    })
  );
  const list = rows.map((r) => r.row);
  // A shared copy's own copies include the ones made from the original it was shared from.
  const from = name.startsWith("@thetis/") ? (await promotions(env)).get(name)?.name ?? null : null;
  const installedForks = rows.flatMap((r) => r.forks);
  const folder = folderCopies(env.cwd, new Set([name, ...(from ? [from] : [])]), env.user).filter((f) => !installedForks.some((i) => i.user === f.user && i.name === f.name));
  const forks = [...installedForks.map((f) => ({ ...f, installed: true })), ...(folder.length ? await withInstalled(env, folder) : [])];
  const counts = {
    people: list.length,
    installed: list.filter((r) => r.installed).length,
    // The people who have not applied the copy on disk yet: "3 people haven't applied it yet".
    waiting: list.filter((r) => r.installed && r.loaded?.state === "update").length,
    forks: forks.length,
    broken: list.filter((r) => r.config?.broken).length,
  };
  return { data: { people: list, forks, counts } };
}

// ---- the journal about one package ----

const about = (entry, name) => entry.target === name || [entry.data?.name, entry.data?.package, entry.data?.promoted].includes(name);

/** package-activity: the journal's entries about one package, newest first. */
export async function packageActivity(args, env) {
  const name = packageName(args.name);
  const wanted = Math.min(500, Math.max(1, Number(args.limit ?? 50) || 50));
  const tail = await call(env, "journal.tail", { limit: 1000 });
  const entries = (Array.isArray(tail) ? tail : [])
    .filter((e) => e && about(e, name))
    .sort((a, b) => String(b.at).localeCompare(String(a.at)))
    .slice(0, wanted)
    .map((e) => ({ at: e.at, kind: e.kind, actor: e.actor ?? null, target: e.target ?? null, data: e.data ?? {} }));
  return { data: { entries } };
}

// ---- actions ----

/**
 * package-update: moves a package to the commit its registry holds. A system package moves for everyone
 * at once; anyone else's moves in the admin's own workspace, which is the only one the page can speak for.
 */
export async function packageUpdate(args, env) {
  const name = packageName(args.name);
  const lib = (await marketplace()) ?? fail("the marketplace library is not installed here, so no registry can be asked");
  const installed = await env.kernel.packages.list();
  const copy = installed.find((p) => p.name === name) ?? fail(`${name} is not installed in your workspace`);
  const behind = lib.behind([copy], await lib.readIndex(env))[0] ?? fail(`${name} is not behind its registry`);
  if (isSystem(name)) {
    const out = await call(env, "packages.installEveryone", { source: behind.source });
    return { data: { name, version: behind.version, people: out?.userspaces ?? [] } };
  }
  const info = await call(env, "packages.install", { user: env.user, source: behind.source });
  return { data: { name, version: info?.version ?? behind.version, people: [env.user] } };
}

/** package-fork: a copy of an installed package in the admin's own home, installed at once so it replaces the original there. */
export async function packageFork(args, env) {
  const name = packageName(args.name);
  const installed = await env.kernel.packages.list();
  const origin = installed.find((p) => p.name === name) ?? fail(`${name} is not installed in your workspace`);
  const as = args.as ? String(args.as) : name.slice(name.indexOf("/") + 1);
  if (!DIR_NAME.test(as)) fail(`as must be a plain directory name: ${as}`);
  const forkName = `@${env.user}/${as}`;
  const { forkPackage, forkVersion } = await import("@thetis/runtime/lib/pkg-fs");
  const version = forkVersion(origin.version, installed.find((p) => p.name === forkName)?.version);
  const to = resolve(env.cwd, "packages", as);
  forkPackage({ from: origin.root, to, name: forkName, version, origin: { name, version: origin.version }, root: env.root });
  const dir = `packages/${as}`;
  const info = await env.kernel.packages.install(dir);
  return { data: { name: info?.name ?? forkName, version: info?.version ?? version, dir } };
}

/** package-promote: a person's package becomes a system package, installed for everyone; the person's own copy goes. */
export async function packagePromote(args, env) {
  const name = packageName(args.name);
  if (isSystem(name)) fail(`${name} is already everyone's`);
  const user = userId(args.user);
  const out = await call(env, "packages.promote", { user, name });
  return { data: { name: out?.name ?? name, userspaces: out?.userspaces ?? [] } };
}

/** package-remove: for one person, or with `user: "*"` for everyone who has it, one at a time so a refusal names who kept it. */
export async function packageRemove(args, env) {
  const name = packageName(args.name);
  const who = args.user === EVERYONE ? EVERYONE : userId(args.user);
  if (who !== EVERYONE) {
    await call(env, "packages.uninstall", { user: who, name });
    return { data: { removed: [who] } };
  }
  const removed = [];
  for (const person of await people(env)) {
    const list = await installedFor(env, person.id);
    if (!list.some((p) => p.name === name)) continue;
    await call(env, "packages.uninstall", { user: person.id, name });
    removed.push(person.id);
  }
  return { data: { removed } };
}

/** package-install-for: a system (or promoted) package, by name, into one person's workspace. The kernel refuses what it cannot install. */
export async function packageInstallFor(args, env) {
  const name = packageName(args.name);
  const user = userId(args.user);
  const info = await call(env, "packages.install", { user, source: name });
  return { data: { name: info?.name ?? name, version: info?.version ?? null } };
}

/**
 * package-everyone: turns an extension by Thetis or a registry on for everyone (`on: true`), or off
 * (`on: false`). On is `packages.installEveryone` with the extension's own source: its name for one shipped
 * with Thetis, the pinned registry source for one installed from a registry (which the kernel makes a shared
 * copy of). Off takes an admin's mark back: new people stop getting it, people who have it keep it. A
 * person's own extension is shared with package-promote, and nothing here reads a source from the browser.
 */
export async function packageEveryone(args, env) {
  const name = packageName(args.name);
  if (args.on === false) {
    await call(env, "packages.unmarkEveryone", { name });
    return { data: { name, on: false } };
  }
  const info = await installedPackage(env, name);
  const source = info.source?.kind === "system" || isSystem(name) ? name : info.source?.kind === "git" ? info.source.ref : fail(`${name} is a person's own extension: share it with everyone instead`);
  const out = await call(env, "packages.installEveryone", { source });
  return { data: { name: out?.name ?? name, on: true, userspaces: out?.userspaces ?? [] } };
}

/**
 * package-unfork: the admin's own customized copy goes, and the official version it was made from comes back
 * in their workspace ("Use Thetis's version"). Only a copy in the admin's own list, because the kernel's
 * unfork speaks for the fence that asks; the copy's files stay.
 */
export async function packageUnfork(args, env) {
  const name = packageName(args.name);
  const own = (await env.kernel.packages.list()).find((p) => p.name === name) ?? fail(`${name} is not installed in your workspace`);
  if (!own.forkedFrom) fail(`${name} is not a copy of another extension`);
  const back = await env.kernel.packages.unfork(name);
  return { data: { name: back?.name ?? own.forkedFrom.name, version: back?.version ?? null, from: name } };
}

// ---- Thetis's own parts ----
//
// The Extensions place lists the parts that make Thetis run (the host packages, the storage driver, the
// gateways, the model providers, the harness, the index service, the page's own plumbing) under "Part of
// Thetis", apart from what a person added or was given, and counts only the rest as Installed. The Control
// panel says the same number, so the rule is `@thetis/ui-marketplace`'s `lib/rows.js` `isComponent`, restated
// (a package imports only its own files and its declared dependencies) and held to it by `test/fleet.test.js`.

const COMPONENT_TYPES = new Set(["host", "storage", "gateway", "provider", "skill-type", "service"]);
const COMPONENT_NAMES = new Set(["harness-core", "prompt-cache", "bench", "bench-probe", "ui-admin", "ui-marketplace", "ui-context", "ui-tools", "ui-skills"]);
const SKILL_LOADERS = new Set(["skills-all", "skills-l1", "skills-hybrid"]);

/** Whether a row is one of Thetis's own parts: `audience`, then the type and the name. `installed` is for the reader. */
export function isComponent(row) {
  if (row.audience === "system") return true;
  if (row.audience === "everyone") return false;
  const base = String(row.name ?? "").replace(/^@[^/]+\//, "");
  if (SKILL_LOADERS.has(base)) return !row.installed;
  return COMPONENT_TYPES.has(row.type) || COMPONENT_NAMES.has(base);
}

// ---- the fleet ----

/** The configuration reports at one layer, by package; a refusal is an empty map. */
async function reportsAt(env, user) {
  try {
    const list = await call(env, "config.list", user ? { user } : {});
    return new Map((Array.isArray(list) ? list : []).map((r) => [r.package, r]));
  } catch {
    return new Map();
  }
}

/** The version most copies carry; ties go to the first seen. */
function commonVersion(versions) {
  const counts = new Map();
  for (const v of versions) if (v) counts.set(v, (counts.get(v) ?? 0) + 1);
  let best = null;
  for (const [v, n] of counts) if (best === null || n > counts.get(best)) best = v;
  return best;
}

/**
 * One person's copy in the matrix: what they run, what their workspace loaded, its one word, and what is worth a
 * look. A copy whose settings are missing something carries the missing keys (never a value), so the person
 * reading reads their own Needs setup from their own layer, as the Extensions place does.
 */
function copyCell(p, space, reports, { fork = false, forkOf = null } = {}) {
  const loaded = typeof p.loadedVersion === "string" ? p.loadedVersion : null;
  const report = reports.get(p.name);
  const broken = Boolean(report?.broken);
  return {
    version: p.version,
    fork,
    forkOf: forkOf ?? p.forkedFrom?.name ?? null,
    broken,
    ...(broken ? { summary: report.summary ?? "", missing: setupOf(report).missing } : {}),
    loaded,
    state: copyState(p, space),
  };
}

/** The system packages on disk, whether anyone has them or not; a kernel without the question has none to add. */
async function catalogOf(env) {
  if (typeof env.kernel.packages.catalog !== "function") return [];
  try {
    const list = await env.kernel.packages.catalog();
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/**
 * fleet: every package in every workspace, one row per name, with each person's copy (version, what that
 * workspace loaded, its one word, whether a fork stands in for it, whether the configuration is broken
 * there), the registry's word, the row's own word, and the counts the page shows. No git here: that is
 * one package's page.
 *
 * `state` on a row is `update` when anything about it is ready to apply: a registry holding a newer commit
 * than the pin (`registry.update.apply: "install"`), or a person whose workspace has not applied the copy on
 * disk (`waiting` names them). `daemon.state` is `restart` when the daemon itself runs older code than the
 * disk, the one thing only a restart puts into service.
 */
export async function fleet(_args, env) {
  const [everyone, { spaces, daemonStale }, own, systemList, system, catalog] = await Promise.all([people(env), statusOf(env), env.kernel.packages.list(), installedFor(env, SYSTEM), reportsAt(env, null), catalogOf(env)]);
  const perPerson = await Promise.all(everyone.map(async (person) => ({ person, list: await installedFor(env, person.id), reports: await reportsAt(env, person.id) })));
  const lib = await marketplace();
  const index = lib ? await lib.readIndex(env) : undefined;
  const behind = new Map(lib && index ? lib.behind(own, index).map((b) => [b.name, b]) : []);
  const indexed = new Map(index?.packages.map((e) => [e.name, e]) ?? []);
  const ownByName = new Map(own.map((p) => [p.name, p]));

  const rows = new Map();
  const row = (p) => {
    let r = rows.get(p.name);
    if (!r) rows.set(p.name, (r = { name: p.name, type: p.type, description: p.description ?? "", scope: "some", version: null, versions: [], entry: indexed.get(p.name) ?? null, config: null, byUser: {}, git: null, info: null }));
    // The first real record seen speaks for the row's facts; a stand-in made for a fork's original has none.
    if (!r.info && p.thetis) r.info = p;
    return r;
  };
  for (const { person, list, reports } of perPerson) {
    const space = spaces.get(person.id) ?? null;
    for (const p of list) {
      const r = row(p);
      r.versions.push(p.version);
      r.byUser[person.id] = copyCell(p, space, reports);
      // The original this fork replaced is not in the person's list any more: its row says a fork stands in.
      if (p.forkedFrom && p.replaced) {
        const original = row({ name: p.replaced, type: p.type, description: ownByName.get(p.replaced)?.description ?? "" });
        original.byUser[person.id] = copyCell(p, space, reports, { fork: true, forkOf: p.name });
      }
    }
  }
  for (const p of systemList) {
    const r = row(p);
    r.versions.push(p.version);
    r.byUser[SYSTEM] = copyCell(p, spaces.get(SYSTEM) ?? null, system);
  }
  // The admin's own folder copies nobody installed (a variant such as Notion (Read Only)): listed too, in their
  // family, so the tree has every extension. Another person's folder is not readable from here.
  for (const p of folderPackages(env.cwd)) {
    if (!p.forkedFrom || rows.has(p.name)) continue;
    const r = row(p);
    r.versions.push(p.version);
    r.onDisk = true;
    r.folder = p.folder;
  }
  // What is on disk and nobody has: listed too, so every extension of this server has a row and a page.
  for (const p of catalog) {
    // A stand-in (the original a person's copy replaced) takes its facts from the disk: its label and summary.
    if (rows.has(p.name)) {
      const r = rows.get(p.name);
      if (!r.info && p.thetis) r.info = p;
      continue;
    }
    const r = row(p);
    r.versions.push(p.version);
    r.onDisk = true;
  }
  const promoted = [...rows.values()].some((r) => (ownByName.get(r.name) ?? r.info)?.everyoneBy === "promoted") ? await promotions(env) : new Map();
  const packages = [...rows.values()].map((r) => {
    const mine = ownByName.get(r.name);
    const facts = factsOf(mine ?? r.info);
    const setup = setupOf(system.get(r.name));
    const onlySystem = Object.keys(r.byUser).every((u) => u === SYSTEM);
    const report = system.get(r.name);
    const version = commonVersion(r.versions);
    // An install wins over applying, as the library says: an install brings the new pin and reopens the workspace.
    // A copy whose official version moved on (`unfork`) is not an update of what anyone runs: it is Customized,
    // and the copy's page says what using Thetis's version would do.
    const found = behind.get(r.name)?.apply === "unfork" ? null : behind.get(r.name);
    const waiting = Object.entries(r.byUser).filter(([, c]) => c.state === "update" && !c.fork).map(([who]) => who);
    // The commits travel too: a newer commit of the same version is an update, as the place says ("A newer build of 0.1.1").
    const update = found ? { apply: found.apply, version: found.version, ...(found.apply === "install" ? { from: String(found.installed ?? "").slice(0, 7), to: String(found.available ?? "").slice(0, 7) } : {}) } : waiting.length ? { apply: "reload", version } : null;
    return {
      name: r.name,
      type: r.type,
      description: r.description,
      ...facts,
      scope: mine?.everyone ? "everyone" : onlySystem ? "system" : "some",
      version,
      registry: r.entry ? { version: r.entry.version, registry: r.entry.registry ?? null, update } : update ? { version, update } : null,
      config: report ? { broken: Boolean(report.broken), keys: report.keys?.length ?? 0, summary: setup.summary, missing: setup.missing } : null,
      byUser: r.byUser,
      // Installed for the person asking: their own copy, not a fork of theirs standing in for it.
      mine: Boolean(r.byUser[env.user] && !r.byUser[env.user].fork),
      // One of Thetis's own parts, as the Extensions place decides it: not counted among what is installed.
      component: isComponent({ name: r.name, type: r.type, audience: facts.audience, installed: Boolean(r.byUser[env.user] && !r.byUser[env.user].fork) }),
      ...(promoted.has(r.name) ? { promotedFrom: promoted.get(r.name) } : {}),
      // On disk only: nobody has it, not even Thetis itself.
      ...(r.onDisk ? { nobody: true } : {}),
      // In the admin's own folder, not installed: the path an install sends.
      ...(r.folder ? { folder: r.folder } : {}),
      state: update ? "update" : "current",
      waiting,
      git: null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  // A workspace counts once however many of its copies wait; `_system` is one too. What nobody has is not counted.
  const held = packages.filter((p) => !p.nobody);
  const waiting = new Set(held.flatMap((p) => p.waiting));
  const stats = {
    // Up to date: nothing to install and nobody waiting for a reload.
    current: held.filter((p) => p.state === "current").length,
    // A real newer version: a registry's newer commit. A workspace that has not reloaded is `waiting`, never this.
    updates: held.filter((p) => p.registry?.update?.apply === "install").length,
    installs: held.filter((p) => p.registry?.update?.apply === "install").length,
    waiting: waiting.size,
    // Copies, not rows: each person's copy once, under the copy's own name (its original's row holds the same copy again).
    forks: held.reduce((n, p) => n + Object.values(p.byUser).filter((c) => !c.fork && c.forkOf).length, 0),
    broken: held.filter((p) => p.config?.broken || Object.values(p.byUser).some((c) => c.broken && !c.fork)).length,
  };
  return { data: { people: everyone.map((u) => ({ user: u.id, role: u.role, status: u.status })), packages, stats, daemon: { state: daemonStale ? "restart" : "current" } } };
}
