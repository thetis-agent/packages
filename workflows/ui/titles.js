/* Names the conversations a workflow run opened, and gives each the model the run last used in it. A run
 * sends its title as the first line of a new conversation, but the sidebar's derived title is the first
 * message with its newlines collapsed (the kernel's summary), so the title ran into the prompt; and a turn
 * the page only watched carries no model, so the row showed none and the pill offered the default. The page
 * keeps names and models in its own store, reachable only from a signed-in page, so this module does it:
 * whenever the list shows a conversation that lacks a name or a model and this page has not asked about,
 * it reads the service's `conversations` map once and applies what is missing through the page's own
 * routes. The model is set without becoming the person's default for new conversations (`remember: false`).
 * A name or model the person chose is never changed. */

/** The ids to ask about: sessions missing a name or a model that this page has not checked yet. */
export function toCheck(sessions, checked) {
  return (Array.isArray(sessions) ? sessions : [])
    .filter((s) => s && typeof s.id === "string" && (!s.named || !s.model) && !checked.has(s.id))
    .map((s) => s.id);
}

/** What to apply for the ids just checked: only what the session lacks and the run knows. */
export function toApply(ids, sessions, known) {
  const byId = new Map((Array.isArray(sessions) ? sessions : []).filter(Boolean).map((s) => [s.id, s]));
  const out = [];
  for (const id of ids) {
    const s = byId.get(id);
    const k = known?.[id];
    if (!s || !k) continue;
    const title = !s.named && typeof k.title === "string" && k.title.trim() ? k.title.trim() : undefined;
    const model = !s.model && typeof k.model === "string" && k.model.trim() ? k.model.trim() : undefined;
    if (title || model) out.push({ id, ...(title ? { title } : {}), ...(model ? { model } : {}) });
  }
  return out;
}

const MAX_RETRIES = 5;

export function nameRunConversations(ext, { post = defaultPost, delayMs = 800, retryMs = 3000 } = {}) {
  const checked = new Set();
  let timer = null;
  let retries = 0;

  async function pass() {
    const sessions = ext.sessions?.list?.();
    const ids = toCheck(sessions, checked);
    if (!ids.length) return;
    for (const id of ids) checked.add(id);
    let known;
    try {
      known = (await ext.request("call", { args: { op: "conversations" } }))?.data ?? {};
    } catch {
      // The service is not up yet (a reload), or refused: ask again later, not only on the next list change.
      for (const id of ids) checked.delete(id);
      retries += 1;
      if (retries <= MAX_RETRIES) {
        clearTimeout(timer);
        timer = setTimeout(() => void pass(), retryMs * retries);
      }
      return;
    }
    retries = 0;
    for (const change of toApply(ids, sessions, known)) {
      try {
        await post(change);
      } catch (err) {
        console.error(`workflows: could not name conversation ${change.id}:`, err);
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

/** The page's own routes, relative to its `<base>`. */
async function defaultPost({ id, title, model }) {
  const send = async (route, body) => {
    const res = await fetch(`api/sessions/${encodeURIComponent(id)}/${route}`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`the page refused the ${route} (${res.status})`);
  };
  if (title) await send("title", { title });
  if (model) await send("model", { model, remember: false });
}
