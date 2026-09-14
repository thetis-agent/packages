import { resolve } from "node:path";

/** Where the running kernel listens for the command line. Access is by file permission, like the rest of the data directory. */
export function controlSocketPath(home: string): string {
  return resolve(home, "thetis.sock");
}
