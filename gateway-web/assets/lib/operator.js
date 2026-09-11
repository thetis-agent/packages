/* What the control panel computes, kept apart from what it draws.
 *
 * Everything here is a pure function of frames the host sent. Nothing touches `document`, for the
 * same reason lib/dispatch.js does not: there is no DOM harness in this repository, and the parts
 * with branches worth testing are exactly the parts that need no document to decide. The drawing
 * lives in views/admin.js, views/packages.js and views/installing.js; the decisions live here.
 *
 * The other reason this file exists is the vocabulary. The kernel's own words for a change in flight
 * are a state machine's, and a person must never see them — so the mapping from those words to
 * sentences sits in one table, once, where it can be read and checked, rather than scattered through
 * three views where one of them would eventually say the wrong thing. docs/08-vocabulary.md is the
 * list this table is written against.
 */

/** The control panel's sections, in the order the left nav shows them.
 *
 * This table is an ordering and a wording, not a promise that any of them exist: the host says which
 * sections have something behind them in this deployment (admin.ts's `sections`), and the nav draws
 * only those. A section nothing answers is left out, never shown greyed or empty. */
export const SECTIONS = [
  { id: "settings", label: "Settings", note: "How this place is set up." },
  { id: "accounts", label: "Accounts", note: "Who can sign in, and what each of them may do." },
  { id: "models", label: "Models", note: "Which model answers, and where it runs." },
  { id: "modes", label: "Modes", note: "What the agent is allowed to change." },
  { id: "limits", label: "Limits", note: "How long an answer may run, and how much it may use." },
  { id: "spaces", label: "Spaces", note: "The folders agents can read and write." },
  { id: "updates", label: "Updates", note: "New versions, and what the checks said about them." },
  { id: "packages", label: "Packages", note: "Everything added here, and what each one brings." },
  { id: "environments", label: "Environments", note: "Your own copy of the system, and whether it is ready." },
  { id: "activity", label: "Activity", note: "What has happened to your environment, most recent first." },
  { id: "restore-points", label: "Restore points", note: "Saved states you can go back to." },
  { id: "undo", label: "Undo", note: "Put your environment back the way it was." },
];

/** The sections this deployment actually offers, in nav order. Anything the host named that this
 *  build has no wording for is dropped rather than shown under its own identifier. */
export function visibleSections(offered) {
  const named = new Set(Array.isArray(offered) ? offered : []);
  return SECTIONS.filter((entry) => named.has(entry.id));
}

/* The steps of one change, in the order they happen.
 *
 * `at` is the word the environment reports itself as being in; it is a key, never a caption. Each
 * `name` is what happens said plainly, which is the whole point: a person watching an update should
 * learn what is going on and nothing about how it is built. */
export const STAGES = [
  {
    at: "QUIESCING",
    name: "Finishing what's running",
    note: "Your conversations stay open. Anything you send now waits until this is done.",
  },
  {
    at: "FROZEN",
    name: "Saving a restore point",
    note: "Your files and your settings are saved together, so going back never leaves a mismatch.",
  },
  {
    at: "APPLYING",
    name: "Installing",
    note: "Every package is checked against the copy its publisher released.",
  },
  {
    at: "PROBING",
    name: "Checking it works",
    note: "Starting each part and waiting for it to answer. If anything fails here, what you have now comes back on its own.",
  },
  {
    at: "SWITCHING",
    name: "Switching over",
    note: "New messages start using the new version.",
  },
  {
    at: "TIDYING",
    name: "Tidying up",
    note: "The version you had is kept, so you can go back to it without installing it again.",
  },
];

/* "Tidying up" has no word of its own to watch for — the environment reports the step before it and
 * then reports itself ready — so it is marked done by arrival rather than by report. */
const REPORTED = new Map(STAGES.map((stage, index) => [stage.at, index]));
REPORTED.set("DRAINING", STAGES.length - 1);

/** Nothing has started yet. `reached` is the furthest step seen, `-1` before the first one. */
export const NOT_STARTED = Object.freeze({ reached: -1, started: false, failed: false, settled: false });

/**
 * Folds one report of how the environment is doing into how far the change has got.
 *
 * Monotonic on purpose. Reports are polled, so one can be missed entirely and another can arrive out
 * of order after a reconnect; taking the furthest step seen means a missed report costs a tick of
 * detail rather than a progress bar that jumps backwards. A change is only finished once something
 * other than ready has been seen, so the ready report that precedes a change is not mistaken for the
 * one that ends it.
 *
 * @param {{reached:number,started:boolean,failed:boolean,settled:boolean}} prior
 * @param {string} reported  what the environment says it is doing
 */
export function advance(prior, reported) {
  if (reported === "FAILED") return { ...prior, started: true, failed: true, settled: true };
  if (reported === "ROLLING_BACK") return { ...prior, started: true, failed: true, settled: false };
  const step = REPORTED.get(reported);
  if (step !== undefined) return { reached: Math.max(prior.reached, step), started: true, failed: prior.failed, settled: false };
  if (reported !== "LIVE") return prior;
  if (!prior.started) return prior;
  return { ...prior, reached: prior.failed ? prior.reached : STAGES.length - 1, settled: true };
}

/** True once a change has begun but not yet landed — what decides whether the screen is up at all. */
export function inFlight(progress) {
  return progress.started && !progress.settled;
}

