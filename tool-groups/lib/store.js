// What tool_search leaves for the next turn. A tool cannot return harness, so it writes the groups it loaded
// to a document under `env.storage("sessions")` keyed by the session id, and the prompt step merges the
// document into the pin. The prompt step writes the active set there too, so the tool can mark the catalogue
// without seeing the harness. Nothing here is ever cleared: a loaded group stays loaded.
export const NAMESPACE = "sessions";

const clean = (doc) => {
  const active = Array.isArray(doc?.active) ? doc.active.filter((id) => typeof id === "string") : [];
  const loaded = {};
  if (doc?.loaded && typeof doc.loaded === "object" && !Array.isArray(doc.loaded)) {
    for (const [id, reason] of Object.entries(doc.loaded)) if (typeof reason === "string") loaded[id] = reason;
  }
  return { active, loaded };
};

/** The session's document, or an empty one. A missing storage (a test env, an old agent) reads as empty. */
export async function readDoc(env, sessionId) {
  if (typeof env?.storage !== "function" || !sessionId) return clean(null);
  try {
    return clean(await env.storage(NAMESPACE).get(sessionId));
  } catch {
    return clean(null);
  }
}

export async function writeDoc(env, sessionId, doc) {
  if (typeof env?.storage !== "function" || !sessionId) return false;
  await env.storage(NAMESPACE).set(sessionId, clean(doc));
  return true;
}

/** Adds `ids` under `reason` to the loaded map, keeping what is there. Returns the ids that were new. */
export async function addLoaded(env, sessionId, ids, reason) {
  const doc = await readDoc(env, sessionId);
  const added = [];
  for (const id of ids) {
    if (doc.loaded[id] || doc.active.includes(id)) continue;
    doc.loaded[id] = reason;
    added.push(id);
  }
  if (added.length) await writeDoc(env, sessionId, doc);
  return { added, doc };
}
