// The keys of `thetis.config.json` an admin may change from the Control panel. The file is the host's, so a
// fence cannot write it; this host package does, loaded by the daemon per call as `host.config.<export>`.
// Writing is all it does: the caller then asks for `config.reload`, which reads the file again and puts each
// changed key into service by its tier. `model` is a dispatch key, so the next turn already has it.
//
// Every export is `(args, env)`. The kernel admits an admin or the operator; no export is listed in
// `thetis.host.self`, and a self call is refused here again.
import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MODEL_MAX = 200;
const MODEL_ID = /^[^\s\u0000-\u001f]+$/;

function fail(message, code = "invalid") {
  throw Object.assign(new Error(message), { code });
}

/** A person's call about themselves, which the kernel marks with `self`. Anything but an explicit false counts. */
const isSelf = (args) => args.self !== undefined && args.self !== false && args.self !== "false";

/** The config file as it is on disk, and where it really lives: a symlinked file is written through to its target. */
function readFile(home) {
  const path = resolve(home, "thetis.config.json");
  if (!existsSync(path)) return { path, doc: {} };
  const real = realpathSync(path);
  let doc;
  try {
    doc = JSON.parse(readFileSync(real, "utf8"));
  } catch (err) {
    fail(`${path} is not valid JSON (${err.message}); fix it on the host first`);
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) fail(`${path} does not hold a JSON object; fix it on the host first`);
  return { path: real, doc };
}

/** Whole or not at all: a sibling file renamed over the old one, with the old one's mode. */
function writeFile(path, doc) {
  const tmp = join(dirname(path), `.thetis.config.json.${process.pid}.tmp`);
  const mode = existsSync(path) ? statSync(path).mode & 0o777 : 0o644;
  writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`, { mode });
  renameSync(tmp, path);
}

/**
 * Sets the default model: the file's `model`, what a conversation starts with when nobody chose one. An empty
 * `model` removes the key, so the built-in default applies again. Answers the model written (null when
 * removed) and the one the file had before. Whether a provider serves the id is not checked here: the list
 * the panel offers is the providers' own, and a provider installed later may serve an id none serves now.
 */
export async function modelSet(args, env) {
  if (isSelf(args)) fail("the default model is an admin's to set", "unauthorized");
  if (typeof args.model !== "string") fail("model must be a model id, or empty for the built-in default");
  const model = args.model.trim();
  if (model.length > MODEL_MAX) fail(`a model id is at most ${MODEL_MAX} characters`);
  if (model && !MODEL_ID.test(model)) fail("a model id has no spaces or control characters");
  const { path, doc } = readFile(env.home);
  const was = typeof doc.model === "string" ? doc.model : null;
  if (model) doc.model = model;
  else delete doc.model;
  if ((was ?? "") !== model) writeFile(path, doc);
  env.journal({ kind: "config.model", target: "_system", data: { from: was, to: model || null }, ...(args.actor ? { actor: String(args.actor) } : {}) });
  return { model: model || null, was };
}
