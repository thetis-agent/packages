import { SYSTEM_USER, type KernelRpc, type UserRecord, type UserRole, type UserStatus } from "@thetis/contracts";
import { CodedError } from "@thetis/lib/error";
import type { KernelServices } from "./kernel.js";

type Args = Record<string, string | undefined>;

/**
 * Operator scope: everything the command line does, against one running kernel. The same handler serves
 * an in-process kernel, the control socket, and an admin's fence through `operator.*`, so every path
 * runs the same checks and leaves the same journal rows.
 */
export function createControlHandler(k: KernelServices): KernelRpc {
  return async (method, raw, emit) => {
    const a = (raw ?? {}) as Args;
    const user = () => String(a.user ?? SYSTEM_USER);
    const us = () => k.sessions.userspaceFor(k.users.authorize(user()));
    /** Who performs the operation: the named actor (an admin over the operator channel, the operator from the CLI), else the target user. */
    const actor = () => k.users.authorize(String(a.actor ?? user()));
    /** Every operator act leaves one row, with who did it and to whom. */
    const journal = (kind: string, target: string, data?: Record<string, unknown>) => {
      k.journal.append({ kind, actor: String(a.actor ?? "operator"), target, data });
    };
    switch (method) {
      case "ping":
        return "pong";
      case "users.list":
        return k.users.list();
      case "users.create": {
        const rec = k.users.create(String(a.id), a.role as UserRole | undefined);
        journal("user.create", rec.id, { role: rec.role });
        await k.services.ensure(rec.id);
        return rec;
      }
      case "users.remove":
        await k.removeUser(String(a.id));
        journal("user.remove", String(a.id));
        return null;
      case "users.setStatus":
        journal("user.status", String(a.id), { status: a.status });
        return k.users.setStatus(String(a.id), a.status as UserStatus);
      case "users.setRole":
        journal("user.role", String(a.id), { role: a.role });
        return k.users.setRole(String(a.id), a.role as UserRole);
      case "users.passwd":
        await k.auth.setPassword(String(a.id), String(a.password));
        journal("user.password", String(a.id));
        return null;
      case "packages.list":
        return k.packages.installed(us());
      case "packages.install": {
        const info = await k.packages.install(us(), actor(), String(a.source));
        journal("package.install", user(), { name: info.name, version: info.version, source: String(a.source) });
        return info;
      }
      case "packages.uninstall":
        await k.packages.uninstall(us(), String(a.name));
        journal("package.uninstall", user(), { name: String(a.name) });
        return null;
      case "packages.promote": {
        const owner = us();
        const promoted = k.packages.promote(owner, String(a.name));
        await k.packages.uninstall(owner, String(a.name));
        const userspaces = await installEverywhere(k, promoted);
        journal("package.promote", user(), { name: String(a.name), promoted, userspaces });
        return { name: promoted, userspaces };
      }
      case "packages.installEveryone":
        return installEveryone(k, actor(), String(a.source), journal);
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
        for await (const event of k.sessions.send(user(), String(a.session), String(a.input), { model: a.model || undefined })) emit?.(event);
        return null;
      }
      default:
        throw new CodedError(`unknown control method: ${method}`, "rpc");
    }
  };
}

type JournalFn = (kind: string, target: string, data?: Record<string, unknown>) => void;

/**
 * Makes a package the default for everyone. A shipped system package is marked and linked into every
 * person. Anything else is installed for the actor first and then promoted, which copies it under
 * @thetis for everyone.
 */
async function installEveryone(k: KernelServices, who: UserRecord, source: string, journal: JournalFn): Promise<{ name: string; userspaces: string[] }> {
  if (k.packages.systemPackageDir(source)) {
    // Link first: the registry record the mark lives on exists only once someone has the package.
    const userspaces = await installEverywhere(k, source);
    k.packages.markEveryone(source, true);
    journal("package.everyone", source, { userspaces });
    return { name: source, userspaces };
  }
  const own = k.sessions.userspaceFor(who);
  const info = await k.packages.install(own, who, source);
  if (info.name.startsWith("@thetis/")) {
    const userspaces = await installEverywhere(k, info.name);
    journal("package.everyone", info.name, { source, userspaces });
    return { name: info.name, userspaces };
  }
  const promoted = k.packages.promote(own, info.name);
  await k.packages.uninstall(own, info.name);
  const userspaces = await installEverywhere(k, promoted);
  journal("package.promote", who.id, { name: info.name, promoted, source, userspaces });
  return { name: promoted, userspaces };
}

/** Installs a system package into every existing person's userspace. */
async function installEverywhere(k: KernelServices, name: string): Promise<string[]> {
  const system = k.users.authorize(SYSTEM_USER);
  const done: string[] = [];
  for (const u of k.users.list()) {
    if (u.role === "system" || !k.userspaces.exists(u.id)) continue;
    await k.packages.install(k.userspaces.pathFor(u.id), system, name);
    done.push(u.id);
  }
  return done;
}

const SECRET = /key|secret|token|password/i;

/** A copy of a value with every string under a secret-looking key replaced, for display. */
export function redact<T>(value: T, key = ""): T {
  if (typeof value === "string") return (SECRET.test(key) && value ? "•••" : value) as T;
  if (Array.isArray(value)) return value.map((v) => redact(v, key)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)])) as T;
  return value;
}
