// The grants an admin makes into one person's fence: host directories bound at their own path, and ssh
// keys the fence's agent holds. Both need the host -- a directory to browse, a key file to write under
// `<home>/fence-keys`, a path whose presence to check -- so they live here, a host package the daemon
// loads per call as `host.grants.<export>`. The kernel has already checked that the caller is an admin
// or the operator and journalled the call; what each export does is checked and journalled again here,
// with the grant itself, never a key's material.
//
// Every export is `(args, env)`. `args.user` names the target person (`_system` when absent, which no
// grant accepts); `args.actor` is the admin who called through a fence, absent for the operator at the
// socket. `env.records` are the kernel's own mount and ssh records: writing one is the grant, and
// `env.reloadFence` is what makes it reach the fence.
import { resolve } from "node:path";
import { assert } from "./lib/error.js";
import { browseDirectories, parseMountList, withPresence } from "./lib/mounts.js";
import { describeKeys, generateKey, importKey, parseSshGrants } from "./lib/ssh.js";

const SYSTEM_USER = "_system";

const userOf = (args) => String(args.user ?? SYSTEM_USER);

/**
 * One person's grants, or everyone's, each entry carrying what the host says about it now. Both listings
 * answer the same shape -- a map of user to states -- so a caller reads them the same way whether it asked
 * about one person or all of them.
 */
function listing(args, records, state) {
  const lists = args.user ? { [userOf(args)]: records.get(userOf(args)) } : records.all();
  return Object.fromEntries(Object.entries(lists).map(([u, list]) => [u, state(list)]));
}

/**
 * Granting a host resource into one person's fence. A mount and an ssh key are the same act: the target
 * has to exist and must not be `_system`, the grant is journalled without its contents, and it reaches
 * the fence by closing it -- the pool reopens on the next request and the services restart. Only the
 * record written and what the journal row says differ, so only those are arguments.
 */
async function grant(args, env, kind, value, records, row) {
  const target = targetOf(args, env, kind);
  records.set(target.id, value);
  env.journal({ kind, target: target.id, data: { [kind]: row(value) }, ...(args.actor ? { actor: String(args.actor) } : {}) });
  await env.reloadFence(target.id);
  return value;
}

/** The person a grant is for: known, and not the system userspace, which takes none. */
function targetOf(args, env, kind) {
  const target = env.users.get(userOf(args));
  assert(target, `unknown user: ${userOf(args)}`, "not-found");
  assert(target.role !== "system", `the system userspace takes no ${kind}`, "invalid");
  return target;
}

/** Where the host keeps the keys it made or took in for one person. */
const keyDir = (env, user) => resolve(env.home, "fence-keys", user);

/** A key the host holds for this person, granted with its known hosts in place of any grant of the same path. */
async function ownKey(args, env, made, hosts) {
  const ssh = [...env.records.ssh.get(userOf(args)).filter((g) => g.key !== made.key), { key: made.key, ...(hosts?.length ? { hosts } : {}) }];
  await grant(args, env, "ssh", ssh, env.records.ssh, (v) => v.map((g) => g.key));
  return made;
}

/**
 * `{ <user>: MountState[] }` for one person (`user`) or everyone. Every mount comes back with what the
 * host holds at its path, because a mount whose directory is gone is skipped when the fence opens: the
 * list alone cannot say a mount works.
 */
export async function mountsList(args, env) {
  return listing(args, env.records.mounts, withPresence);
}

/** The directories under `path` (default `/`), hidden ones too with `all`. The host filesystem is the admin's to see: a person's fence shows only what is bound into it. */
export async function mountsBrowse(args) {
  return browseDirectories(String(args.path ?? "/"), { all: args.all === true || args.all === "true" });
}

/** Replaces one person's mounts with `mounts`. The answer carries presence: a caller learns at once that a path it named is not there to bind. */
export async function mountsSet(args, env) {
  return withPresence(await grant(args, env, "mounts", parseMountList(args.mounts), env.records.mounts, (v) => v));
}

/**
 * `{ <user>: SshGrantState[] }` for one person or everyone. Presence, like mounts: a caller learns at once
 * that a granted key is not on this host, rather than from a fence that quietly opened without an agent;
 * the public half and fingerprint ride along for the ones there.
 */
export async function sshList(args, env) {
  return listing(args, env.records.ssh, describeKeys);
}

/**
 * No host credential to lend: the host makes this person a key of their own, grants it with the known
 * hosts of `ssh[0]`, and hands back `{ key, publicKey, fingerprint }` to register wherever it is going.
 * The private half sits with the other things the host holds for that fence, so it is agent-held like
 * any other grant. An existing key is kept.
 */
export async function sshKeygen(args, env) {
  const user = targetOf(args, env, "ssh").id;
  return ownKey(args, env, generateKey(keyDir(env, user), `thetis-${user}`), parseSshGrants(args.ssh ?? [])[0]?.hosts);
}

/**
 * A key the person already has, registered somewhere: `privateKey` lands beside the generated ones under
 * `name`, read once by ssh-keygen to prove it is one, granted with `hosts`, and the journal names its
 * path, never the material. Answers `{ key, publicKey, fingerprint }`.
 */
export async function sshImport(args, env) {
  const user = targetOf(args, env, "ssh").id;
  const made = importKey(keyDir(env, user), String(args.name ?? ""), String(args.privateKey ?? ""));
  return ownKey(args, env, made, parseSshGrants([{ key: "/hosts", hosts: args.hosts ?? [] }])[0]?.hosts);
}

/** Replaces one person's grants with `ssh`. The key paths are the grant; the key material is never read here and never journalled. */
export async function sshSet(args, env) {
  return describeKeys(await grant(args, env, "ssh", parseSshGrants(args.ssh), env.records.ssh, (v) => v.map((g) => g.key)));
}
