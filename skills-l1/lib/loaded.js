// What the model loaded in a conversation, one file per session under the home. A tool cannot write
// `harness`, so the tool records the load here and the prompt step reads it back on the next turn to put
// the body into the prefix; the record carries the content hash, so the dock can tell when a pack changed
// under a loaded skill.
export const DIR = "skills-l1/loaded";

export const loadedPath = (session) => `${DIR}/${session}.json`;

const idOf = (session) => (typeof session === "string" ? session : session?.id) || "";

/** `[{ id, contentHash, at }]` for the session, or an empty list. */
export async function readLoaded(env, session) {
  const id = idOf(session);
  if (!id) return [];
  let text;
  try {
    text = await env.readFile(loadedPath(id));
  } catch (e) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list.filter((x) => x && typeof x.id === "string") : [];
  } catch {
    return [];
  }
}

export async function writeLoaded(env, session, list) {
  const id = idOf(session);
  if (!id) throw new Error("load_skill needs a session");
  await env.writeFile(loadedPath(id), `${JSON.stringify(list, null, 2)}\n`);
}
