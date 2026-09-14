// Builds the fence-side kernel client over a raw RPC function. The userspace agent has its own copy of this
// shape; this one serves tests and any host that runs the gateway in-process against `createRpcHandler`.
import type { KernelClient, KernelRpc, TurnEvent } from "@thetis/kernel";

export function clientFromRpc(rpc: KernelRpc): KernelClient {
  const call = <T>(method: string, args: unknown, emit?: (e: unknown) => void) => rpc(method, args, emit) as Promise<T>;
  return {
    packages: {
      install: (source, as) => call("packages.install", { source, as }),
      uninstall: (name, as) => call("packages.uninstall", { name, as }),
      list: (as) => call("packages.list", { as }),
    },
    operator: {
      call: (method, args, onEvent) => call(`operator.${method}`, args, onEvent),
    },
    sessions: {
      create: (parent, as) => call("sessions.create", { parent, as }),
      ask: (session, input, as) => call("sessions.ask", { session, input, as }),
      send: (session, input, onEvent, as) => call("sessions.send", { session, input, as }, (e) => onEvent(e as TurnEvent)),
      cancel: (session, as) => call("sessions.cancel", { session, as }),
      list: (as) => call("sessions.list", { as }),
      inspect: (session, as) => call("sessions.inspect", { session, as }),
    },
    auth: {
      login: (id, password) => call("auth.login", { id, password }),
      authenticate: (token) => call("auth.authenticate", { token }),
      logout: (token) => call("auth.logout", { token }),
    },
  };
}
