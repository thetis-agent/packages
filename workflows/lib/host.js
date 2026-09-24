// The socket the workflow service answers on, `<root>/run/workflows.sock`, in the terminal package's
// shape: newline-delimited JSON, a request `{ i, op, ...args }`, an answer `{ i, ok: true, result }` or
// `{ i, ok: false, error }`, and, on a connection that has subscribed, events `{ ev, ... }` with no `i`.
//
// The service runs in the person's userspace agent; the UI commands run in their gateway. The socket is
// where the two meet, at mode 0600 inside the person's own userspace, so the only processes that can
// reach it are that person's. Isolation is structural, not a check.
import { createServer } from "node:net";
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createService } from "./service.js";

export const SOCKET = "workflows.sock";

/**
 * Starts the service and its socket. Resolves once the socket listens; loading the runs and resuming
 * the ones left running happen after, and every op waits for them.
 */
export async function startHost(env = {}, { user } = {}) {
  const root = env.root ?? process.cwd();
  const log = env.log ?? (() => {});
  const runDir = resolve(root, "run");
  mkdirSync(runDir, { recursive: true });
  const socketPath = resolve(runDir, SOCKET);
  rmSync(socketPath, { force: true });

  const conns = new Set();
  function broadcast(line) {
    const text = `${JSON.stringify(line)}\n`;
    for (const c of conns) if (c.subscribed && c.socket.writable) c.socket.write(text);
  }

  const service = createService({ ...env, cwd: env.cwd ?? root, log }, { broadcast, user });
  const ops = {
    ...service.ops,
    async subscribe(_args, conn) {
      if (!conn) throw new Error("subscribe needs a connection; it is not a one-shot call.");
      conn.subscribed = true;
      return { runs: service.snapshot() };
    },
  };

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    const conn = { socket, subscribed: false };
    conns.add(conn);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void handle(line, conn);
      }
    });
    const gone = () => conns.delete(conn);
    socket.on("close", gone);
    socket.on("error", gone);
  });

  const reply = (conn, message) => {
    if (conn.socket.writable) conn.socket.write(`${JSON.stringify(message)}\n`);
  };

  async function handle(line, conn) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return reply(conn, { ok: false, error: "That was not a JSON line." });
    }
    const { i, op, ...args } = request && typeof request === "object" ? request : {};
    const fn = typeof op === "string" && Object.prototype.hasOwnProperty.call(ops, op) ? ops[op] : null;
    if (!fn) return reply(conn, { i, ok: false, error: `There is no op named ${JSON.stringify(op)}; the ops are ${Object.keys(ops).join(", ")}.` });
    try {
      await service.ready;
      const result = await fn(args, conn);
      reply(conn, { i, ok: true, result });
    } catch (e) {
      reply(conn, { i, ok: false, error: e?.message ?? String(e) });
    }
  }

  await new Promise((done, fail) => server.once("error", fail).listen(socketPath, done));
  chmodSync(socketPath, 0o600);
  log(`workflows: listening on ${socketPath}`);
  void service.start();

  return {
    socket: socketPath,
    service,
    /** Closes the socket and lets go of the runs in flight without ending them: the next start resumes them. */
    async stop() {
      rmSync(socketPath, { force: true });
      for (const c of conns) c.socket.destroy();
      conns.clear();
      const closed = new Promise((done) => server.close(() => done()));
      await service.stop();
      await closed;
    },
  };
}
