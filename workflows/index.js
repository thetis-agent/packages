// Entry point: the workflow service, and the two UI commands the Workflows place sends. The mechanism is
// under `lib/`: `host.js` (the socket), `service.js` (definitions, runs, the queue), `engine.js` (one run,
// step by step), `validate.js`, `template.js`, `definition.js`, `runs.js`.
//
// A UI command answers a program: `{ data }`, because the gateway keeps `text` and `data` and drops every
// other field, and a thrown error is a 400 with its sentence. The stream yields values and closes its
// connection when the browser lets go.
import { connect } from "./lib/client.js";
import { startHost } from "./lib/host.js";

/** How long a watching stream may hear nothing before it asks the service whether it is still there. */
export const HEARTBEAT_MS = 20_000;

const OPS = new Set(["list", "get", "create", "save", "publish", "remove", "validate", "enqueue", "runs", "run", "cancel", "retry", "approve", "queue", "catalog"]);

/**
 * The service. `env` is the `ServiceEnv`. Resolves as soon as the socket listens: the runs are loaded, and
 * the ones a stopped service left running are resumed, after it has returned.
 */
export async function startWorkflows(env) {
  const host = await startHost(env);
  return { stop: () => host.stop() };
}

/** call: `args: { op, ...args }`, answered `{ data: result }`. */
export async function uiCall(args, env) {
  const { op, ...rest } = args && typeof args === "object" ? args : {};
  if (typeof op !== "string" || !op) throw new Error(`op is required: one of ${[...OPS].join(", ")}.`);
  if (!OPS.has(op)) throw new Error(`There is no op named ${JSON.stringify(op)}; the ops are ${[...OPS].join(", ")}.`);
  const conn = await connect(env.root);
  try {
    return { data: await conn.request(op, rest) };
  } finally {
    conn.close();
  }
}

/**
 * watch: `{ ev: "snapshot", runs }` first, then every event the service sends (`run`, `workflow`,
 * `queue`) as it is, until the browser lets go. When nothing has come for a while the service is asked
 * for the queue; if that fails the connection has died and the stream ends, so the page retries it.
 */
export async function* uiWatch(args, env) {
  const conn = await connect(env.root);
  const queue = [];
  let wake = null;
  let stopped = false;
  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  const abort = () => {
    stopped = true;
    nudge();
  };
  env.signal?.addEventListener("abort", abort, { once: true });
  conn.onClose(abort);
  try {
    if (env.signal?.aborted) return;
    const snapshot = await conn.subscribe((event) => {
      if (stopped) return;
      queue.push(event);
      nudge();
    });
    yield { ev: "snapshot", runs: snapshot?.runs ?? [] };
    for (;;) {
      if (stopped) return;
      if (!queue.length) {
        await new Promise((done) => {
          const timer = setTimeout(() => {
            wake = null;
            done();
          }, HEARTBEAT_MS);
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
        if (stopped) return;
        if (!queue.length) {
          try {
            await conn.request("queue", {});
          } catch {
            return;
          }
          continue;
        }
      }
      yield queue.shift();
    }
  } finally {
    env.signal?.removeEventListener("abort", abort);
    stopped = true;
    conn.close();
  }
}