/**
 * The screen for one change: a headline, a sentence under it, and every step with its mark.
 *
 * The headline is the step happening now, so the sentence at the top of the page and the row that is
 * pulsing always say the same thing. A failure says what was put back rather than what broke, because
 * what a person needs from that screen is whether they still have a working setup.
 */
export function changeView(progress) {
  const steps = STAGES.map((stage, index) => ({
    name: stage.name,
    note: stage.note,
    mark: progress.failed && index > progress.reached ? "todo"
      : progress.settled && !progress.failed ? "done"
        : index < progress.reached ? "done"
          : index === progress.reached ? "live"
            : "todo",
  }));
  if (progress.failed && progress.settled) {
    return { headline: "It did not start, so what you had is back.",
      note: "Nothing was left half-applied: your files and your settings went back together.", steps, tone: "error" };
  }
  if (progress.failed) {
    return { headline: "Putting things back…",
      note: "Something did not start. What you had is coming back on its own.", steps, tone: "warn" };
  }
  if (progress.settled) {
    return { headline: "Done.", note: "Your conversations carry on where they left off.", steps, tone: "ok" };
  }
  const live = steps.find((step) => step.mark === "live");
  return { headline: live ? `${live.name}…` : "Starting…", note: live ? live.note : "", steps, tone: "busy" };
}

/** Everything installed, filtered and ordered for the table. Sorted by name so the row a person is
 *  looking at does not move when a filter changes; the scope becomes the words for it here, once. */
export function packageRows(packages, filter = "") {
  const needle = String(filter).trim().toLowerCase();
  return (Array.isArray(packages) ? packages : [])
    .filter((row) => row && typeof row.name === "string")
    .filter((row) => !needle || row.name.toLowerCase().includes(needle))
    .map((row) => ({
      name: row.name,
      version: typeof row.version === "string" ? row.version : "",
      scope: row.scope === "deployment" ? "deployment" : "person",
      scopeLabel: row.scope === "deployment" ? "Everyone" : "Only me",
      internet: row.internet === true,
      needs: Array.isArray(row.needs) ? row.needs : [],
      gives: Array.isArray(row.gives) ? row.gives : [],
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * The two ways to add a version, and whether either is offered here.
 *
 * Scope is the axis and there is no third value: a package either runs for one person or for
 * everyone, and which of the two it is comes from the package itself. "Everyone" is also the only one
 * a deployment currently answers, so the other is left out rather than shown and refused — the same
 * rule the left nav follows.
 */
export function installChoices(offered) {
  const named = new Set(Array.isArray(offered) ? offered : []);
  return [
    { scope: "person", label: "Only me", note: "Changes your own setup. Everyone else keeps the version they have.", offered: named.has("add") },
    { scope: "deployment", label: "Everyone", note: "Changes the setup everyone starts from.", offered: named.has("updates") },
  ].filter((choice) => choice.offered);
}

/* How one of the kernel's own observations reads to the person it happened to.
 *
 * The journal's row kinds and the words inside them are the kernel's; the sentences are this table's.
 * A kind with no entry here is left out of the list rather than shown under its own name — a line a
 * person cannot read is worse than a shorter list, and the rows this drops (one per message sent and
 * one per reply finished) are already visible in the conversation itself.
 */
const OBSERVED = {
  "process.start": () => ({ text: "Your environment started.", tone: "ok" }),
  "process.exit": (data) => ({ text: reasoned("Your environment stopped", data), tone: "error" }),
  "process.shutdown": (data) => ({ text: reasoned("Your environment was shut down", data), tone: "warn" }),
  "process.drain": (data) => ({
    text: data.outcome === "killed" ? "A reply was still running and was stopped." : "Replies in progress were allowed to finish.",
    tone: data.outcome === "killed" ? "warn" : "ok",
  }),
  "work.change": (data) => ({
    text: data.outcome === "live" ? "A package you are working on changed and was picked up." : "A package you are working on changed and could not be picked up.",
    tone: data.outcome === "live" ? "ok" : "error",
  }),
  "generation.transition": (data) => {
    const step = STAGES.find((stage) => stage.at === data.to);
    if (step) return { text: `${step.name}.`, tone: "busy" };
    if (data.to === "LIVE") return { text: "Your environment is ready.", tone: "ok" };
    if (data.to === "ROLLING_BACK") return { text: reasoned("Putting things back", data), tone: "warn" };
    if (data.to === "FAILED") return { text: reasoned("Your environment could not start", data), tone: "error" };
    return null;
  },
};

/* The kernel's reason is quoted rather than reworded — a reason this table paraphrased could disagree
 * with what actually went wrong, which is the same rule views/environment.js already follows — so the
 * only thing added is the full stop it may or may not already end with. */
function reasoned(lead, data) {
  const why = typeof data.reason === "string" && data.reason.trim() ? data.reason.trim() : "";
  if (!why) return `${lead}.`;
  return /[.!?]$/.test(why) ? `${lead}: ${why}` : `${lead}: ${why}.`;
}

/** Turns the rows the kernel observed about one environment into lines, newest first, dropping every
 *  row this build has no sentence for. */
export function activityLines(rows) {
  const lines = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.kind !== "string") continue;
    const read = OBSERVED[row.kind];
    const line = read ? read(row.data && typeof row.data === "object" ? row.data : {}) : null;
    if (line) lines.push({ at: typeof row.at === "number" ? row.at : 0, cursor: row.cursor, ...line });
  }
  return lines.reverse();
}
