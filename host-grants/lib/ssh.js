// ssh grants: what a grant list looks like when it arrives, what the host holds at each key's path now,
// and the keys the host makes or takes in for one person. The store itself is the kernel's record
// (`env.records.ssh`); `knownHostsOf`, which the fence uses, stays in @thetis/runtime/lib.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assert } from "./error.js";

/** A grant list as it arrives from a socket: at most 16 keys, each an absolute normalized path. Answers `{ key, hosts? }[]`. */
export function parseSshGrants(raw) {
  assert(Array.isArray(raw) && raw.length <= 16, "ssh grants must be a list of at most 16 entries", "invalid");
  return raw.map((g) => {
    const key = String(g?.key ?? "");
    assert(key !== "/" && key === resolve(key), `invalid ssh key path: ${key} (absolute and normalized)`, "invalid");
    const hosts = g?.hosts === undefined ? undefined : g.hosts;
    assert(hosts === undefined || Array.isArray(hosts), `invalid hosts for ${key}: a list of known_hosts lines`, "invalid");
    const lines = hosts?.map((h) => String(h).trim()).filter(Boolean) ?? [];
    return { key, ...(lines.length ? { hosts: lines } : {}) };
  });
}

/**
 * The grants with what the host says about each key now -- `present` is true only for a regular file --
 * so a caller can tell a grant that works from one that is only written down, the same distinction
 * `mountsList` draws; and, for a key that is there, `publicKey`, the half that gets registered elsewhere,
 * and `fingerprint`, the way GitHub and the like name it, both null when the key is not there to read.
 * The public half comes from `<key>.pub` beside the key when there is one, else from the key itself; the
 * private material is read by ssh-keygen and never answered.
 */
export function describeKeys(grants) {
  return grants.map((g) => {
    const present = isFile(g.key);
    const publicKey = present ? publicKeyOf(g.key) : null;
    return { ...g, present, publicKey, fingerprint: publicKey ? fingerprintOf(publicKey) : null };
  });
}

/** The former name. */
export const withKeyPresence = describeKeys;

/** The public line of a key: the `.pub` beside it, else derived from the key; null when neither can be read. */
export function publicKeyOf(key) {
  if (isFile(`${key}.pub`)) {
    try {
      return readFileSync(`${key}.pub`, "utf8").trim() || null;
    } catch {
      return null;
    }
  }
  const run = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", key], { encoding: "utf8" });
  return run.status === 0 ? run.stdout.trim() || null : null;
}

/** `SHA256:…` for a public line, the way the far end shows it; null when ssh-keygen cannot read the line. */
export function fingerprintOf(publicKey) {
  const run = spawnSync("ssh-keygen", ["-lf", "-"], { encoding: "utf8", input: `${publicKey}\n` });
  const token = run.status === 0 ? run.stdout.split(/\s+/).find((t) => t.startsWith("SHA256:")) : undefined;
  return token ?? null;
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * Makes a keypair for one person, for the case where there is no host credential to share and there does
 * not need to be. Each fence is then its own machine: the public half is registered wherever it is going,
 * revocation is per person and visible at the far end -- which key pushed this -- and nothing on the host
 * is lent out. The private half lands beside the other things the host holds for that fence, never in
 * the userspace, so it is agent-held like any other grant and the fence still cannot read it.
 *
 * An existing key is kept rather than replaced: generating over one that is already registered somewhere
 * would silently break whatever trusts it. Answers `{ key, publicKey, fingerprint }`.
 */
export function generateKey(dir, comment) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, "id_ed25519");
  if (!existsSync(key)) {
    const gen = spawnSync("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", key], { encoding: "utf8" });
    assert(gen.status === 0, `ssh-keygen failed: ${(gen.stderr ?? "").trim() || `exit ${gen.status}`}`, "invalid");
  }
  chmodSync(key, 0o600);
  const publicKey = readFileSync(`${key}.pub`, "utf8").trim();
  return { key, publicKey, fingerprint: fingerprintOf(publicKey) };
}

/** A name a person gives an imported key: one path segment, never the public half's suffix. */
export const KEY_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Takes a private key a person already has -- one registered at GitHub, say -- and puts it beside the
 * generated ones, so the fence's agent can hold it like any other grant. The material is written once
 * with the key's own mode, read back by ssh-keygen to prove it is a key and to derive the public half,
 * and is never returned or logged. A key that ssh-keygen cannot read is removed again before the refusal,
 * so a typo leaves nothing behind; one with a passphrase is refused too, because an agent nobody can
 * answer a prompt for cannot load it. An existing name is never overwritten: whatever trusts that key
 * would break silently. Answers `{ key, publicKey, fingerprint }`.
 */
export function importKey(dir, name, material) {
  assert(KEY_NAME.test(name) && !name.endsWith(".pub"), `a key name is one plain name, letters, digits, dots, dashes and underscores, not ending in .pub: ${name}`, "invalid");
  const text = String(material ?? "").replace(/\r\n/g, "\n").trim();
  assert(text.startsWith("-----BEGIN ") && text.includes("PRIVATE KEY-----"), "the material is not a private key: it should start with -----BEGIN ... PRIVATE KEY-----", "invalid");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const key = join(dir, name);
  assert(!existsSync(key), `${key} already exists: revoke and remove it first, or pick another name`, "invalid");
  writeFileSync(key, `${text}\n`, { mode: 0o600 });
  const run = spawnSync("ssh-keygen", ["-y", "-P", "", "-f", key], { encoding: "utf8" });
  if (run.status !== 0) {
    unlinkSync(key);
    const why = (run.stderr ?? "").trim();
    assert(!/passphrase|incorrect/i.test(why), "the key has a passphrase: an agent nobody can answer a prompt for cannot load it; import a key without one", "invalid");
    assert(false, `not a private key ssh-keygen can read${why ? `: ${why}` : ""}`, "invalid");
  }
  const publicKey = run.stdout.trim();
  writeFileSync(`${key}.pub`, `${publicKey}\n`, { mode: 0o644 });
  return { key, publicKey, fingerprint: fingerprintOf(publicKey) };
}
