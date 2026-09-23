// The login target as a service package of the system userspace. It listens on `run/login.sock`; the
// door routes `/login`, `/logout` and `/` to it.
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import type { Service } from "@thetis/runtime/contracts";
import { createLogin } from "./server.js";

export { createLogin, type LoginOptions, COOKIE } from "./server.js";

export const SOCKET = "login.sock";

export const startService: Service = async (env) => {
  const dir = resolve(env.root, "run");
  mkdirSync(dir, { recursive: true });
  const socket = resolve(dir, SOCKET);
  rmSync(socket, { force: true });
  const server = createLogin(env.kernel, { log: env.log, secure: env.config.secure === true });
  await new Promise<void>((done, fail) => server.once("error", fail).listen(socket, done));
  chmodSync(socket, 0o660);
  env.log(`login on ${socket}`);
  return {
    stop: () =>
      new Promise<void>((done) => {
        // close() alone waits for every open connection, and an event stream never ends on its own.
        server.close(() => done());
        server.closeAllConnections();
      }),
  };
};
