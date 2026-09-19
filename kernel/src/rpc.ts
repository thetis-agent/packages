import { SYSTEM_USER, type KernelRpc, type ModelChoices, type Userspace } from "@thetis/contracts";
import { assert, CodedError } from "@thetis/lib/error";
import { assertStoreDoc, storeId } from "@thetis/lib/store";
import type { KernelServices } from "./kernel.js";

type Args = Record<string, string | undefined>;

const OPERATOR = "operator.";

/** What a fence's handler needs of the kernel: identity, packages, sessions, tokens, the store and the configuration. */
export type RpcServices = Pick<KernelServices, "users" | "packages" | "sessions" | "auth" | "store" | "settings">;

/**
 * What code inside a fence may ask the kernel to do. Identity is the fence: every method acts as the
 * userspace's own user, so a package can only install into its own scope, drive its own sessions, and
 * resolve login tokens that name its own user. An admin's fence may also call operator methods
 * (`operator.<method>`, the table the command line uses); the kernel checks the role, so a gateway
 * hiding a button is a courtesy. The system userspace alone may log people in.
 */
export function createRpcHandler(us: Userspace, k: RpcServices, operator?: KernelRpc, models?: (us: Userspace) => Promise<ModelChoices>): KernelRpc {
  const system = us.id === SYSTEM_USER;
  return async (method, raw, emit, signal) => {
    const args = (raw ?? {}) as Args;
    const actor = k.users.authorize(us.id);
    if (method.startsWith(OPERATOR)) {
      assert(operator, "no operator channel is configured", "rpc");
      assert(actor.role !== "user", "only an admin may use operator methods", "unauthorized");
      return operator(method.slice(OPERATOR.length), { ...args, actor: us.id }, emit);
    }
    // The fence names its package and a sub-namespace; the prefix is the kernel's, so nothing a fence sends can leave its own tree.
    const space = () => k.store.open(storeId("userspaces", us.id, String(args.package ?? ""), args.namespace ?? "default"));
    /** A fence configures only what is installed in it; the system fence's own layer is the system layer. */
    const target = () => {
      const name = String(args.name);
      assert(k.packages.installed(us).some((p) => p.name === name), `${name} is not installed in ${us.id}`, "not-found");
      return { name, ...(system ? {} : { user: us.id }) };
    };
    switch (method) {
      case "packages.install":
        return k.packages.install(us, actor, String(args.source));
      case "packages.uninstall":
        return k.packages.uninstall(us, String(args.name));
      case "packages.delete":
        return k.packages.delete(us, String(args.name));
      case "packages.list":
        return k.packages.installed(us);
      case "sessions.create":
        return k.sessions.create(us.id, { parent: args.parent });
      case "sessions.ask":
        return k.sessions.ask(us.id, String(args.session), String(args.input));
      case "sessions.send": {
        for await (const event of k.sessions.send(us.id, String(args.session), String(args.input), { model: args.model || undefined })) emit?.(event);
        return null;
      }
      case "models":
        assert(models, "no model list is configured", "rpc");
        return models(us);
      case "sessions.cancel":
        return k.sessions.cancel(us.id, String(args.session));
      case "sessions.list":
        return k.sessions.list(us.id);
      case "sessions.inspect":
        return k.sessions.inspect(us.id, String(args.session));
      case "sessions.watch":
        return k.sessions.watch(us.id, (m) => emit?.(m), signal);
      case "store.get":
        return (await space().get(String(args.key))) ?? null;
      case "store.set": {
        const doc = (raw as { doc?: unknown }).doc;
        assertStoreDoc(doc);
        await space().set(String(args.key), doc);
        return null;
      }
      case "store.delete":
        await space().delete(String(args.key));
        return null;
      case "store.list":
        return space().list(args.prefix);
      case "store.clear":
        await space().clear();
        return null;
      case "config.show":
        return k.settings.show(target());
      case "config.set":
        return k.settings.set(target(), String(args.key), (raw as { value?: unknown }).value, us.id, true);
      case "config.unset":
        return k.settings.unset(target(), String(args.key), us.id);
      case "config.effective":
        return k.settings.effective(us, target().name);
      case "auth.login": {
        assert(system, "only the system userspace may log people in", "unauthorized");
        const r = await k.auth.login(String(args.id), String(args.password));
        return r ? { token: r.token, user: { id: r.user.id, role: r.user.role } } : null;
      }
      case "auth.authenticate": {
        const user = k.auth.authenticate(String(args.token));
        return user && (system || user.id === us.id) ? { id: user.id, role: user.role } : null;
      }
      case "auth.logout": {
        const user = k.auth.authenticate(String(args.token));
        if (user && (system || user.id === us.id)) k.auth.logout(String(args.token));
        return null;
      }
      default:
        throw new CodedError(`unknown kernel method: ${method}`, "rpc");
    }
  };
}
