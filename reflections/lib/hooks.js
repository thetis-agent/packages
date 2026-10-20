// The two session hooks the web gateway calls, as the person, with this package's configuration.
//
// `archive` runs after the mark is written, for an archive and for a restore. It is fast and never calls
// a model: it writes the record that tells the service what to do, `queued` or `skipped` with the reason,
// and on a restore turns a reflection that has not finished into `cancelled`. A done reflection stays.
//
// `forget` answers the dialog's preview with what this package holds about the conversations, and on the
// forget removes it: the records, the reflections, the exported evidence, this conversation's sightings in
// the findings, and the proposals that came only from it when the person left that box ticked (with their
// trials). An adopted change stays, and the dialog says so. Both are idempotent: a missing file is fine,
// and only what was there is reported.
import { exists, remove } from "./files.js";
import { forgetInLibrary, forgetPlan } from "./library.js";
import { contextDir, freshRecord, isSessionId, markOf, projectOf, readRecord, readSwitches, recordPath, reflectionPath, settingsOf, titleOf, writeRecord } from "./records.js";

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const idOf = (s) => (typeof s === "string" ? s : s && typeof s === "object" && typeof s.id === "string" ? s.id : "");

/**
 * What an archive of conversation `s` should write, decided from facts alone so a test needs no kernel:
 * `{ state: "queued" }` or `{ state: "skipped", reason }`, or null when the record already says enough.
 */
export function decideArchive({ record, turns, enabled, minTurns, projectOff }) {
  if (record && ["queued", "running", "done"].includes(record.state)) return null;
  if (!enabled) return { state: "skipped", reason: "switched off in the Reflections settings" };
  if (projectOff) return { state: "skipped", reason: "switched off for this project" };
  if (turns < minTurns) return { state: "skipped", reason: `too short (${plural(turns, "turn")})` };
  return { state: "queued" };
}

/** `archive({ session, archived, archivedAt }, env)`. */
export async function onArchive(args, env) {
  const home = env.cwd;
  const s = idOf(args?.session) || idOf(env.session);
  if (!isSessionId(s)) return;
  const record = await readRecord(home, s);

  if (args?.archived === false) {
    if (record && (record.state === "queued" || record.state === "running")) {
      await writeRecord(home, { ...record, state: "cancelled", reason: "restored before it ran", updatedAt: new Date().toISOString() });
    }
    return;
  }

  const list = await env.kernel.sessions.list();
  const summary = list.find((x) => x.id === s);
  // A subagent is archived with its parent and reflected inside its parent's reflection, never alone.
  if (!summary || summary.parent) return;
  const settings = settingsOf(env.config);
  const project = await projectOf(home, s);
  const switches = await readSwitches(home);
  // The gateway runs a hook the way it runs a tool, so the person is `env.session.user`; a UI command's env says `user`.
  const mark = await markOf(home, env.user ?? env.session?.user, s);
  const decision = decideArchive({ record, turns: summary.turns ?? 0, enabled: settings.enabled, minTurns: settings.minTurns, projectOff: !!project && switches[project] === false });
  if (!decision) return;
  const base = { session: s, title: titleOf(mark, summary), project };
  await writeRecord(home, freshRecord(base, decision.state, { archivedAt: typeof args?.archivedAt === "string" ? args.archivedAt : new Date().toISOString(), ...(decision.reason ? { reason: decision.reason } : {}) }));
}

/** `forget({ phase, session, sessions, options }, env)`. */
export async function forgetSession(args, env) {
  const home = env.cwd;
  const sessions = (Array.isArray(args?.sessions) && args.sessions.length ? args.sessions : [args?.session]).map(idOf).filter(isSessionId);
  const plan = await forgetPlan(home, sessions);
  const held = [];
  for (const s of sessions) if ((await exists(home, recordPath(s))) || (await exists(home, reflectionPath(s))) || (await exists(home, contextDir(s)))) held.push(s);

  if (args?.phase === "preview") {
    const items = [];
    if (held.length) items.push({ id: "reflection", label: "Its reflection and the evidence exported for it", optional: false });
    if (plan.removable.length) items.push({ id: "proposals", label: `${plural(plan.removable.length, "proposal")} came only from this conversation`, optional: true, default: true });
    if (plan.findings.length) items.push({ id: "findings", label: `Its sightings in ${plural(plan.findings.length, "finding")}`, optional: false });
    return { items };
  }

  if (args?.phase !== "forget") return {};
  const removed = [];
  const kept = [];
  for (const s of held) {
    await remove(home, recordPath(s));
    await remove(home, reflectionPath(s));
    await remove(home, `reflections/${s}`);
  }
  if (held.length) removed.push(held.length === 1 ? "its reflection" : `the reflections of ${held.length} conversations`);
  const wantProposals = args?.options?.proposals !== false;
  const done = await forgetInLibrary(home, sessions, { proposals: wantProposals, kernel: env.kernel, user: env.user ?? env.session?.user, log: env.log ?? ((l) => console.error(l)) });
  if (done.removed) removed.push(`${plural(done.removed, "proposal")} it led to`);
  else if (!wantProposals && plan.removable.length) kept.push(`${plural(plan.removable.length, "proposal")} it led to ${plan.removable.length === 1 ? "stays" : "stay"} in Reflections`);
  if (done.findingsTouched) removed.push(`its sightings in ${plural(done.findingsTouched, "finding")}`);
  if (plan.adopted.length) kept.push(`${plural(plan.adopted.length, "adopted change")} it led to ${plan.adopted.length === 1 ? "stays" : "stay"}; retire ${plan.adopted.length === 1 ? "it" : "them"} in Reflections`);
  return { removed, kept };
}
