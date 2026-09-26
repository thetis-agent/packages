// The two files of this package, under `effort/` in the person's home and written only by its own
// commands: `sessions.json` maps a session id to the effort chosen for it, and `prefs.json` holds the
// choice made last, which is what a conversation without a choice of its own gets, so a person who
// always wants "low" says so once. Reads and writes go through the fence environment (`readFile`,
// `writeFile`, relative to the home), so the step and the commands use the same door. A missing file is
// an empty value, never an error: a person who never touched the pill is the normal case.

export const DIR = "effort";
export const sessionsPath = () => `${DIR}/sessions.json`;
export const prefsPath = () => `${DIR}/prefs.json`;

/** Every effort the gateway knows, highest first. `none` turns thinking off. */
export const EFFORTS = Object.freeze(["max", "xhigh", "high", "medium", "low", "minimal", "none"]);

export const isEffort = (value) => typeof value === "string" && EFFORTS.includes(value);

async function readJson(env, path) {
  let text;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if (e?.code === "ENOENT") return {};
    throw e;
  }
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}

const writeJson = (env, path, value) => env.writeFile(path, JSON.stringify(value, null, 2) + "\n");

/** The session map, with anything that is not a known effort dropped. */
export async function readSessions(env) {
  const raw = await readJson(env, sessionsPath());
  return Object.fromEntries(Object.entries(raw).filter(([, v]) => isEffort(v)));
}

/** The remembered choice, or null. */
export async function readRemembered(env) {
  const raw = await readJson(env, prefsPath());
  return isEffort(raw.default) ? raw.default : null;
}

/**
 * What the step sends for a session: its own choice, else the remembered one, else nothing.
 * `source` says which, so a page can tell a choice made here from one inherited.
 */
export async function effortOf(env, session) {
  const sessions = await readSessions(env);
  const own = session ? sessions[session] : undefined;
  if (own) return { effort: own, source: "session" };
  const remembered = await readRemembered(env);
  if (remembered) return { effort: remembered, source: "remembered" };
  return { effort: null, source: null };
}

/**
 * Records a choice. An empty `effort` means the default again: the session's entry goes, and with
 * `remember` so does the remembered choice, exactly as the model picker treats "Default".
 */
export async function setEffort(env, session, effort, remember = true) {
  if (effort !== "" && effort !== null && !isEffort(effort)) throw new Error(`"${effort}" is not an effort; one of ${EFFORTS.join(", ")}, or empty for the default`);
  const chosen = effort || null;
  const sessions = await readSessions(env);
  if (chosen) sessions[session] = chosen;
  else delete sessions[session];
  await writeJson(env, sessionsPath(), sessions);
  if (remember) await writeJson(env, prefsPath(), chosen ? { default: chosen } : {});
  return chosen;
}
