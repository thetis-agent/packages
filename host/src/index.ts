// What a process that runs Thetis needs: a kernel wired to the sandbox, and the control socket for the CLI.
export { createKernel, T, type Kernel } from "./kernel.js";
export { controlSocketPath } from "./control.js";
export { RpcSocketServer as ControlServer } from "@thetis/lib/ndjson-socket";
