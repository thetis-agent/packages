// The other end of `host.js`, used by both processes that need it: the five tools, which run in the
// userspace agent, and the ui commands, which run in the person's gateway. Neither can hold a session in
// module state, so both ask the one process that does.
//
// The whole file is here so that the failure has one wording. A socket that is missing or refuses means
// the terminal service is not running in this workspace, and that is a thing a person can act on — turn
// the package on, or wait for the fence to finish opening — so it is said that way rather than as ENOENT.
import { createConnection } from "node:net";
import { resolve } from "node:path";
import { SOCKET } from "./host.js";

const notRunning = (path, why) =>
  new Error(
    `the terminal service is not running in this workspace (nothing is listening on ${path}${why ? `: ${why}` : ""}). ` +
      "It starts with the fence, so either the fence is still opening or @thetis/terminal is not installed for this person.",
  );

/**
 * Connect to the session host under `root` (the userspace root: the socket is `<root>/run/term.sock`).
 *
 * @returns `{ socket, request(op, args), subscribe(from, onEvent, opts), close() }`. One connection
 *          carries both request/answer traffic and, once subscribed, the unsolicited events.
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
        continue; // the host speaks JSON lines; a line that is not one is not ours to interpret
      }
      if (message.ev) {
        for (const l of [...listeners]) l(message);
        continue;
      }
      const slot = pending.get(message.i);
      if (!slot) continue;
      pending.delete(message.i);
      if (message.ok) slot.done(message.result);
      else slot.fail(new Error(message.error ?? "the terminal service refused the call and said nothing."));
    }
  });

  function finish(error) {
    ended = ended ?? error ?? notRunning(path, "the connection closed");
    for (const slot of pending.values()) slot.fail(ended);
    pending.clear();
  }
  socket.on("close", () => finish(null));
  socket.on("error", (e) => finish(notRunning(path, e?.code ?? e?.message)));
  // A connection this caller closed itself is not the service being down, and must not be reported as it.
  const hungUp = () => new Error("this connection to the terminal service was closed; open another one.");

  return {
    socket: path,

    /** One request, one answer. Rejects with the host's own wording when the host refused. */
    request(op, args = {}) {
      if (ended) return Promise.reject(ended);
      const i = next++;
      return new Promise((done, fail) => {
        pending.set(i, { done, fail });
        socket.write(`${JSON.stringify({ i, op, ...args })}\n`);
      });
    },

    /**
     * Subscribe this connection to the host's events. Answers with the snapshot of every session; from
     * then on `onEvent` is called with each `{ ev, ... }` line. Returns the snapshot, not a stop function:
     * the way to stop is to `close()` the connection, because a subscribed connection is what a watcher is.
     */
    async subscribe(from, onEvent, { consumer } = {}) {
      if (typeof onEvent === "function") listeners.add(onEvent);
      return this.request("subscribe", { from, consumer });
    },

    close() {
      finish(hungUp());
      listeners.clear();
      socket.destroy();
    },
  };
}
