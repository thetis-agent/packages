import type { AuthService } from "./auth.js";
import type { KernelRpc } from "./fence/fence.js";
import type { PackageManager } from "./packages/manager.js";
import type { SessionApi } from "./sessions/api.js";
import { SYSTEM_USER, type Userspace } from "./types.js";
import type { UserStore } from "./users.js";
import { assert, KernelError } from "./util.js";

type Args = Record<string, string | undefined>;

const OPERATOR = "operator.";

/**
 * What code inside a fence may ask the kernel to do. Identity is the fence: every method acts as the
 * userspace's own user, so a package can only install into its own scope, drive its own sessions, and
 * resolve login tokens that name its own user. An admin's fence may also call operator methods
 * (`operator.<method>`, the table the command line uses); the kernel checks the role, so a gateway
 * hiding a button is a courtesy. The system userspace alone may log people in.
 */
export function createRpcHandler(us: Userspace, users: UserStore, packages: PackageManager, sessions: SessionApi, auth: AuthService, operator?: KernelRpc): KernelRpc {
  const system = us.id === SYSTEM_USER;
  return async (method, raw, emit) => {
    const args = (raw ?? {}) as Args;
    const actor = users.authorize(us.id);
    if (method.startsWith(OPERATOR)) {
      assert(operator, "no operator channel is configured", "rpc");
      assert(actor.role !== "user", "only an admin may use operator methods", "unauthorized");
      return operator(method.slice(OPERATOR.length), { ...args, actor: us.id }, emit);
    }
    switch (method) {
      case "packages.install":
        return packages.install(us, actor, String(args.source));
      case "packages.uninstall":
        return packages.uninstall(us, String(args.name));
      case "packages.list":
        return packages.installed(us);
      case "sessions.create":
        return sessions.create(us.id, { parent: args.parent });
      case "sessions.ask":
        return sessions.ask(us.id, String(args.session), String(args.input));
      case "sessions.send": {
        for await (const event of sessions.send(us.id, String(args.session), String(args.input))) emit?.(event);
        return null;
      }
      case "sessions.cancel":
        return sessions.cancel(us.id, String(args.session));
      case "sessions.list":
        return sessions.list(us.id);
      case "sessions.inspect":
        return sessions.inspect(us.id, String(args.session));
      case "auth.login": {
        assert(system, "only the system userspace may log people in", "unauthorized");
        const r = await auth.login(String(args.id), String(args.password));
        return r ? { token: r.token, user: { id: r.user.id, role: r.user.role } } : null;
      }
      case "auth.authenticate": {
        const user = auth.authenticate(String(args.token));
        return user && (system || user.id === us.id) ? { id: user.id, role: user.role } : null;
      }
      case "auth.logout": {
        const user = auth.authenticate(String(args.token));
        if (user && (system || user.id === us.id)) auth.logout(String(args.token));
        return null;
      }
      default:
        throw new KernelError(`unknown kernel method: ${method}`, "rpc");
    }
  };
}
