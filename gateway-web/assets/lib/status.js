/* The facts along the foot of the page, worked out away from the DOM.
 *
 * views/statusbar.js draws; this decides. Everything below is a pure function of the frames the
 * host sends — `env-status`, `system-status`, `env-logs` — plus how many of this person's
 * conversations are working right now, which is the client's own knowledge and moves faster than
 * any poll. Split out for the same reason lib/dispatch.js is: there is no DOM harness in this
 * repository, and the part of a status bar worth testing is the wording and the arithmetic, not
 * the spans. status.checks.mjs covers it, and can only do that because nothing here touches
 * `document`. Keep it that way — an import of ./dom.js would take the checks with it.
 *
 * Every function returns null rather than a placeholder when its datum is missing. A bar carrying
 * three true things is worth more than one carrying nine dashes, and the host genuinely does
 * withhold things: a deployment need not offer environment status at all, and a platform need not
 * be able to say what its load average is.
 *
 * One rule governs every string returned from this file: it is read by somebody who never asked to
 * learn how any of this works. The kernel's own state words are translated here, once, and the
 * machine vocabulary stops at this line.
 */

/** How often the bar re-asks while the tab is on screen. */
export const POLL_MS = 10_000;

/** How many lines of environment output to ask for. The host caps this again; so does the kernel. */
export const LOG_ROWS = 120;

/* The environment's own states, said plainly. These are the words a person sees; the machine's
 * names for them (which include every term the house style bans from a screen) stay on this side
 * of the map and go no further. An unknown state falls back to readiness, because a newer host
 * inventing a state must not blank the item. */
const ENV_WORDS = {
  LIVE: "ready",
  QUIESCING: "pausing",
  FROZEN: "paused",
  APPLYING: "updating",
  PROBING: "checking the update",
  SWITCHING: "switching over",
  DRAINING: "finishing up",
  ROLLING_BACK: "putting the old setup back",
  FAILED: "stopped",
};

/** The environment item: whose environment it is, and a word for how it is doing. */
export function describeEnv(env) {
  if (!env) return null;
  const word = ENV_WORDS[env.state] || (env.ready ? "ready" : "not ready");
  return {
    name: env.target || "environment",
    word,
    tone: env.ready ? null : env.state === "FAILED" ? "err" : "warn",
    title: env.ready
      ? `The environment your conversations run in is ${word}.`
      : `The environment your conversations run in is ${word}.${env.reason ? ` ${env.reason}` : ""}`,
  };
}

/* The dot and the word at the far left: one glance, the whole machine.
 *
 * `working` is counted by the client rather than read off the last poll, so the dot moves the
 * instant a turn starts instead of up to ten seconds later. Everything else follows the
 * environment, because an environment that is not running is the only thing here that stops a
 * person getting work done. */
export function describeOverall(env, working) {
  if (working > 0) {
    return { word: "working", tone: "warn", title: working === 1 ? "A turn is running." : `${working} turns are running.` };
  }
  if (!env) return { word: "connecting", tone: null, title: "Waiting for the first word about this environment." };
  if (env.ready) return { word: "running", tone: "ok", title: "Nothing is running and the environment is ready." };
  if (env.state === "FAILED") {
    return { word: "problem", tone: "err", title: env.reason || "The environment your conversations run in has stopped." };
  }
  return { word: "updating", tone: "warn", title: `The environment your conversations run in is ${ENV_WORDS[env.state] || "not ready"}.` };
}

/** The version of the setup this deployment runs, when the host knows one. */
export function describeSetup(system) {
  const value = system?.setup;
  return typeof value === "string" && value ? value : null;
}

/** The version of Thetis serving this page. */
export function describeAgent(system) {
  const value = system?.agent;
  return typeof value === "string" && value ? value : null;
}

/** How many conversations this socket holds open, and how many of them are mid-turn. */
export function describeCounts(system) {
  const open = system?.conversations;
  if (!Number.isInteger(open) || open < 0) return null;
  const turns = Number.isInteger(system?.turns) && system.turns > 0 ? system.turns : 0;
  return {
    open: String(open),
    label: open === 1 ? "conversation" : "conversations",
    busy: turns > 0 ? `${turns} working` : null,
    title: `${open} conversation${open === 1 ? "" : "s"} open on this connection${turns > 0 ? `, ${turns} of them running a turn` : ""}.`,
  };
}

/* Sizes are printed with one unit for the pair — "7.5/16G" rather than "7.5G/16G" — because the
 * bar is one line and the second unit says nothing the first did not. Ten and over loses its
 * decimal: three significant figures on a memory total is noise. */
