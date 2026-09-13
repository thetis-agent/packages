import type { KernelRpc } from "./fence/fence.js";
import type { PackageManager } from "./packages/manager.js";
import type { SessionApi } from "./sessions/api.js";
import type { Userspace } from "./types.js";
import type { UserStore } from "./users.js";
import { KernelError } from "./util.js";

type Args = Record<string, string | undefined>;

/**
 * What code inside a fence may ask the kernel to do. Every method acts as the fence's own
 * user, so a package can only ever install into its own scope or spawn its own sessions.
 */
export function createRpcHandler(us: Userspace, users: UserStore, packages: PackageManager, sessions: SessionApi): KernelRpc {
  return async (method, raw) => {
    const args = (raw ?? {}) as Args;
    const actor = users.authorize(us.id);
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
      case "sessions.list":
        return sessions.list(us.id);
      case "sessions.inspect":
        return sessions.inspect(us.id, String(args.session));
      default:
        throw new KernelError(`unknown kernel method: ${method}`, "rpc");
    }
  };
}
