// The commands of @thetis/ui-marketplace, one per verb the manifest declares. The gateway runs them as
// the person, inside the person's own fence, with the `StepEnv` it holds plus `user` and `role`. The
// index and the README copies are read from the shared directory through `@thetis/marketplace`; a
// person's own packages go through `env.kernel.packages`; the admin verbs go through
// `env.kernel.operator.call`, which the gateway allows only past the declared role and the kernel only
// for an admin's fence. Nothing here trusts the browser: `env.user` says who asked.
import { readIndex, readReadme, readReadmeAsset, search as searchIndex } from "@thetis/marketplace";
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

/**
 * The gateway caps a command's answer at 256 KiB. The README may be that long on its own, so its pictures
 * ride along only while the answer stays under this many bytes; one that does not fit shows as its alt text.
 */
const SHOW_BUDGET = 200 * 1024;

/** The README's pictures, in README order, as `{ [path]: { type, data } }`, as many as fit beside the text. */
async function assetsOf(env, entry, readme) {
  const out = {};
  let spent = Buffer.byteLength(readme ?? "");
  for (const path of entry?.readmeAssets ?? []) {
    const asset = await readReadmeAsset(env, entry, path);
    if (!asset) continue;
    spent += Buffer.byteLength(asset.data);
    if (spent > SHOW_BUDGET) break;
    out[path] = asset;
  }
  return out;
}

