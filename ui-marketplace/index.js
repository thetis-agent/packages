// The commands of @thetis/ui-marketplace, one per verb the manifest declares. The gateway runs them as
// the person, inside the person's own fence, with the `StepEnv` it holds plus `user` and `role`. The
// index and the README copies are read from the shared directory through `@thetis/marketplace`; a
// person's own packages go through `env.kernel.packages`; the admin verbs go through
// `env.kernel.operator.call`, which the gateway allows only past the declared role and the kernel only
// for an admin's fence. Nothing here trusts the browser: `env.user` says who asked.
import { readIndex, readReadme, search as searchIndex } from "@thetis/marketplace";
import { installedRow, matchesQuery, mergeRows } from "./lib/rows.js";

const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;

function fail(message) {
  throw new Error(message);
}

const packageName = (value) => (typeof value === "string" && PACKAGE_NAME.test(value) ? value : fail("a package name looks like @scope/name"));
const userId = (value) => (typeof value === "string" && USER_ID.test(value) ? value : fail("user must be lowercase letters, digits and dashes, up to 32 characters"));
const sourceOf = (value) => (typeof value === "string" && value.trim() ? value.trim() : fail("source is required"));

/** What the page shows about the index beside the rows: when it was refreshed, and by which registries. */
function facts(index) {
  return { updatedAt: index?.updatedAt ?? null, registries: index?.registries ?? [], total: index?.packages.length ?? 0, indexed: !!index };
}

async function rowsOf(env) {
  const [installed, index] = await Promise.all([env.kernel.packages.list(), readIndex(env)]);
  return { installed, index, rows: mergeRows(installed, index?.packages ?? [], index) };
}

/**
 * Every package known here, installed first, narrowed by `q` and `type`. The index does the search with its
 * ranking; an installed package that the index does not carry is matched on its name, type and description.
 */
export async function search(args, env) {
  const q = typeof args.q === "string" ? args.q.trim() : "";
  const type = typeof args.type === "string" && args.type ? args.type : "";
  const { index, rows } = await rowsOf(env);
  let shown = rows;
  if (q || type) {
    const hits = new Set(index ? searchIndex(index, q, { type, limit: 200 }).map((e) => e.name) : []);
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    shown = rows.filter((r) => hits.has(r.name) || (r.installed && matchesQuery(r, terms, type)));
  }
  return { data: { ...facts(index), rows: shown, user: env.user, role: env.role } };
}

/** One package: its row, the README copy when the registry holds one, and who is looking. */
export async function show(args, env) {
  const name = packageName(args.name);
  const { index, rows } = await rowsOf(env);
  const row = rows.find((r) => r.name === name);
  if (!row) fail(`${name} is not installed here and no registry offers it`);
  const entry = index?.packages.find((e) => e.name === name);
  const readme = entry ? ((await readReadme(env, entry)) ?? null) : null;
  return { data: { ...facts(index), row, readme, user: env.user, role: env.role } };
}

export async function install(args, env) {
  const source = sourceOf(args.source);
  const before = await env.kernel.packages.list();
  const info = await env.kernel.packages.install(source);
  return { data: { ...installedRow(info), reinstalled: before.some((p) => p.name === info.name) } };
}

export async function remove(args, env) {
  const name = packageName(args.name);
  await env.kernel.packages.uninstall(name);
  return { data: { name } };
}

/** Deletes the files too. The kernel allows that only for the person's own scope under their home. */
export async function del(args, env) {
  return { data: await env.kernel.packages.delete(packageName(args.name)) };
}

/** An update is an install of the newer pinned source, as `thetis packages update` does. Refused when nothing is newer. */
export async function update(args, env) {
  const name = packageName(args.name);
  const { rows } = await rowsOf(env);
  const row = rows.find((r) => r.name === name);
  if (!row?.installed) fail(`${name} is not installed here`);
  if (!row.update) fail(`${name} is not behind its registry`);
  const info = await env.kernel.packages.install(row.update.source);
  return { data: { ...installedRow(info), from: row.update.from, to: row.update.to } };
}

const call = (env, method, a = {}) => env.kernel.operator.call(method, a);

/** A shipped `@thetis/<name>` is marked for everyone and linked into every person; anything else is installed for the admin and promoted. */
export async function installEveryone(args, env) {
  return { data: await call(env, "packages.installEveryone", { source: sourceOf(args.source) }) };
}

export async function installFor(args, env) {
  const info = await call(env, "packages.install", { user: userId(args.user), source: sourceOf(args.source) });
  return { data: installedRow(info) };
}

export async function removeFor(args, env) {
  const user = userId(args.user);
  const name = packageName(args.name);
  await call(env, "packages.uninstall", { user, name });
  return { data: { user, name } };
}

/** Copies a person's package under @thetis, installs it for everyone, and removes the person's own copy. */
export async function promote(args, env) {
  return { data: await call(env, "packages.promote", { user: userId(args.user), name: packageName(args.name) }) };
}

/** The people an admin may install for. The system user is not one of them. */
export async function people(_args, env) {
  const list = await call(env, "users.list");
  return { data: (Array.isArray(list) ? list : []).filter((p) => p.role !== "system").map((p) => ({ id: p.id, role: p.role, status: p.status })) };
}
