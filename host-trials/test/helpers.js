// A scratch THETIS_HOME with people in it, trials written the way `start` writes them (without starting a
// runner), and a fake HostEnv.
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { newTrial, newTrialId, parseStart } from "../lib/spec.js";
import { enqueue, hostDir, personDir, saveTrial, writeJsonAtomic } from "../lib/store.js";

export const FAKE_INNER = resolve(dirname(fileURLToPath(import.meta.url)), "fixtures/fake-inner.js");

export function scratchHome(users = ["ann", "bob"]) {
  const home = mkdtempSync(join(tmpdir(), "tt-"));
  for (const u of users) mkdirSync(join(home, "userspaces", u, "home"), { recursive: true });
  return home;
}

export function fakeEnv(home, users = { ann: "user", bob: "user", root: "admin", _system: "system" }) {
  const journal = [];
  return {
    env: {
      home,
      root: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      users: { get: (id) => (users[id] ? { id, role: users[id], status: "active" } : undefined), list: () => [] },
      records: { mounts: { get: () => [] }, ssh: { get: () => [] } },
      journal: (row) => journal.push(row),
      log: () => {},
    },
    journal,
  };
}

export const START = Object.freeze({
  session: "s_0123abcd",
  request: { text: "do the thing" },
  model: "echo",
  arms: [{ id: "base", change: null }, { id: "change", change: { kind: "guide-note", note: "Check the tests first." } }],
  runs: 2,
  costUsd: 1,
  minutes: 1,
  scratchMb: 128,
});

/** A trial as `start` leaves it, minus the runner. Answers `{t, dir}` with `dir` the person's trial directory. */
export function writeTrial(home, user, overrides = {}, { queue = false, createdAt } = {}) {
  const spec = parseStart({ ...START, ...overrides });
  const t = newTrialId();
  mkdirSync(hostDir(home, t), { recursive: true });
  writeJsonAtomic(resolve(hostDir(home, t), "spec.json"), { id: t, user, home, root: "/nonexistent", uid: 1000, rwMounts: [], ...spec });
  saveTrial(home, newTrial({ id: t, user, spec, ...(createdAt ? { now: createdAt } : {}) }));
  if (queue) enqueue(home, t);
  return { t, dir: personDir(home, user, t) };
}

export const fakeCommand = (script = {}) => (specPath) => [process.execPath, FAKE_INNER, specPath, JSON.stringify(script)];
export const FAST = { pollMs: 20, flushMs: 0, graceMs: 2000, stopGraceMs: 500, skipEnqueue: false };
export const code = (want) => (e) => e.code === want;
