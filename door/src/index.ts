// The door: the one host port. It copies bytes between the browser and unix sockets it never
// authenticates against: `/login`, `/logout` and `/` go to the login target, `/<person>/...` goes to
// that person's own gateway. A path prefix is routing, never authority; each gateway rechecks the
// cookie with the kernel, which answers a fence only about its own user.
import { request as httpRequest, createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";

export interface DoorOptions {
  /** The unix socket of the login target. */
  loginSocket: string;
  /** The unix socket of a person's gateway, or undefined when there is no such person. */
  socketFor(user: string): string | undefined;
  log?: (line: string) => void;
}

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const HOP = new Set(["connection", "keep-alive", "proxy-connection", "transfer-encoding", "upgrade", "te", "trailer"]);

export function createDoor(opts: DoorOptions): Server {
  const log = opts.log ?? (() => {});
  const server = createServer((req, res) => route(req, res));
  server.requestTimeout = 0;
  server.headersTimeout = 65_000;
  // close() alone waits for every open connection, and an event stream through the door never ends on its
  // own. The door closes them itself; each response then fires `close`, which tears down its upstream request.
  const close = server.close.bind(server);
  server.close = (cb) => {
    close(cb);
    server.closeAllConnections();
    return server;
  };

  function route(req: IncomingMessage, res: ServerResponse): void {
    const path = (req.url ?? "/").split("?")[0];
    if (path === "/" || path === "/login" || path === "/logout" || path.startsWith("/login/")) return forward(req, res, opts.loginSocket, "the login page");
    const user = path.split("/")[1] ?? "";
    const socket = USER_ID.test(user) ? opts.socketFor(user) : undefined;
    if (!socket) return reply(res, 404, "There is nobody here by that name.");
    if (path === `/${user}`) {
      res.writeHead(303, { Location: `/${user}/` });
      res.end();
      return;
    }
    forward(req, res, socket, `${user}'s gateway`);
  }

  function forward(req: IncomingMessage, res: ServerResponse, socketPath: string, what: string): void {
    if (!existsSync(socketPath)) return reply(res, 503, `${what} is not running.`);
    const headers: Record<string, string | string[] | undefined> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    const up = httpRequest({ socketPath, path: req.url, method: req.method, headers }, (upstream) => {
      const out: Record<string, string | string[] | undefined> = {};
      for (const [k, v] of Object.entries(upstream.headers)) if (!HOP.has(k.toLowerCase())) out[k] = v;
      res.writeHead(upstream.statusCode ?? 502, out);
      upstream.pipe(res);
      upstream.on("error", () => res.end());
    });
    up.on("error", (err) => {
      log(`[door] ${req.method} ${req.url} -> ${socketPath}: ${err.message}`);
      if (!res.headersSent) reply(res, 502, `${what} did not answer.`);
      else res.end();
    });
    req.pipe(up);
    res.on("close", () => up.destroy());
  }

  return server;
}

function reply(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text + "\n");
}
