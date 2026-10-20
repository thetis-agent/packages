// Entry point: the reflection service, the two session hooks the web gateway calls, and the one UI
// command the place and the chip send. The mechanism is under `lib/`: `service.js` (the queue),
// `reflect.js` (one reflection), `export.js` (the evidence), `prompt.js` (the mission, the parse and the
// writer guard), `lessons.js` (lessons as skills), `hooks.js`, `ops.js`, `records.js`, `files.js`.
//
// A UI command answers `{ data }`, because the gateway keeps `text` and `data` and drops every other
// field, and a thrown error is a 400 with its sentence.
import { createService } from "./lib/service.js";
import { createOps, OPS } from "./lib/ops.js";

export { onArchive, forgetSession } from "./lib/hooks.js";
export { OPS };

/** The service. `env` is the `ServiceEnv`; it resolves once the queue is started. */
export async function startReflections(env) {
  const service = createService(env);
  await service.start();
  return { stop: () => service.stop() };
}

/** call: `args: { op, ...args }`, answered `{ data: result }`. */
export async function uiCall(args, env) {
  const { op, ...rest } = args && typeof args === "object" ? args : {};
  if (typeof op !== "string" || !op) throw new Error(`op is required: one of ${OPS.join(", ")}.`);
  if (!OPS.includes(op)) throw new Error(`There is no op named ${JSON.stringify(op)}; the ops are ${OPS.join(", ")}.`);
  return { data: await createOps(env)[op](rest) };
}
