import { statSync } from "node:fs";
import { resolve } from "node:path";
import type { SshGrant } from "@thetis/contracts";
import { assert } from "./error.js";
import type { StoreMirror } from "./store.js";

/** A grant and what the host holds at the key's path now. `present` is true only for a regular file. */
export interface SshGrantState extends SshGrant {
  present: boolean;
}

/**
 * The per-user ssh grants: one document per person, `{ ssh: [ { key, hosts } ] }`.
 *
 * A grant names one key file on the host, never a directory. A host `~/.ssh` holds unrelated credentials
 * -- a deploy key, a cloud key, a personal key -- so a directory grant would hand all of them to a fence
 * that needed one. The key itself is read by the kernel and loaded into that fence's agent; it is never
 * bound anywhere the fence can reach. Who may set a grant is the caller's decision.
 */
export class SshStore {
  constructor(private readonly docs: StoreMirror<{ ssh: SshGrant[] }>) {}

  /** A copy of one person's grants; empty when none. */
  get(user: string): SshGrant[] {
    return (this.docs.get(user)?.ssh ?? []).map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: [...g.hosts] } : {}) }));
  }

  all(): Record<string, SshGrant[]> {
    return Object.fromEntries(this.docs.all().map(([u]) => [u, this.get(u)]));
  }

  /** Replaces one person's grants; an empty list removes the document. */
  set(user: string, grants: SshGrant[]): void {
    if (grants.length) this.docs.set(user, { ssh: grants.map((g) => ({ key: g.key, ...(g.hosts?.length ? { hosts: [...g.hosts] } : {}) })) });
    else this.docs.delete(user);
  }
}

/** A grant list as it arrives from a socket: at most 16 keys, each an absolute normalized path. */
export function parseSshGrants(raw: unknown): SshGrant[] {
  assert(Array.isArray(raw) && raw.length <= 16, "ssh grants must be a list of at most 16 entries", "invalid");
  return raw.map((g: { key?: unknown; hosts?: unknown } | null) => {
    const key = String(g?.key ?? "");
    assert(key !== "/" && key === resolve(key), `invalid ssh key path: ${key} (absolute and normalized)`, "invalid");
    const hosts = g?.hosts === undefined ? undefined : g.hosts;
    assert(hosts === undefined || Array.isArray(hosts), `invalid hosts for ${key}: a list of known_hosts lines`, "invalid");
    const lines = (hosts as unknown[] | undefined)?.map((h) => String(h).trim()).filter(Boolean) ?? [];
    return { key, ...(lines.length ? { hosts: lines } : {}) };
  });
}

/**
 * The grants with what the host says about each key now, so a caller can tell a grant that works from one
 * that is only written down -- the same distinction `mounts.list` draws with `present`.
 */
export function withKeyPresence(grants: SshGrant[]): SshGrantState[] {
  return grants.map((g) => ({ ...g, present: isFile(g.key) }));
}

/** Every known_hosts line of a grant list, deduplicated, in the order they were granted. */
export function knownHostsOf(grants: SshGrant[]): string {
  const lines: string[] = [];
  for (const g of grants) for (const h of g.hosts ?? []) if (!lines.includes(h)) lines.push(h);
  return lines.length ? `${lines.join("\n")}\n` : "";
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}
