// Web gateway: a service package. The userspace agent of the system userspace calls `startService`
// when the fence opens; the server then serves the browser UI and reaches the kernel over the fence's RPC.
import { resolve } from "node:path";
import type { AddressInfo } from "node:net";
import type { Service } from "@thetis/kernel";
import { createGateway } from "./server.js";
import { ArchiveStore } from "./store.js";

export { createGateway, type GatewayOptions, type SessionSummary } from "./server.js";
export { ArchiveStore } from "./store.js";
export { TurnHub, type TurnMessage, type RunningTurn } from "./turns.js";
export { clientFromRpc } from "./client.js";

export const startService: Service = async (env) => {
  const host = typeof env.config.host === "string" ? env.config.host : "127.0.0.1";
  const port = typeof env.config.port === "number" ? env.config.port : 8777;
  const server = createGateway(env.kernel, new ArchiveStore(resolve(env.cwd, "gateway-web")), { log: env.log, secure: env.config.secure === true });
  await new Promise<void>((done, fail) => server.once("error", fail).listen(port, host, done));
  env.log(`listening on http://${host}:${(server.address() as AddressInfo).port}`);
  return { stop: () => new Promise<void>((done) => server.close(() => done())) };
};
