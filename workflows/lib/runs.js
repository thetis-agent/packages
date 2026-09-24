// Runs on disk: `workflows/runs/<run>.json`, one file per run, and `workflows/queue.json`. The service
// holds every run in memory and writes a run's file each time it changes; these are the reads and the
// writes, and the shape a new run starts with.
import { DIR, list, readJson, writeJson } from "./files.js";
import { isRunId, newRunId } from "./definition.js";

export const STATES = Object.freeze(["queued", "running", "waiting", "done", "needs", "failed", "cancelled"]);
/** A run in one of these is still the queue's business. */
export const ACTIVE = Object.freeze(["queued", "running", "waiting"]);

export const runsDir = () => `${DIR}/runs`;
export const runPath = (id) => `${DIR}/runs/${id}.json`;
export const queuePath = () => `${DIR}/queue.json`;

export const isActive = (run) => ACTIVE.includes(run?.state);

/** A run as it is queued: at the definition's start, with nothing saved yet. */
export function newRun({ definition, input, number, costCapUsd, now = new Date().toISOString(), id = newRunId() }) {
  return {
    id,
    workflow: definition.id,
    version: definition.version,
    name: definition.name,
    number,
    input: typeof input === "string" ? input : "",
    state: "queued",
    step: definition.start,
    reason: "",
    vars: {},
    history: [],
    cost: 0,
    costCapUsd,
    conversations: [],
    createdAt: now,
    updatedAt: now,
  };
}

/** A copy without `vars`, which is what every list and every event carries. */
export function withoutVars(run) {
  if (!run) return run;
  const { vars, ...rest } = run;
  return structuredClone(rest);
}

/** Newest first: by creation time, then by number, so the runs of one enqueue keep their order. */
export const newestFirst = (a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? "") || (b.number ?? 0) - (a.number ?? 0);
export const oldestFirst = (a, b) => -newestFirst(a, b);

export async function readRun(home, id) {
  if (!isRunId(id)) return null;
  const run = await readJson(home, runPath(id), null);
  return run && run.id === id ? run : null;
}

export async function writeRun(home, run) {
  await writeJson(home, runPath(run.id), run);
}

/** Every run on disk. Files that are not `r_<10 hex>.json`, or do not parse, are skipped. */
export async function readRuns(home) {
  const ids = (await list(home, runsDir())).filter((n) => n.endsWith(".json")).map((n) => n.slice(0, -5)).filter(isRunId);
  const runs = await Promise.all(ids.map((id) => readRun(home, id)));
  return runs.filter((r) => r && STATES.includes(r.state));
}

export async function readQueue(home) {
  const q = await readJson(home, queuePath(), null);
  return { paused: q?.paused === true };
}

export async function writeQueue(home, queue) {
  await writeJson(home, queuePath(), { paused: queue.paused === true });
}
