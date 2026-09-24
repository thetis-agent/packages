/* Names the conversations a workflow run opened. A run sends its title as the first line of a new
 * conversation, but the sidebar's derived title is the first message with its newlines collapsed (the
 * kernel's summary), so the title ran into the prompt. The page keeps names in its own store, reachable
 * only from a signed-in page, so this module does the naming: whenever the list shows a conversation that
 * nobody named and this page has not asked about, it reads the service's `titles` map once and names
 * those conversations through the page's own title route. A name the person gave is never touched. */

/** The ids to name: unnamed sessions this page has not checked yet. Pure, so it is tested without a DOM. */
export function toCheck(sessions, checked) {
  return (Array.isArray(sessions) ? sessions : []).filter((s) => s && typeof s.id === "string" && !s.named && !checked.has(s.id)).map((s) => s.id);
}

/** The names to apply from the service's map, for the ids just checked. */
export function toName(ids, titles) {
  return ids.filter((id) => typeof titles?.[id] === "string" && titles[id].trim()).map((id) => ({ id, title: titles[id].trim() }));
}

const MAX_RETRIES = 5;

export function nameRunConversations(ext, { post = defaultPost, delayMs = 800, retryMs = 3000 } = {}) {
  const RETRY_MS = retryMs;
  const checked = new Set();
  let timer = null;
  let retries = 0;

  async function pass() {
    const ids = toCheck(ext.sessions?.list?.(), checked);
    if (!ids.length) return;
    for (const id of ids) checked.add(id);
    let titles;
    try {
      titles = (await ext.request("call", { args: { op: "titles" } }))?.data ?? {};
    } catch {
      // The service is not up yet (a reload), or refused: ask again later, not only on the next list change.
      for (const id of ids) checked.delete(id);
      retries += 1;
      if (retries <= MAX_RETRIES) {
        clearTimeout(timer);
        timer = setTimeout(() => void pass(), RETRY_MS * retries);
      }
      return;
    }
    retries = 0;
    for (const { id, title } of toName(ids, titles)) {
      try {
        await post(id, title);
      } catch (err) {
        console.error(`workflows: could not name conversation ${id}:`, err);
      }
    }
  }

  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void pass(), delayMs);
  };
  ext.sessions?.watch?.(schedule);
  schedule();
}

/** The page's own rename route, relative to its `<base>`. */
async function defaultPost(id, title) {
  const res = await fetch(`api/sessions/${encodeURIComponent(id)}/title`, {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ title }),
  });
  if (!res.ok) throw new Error(`the page refused the name (${res.status})`);
}
