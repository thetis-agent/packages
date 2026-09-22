// The manifest gate. A registry is read by every other installation's marketplace, so a package that does
// not load is not a local mistake: it is a broken entry in an index a hundred fences pull. The checks here
// are the ones the kernel makes at install time, made before the push instead of after it.
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { refuse } from "./refuse.js";
import { isVersion } from "./semver.js";

const onDisk = (path) => stat(path).then(() => true, () => false);

/** The manifest at `dir`, or `{ error }` when there is none or it is not JSON. Never throws. */
export async function readManifest(env, dir) {
  let text;
  try {
    text = await env.readFile(join(dir, "package.json"));
  } catch {
    return { error: `there is no package.json in ${dir}` };
  }
  try {
    return { manifest: JSON.parse(text), text };
  } catch (err) {
    return { error: `${join(dir, "package.json")} is not readable JSON: ${err.message}` };
  }
}

/**
 * What is wrong with this manifest, in one sentence, or null. Returned rather than thrown so that
 * `publish_targets` can report an unsound package on a card instead of failing the whole answer;
 * `assertSound` is what the publish itself calls.
 *
 * `exists` is a seam, not a convenience: a passenger riding on the branch is judged on the tree that
 * would actually land in the registry, which is its directory in `HEAD` and not the working copy beside
 * it. Pointing this at `git cat-file` is the only way to ask that question.
 */
export async function manifestProblem(manifest, dir, exists = onDisk) {
  const m = manifest ?? {};
  if (typeof m.name !== "string" || !m.name.trim()) return `${join(dir, "package.json")} has no name. A package needs a scoped name such as @thetis/example before it can be published.`;
  if (typeof m.version !== "string" || !m.version.trim()) return `${m.name} has no version in ${join(dir, "package.json")}. Give it one, or publish with version or bump.`;
  if (!isVersion(m.version)) return `${m.name} has version ${m.version}, which is not a semantic version like 1.2.0. Every registry compares versions, so it has to be one.`;
  if (!m.thetis || typeof m.thetis !== "object" || Array.isArray(m.thetis)) return `${m.name} has no thetis field, so nothing in Thetis would load it. Add "thetis": { "type": "tool" }, or the type it is.`;
  // `main` is checked when it is declared, and when the manifest declares code to load, because that is
  // when the kernel checks it: a skill pack has no main and needs none, a tool package with no entry file
  // installs and then fails on the first call, somewhere else, for somebody else.
  const needsCode = Boolean(m.thetis.steps?.length || m.thetis.tools?.length || m.thetis.service || m.thetis.export);
  const main = typeof m.main === "string" && m.main.trim() ? m.main.trim() : needsCode ? "index.js" : null;
  if (main && !(await exists(join(dir, main)))) return `${m.name} names main ${main}, which is not in ${dir}. Add the file, or correct main, and publish again.`;
  return null;
}

export async function assertSound(manifest, dir) {
  const problem = await manifestProblem(manifest, dir);
  if (problem) refuse("manifest", problem);
}

/**
 * The manifest text with a new version in it, keeping the file exactly as it was otherwise. A package.json
 * is a file a person reads and edits, so reformatting it on every publish would put noise in every diff
 * the registry carries. The regular expression is checked by parsing the result: if it moved anything but
 * the top-level version, the whole manifest is written out again instead.
 */
export function withVersion(text, manifest, version) {
  const patched = text.replace(/("version"\s*:\s*")[^"]*(")/, `$1${version}$2`);
  try {
    const parsed = JSON.parse(patched);
    if (parsed.version === version && JSON.stringify({ ...parsed, version: "" }) === JSON.stringify({ ...manifest, version: "" })) return patched;
  } catch {
    // fall through to the rewrite
  }
  return `${JSON.stringify({ ...manifest, version }, null, 2)}\n`;
}
