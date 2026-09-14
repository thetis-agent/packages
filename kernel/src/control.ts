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
    /** Who performs the operation: the named actor (an admin over the operator channel, the operator from the CLI), else the target user. */
    const actor = () => k.users.authorize(String(a.actor ?? user()));
    /** Installs a system package into every existing person's userspace. */
    const everywhere = async (name: string): Promise<string[]> => {
      const system = k.users.authorize("_system");
      const done: string[] = [];
      for (const u of k.users.list()) {
        if (u.role === "system" || !k.userspaces.exists(u.id)) continue;
        await k.packages.install(k.userspaces.pathFor(u.id), system, name);
        done.push(u.id);
      }
      return done;
    };
    /** Every operator act leaves one row, with who did it and to whom. */
    const journal = (kind: string, target: string, data?: Record<string, unknown>) => k.journal.append({ kind, actor: String(a.actor ?? "operator"), target, data });
    switch (method) {
      case "ping":
        return "pong";
      case "users.list":
        return k.users.list();
      case "users.create": {
        const rec = k.users.create(String(a.id), a.role as "admin" | "user" | undefined);
        journal("user.create", rec.id, { role: rec.role });
        await k.services.ensure(rec.id);
        return rec;
      }
      case "users.remove":
        await k.removeUser(String(a.id));
        return journal("user.remove", String(a.id)), null;
      case "users.setStatus":
        return journal("user.status", String(a.id), { status: a.status }), k.users.setStatus(String(a.id), a.status as "active" | "suspended");
      case "users.setRole":
        return journal("user.role", String(a.id), { role: a.role }), k.users.setRole(String(a.id), a.role as "admin" | "user");
      case "users.passwd":
        await k.auth.setPassword(String(a.id), String(a.password));
        return journal("user.password", String(a.id)), null;
      case "packages.list":
        return k.packages.installed(us());
      case "packages.install": {
        const info = await k.packages.install(us(), actor(), String(a.source));
        return journal("package.install", user(), { name: info.name, version: info.version, source: String(a.source) }), info;
      }
      case "packages.uninstall":
        await k.packages.uninstall(us(), String(a.name));
        return journal("package.uninstall", user(), { name: String(a.name) }), null;
      case "packages.promote": {
        const owner = us();
        const promoted = k.packages.promote(owner, String(a.name));
        await k.packages.uninstall(owner, String(a.name));
        const userspaces = await everywhere(promoted);
        journal("package.promote", user(), { name: String(a.name), promoted, userspaces });
        return { name: promoted, userspaces };
      }
      case "packages.installEveryone": {
        // A shipped system package is marked for everyone and linked into every person. Anything else is
        // installed for the actor first and then promoted, which copies it under @thetis for everyone.
        const source = String(a.source);
        if (k.packages.systemPackageDir(source)) {
          k.packages.markEveryone(source, true);
          const userspaces = await everywhere(source);
          journal("package.everyone", source, { userspaces });
          return { name: source, userspaces };
        }
        const who = actor();
        const own = k.sessions.userspaceFor(who);
        const info = await k.packages.install(own, who, source);
        if (info.name.startsWith("@thetis/")) {
          const userspaces = await everywhere(info.name);
          journal("package.everyone", info.name, { source, userspaces });
          return { name: info.name, userspaces };
        }
        const promoted = k.packages.promote(own, info.name);
        await k.packages.uninstall(own, info.name);
        const userspaces = await everywhere(promoted);
        journal("package.promote", who.id, { name: info.name, promoted, source, userspaces });
        return { name: promoted, userspaces };
      }
      case "journal.tail":
        return k.journal.tail(Math.min(1000, Number(a.limit ?? 200) || 200), { actor: a.actor_filter, target: a.target, kind: a.kind });
      case "config.get":
        return redact(k.config);
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

const SECRET = /key|secret|token|password/i;

/** A copy of a value with every string under a secret-looking key replaced, for display. */
export function redact<T>(value: T, key = ""): T {
  if (typeof value === "string") return (SECRET.test(key) && value ? "•••" : value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)])) as T;
  return value;
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
