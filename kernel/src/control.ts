import { resolve } from "node:path";
import { SYSTEM_USER, type Fences, type KernelRpc, type PackageInfo, type UserRecord, type UserRole, type UserStatus } from "@thetis/contracts";
import { assert, CodedError } from "@thetis/lib/error";
import { newestMtime } from "@thetis/lib/freshness";
import { isSupervised } from "@thetis/lib/restart";
import { applyInPlace, classifyChanges } from "@thetis/lib/config-tiers";
import { CONFIG_TIERS, loadConfig } from "./config.js";
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
    /** The configuration layer named: a person's own, or the system layer when none or the system user is named. */
    const layer = () => (a.user && k.users.authorize(a.user).id !== SYSTEM_USER ? a.user : undefined);
    const configTarget = () => ({ name: String(a.name), user: layer() });
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
        const promoted = await k.packages.promote(owner, String(a.name));
        await k.packages.uninstall(owner, String(a.name));
        const userspaces = await installEverywhere(k, promoted);
        journal("package.promote", user(), { name: String(a.name), promoted, userspaces });
        return { name: promoted, userspaces };
      }
      case "packages.installEveryone":
        return installEveryone(k, actor(), String(a.source), journal);
      case "fence.reload": {
        // `_system` is a legal target, unlike a grant: the providers and the sign-in page live in it,
        // and are otherwise out of reach without a new daemon. `authorize` refuses the unknown and the suspended.
        const target = k.users.authorize(user());
        journal("fence.reload", target.id);
        k.providers.forget(target.id);
        await k.services.reload(target.id);
        return { user: target.id, services: serviceNames(installedIn(k, target.id)) };
      }
      case "restart.request": {
        // Only an admin, asserted here rather than left to `rpc.ts`, which admits any non-user and so admits
        // the system userspace: that fence has no business ending every turn on this host. A call with no
        // named actor came over the control socket, whose 0600 holder is the operator, as with every command.
        if (a.actor) assert(actor().role === "admin", "only an admin may restart the daemon", "unauthorized");
        const reason = String(a.reason ?? "").trim();
        assert(reason, "a restart needs a reason: it is shown to everyone waiting and recorded", "invalid");
        // The latch wrote every sentence, refusals included; passing them through is what keeps the host, the
        // page and the model reading the same words about the same latch.
        const armed = k.restart.arm(reason, String(a.actor ?? "operator"));
        journal(`restart.${armed.state}`, "daemon", { reason, ...(armed.why ? { why: armed.why } : {}) });
        return armed;
      }
      case "restart.status":
        return { ...k.restart.status(), policy: k.restartPolicy() };
      case "restart.cancel": {
        // The same assert as `restart.request`, for the same reason. Calling one off is the safer direction,
        // but an armed restart is an admin's decision and the system userspace is not one.
        if (a.actor) assert(actor().role === "admin", "only an admin may call off a restart", "unauthorized");
        const { was } = k.restart.cancel();
        // Nothing pending is not an event: only a restart actually called off leaves a row.
        if (was) journal("restart.cancel", "daemon", { reason: was.reason, by: was.by });
        return { cancelled: !!was, was: was ?? null };
      }
      case "status":
        return status(k);
      case "journal.tail":
        return k.journal.tail(Math.min(1000, Number(a.limit ?? 200) || 200), { actor: a.actor_filter, target: a.target, kind: a.kind });
      case "config.get":
        return redact(k.config);
      case "config.list":
        return k.settings.list(layer());
      case "config.show":
        return k.settings.show(configTarget());
      case "config.set":
        return k.settings.set(configTarget(), String(a.key), (raw as { value?: unknown }).value, String(a.actor ?? "operator"));
      case "config.unset":
        return k.settings.unset(configTarget(), String(a.key), String(a.actor ?? "operator"));
      case "config.reload": {
        // The whole file is read again, not only `packages[*]`. What that reaches depends on how each key
        // is consumed: `CONFIG_TIERS` says which, `applyInPlace` writes the new values into the object the
        // kernel bound at boot -- so every holder of it, and of any object inside it, sees them without
        // being handed a new reference -- and the fences are closed when a key they are built from moved.
        // Keys that are read once into a socket or a driver are named in the answer instead of silently
        // doing nothing, which is the failure this replaces.
        const next = loadConfig(k.config.home, k.config.projectRoot);
        const tiers = classifyChanges(k.config, next, CONFIG_TIERS);
        applyInPlace(k.config as unknown as Record<string, unknown>, next as unknown as Record<string, unknown>);
        const settings = await k.settings.reload(k.config.packages);
        if (tiers.fence.length) for (const u of k.users.list()) await k.services.reload(u.id);
        journal("config.reload", SYSTEM_USER, { ...tiers });
        return { ...settings, ...tiers };
      }
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
      case "sessions.delete":
        await k.sessions.delete(user(), String(a.session));
        journal("session.delete", user(), { session: String(a.session) });
        return null;
      case "sessions.send": {
        for await (const event of k.sessions.send(user(), String(a.session), String(a.input), { model: a.model || undefined })) emit?.(event);
        return null;
      }
      default: {
        // `host.<name>.<export>`: a host package's method, run by the host process. The kernel checks who
        // is calling and writes the row; what the method does and with what is the package's, so the
        // arguments are never journalled here (a key's material travels this way). Only an admin, for the
        // same reason as `restart.request`: `rpc.ts` admits the system userspace, which has no business
        // granting anything.
        const [name, exp, ...rest] = method.startsWith("host.") ? method.slice("host.".length).split(".") : [];
        if (name && exp && !rest.length) {
          if (a.actor) assert(actor().role === "admin", "only an admin may call a host package", "unauthorized");
          journal("host.call", user(), { name, method: exp });
          return k.hosts.call(name, exp, { ...(raw as Record<string, unknown> | undefined), ...(a.actor ? { actor: a.actor } : {}) });
        }
        throw new CodedError(`unknown control method: ${method}`, "rpc");
      }
    }
  };
}

