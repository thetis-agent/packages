/* Folds the conversations workflow runs opened into one "Workflow runs" group in the sidebar, on a gateway
 * that has `ext.sessions.group` (an older one lists them with the rest). The set comes from the service's
 * `runConversations`, read again whenever the list shows a conversation this page has not seen; when the
 * set grows the group is claimed again, which redraws it. */

/** The ids in the list this page has not seen yet: a new one may be a run's. */
export function unseen(sessions, seen) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s.id === "string" && !seen.has(s.id)).map((s) => s.id);
}

export function foldRunConversations(ext, { delayMs = 800, retryMs = 3000 } = {}) {
  if (typeof ext.sessions?.group !== "function") return null;
  const runs = new Set();
  const seen = new Set();
  const claim = () => ext.sessions.group("runs", { label: "Workflow runs", test: (s) => runs.has(s?.id) });
  let timer = null;
  let retries = 0;
  claim();

  async function pass() {
    const fresh = unseen(ext.sessions.list?.(), seen);
    if (!fresh.length) return;
    for (const id of fresh) seen.add(id);
    let ids;
    try {
      ids = (await ext.request("call", { args: { op: "runConversations" } }))?.data?.ids;
    } catch {
      // The service is not up yet (a reload), or too old to know the op: ask again a few times.
      for (const id of fresh) seen.delete(id);
      if (++retries <= 5) {
        clearTimeout(timer);
        timer = setTimeout(() => void pass(), retryMs * retries);
      }
      return;
    }
    retries = 0;
    const before = runs.size;
    for (const id of Array.isArray(ids) ? ids : []) if (typeof id === "string") runs.add(id);
    if (runs.size > before) claim();
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void pass(), delayMs);
  };
  ext.sessions.watch?.(schedule);
  schedule();
  return { has: (id) => runs.has(id) };
}