function unitOf(value) {
  if (value >= 1024 ** 3) return { divisor: 1024 ** 3, suffix: "G" };
  if (value >= 1024 ** 2) return { divisor: 1024 ** 2, suffix: "M" };
  if (value >= 1024) return { divisor: 1024, suffix: "K" };
  return { divisor: 1, suffix: "B" };
}

export function figure(value, divisor) {
  const scaled = value / divisor;
  return scaled >= 10 ? String(Math.round(scaled)) : scaled.toFixed(1);
}

/** A single size, for prose rather than the paired meter label. */
export function bytes(value) {
  const unit = unitOf(value);
  return `${figure(value, unit.divisor)}${unit.suffix}`;
}

/* Memory in use against the whole machine. The host sends what is *available* rather than what is
 * free, and the difference matters: free ignores page cache the kernel would hand back on demand,
 * so a healthy machine reports a frightening number. Used is what is left over. */
export function describeMemory(host) {
  const total = host?.memTotal;
  const available = host?.memAvailable;
  if (!(total > 0) || !(available >= 0) || available > total) return null;
  const used = total - available;
  const fraction = used / total;
  const unit = unitOf(total);
  return {
    text: `${figure(used, unit.divisor)}/${figure(total, unit.divisor)}${unit.suffix}`,
    percent: Math.min(100, Math.round(fraction * 100)),
    tone: fraction > 0.9 ? "err" : fraction > 0.75 ? "warn" : null,
    title: `${bytes(used)} of ${bytes(total)} in use across this machine, ${bytes(available)} still free.`,
  };
}

/* How much work is queued for the processors. Above one job per core means things are waiting for
 * a turn on the CPU, which is what a long-running build looks like from here. */
export function describeLoad(host) {
  const load = host?.load1;
  const cores = host?.cpus;
  if (typeof load !== "number" || !Number.isFinite(load) || load < 0 || !(cores > 0)) return null;
  const fraction = load / cores;
  return {
    text: load.toFixed(2),
    percent: Math.min(100, Math.round(fraction * 100)),
    tone: fraction > 1 ? "err" : fraction > 0.7 ? "warn" : null,
    title: `About ${load.toFixed(2)} jobs waiting on ${cores} processor${cores === 1 ? "" : "s"}.${
      fraction > 1 ? " More work is queued than the machine can run at once, so everything is slower." : ""
    }`,
  };
}

/** Whether recent environment output can be asked for at all. */
export function canShowLogs(env) {
  return Boolean(env?.logs);
}

/* One line of environment output.
 *
 * Deliberately verbatim, the way views/environment.js keeps the host's failure reason verbatim: a
 * log is the one place a person goes when the plain-language summary above it was not enough, and
 * a line this view paraphrased could disagree with what actually happened. The chrome around it is
 * plain; the rows are the machine's own words.
 *
 * The timestamp is wall-clock milliseconds from the kernel's journal. Anything that is not a
 * plausible date shows the line's number instead, which is at least true. */
export function describeLogRow(row, index) {
  const at = typeof row?.at === "number" && row.at > 946684800000 ? new Date(row.at) : null;
  return {
    at: at ? at.toTimeString().slice(0, 8) : `#${row?.cursor ?? index}`,
    kind: typeof row?.kind === "string" ? row.kind : "",
    detail: logDetail(row?.data),
  };
}

/** The row's fields on one line, cut at a width the bar's panel can hold. */
export function logDetail(data, max = 200) {
  if (!data || typeof data !== "object") return "";
  const parts = [];
  let width = 0;
  for (const [key, value] of Object.entries(data)) {
    const rendered = `${key}=${value !== null && typeof value === "object" ? JSON.stringify(value) : String(value)}`;
    parts.push(rendered);
    width += rendered.length + 1;
    if (width > max) break;
  }
  const text = parts.join(" ");
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/** What the log panel says when it has nothing to show, which is never a blank panel. */
export function describeLogs(logs) {
  if (!logs) return { note: "Asking the environment for recent activity…", rows: [] };
  const rows = Array.isArray(logs.rows) ? logs.rows : [];
  if (!rows.length) return { note: "This environment has not recorded anything yet.", rows: [] };
  return {
    note: logs.truncated ? `Showing the last ${rows.length} lines; there are older ones.` : `Showing all ${rows.length} recorded lines.`,
    rows: rows.map((row, index) => describeLogRow(row, index)),
  };
}
