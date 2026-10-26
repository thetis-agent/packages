/* What a run says about each step of its graph, and the run's own state in words. DOM-free. A run's
 * `history` is the steps in the order they ran (a loop repeats them); `step` is the current step while
 * running or waiting, else the last one. */

/** The run states, as the chip says them and the tone it takes. */
export const RUN_STATES = {
  queued: { label: "queued", tone: "dim" },
  running: { label: "running", tone: "accent" },
  waiting: { label: "waiting for you", tone: "warn" },
  done: { label: "done", tone: "ok" },
  needs: { label: "needs you", tone: "warn" },
  failed: { label: "failed", tone: "err" },
  cancelled: { label: "cancelled", tone: "dim" },
};

export const ACTIVE = new Set(["queued", "running", "waiting"]);
export const ENDED = new Set(["done", "needs", "failed", "cancelled"]);

export const runLabel = (state) => RUN_STATES[state]?.label ?? String(state ?? "unknown");
export const runTone = (state) => RUN_STATES[state]?.tone ?? "dim";

/**
 * The status of every step of `def` in `run`: `done`, `running`, `waiting`, `failed`, `skipped`, `needs`,
 * `cancelled`, `queued` or `idle` (not reached). A step's own latest history entry decides, and the
 * current step then takes the run's state: running pulses, an approval waits, and a run that ended at a
 * step it had not finished marks that step with how it ended.
 */
export function nodeStatuses(run, def) {
  const out = {};
  for (const id of Object.keys(def?.steps ?? {})) out[id] = "idle";
  const history = Array.isArray(run?.history) ? run.history : [];
  for (const h of history) if (h && h.step in out) out[h.step] = h.status === "running" ? "running" : h.status || "done";
  const cur = run?.step;
  if (cur && cur in out) {
    if (run.state === "running") out[cur] = "running";
    else if (run.state === "waiting") out[cur] = "waiting";
    else if (run.state === "queued") out[cur] = out[cur] === "idle" ? "queued" : out[cur];
    else if (ENDED.has(run.state)) {
      const endStep = run.state === "needs" && def.steps[cur]?.type === "needs";
      // A step that failed stays failed, and one that finished stays done, unless it is the needs step the run ended on.
      if (out[cur] !== "failed" && (out[cur] !== "done" || endStep)) out[cur] = run.state;
    }
  }
  // A running entry left behind by a run that is no longer running is not running: say it was interrupted.
  if (run && run.state !== "running") for (const id of Object.keys(out)) if (out[id] === "running") out[id] = "cancelled";
  return out;
}

/** How many times each step ran, for the "×2" on a node a loop took twice. */
export function visitCounts(run) {
  const out = {};
  for (const h of run?.history ?? []) if (h?.step) out[h.step] = (out[h.step] ?? 0) + 1;
  return out;
}

/** The `from>to` pairs the run actually took, from consecutive history entries: the path to highlight. */
export function pathTaken(run) {
  const out = new Set();
  const h = (run?.history ?? []).filter((x) => x?.step);
  for (let i = 1; i < h.length; i++) out.add(`${h[i - 1].step}>${h[i].step}`);
  const last = h[h.length - 1]?.step;
  if (last && run?.step && run.step !== last) out.add(`${last}>${run.step}`);
  return out;
}

/** The steps a retry can start from: every step of the definition, the one the run stopped at first. */
export function retryChoices(run, def) {
  const ids = Object.keys(def?.steps ?? {});
  const at = run?.step && ids.includes(run.step) ? run.step : null;
  return at ? [at, ...ids.filter((id) => id !== at)] : ids;
}

/**
 * The cap a retry needs, or null when the run did not stop at its cap. A run that spent its cap stops again
 * at once under the same one, so Retry offers the spend plus the original cap, in whole dollars.
 */
export function retryCap(run) {
  const cap = Number(run?.costCapUsd);
  const cost = Number(run?.cost);
  if (!ENDED.has(run?.state) || !(cap > 0) || !(cost >= cap)) return null;
  return Math.ceil(cost + cap);
}

/** The share of the cap spent, 0..1, or null without a cap. */
export function costShare(run) {
  const cap = Number(run?.costCapUsd);
  if (!Number.isFinite(cap) || cap <= 0) return null;
  return Math.max(0, Math.min(1, Number(run?.cost ?? 0) / cap));
}

/** "cost unknown for 2 turns": the turns of a run or a step whose model reported no cost, or null when there are none. */
export function unknownCostNote(of) {
  const n = Math.max(0, Math.floor(Number(of?.unknownCostTurns) || 0));
  return n ? `cost unknown for ${n} turn${n === 1 ? "" : "s"}` : null;
}

/**
 * What the meter says under the total when some turns reported no cost. With a cap it says the cap cannot see
 * them: the cap counts reported costs alone, so a run on such a model can spend past it unstopped.
 */
export function capNote(run) {
  const note = unknownCostNote(run);
  if (!note) return null;
  return costShare(run) == null ? note : `${note}; the cap cannot see ${Number(run.unknownCostTurns) === 1 ? "it" : "them"}`;
}

/** Milliseconds a history entry took, or has taken so far when it is still going. */
export function entryMs(entry, now = Date.now()) {
  if (Number.isFinite(entry?.ms)) return entry.ms;
  const start = Date.parse(entry?.startedAt);
  if (!Number.isFinite(start)) return null;
  if (!entry?.endedAt && entry?.status !== "running") return null; // finished, but the end was not recorded
  const end = entry?.endedAt ? Date.parse(entry.endedAt) : now;
  return Number.isFinite(end) ? Math.max(0, end - start) : null;
}
