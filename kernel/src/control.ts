import { chmodSync, existsSync, unlinkSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import type { KernelRpc } from "./fence/fence.js";
import type { Kernel } from "./kernel.js";
import { KernelError } from "./util.js";

export function controlSocketPath(home: string): string {
  return resolve(home, "thetis.sock");
}

/**
 * Operator scope: everything the command line does, against one running kernel. The same handler serves
 * an in-process kernel and the control socket, so the CLI is the same code either way. Access to the
 * socket is by file permission, like the rest of the data directory.
 */
export function createControlHandler(k: Kernel): KernelRpc {
  return async (method, raw, emit) => {
    const a = (raw ?? {}) as Record<string, string | undefined>;
    const user = () => String(a.user ?? "_system");
    const us = () => k.sessions.userspaceFor(k.users.authorize(user()));
    switch (method) {
      case "ping":
        return "pong";
      case "users.list":
        return k.users.list();
      case "users.create":
        return k.users.create(String(a.id), a.role as "admin" | "user" | undefined);
      case "users.remove":
        return k.removeUser(String(a.id));
      case "users.setStatus":
        return k.users.setStatus(String(a.id), a.status as "active" | "suspended");
      case "users.setRole":
        return k.users.setRole(String(a.id), a.role as "admin" | "user");
      case "users.passwd":
        return k.auth.setPassword(String(a.id), String(a.password));
      case "packages.list":
        return k.packages.installed(us());
      case "packages.install":
        return k.packages.install(us(), k.users.authorize(user()), String(a.source));
      case "packages.uninstall":
        return k.packages.uninstall(us(), String(a.name));
      case "models":
        return k.providers.listModels(us());
      case "sessions.create":
        return k.sessions.create(user(), { parent: a.parent });
      case "sessions.list":
        return k.sessions.list(user());
      case "sessions.inspect":
        return k.sessions.inspect(user(), String(a.session));
      case "sessions.cancel":
        return k.sessions.cancel(user(), String(a.session));
      case "sessions.send": {
        for await (const event of k.sessions.send(user(), String(a.session), String(a.input))) emit?.(event);
        return null;
      }
      default:
        throw new KernelError(`unknown control method: ${method}`, "rpc");
    }
  };
}

/**
 * The control socket: newline-delimited JSON over a Unix socket, the same frames as the fence RPC
 * (`{ id, method, args }` in; `{ id, event }`* then `{ id, result }` or `{ id, error, code }` out).
 */
export class ControlServer {
  private server?: Server;

  constructor(
    private readonly path: string,
    private readonly handler: KernelRpc,
    private readonly log: (line: string) => void = () => {},
  ) {}

  async listen(): Promise<void> {
    if (existsSync(this.path)) unlinkSync(this.path);
    const server = createServer((socket) => this.serve(socket));
    await new Promise<void>((done, fail) => server.once("error", fail).listen(this.path, done));
    chmodSync(this.path, 0o600);
    this.server = server;
  }

  async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((done) => server.close(() => done()));
    if (existsSync(this.path)) unlinkSync(this.path);
  }

  private serve(socket: Socket): void {
    const write = (msg: unknown) => socket.writable && socket.write(JSON.stringify(msg) + "\n");
    createInterface({ input: socket }).on("line", (line) => {
      let msg: { id?: string; method?: string; args?: unknown };
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      const id = String(msg.id);
      this.handler(String(msg.method), msg.args, (event) => write({ id, event })).then(
        (result) => write({ id, result: result ?? null }),
        (err) => write({ id, error: err instanceof Error ? err.message : String(err), code: (err as { code?: string }).code }),
      );
    });
    socket.on("error", (err) => this.log(`[control] ${err.message}`));
  }
}
