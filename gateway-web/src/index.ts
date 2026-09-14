// Web gateway: a service package that runs inside each person's own fence. The userspace agent calls
// `startService` when the fence opens; the server then serves that person's UI on a unix socket in the
// userspace's `run/` directory, which the door on the host routes `/<person>/` to.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Service } from "@thetis/contracts";
import { createGateway } from "./server.js";
import { GatewayStore } from "./store.js";

export { createGateway, type GatewayOptions, type SessionSummary } from "./server.js";
export { GatewayStore, ArchiveStore } from "./store.js";
export { TurnHub, type TurnMessage, type RunningTurn } from "./turns.js";
export { clientFromRpc } from "./client.js";

export const SOCKET = "web.sock";

export const startService: Service = async (env) => {
  const user = process.env.THETIS_USER ?? "";
  if (!user) throw new Error("THETIS_USER is not set; the gateway does not know whom it serves");
  const dir = resolve(env.root, "run");
  mkdirSync(dir, { recursive: true });
  const socket = resolve(dir, SOCKET);
  rmSync(socket, { force: true });
  const server = createGateway(env.kernel, new GatewayStore(resolve(env.cwd, "gateway-web")), { log: env.log, env, user, base: `/${user}` });
  await new Promise<void>((done, fail) => server.once("error", fail).listen(socket, done));
  chmodSync(socket, 0o660);
  env.log(`serving /${user}/ on ${socket}`);
  return { stop: () => new Promise<void>((done) => server.close(() => done())) };
};
