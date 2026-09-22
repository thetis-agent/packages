// Entry point. The mechanism lives in `lib/` as plain functions over `(args, env)`, and these are the two
// exports the manifest names. They are thin on purpose: a browser surface reaches the same code through
// `env.invokeTool`, and code in this fence can import `publish` and `targets` directly when a tool call is
// the wrong seam. Nothing decides anything here that the library does not decide the same way.
//
// The one thing the wrappers do is coerce: arguments that arrive from a model are JSON that was written
// by a language model, so `dryRun: "true"` and a name with a stray space around it turn up, and a boolean
// that is really the string "false" would otherwise publish for real.
import { publish } from "./lib/publish.js";
import { targets } from "./lib/targets.js";

export { publish } from "./lib/publish.js";
export { targets } from "./lib/targets.js";
export { Refusal } from "./lib/refuse.js";
export { bumpVersion, compareVersions, isVersion } from "./lib/semver.js";
export { repoKey, sameRepository } from "./lib/git-url.js";
export { pickTarget, targetsOf, workDirOf } from "./lib/config.js";
export { lastPublish } from "./lib/record.js";

const text = (v) => (typeof v === "string" && v.trim() ? v.trim() : undefined);
const flag = (v) => v === true || v === "true" || v === 1 || v === "1";
/** A list of names, however it arrived: a list, one string, or a comma-separated one. */
const names = (v) => (Array.isArray(v) ? v : typeof v === "string" ? v.split(",") : []).map((x) => String(x).trim()).filter(Boolean);

export async function publishPackage(args = {}, env) {
  return publish({ package: text(args.package), to: text(args.to), version: text(args.version), bump: text(args.bump), message: text(args.message), with: names(args.with), dryRun: flag(args.dryRun) }, env);
}

export async function publishTargets(args = {}, env) {
  return targets({ package: text(args.package) }, env);
}
