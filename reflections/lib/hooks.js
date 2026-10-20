// The two session hooks the web gateway calls, as the person, with this package's configuration.
//
// `archive` runs after the mark is written, for an archive and for a restore. It is fast and never calls
// a model: it writes the record that tells the service what to do, `queued` or `skipped` with the reason,
// and on a restore turns a reflection that has not finished into `cancelled`. A done reflection stays.
//
// `forget` answers the dialog's preview with what this package holds about the conversations, and on the
// forget removes it: the records, the reflections, the exported evidence, and the lessons when the person
// left that box ticked. Both are idempotent: a missing file is fine, and only what was there is reported.
import { exists, remove } from "./files.js";
import { listLessons, removeLessons } from "./lessons.js";
import { contextDir, freshRecord, isSessionId, markOf, lessonsFrom, projectOf, readLessonsIndex, readRecord, readSwitches, recordPath, reflectionPath, settingsOf, titleOf, writeRecord } from "./records.js";

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
  const index = await readLessonsIndex(home);
  const lessons = lessonsFrom(index, sessions);
  const present = (await listLessons(home)).filter((l) => lessons.includes(l.id) && l.present).map((l) => l.id);
  const held = [];
  for (const s of sessions) if ((await exists(home, recordPath(s))) || (await exists(home, reflectionPath(s))) || (await exists(home, contextDir(s)))) held.push(s);

  if (args?.phase === "preview") {
    const items = [];
    if (held.length) items.push({ id: "reflection", label: "Its reflection and the evidence exported for it", optional: false });
    if (present.length) items.push({ id: "lessons", label: `${plural(present.length, "lesson")} came from this conversation`, optional: true, default: true });
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
  if (lessons.length) {
    if (args?.options?.lessons === true) {
      const gone = await removeLessons(home, lessons);
      if (gone.length) removed.push(plural(gone.length, "lesson") + " it taught");
    } else if (present.length) {
      kept.push(`${plural(present.length, "lesson")} it taught ${present.length === 1 ? "stays" : "stay"} in your skills`);
    }
  }
  return { removed, kept };
}
