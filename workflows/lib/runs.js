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

/** An ended run whose cost reached its cap: it stopped there, and a retry under the same cap stops at once. */
export const atCap = (run) => !isActive(run) && Number(run?.costCapUsd) > 0 && Number(run?.cost) >= Number(run.costCapUsd);

/**
 * The inputs one enqueue makes runs of. `text` input is one run. `lines` input is one run per non-empty line,
 * and a line that is nothing but links (two pasted with no newline between them, or with spaces) is a run
 * per link: a glued pair would otherwise reach the first step as one link that names neither page.
 */
export function inputsOf(definition, text) {
  if (definition?.input?.kind === "text") return text.trim() ? [text] : [];
  return text.split(/\r?\n/).flatMap((line) => {
    const t = line.trim();
    if (!t) return [];
    const parts = t.split(/\s+/).flatMap((p) => p.split(/(?=https?:\/\/)/)).filter(Boolean);
    return parts.length > 1 && parts.every((p) => /^https?:\/\/\S+$/.test(p)) ? parts : [t];
  });
}

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

/** `{ paused, reason? }`: `reason` is set only when the queue paused itself, and goes when it is resumed. */
export async function readQueue(home) {
  const q = await readJson(home, queuePath(), null);
  const paused = q?.paused === true;
  return paused && typeof q.reason === "string" && q.reason ? { paused, reason: q.reason } : { paused };
}

export async function writeQueue(home, queue) {
  const paused = queue.paused === true;
  await writeJson(home, queuePath(), paused && queue.reason ? { paused, reason: queue.reason } : { paused });
}
