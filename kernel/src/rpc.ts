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
 * What code inside a fence may ask the kernel to do. Every method acts as the fence's own user, so a
 * package can only ever install into its own scope or drive its own sessions. The system userspace is
 * the one exception: a gateway there authenticates a person and then names them with `as`. When that
 * person is an admin, the gateway may also call operator methods (`operator.<method>`), the same
 * table the command line uses; the kernel checks the role, so a gateway hiding a button is a courtesy.
 */
export function createRpcHandler(us: Userspace, users: UserStore, packages: PackageManager, sessions: SessionApi, auth: AuthService, operator?: KernelRpc): KernelRpc {
  const system = () => assert(us.id === SYSTEM_USER, "only the system userspace may do this", "unauthorized");
  return async (method, raw, emit) => {
    const args = (raw ?? {}) as Args;
    const actor = users.authorize(us.id);
    const as = (): string => {
      if (args.as === undefined) return us.id;
      system();
      return String(args.as);
    };
    /** The userspace a package call targets: the fence's own, or the named user's when a system gateway acts for them. */
    const target = () => (args.as === undefined ? { us, actor } : { us: sessions.userspaceFor(users.authorize(as())), actor: users.authorize(as()) });
    if (method.startsWith(OPERATOR)) {
      system();
      assert(operator, "no operator channel is configured", "rpc");
      assert(users.authorize(String(args.as)).role !== "user", "only an admin may use operator methods", "unauthorized");
      const { as: actor, ...rest } = args;
      return operator(method.slice(OPERATOR.length), { ...rest, actor }, emit);
    }
    switch (method) {
      case "packages.install": {
        const t = target();
        return packages.install(t.us, t.actor, String(args.source));
      }
      case "packages.uninstall":
        return packages.uninstall(target().us, String(args.name));
      case "packages.list":
        return packages.installed(target().us);
      case "sessions.create":
        return sessions.create(as(), { parent: args.parent });
      case "sessions.ask":
        return sessions.ask(as(), String(args.session), String(args.input));
      case "sessions.send": {
        for await (const event of sessions.send(as(), String(args.session), String(args.input))) emit?.(event);
        return null;
      }
      case "sessions.cancel":
        return sessions.cancel(as(), String(args.session));
      case "sessions.list":
        return sessions.list(as());
      case "sessions.inspect":
        return sessions.inspect(as(), String(args.session));
      case "auth.login": {
        system();
        const r = await auth.login(String(args.id), String(args.password));
        return r ? { token: r.token, user: { id: r.user.id, role: r.user.role } } : null;
      }
      case "auth.authenticate": {
        system();
        const user = auth.authenticate(String(args.token));
        return user ? { id: user.id, role: user.role } : null;
      }
      case "auth.logout":
        system();
        return auth.logout(String(args.token));
      default:
        throw new KernelError(`unknown kernel method: ${method}`, "rpc");
    }
  };
}
