// The commands of @thetis/ui-admin: thin wrappers over `env.kernel.operator.call(...)`, one per verb the
// manifest declares. Each one checks its arguments the way the gateway's old `/api/admin/*` routes did,
// so a refusal is a plain sentence before the kernel sees anything, and answers `{ data }`. The gateway
// runs a command only when the person's role clears the declared one (admin, for every verb here); the
// kernel allows an operator method only when the fence's own user is an admin. Nothing here trusts the
// browser: the person's own id comes from `env.user`, never from the arguments.
import { isAbsolute, resolve } from "node:path";

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MOUNT_LIMIT = 32;
const SYSTEM = "_system";

function fail(message) {
  throw new Error(message);
}

function userId(value, what = "id") {
  if (typeof value !== "string" || !USER_ID.test(value)) fail(`${what} must be lowercase letters, digits and dashes, up to 32 characters`);
  return value;
}

/** The account under `env.user` is the admin's own; another admin, or the host, changes that one. */
function notSelf(id, env) {
  if (id === env.user) fail("you cannot change your own account here");
  return id;
}

function roleOf(value) {
  if (value !== "user" && value !== "admin") fail("role must be user or admin");
  return value;
}

function passwordOf(value) {
  if (typeof value !== "string" || value.length < 8) fail("a password needs at least 8 characters");
  return value;
}

const call = (env, method, args = {}) => env.kernel.operator.call(method, args);

export async function users(_args, env) {
  return { data: await call(env, "users.list") };
}

/** Creates the person, then sets the password when one was given. `role` defaults to user. */
export async function userCreate(args, env) {
  const id = userId(args.id);
  const role = roleOf(args.role ?? "user");
  const password = args.password ? passwordOf(args.password) : null;
  const created = await call(env, "users.create", { id, role });
  if (password) await call(env, "users.passwd", { id, password });
  return { data: created };
}

export async function userRole(args, env) {
  const id = notSelf(userId(args.id), env);
  return { data: await call(env, "users.setRole", { id, role: roleOf(args.role) }) };
}

export async function userStatus(args, env) {
  const id = notSelf(userId(args.id), env);
  if (args.status !== "active" && args.status !== "suspended") fail("status must be active or suspended");
  return { data: await call(env, "users.setStatus", { id, status: args.status }) };
}

/** Sets the password, which signs the person out everywhere. */
export async function userPassword(args, env) {
  const id = notSelf(userId(args.id), env);
  await call(env, "users.passwd", { id, password: passwordOf(args.password) });
  return { data: { id } };
}

export async function userRemove(args, env) {
  const id = notSelf(userId(args.id), env);
  await call(env, "users.remove", { id });
  return { data: { id } };
}

/** The default model and what every provider in the system userspace serves. */
export async function models(_args, env) {
  const [list, config] = await Promise.all([call(env, "models"), call(env, "config.get")]);
  return { data: { model: config.model, models: list } };
}

/** The configuration as the kernel reports it, secrets already replaced. */
export async function config(_args, env) {
  return { data: await call(env, "config.get") };
}

const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const CONFIG_KEY = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/;

const packageName = (value) => (typeof value === "string" && PACKAGE_NAME.test(value) ? value : fail("a package name looks like @scope/name"));
const configKey = (value) => (typeof value === "string" && CONFIG_KEY.test(value) ? value : fail("a configuration key is a word: letters, digits, dots, dashes and underscores"));
/** `user` names a person's layer; absent means the system layer. Only the keys given travel, so the kernel sees the same shape the CLI sends. */
const layerOf = (args, rest) => (args.user === undefined || args.user === "" ? rest : { ...rest, user: userId(args.user, "user") });

/** Every package's report: at the system layer, or at one person's when `user` is given. */
export async function configList(args, env) {
  return { data: await call(env, "config.list", layerOf(args, {})) };
}

export async function configShow(args, env) {
  return { data: await call(env, "config.show", layerOf(args, { name: packageName(args.name) })) };
}

/**
 * Writes one key. The value is any JSON but never null or undefined: removing a value is `config-unset`,
 * so a missing field is a refusal here and not an accidental clear. The value is passed through untouched
 * and never appears in a message: the kernel journals the package and the key, not what was written.
 */
