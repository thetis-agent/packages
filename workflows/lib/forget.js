// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. A run keeps three things about a conversation it
// opened: its id (in `conversations` and on the step's history line), the title it gave it (`titles`), and
// its own step results (`vars`, `activity`). Only the title is the conversation's; the rest is the run's
// record of its own work, so it stays and the receipt says so.
//
// The runs live in the service's memory and are written from there, so a title is removed through the
// service's `forgetConversations` op whenever the service answers: a file rewritten behind its back would be
// written over by the next change to that run. When nothing listens on the socket (ENOENT, ECONNREFUSED) no
// service holds the runs and the files are rewritten here, whole and renamed into place as the service
// writes them. A service that is there but does not answer keeps the titles, and the receipt says so.
//
// Preview blocks while a run that uses one of the conversations is still going (queued, running or waiting):
// deleting a conversation under a run would fail its next step for a reason nobody would recognise.
import { connect } from "./client.js";
import { isActive, readRuns, writeRun } from "./runs.js";

/** How long the hook waits for the service before it treats it as not answering. */
export const FORGET_TIMEOUT_MS = 5000;
const NOT_LISTENING = new Set(["ENOENT", "ECONNREFUSED"]);

/** `{ result }` when the service answered, `{ down: true }` when nothing listens, else `{ error }`. */
async function ask(env, op, args, timeoutMs) {
  let conn;
  try {
    conn = await connect(env.root ?? env.cwd);
  } catch (e) {
    return NOT_LISTENING.has(e?.code) ? { down: true } : { error: e };
  }
  let timer;
  try {
    const late = new Promise((_, fail) => {
      timer = setTimeout(() => fail(new Error(`the workflow service did not answer in ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
    });
    return { result: await Promise.race([conn.request(op, args), late]) };
  } catch (e) {
    return { error: e };
  } finally {
    clearTimeout(timer);
    conn.close();
  }
}

const usesAny = (run, ids) => (run.conversations ?? []).some((s) => ids.has(s)) || Object.keys(run.titles ?? {}).some((s) => ids.has(s));
const label = (run) => `${run.name || run.workflow || "a workflow"} #${run.number ?? "?"}`;
const runs = (n) => `${n} workflow run${n === 1 ? "" : "s"}`;

/** The runs, as the service holds them when it answers, else as they are on disk. */
async function currentRuns(env, timeoutMs) {
  const live = await ask(env, "runs", { limit: 1000 }, timeoutMs);
  if (Array.isArray(live.result)) return live.result;
  return readRuns(env.cwd);
}

/** Removes the titles from the run files directly. Only for when no service is listening. */
async function scrubFiles(env, ids) {
  let titles = 0;
  const used = [];
  for (const run of await readRuns(env.cwd)) {
    if (!usesAny(run, ids)) continue;
    used.push(run);
    const named = Object.keys(run.titles ?? {}).filter((s) => ids.has(s));
    if (!named.length) continue;
    for (const s of named) delete run.titles[s];
    titles += named.length;
    await writeRun(env.cwd, run);
  }
  return { titles, runs: used };
}

/**
 * `thetis.sessions.forget({ phase, session, sessions, options }, env)`. Preview answers a `block` while a run
 * that uses any of `sessions` is active; forget removes the titles runs gave them. Idempotent.
 */
export async function forgetSession(args, env, { timeoutMs = FORGET_TIMEOUT_MS } = {}) {
  const ids = new Set((Array.isArray(args?.sessions) ? args.sessions : []).filter((s) => typeof s === "string" && s));
  if (args?.phase === "preview") {
    const active = (await currentRuns(env, timeoutMs)).filter((r) => isActive(r) && usesAny(r, ids));
    if (!active.length) return {};
    const named = active.slice(0, 3).map(label).join(", ") + (active.length > 3 ? `, and ${active.length - 3} more` : "");
    return { block: `A workflow run that uses this conversation is still going (${named}). Cancel it or let it finish, then forget the conversation.` };
  }
  if (args?.phase !== "forget") return {};
  const answer = await ask(env, "forgetConversations", { sessions: [...ids] }, timeoutMs);
  let done;
  if (answer.result) done = answer.result;
  else if (answer.down) done = await scrubFiles(env, ids);
  else {
    const said = answer.error?.message ?? String(answer.error);
    // A service started before this version has no such op; it gets it at its next reload.
    const why = /no op named/.test(said) ? "the workflow service is older than this version of @thetis/workflows and has not been reloaded" : said;
    return { removed: [], kept: [`Titles that workflow runs gave this conversation stay in their records: ${why.replace(/\.$/, "")}.`] };
  }
  done.runs.sort((a, b) => (a.number ?? 0) - (b.number ?? 0));
  const removed = done.titles ? [`${done.titles} conversation title${done.titles === 1 ? "" : "s"} that workflow runs kept.`] : [];
  const kept = done.runs.length ? [`${runs(done.runs.length)} (${done.runs.slice(0, 3).map(label).join(", ")}${done.runs.length > 3 ? ", …" : ""}) keep${done.runs.length === 1 ? "s" : ""} ${done.runs.length === 1 ? "its" : "their"} own record of the steps that ran in it.`] : [];
  return kept.length ? { removed, kept } : { removed };
}
