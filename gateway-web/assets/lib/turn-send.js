import { api } from "./api.js";
import { store } from "./store.js";

/**
 * Sends one input and reflects its acknowledgement in the composer's running state. `input` is a string,
 * which travels as `{ text }` the way every gateway has accepted it, or a `TurnInput` message carrying
 * content parts (text and attachments), which travels as `{ input }`.
 */
export async function sendTurn(id, input) {
  const wasRunning = store.isRunning(id);
  const snapshotVersion = store.runningSnapshotVersion();
  let observed = false;
  const stop = store.watch("running", (running) => {
    if (running.has(id) !== wasRunning) observed = true;
  });
  try {
    await api(`/api/sessions/${id}/send`, { method: "POST", body: typeof input === "string" ? { text: input } : { input } });
    // A turn's events or a reconnect snapshot can arrive before its HTTP acknowledgement.
    if (!observed && store.runningSnapshotVersion() === snapshotVersion) store.mark("running", id, true);
  } finally {
    stop();
  }
}