type JournalFn = (kind: string, target: string, data?: Record<string, unknown>) => void;

/** The daemon's own code. A change to any of it needs a new process; a reload would not pick it up. */
const DAEMON_PACKAGES = ["kernel", "host", "sandbox", "door", "lib", "contracts", "gateway-cli"];

/** What the pool reports beyond the fence contract: when each open fence opened. One that does not keep the
 *  times (an in-process double) reports nothing open, and every row then says nothing rather than guessing. */
type OpenFences = Fences & { openedAt?(): Record<string, number> };

const installedIn = (k: KernelServices, id: string): PackageInfo[] => k.packages.installed(k.userspaces.pathFor(id));

/** The installed packages that declare a service: what a reload takes down and brings back up. */
const serviceNames = (list: PackageInfo[]): string[] => list.filter((p) => p.thetis.service).map((p) => p.name);

/** A moment as the rest of the service plane writes them, and null for one nobody knows. */
const moment = (ms: number): string | null => (ms > 0 ? new Date(ms).toISOString() : null);

/**
 * What is running, and whether it is the code on disk. `stale` is the whole point: someone who deployed and
 * saw nothing change learns here which process is still holding the code it replaced, and what to do about
 * it — a workspace reloads, the daemon needs a new process.
 */
function status(k: KernelServices): unknown {
  const startedAt = Date.now() - Math.round(process.uptime() * 1000);
  const codeAt = newestMtime(DAEMON_PACKAGES.map((name) => resolve(k.config.systemPackagesDir, name, "dist/src")));
  const opened = (k.fences as OpenFences).openedAt?.() ?? {};
  return {
    // Supervision is read here and never inside a fence: the fence hands package code an env allowlist, so a
    // tool would see no INVOCATION_ID and wrongly conclude that nothing would restart the daemon.
    // `restartPolicy` is the deployed unit's `Restart=`, not this checkout's file: it decides whether a clean
    // exit comes back, and an operator who cannot see it finds out when a restart is first attempted.
    daemon: { startedAt: moment(startedAt), uptimeSecs: Math.round(process.uptime()), supervised: isSupervised(), restartPolicy: k.restartPolicy(), codeAt: moment(codeAt), stale: codeAt > startedAt },
    // The armed restart, as the statusbar chip and `thetis restart status` show it, and null when there is none.
    restart: k.restart.status().pending ?? null,
    workspaces: k.users
      .list()
      .filter((u) => k.userspaces.exists(u.id))
      .map((u) => {
        const installed = installedIn(k, u.id);
        const openedAt = opened[u.id] ?? 0;
        const code = newestMtime(installed.map((p) => p.root));
        // A workspace with no fence open is never stale: the next request opens it on the code that is there then.
        return { user: u.id, openedAt: moment(openedAt), codeAt: moment(code), stale: openedAt > 0 && code > openedAt, services: serviceNames(installed) };
      }),
  };
}

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
  const promoted = await k.packages.promote(own, info.name);
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
