// The other end of `host.js`, used by the UI commands in the person's gateway. A socket that is missing
// or refuses means the workflow service is not running in this workspace, and that is something a person
// can act on, so it is said that way rather than as ENOENT.
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { SOCKET } from "./host.js";

const notRunning = (path, why) =>
  new Error(
    `the workflow service is not running in this workspace (nothing is listening on ${path}${why ? `: ${why}` : ""}). ` +
      "It starts with the fence, so either the fence is still opening or @thetis/workflows is not installed for this person.",
  );

/**
 * Connects to the service under `root` (the userspace root: the socket is `<root>/run/workflows.sock`).
 *
 * @returns `{ socket, request(op, args), subscribe(onEvent), close() }`. One connection carries both
 *          request/answer traffic and, once subscribed, the unsolicited events.
 */
export async function connect(root) {
  const path = resolve(root, "run", SOCKET);
  const socket = await new Promise((done, fail) => {
    const s = createConnection(path);
    s.once("connect", () => {
      s.removeListener("error", fail);
      done(s);
    });
    s.once("error", (e) => fail(notRunning(path, e?.code ?? e?.message)));
  });
  socket.setNoDelay(true);
  socket.setEncoding("utf8");

  const pending = new Map();
  const listeners = new Set();
  let next = 1;
  let buffer = "";
  let ended = null;

  socket.on("data", (chunk) => {
    buffer += chunk;
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      if (message.ev) {
        for (const l of [...listeners]) l(message);
        continue;
      }
      const slot = pending.get(message.i);
      if (!slot) continue;
      pending.delete(message.i);
      if (message.ok) slot.done(message.result);
      else slot.fail(new Error(message.error ?? "the workflow service refused the call and said nothing."));
    }
  });

  function finish(error) {
    ended = ended ?? error ?? notRunning(path, "the connection closed");
    for (const slot of pending.values()) slot.fail(ended);
    pending.clear();
    for (const l of [...closers]) l(ended);
  }
  const closers = new Set();
  socket.on("close", () => finish(null));
  socket.on("error", (e) => finish(notRunning(path, e?.code ?? e?.message)));
  const hungUp = () => new Error("this connection to the workflow service was closed; open another one.");

  return {
    socket: path,

    /** One request, one answer. Rejects with the service's own sentence when it refused. */
    request(op, args = {}) {
      if (ended) return Promise.reject(ended);
      const i = next++;
      return new Promise((done, fail) => {
        pending.set(i, { done, fail });
        socket.write(`${JSON.stringify({ ...args, i, op })}\n`);
      });
    },

    /** Subscribes this connection; answers `{ runs }`, then `onEvent` receives every `{ ev, ... }` line. */
    async subscribe(onEvent) {
      if (typeof onEvent === "function") listeners.add(onEvent);
      return this.request("subscribe");
    },

    /** Called once when the connection ends, for whatever reason. */
    onClose(fn) {
      if (ended) fn(ended);
      else closers.add(fn);
    },

    close() {
      finish(hungUp());
      listeners.clear();
      socket.destroy();
    },
  };
}