/** One package: its row, the README copy when the registry holds one with the pictures it shows, and who is looking. */
export async function show(args, env) {
  const name = packageName(args.name);
  const { index, rows } = await rowsOf(env);
  const row = rows.find((r) => r.name === name);
  if (!row) fail(`${name} is not installed here and no registry offers it`);
  const entry = index?.packages.find((e) => e.name === name);
  const readme = entry ? ((await readReadme(env, entry)) ?? null) : null;
  const assets = readme ? await assetsOf(env, entry, readme) : {};
  return { data: { ...facts(index), row, readme, assets, user: env.user, role: env.role } };
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

/**
 * Goes back to the package this fork was copied from. The fork's files are kept: they are the person's own
 * work, and a page that could throw them away on one click would be a page nobody dares press. `Delete`
 * next to it is what removes them, once the person can see that the shipped package is back.
 *
 * The answer to this is very often never read. The package being replaced is usually the web gateway, which
 * is the thing serving the click, so the connection dies mid-call; the browser treats that as the success it
 * is and waits for the new gateway. See `unforkMe` in ui/actions.js.
 */
export async function unfork(args, env) {
  const name = packageName(args.name);
  return { data: installedRow(await env.kernel.packages.unfork(name)) };
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

const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;
const configKey = (value) => (typeof value === "string" && CONFIG_KEY.test(value) ? value : fail("a configuration key is a word: letters, digits, dots, dashes and underscores"));

/** The person's own layer of one installed package: every key's state, secrets redacted. */
export async function configShow(args, env) {
  return { data: await env.kernel.config.show(packageName(args.name)) };
}

/**
 * The one sentence per installed package, for the gallery: `[{ package, summary, broken }]`. One call from
 * the page rather than one per card; a package the kernel cannot report on is left out, because a card
 * that says nothing is better than a gallery that fails on one row.
 */
export async function configList(_args, env) {
  const installed = await env.kernel.packages.list();
  const reports = await Promise.all(installed.map((p) => env.kernel.config.show(p.name).catch(() => null)));
  return { data: reports.filter(Boolean).map((r) => ({ package: r.package, summary: r.summary, broken: !!r.broken })) };
}

/**
 * Writes one key at the person's own layer. The value is any JSON but never null or undefined: removing a
 * value is `config-unset`. It is passed through untouched and never appears in a message.
 */
export async function configSet(args, env) {
  const name = packageName(args.name);
  const key = configKey(args.key);
  if (args.value === undefined || args.value === null) fail(`${key} needs a value; config-unset removes one`);
  return { data: await env.kernel.config.set(name, key, args.value) };
}

export async function configUnset(args, env) {
  return { data: await env.kernel.config.unset(packageName(args.name), configKey(args.key)) };
}

const call = (env, method, a = {}) => env.kernel.operator.call(method, a);

/**
 * Reloads the person's own workspace: the fence closes and opens again on the code on disk now, which is
 * what puts a package shipped with the service into service after its files change. The id is `env.user`
 * and never an argument, so this verb can only ever name the person who sent it; the kernel allows anyone
 * `fence.reload` for their own id and an admin for anyone's, and the operator channel is where it lives.
 */
export async function fenceReload(_args, env) {
  return { data: await call(env, "fence.reload", { user: env.user }) };
}

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

// ---- publishing, as a soft dependency on @thetis/package-publish ----

const PUBLISH = "@thetis/package-publish";
const BUMPS = new Set(["patch", "minor", "major"]);
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)*$/;

/**
 * The publishing package's tool, when it is installed in this fence and declares that tool. Most
 * installations will never have it: publishing is for whoever maintains the packages, and everybody else
 * only ever installs them. So this is a soft dependency in the strict sense -- nothing here imports it,
 * nothing declares it in `dependencies`, and its absence is an answer rather than an error. The reference
 * is read off the installed manifest rather than written down here, because the export a tool names is the
 * manifest's to decide and this package has no business holding a second copy of it.
 */
async function publishTool(env, toolName) {
  const pkg = (await env.kernel.packages.list()).find((p) => p.name === PUBLISH);
  const tool = pkg?.thetis?.tools?.find((t) => t.name === toolName);
  return tool ? { package: PUBLISH, export: tool.export, name: tool.name } : null;
}

/** Where this workspace may publish, from the publishing package's own effective configuration. `[]` when it has none. */
async function publishTargetList(env) {
  const config = await env.kernel.config.effective(PUBLISH).catch(() => ({}));
  const targets = Array.isArray(config.targets) ? config.targets : [];
  return targets.filter((t) => t && typeof t.name === "string").map((t) => ({ name: t.name, url: typeof t.url === "string" ? t.url : "", branch: typeof t.branch === "string" ? t.branch : null }));
}

/**
 * Runs one of the publishing package's tools in this fence. `env.invokeTool` is the same seam the harness
 * uses to run what a model asked for: the tool's export, under the tool's own package, with that package's
 * effective configuration -- which `env.kernel.config.effective` gives, because a fence is one person's
 * authority and a package in it may load another's configuration, exactly as the gateway runs another
 * package's UI commands as the person.
 *
 * `session` is what a tool receives to know which conversation it is serving. This one is not serving a
 * conversation: a page asked, and publishing acts on the workspace and its registries, not on a transcript.
 * The id is whatever conversation happened to be on screen, and empty when none was, which is the truth.
 */
async function invokePublish(env, toolName, args) {
  const ref = await publishTool(env, toolName);
  if (!ref) fail(`${PUBLISH} is not installed in your workspace, so there is nothing here that can publish.`);
  const config = await env.kernel.config.effective(PUBLISH);
  const raw = await env.invokeTool(ref, args, { session: { id: env.session ?? "", user: env.user }, config });
  if (raw && typeof raw === "object") return raw;
  // A tool may answer a string. These two do not, but a refusal read as a success is the one failure mode
  // worth spending three lines on here.
  try {
    return JSON.parse(String(raw));
  } catch {
    return { text: String(raw) };
  }
}

/**
 * Where this workspace may publish, and, when a package is named, what each target already holds for it.
 * Answers `{ available, targets }` and never throws for the ordinary case of the publishing package not
 * being installed or having no target configured: the page simply does not offer the action. `available`
 * is decided from the configuration alone, before any tool runs, so a page that will not offer Publish
 * pays nothing for asking.
 */
export async function publishTargets(args, env) {
  const ref = await publishTool(env, "publish_targets");
  const targets = ref ? await publishTargetList(env) : [];
  if (!ref || !targets.length) return { data: { available: false, targets } };
  const name = typeof args.package === "string" && args.package ? packageName(args.package) : null;
  try {
    const out = await invokePublish(env, "publish_targets", name ? { package: name } : {});
    return { data: { available: true, ...out, targets: Array.isArray(out.targets) && out.targets.length ? out.targets : targets } };
  } catch (err) {
    // The tool reaching its targets can fail for every reason a network can. The configured names are still
    // true and still worth offering: the dry run in front of the publish is where the real answer comes from.
    return { data: { available: true, targets, error: err?.message || String(err) } };
  }
}

/**
 * Publishes one package to one target, or, with `dryRun`, reports what that would do without committing or
 * pushing anything. The page runs the dry run first and shows its `was` and `now` in the confirm popover,
 * because this is the one action in the product that changes what other installations receive, and a person
 * must see the old version, the new version and the target before they agree to it -- not a bump they have
 * to do the arithmetic for. A refusal is thrown, and its sentence stands alone in a toast.
 *
 * `with` names the packages being published deliberately alongside this one. A dry run answers
 * `ok: false` with `blockers[]` instead of refusing, each blocker carrying `details` rows about the
 * passengers, which is what lets the page draw them and let the person choose rather than guess.
 */
export async function publish(args, env) {
  const name = packageName(args.name);
  const to = args.to === undefined || args.to === null || args.to === "" ? undefined : String(args.to);
  const bump = args.bump === undefined || args.bump === null || args.bump === "" ? undefined : String(args.bump);
  const version = args.version === undefined || args.version === null || args.version === "" ? undefined : String(args.version);
  if (bump !== undefined && !BUMPS.has(bump)) fail("bump is patch, minor or major");
  if (version !== undefined && !VERSION.test(version)) fail("a version looks like 1.2.0");
  if (bump !== undefined && version !== undefined) fail("give a bump or a version, not both");
  // The passengers, named one by one and never filled in by anybody but the person. A publish in a
  // checkout that is itself the registry pushes the branch, so a commit already on that branch rides
  // along whether or not it is wanted; `with` is how the publishing package is told which of those are
  // deliberate. It is a list of names and nothing else, checked here so a mistyped one is a sentence
  // rather than something silently published.
  const also = args.with === undefined || args.with === null ? [] : args.with;
  if (!Array.isArray(also)) fail("with is a list of package names");
  const named = also.map((n) => packageName(n));
  if (named.includes(name)) fail(`${name} is what is being published; it does not go in with as well`);
  if (new Set(named).size !== named.length) fail("with names the same package twice");
  const out = await invokePublish(env, "publish_package", {
    package: name,
    ...(to ? { to } : {}),
    ...(bump ? { bump } : {}),
    ...(version ? { version } : {}),
    ...(named.length ? { with: named } : {}),
    ...(args.dryRun ? { dryRun: true } : {}),
  });
  return { data: { ...out, dryRun: !!args.dryRun, with: named } };
}
