// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. This package keeps one thing per conversation:
// its key in `projects/sessions.json`. The project itself, its instructions and its other conversations
// are the person's and stay. The map is shared by every conversation, so it is rewritten whole beside
// itself and renamed into place: a step reading it mid-forget sees the old map or the new one, never half.
import { randomBytes } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { assignmentsPath, readProject } from "./store.js";

const count = (n) => `${n} conversation${n === 1 ? "" : "s"}`;

/** `thetis.sessions.forget({ phase, session, sessions, options }, env)`: nothing to preview; on forget, the ids' keys. Idempotent. */
export async function forgetSession(args, env) {
  if (args?.phase !== "forget") return {};
  const ids = new Set((Array.isArray(args.sessions) ? args.sessions : []).filter((s) => typeof s === "string" && s));
  const file = resolve(env.cwd, assignmentsPath());
  let map;
  try {
    map = JSON.parse(await readFile(file, "utf8"));
  } catch {
    // Missing or unreadable: no conversation of these is in a project, as far as anything here can tell.
    return { removed: [] };
  }
  if (!map || typeof map !== "object" || Array.isArray(map)) return { removed: [] };
  const gone = Object.keys(map).filter((k) => ids.has(k));
  if (!gone.length) return { removed: [] };
  const byProject = new Map();
  for (const k of gone) byProject.set(map[k], (byProject.get(map[k]) ?? 0) + 1);
  for (const k of gone) delete map[k];
  const tmp = `${file}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(map, null, 2) + "\n");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  const removed = [];
  for (const [project, n] of byProject) {
    const record = await readProject(env, project).catch(() => null);
    removed.push(record ? `${count(n)} taken out of the project ${record.name}.` : `The project assignment of ${count(n)}.`);
  }
  return { removed };
}
