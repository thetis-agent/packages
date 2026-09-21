// The people side of the package page and the fleet matrix: where one package runs (every person's copy,
// the workspace it is loaded in, its configuration there), the journal about it, the actions on it
// (update, fork, promote, remove, install for someone), and every package in every workspace at once.
// Everything about another person goes over the operator channel, which the kernel allows to an admin's
// fence alone; a fork lands in the admin's own home the way tool-exec's does, because the page's Fork
// means "fork it and use it". The marketplace library is imported when asked, so an installation without
// it still answers everything but the registry's word.
import { resolve } from "node:path";

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

/** The workspaces the daemon reports, by person. */
async function workspaces(env) {
  try {
    const status = await call(env, "status");
    return new Map((status?.workspaces ?? []).map((w) => [w.user, w]));
  } catch {
    return new Map();
  }
}

// ---- where one package runs ----

/**
 * package-where: every person's copy of one package, the workspace it is loaded in and whether that
 * workspace runs older code than the disk, the services that workspace runs, and the configuration's
 * state at that person's layer; plus the forks of it anyone runs.
 */
export async function packageWhere(args, env) {
  const name = packageName(args.name);
  const [everyone, spaces] = await Promise.all([people(env), workspaces(env)]);
  const rows = await Promise.all(
    everyone.map(async (person) => {
      const list = await installedFor(env, person.id);
      const copy = list.find((p) => p.name === name) ?? null;
      const space = spaces.get(person.id) ?? null;
      const loaded = space?.openedAt ? { openedAt: space.openedAt, codeAt: space.codeAt ?? null, stale: Boolean(space.stale) } : null;
      let config = null;
      if (copy) {
        try {
          const report = await call(env, "config.show", { name, user: person.id });
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
  const forks = rows.flatMap((r) => r.forks);
  const counts = {
    people: list.length,
    installed: list.filter((r) => r.installed).length,
    stale: list.filter((r) => r.installed && r.loaded?.stale).length,
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
  const { forkPackage, forkVersion } = await import("@thetis/lib/pkg-fs");
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
 * fleet: every package in every workspace, one row per name, with each person's copy (version, whether a
 * fork stands in for it, whether that workspace runs older code, whether the configuration is broken
 * there), the registry's word, and the counts the tiles show. No git here: that is one package's page.
 */
export async function fleet(_args, env) {
  const [everyone, spaces, own, systemList, system] = await Promise.all([people(env), workspaces(env), env.kernel.packages.list(), installedFor(env, SYSTEM), reportsAt(env, null)]);
  const perPerson = await Promise.all(everyone.map(async (person) => ({ person, list: await installedFor(env, person.id), reports: await reportsAt(env, person.id) })));
  const lib = await marketplace();
  const index = lib ? await lib.readIndex(env) : undefined;
  const behind = new Map(lib && index ? lib.behind(own, index).map((b) => [b.name, b]) : []);
  const indexed = new Map(index?.packages.map((e) => [e.name, e]) ?? []);
  const ownByName = new Map(own.map((p) => [p.name, p]));

  const rows = new Map();
  const row = (p) => {
    let r = rows.get(p.name);
    if (!r) {
      const entry = indexed.get(p.name);
      rows.set(p.name, (r = { name: p.name, type: p.type, description: p.description ?? "", scope: "some", version: null, versions: [], registry: entry ? { version: entry.version, update: behind.has(p.name) } : null, config: null, byUser: {}, git: null }));
    }
    return r;
  };
  for (const { person, list, reports } of perPerson) {
    const stale = Boolean(spaces.get(person.id)?.stale);
    for (const p of list) {
      const r = row(p);
      r.versions.push(p.version);
      r.byUser[person.id] = { version: p.version, fork: false, forkOf: p.forkedFrom?.name ?? null, stale, broken: Boolean(reports.get(p.name)?.broken) };
      // The original this fork replaced is not in the person's list any more: its row says a fork stands in.
      if (p.forkedFrom && p.replaced) {
        const original = row({ name: p.replaced, type: p.type, description: ownByName.get(p.replaced)?.description ?? "" });
        original.byUser[person.id] = { version: p.version, fork: true, forkOf: p.name, stale, broken: Boolean(reports.get(p.name)?.broken) };
      }
    }
  }
  for (const p of systemList) {
    const r = row(p);
    r.versions.push(p.version);
    r.byUser[SYSTEM] = { version: p.version, fork: false, forkOf: null, stale: Boolean(spaces.get(SYSTEM)?.stale), broken: Boolean(system.get(p.name)?.broken) };
  }
  const packages = [...rows.values()].map((r) => {
    const mine = ownByName.get(r.name);
    const onlySystem = Object.keys(r.byUser).every((u) => u === SYSTEM);
    const report = system.get(r.name);
    return {
      name: r.name,
      type: r.type,
      description: r.description,
      scope: mine?.everyone ? "everyone" : onlySystem ? "system" : "some",
      version: commonVersion(r.versions),
      registry: r.registry,
      config: report ? { broken: Boolean(report.broken), keys: report.keys?.length ?? 0 } : null,
      byUser: r.byUser,
      git: null,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
  const stats = {
    current: packages.filter((p) => p.registry && !p.registry.update).length,
    updates: packages.filter((p) => p.registry?.update).length,
    forks: packages.filter((p) => Object.values(p.byUser).some((c) => c.fork || c.forkOf)).length,
    broken: packages.filter((p) => p.config?.broken).length,
    stale: everyone.filter((person) => spaces.get(person.id)?.stale).length,
    unpushed: 0,
  };
  return { data: { people: everyone.map((u) => ({ user: u.id, role: u.role, status: u.status })), packages, stats } };
}
