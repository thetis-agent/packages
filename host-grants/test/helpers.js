// A fake HostEnv: records in memory, a user table, a journal that is a list, and a reload that is a list.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** One per-person record, the way the kernel's stores answer: copies out, an empty list removes. */
export function records() {
  const docs = new Map();
  return {
    get: (user) => (docs.get(user) ?? []).map((v) => ({ ...v })),
    all: () => Object.fromEntries([...docs.keys()].map((u) => [u, (docs.get(u) ?? []).map((v) => ({ ...v }))])),
    set: (user, value) => (value.length ? docs.set(user, value.map((v) => ({ ...v }))) : docs.delete(user)),
  };
}

export function fakeEnv({ users = [{ id: "_system", role: "system" }, { id: "alice", role: "user" }, { id: "root", role: "admin" }] } = {}) {
  const home = mkdtempSync(join(tmpdir(), "thetis-host-grants-"));
  const table = users.map((u) => ({ status: "active", createdAt: "2026-01-01T00:00:00.000Z", ...u }));
  const journal = [];
  const reloaded = [];
  const env = {
    home,
    users: { get: (id) => table.find((u) => u.id === id), list: () => [...table] },
    records: { mounts: records(), ssh: records() },
    journal: (row) => void journal.push(row),
    reloadFence: async (user) => void reloaded.push(user),
    log: () => {},
  };
  return { env, home, journal, reloaded };
}

export const code = (want) => (e) => e.code === want;