export async function configSet(args, env) {
  const name = packageName(args.name);
  const key = configKey(args.key);
  if (args.value === undefined || args.value === null) fail(`${key} needs a value; config-unset removes one`);
  return { data: await call(env, "config.set", layerOf(args, { name, key, value: args.value })) };
}

export async function configUnset(args, env) {
  return { data: await call(env, "config.unset", layerOf(args, { name: packageName(args.name), key: configKey(args.key) })) };
}

/** Re-reads thetis.config.json and the env file. Answers what changed and which services were restarted for it. */
export async function configReload(_args, env) {
  return { data: await call(env, "config.reload") };
}

/** The newest journal rows, at most 1000, narrowed to one kind when given. */
export async function journal(args, env) {
  const limit = Math.min(1000, Number(args.limit ?? 200) || 200);
  const kind = typeof args.kind === "string" && args.kind ? args.kind : undefined;
  return { data: await call(env, "journal.tail", { limit, kind }) };
}

/** Every person's mounts as `{ <user>: [{ path, mode }] }`, or one person's with `user`. */
export async function mountsList(args, env) {
  const user = args.user ? userId(args.user, "user") : undefined;
  return { data: await call(env, "mounts.list", user ? { user } : {}) };
}

/**
 * The directories under one host path, for the picker. A person's fence shows only what is bound into it,
 * so the listing comes from the operator: an admin binds host paths, and must be able to see them to pick
 * one that is really there.
 */
export async function mountsBrowse(args, env) {
  const path = args.path === undefined || args.path === "" ? "/" : String(args.path);
  if (!isAbsolute(path) || path !== resolve(path)) fail(`a path to browse must be absolute and normalized: ${path}`);
  return { data: await call(env, "mounts.browse", { path }) };
}

/** A mount as the kernel accepts it: an absolute normalized path that is not the root, and mode rw or ro. */
function mountOf(raw) {
  const path = typeof raw?.path === "string" ? raw.path : "";
  if (!path || !isAbsolute(path) || path !== resolve(path) || path === "/") fail(`a mount path must be absolute and normalized, not /: ${path || "(empty)"}`);
  if (raw.mode !== "rw" && raw.mode !== "ro") fail(`the mode of ${path} must be rw or ro`);
  return { path, mode: raw.mode };
}

/** Replaces one person's mounts with the whole list given. The kernel closes that person's fence, which reopens with the binds. */
export async function mountsSet(args, env) {
  const user = userId(args.user, "user");
  if (!Array.isArray(args.mounts) || args.mounts.length > MOUNT_LIMIT) fail(`mounts must be a list of at most ${MOUNT_LIMIT} entries`);
  const mounts = args.mounts.map(mountOf);
  const paths = new Set(mounts.map((m) => m.path));
  if (paths.size !== mounts.length) fail("a path is listed twice");
  return { data: await call(env, "mounts.set", { user, mounts }) };
}

/**
 * Closes one person's fence and opens it again, so their services, their provider and the agent itself are
 * the code on disk now. `_system` is a legal target here, unlike a mount: the providers and the sign-in page
 * live in it. `userId`'s pattern has no underscore, so that one id is named rather than matched, and every
 * other id is still checked before the kernel is asked.
 */
export async function fenceReload(args, env) {
  const user = args.user === SYSTEM ? SYSTEM : userId(args.user, "user");
  return { data: await call(env, "fence.reload", { user }) };
}

/** What the daemon and every workspace are running, and whether the code on disk is newer than that. */
export async function status(_args, env) {
  return { data: await call(env, "status") };
}

/**
 * Asks the kernel to arm the restart latch, on behalf of the admin whose fence this is. Nothing restarts in
 * this call: the latch waits for every turn to end, counts down, and only then exits. The answer is the
 * latch's own sentence — armed, already armed, or refused — and the page shows it as it stands. The reason is
 * required here, in the kernel's own words, because it is shown to everyone waiting and written to the journal.
 */
export async function restartRequest(args, env) {
  const reason = typeof args.reason === "string" ? args.reason.trim() : "";
  if (!reason) fail("a restart needs a reason: it is shown to everyone waiting and recorded");
  return { data: await call(env, "restart.request", { reason }) };
}
