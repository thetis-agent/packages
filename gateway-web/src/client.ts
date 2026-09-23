// Builds the fence-side kernel client over a raw RPC function. The userspace agent has its own copy of this
// shape; this one serves tests and any host that runs the gateway in-process against `createRpcHandler`.
import type { ProviderEvent, KernelClient, KernelRpc, TurnEvent, WatchedTurnEvent } from "@thetis/runtime/contracts";

export function clientFromRpc(rpc: KernelRpc): KernelClient {
  const call = <T>(method: string, args: unknown, emit?: (e: unknown) => void) => rpc(method, args, emit) as Promise<T>;
  return {
    packages: {
      install: (source) => call("packages.install", { source }),
      uninstall: (name) => call("packages.uninstall", { name }),
      delete: (name) => call("packages.delete", { name }),
      unfork: (name, deleteFiles) => call("packages.unfork", { name, deleteFiles }),
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
      delete: (session) => call("sessions.delete", { session }),
      list: () => call("sessions.list", {}),
      inspect: (session) => call("sessions.inspect", { session }),
      // In-process there is no fence to close: the call never settles, and the watch lives as long as the process.
      watch: (onEvent) => call("sessions.watch", {}, (e) => onEvent(e as WatchedTurnEvent)),
    },
    models: () => call("models", {}),
    providers: {
      call: (c, onEvent) => call("providers.call", { call: c }, (e) => onEvent(e as ProviderEvent)),
    },
    config: {
      show: (name) => call("config.show", { name }),
      set: (name, key, value) => call("config.set", { name, key, value }),
      unset: (name, key) => call("config.unset", { name, key }),
      effective: (name) => call("config.effective", { name }),
    },
    auth: {
      login: (id, password) => call("auth.login", { id, password }),
      authenticate: (token) => call("auth.authenticate", { token }),
      logout: (token) => call("auth.logout", { token }),
    },
  };
}
