// Builds the fence-side kernel client over a raw RPC function. The userspace agent has its own copy of this
// shape; this one serves tests and any host that runs the gateway in-process against `createRpcHandler`.
import type { KernelClient, KernelRpc, TurnEvent } from "@thetis/kernel";

export function clientFromRpc(rpc: KernelRpc): KernelClient {
  const call = <T>(method: string, args: unknown, emit?: (e: unknown) => void) => rpc(method, args, emit) as Promise<T>;
  return {
    packages: {
      install: (source) => call("packages.install", { source }),
      uninstall: (name) => call("packages.uninstall", { name }),
      list: () => call("packages.list", {}),
    },
    operator: {
      call: (method, args, onEvent) => call(`operator.${method}`, args ?? {}, onEvent),
    },
    sessions: {
      create: (parent) => call("sessions.create", { parent }),
      ask: (session, input) => call("sessions.ask", { session, input }),
      send: (session, input, onEvent, opts) => call("sessions.send", { session, input, model: opts?.model }, (e) => onEvent(e as TurnEvent)),
      cancel: (session) => call("sessions.cancel", { session }),
      list: () => call("sessions.list", {}),
      inspect: (session) => call("sessions.inspect", { session }),
    },
    models: () => call("models", {}),
  auth: {
      login: (id, password) => call("auth.login", { id, password }),
      authenticate: (token) => call("auth.authenticate", { token }),
      logout: (token) => call("auth.logout", { token }),
    },
  };
}
