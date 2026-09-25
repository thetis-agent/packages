// What git says about the installation's two checkouts: the runtime, on a branch that tracks its upstream,
// and the packages submodule, detached at the commit the runtime pins. Nothing here changes anything; a
// fetch is the only thing that reaches the network, and only when asked for.
import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { HostError } from "./error.js";

const run = promisify(execFile);
const INCOMING_LIMIT = 40;

/** Git never asks a question here: a repository that needs credentials the host does not hold fails with git's own words. */
const GIT_ENV = { ...process.env, GIT_TERMINAL_PROMPT: "0" };

/** Runs git in a directory and answers its stdout, trimmed. A failure carries git's own words and the code `git`. */
export async function git(dir, args, { timeoutMs = 120_000 } = {}) {
  try {
    const { stdout } = await run("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: GIT_ENV });
    return stdout.trim();
  } catch (err) {
    const words = String(err?.stderr || err?.stdout || err?.message || err).trim();
    throw new HostError(`git ${args.join(" ")} in ${dir}: ${words}`, "git");
  }
}

const short = (commit) => commit.slice(0, 7);

/** `HEAD..<ref>` as `[{ commit, subject }]`, newest first, at most INCOMING_LIMIT of them. */
async function incoming(dir, ref) {
  const text = await git(dir, ["log", `--max-count=${INCOMING_LIMIT}`, "--format=%H %s", `HEAD..${ref}`]);
  return text ? text.split("\n").map((line) => ({ commit: short(line.slice(0, 40)), subject: line.slice(41) })) : [];
}

/** How many commits `HEAD..<ref>` holds, or null when the ref is not known here. */
async function countBehind(dir, ref) {
  try {
    return Number(await git(dir, ["rev-list", "--count", `HEAD..${ref}`]));
  } catch {
    return null;
  }
}

/**
 * The runtime checkout against the branch it tracks. `fetch` reaches the remote first; without it the
 * answer is what the last fetch left, which is enough to draw a page and free to ask for.
 */
export async function runtimeState(root, { fetch = false } = {}) {
  const branch = await git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const commit = await git(root, ["rev-parse", "HEAD"]);
  const dirty = (await git(root, ["status", "--porcelain", "--untracked-files=no"])) !== "";
  let upstream = null;
  try {
    upstream = await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  } catch {
    upstream = null;
  }
  const base = { branch, commit: short(commit), dirty, upstream, ahead: 0, behind: 0, incoming: [], fetched: false, error: null };
  if (!upstream) return { ...base, error: `${branch} tracks no upstream branch, so there is nothing to update from` };
  if (fetch) {
    try {
      await git(root, ["fetch", "--tags", "origin"]);
      base.fetched = true;
    } catch (err) {
      return { ...base, error: err.message };
    }
  }
  return { ...base, ahead: Number(await git(root, ["rev-list", "--count", `${upstream}..HEAD`])), behind: (await countBehind(root, upstream)) ?? 0, incoming: await incoming(root, upstream) };
}

/**
 * The packages submodule against the commit the runtime's upstream pins for it. A submodule sits detached
 * at a pin, so "behind" means the pin has moved: what the next `git submodule update` would bring.
 */
export async function packagesState(root, upstream, { fetch = false } = {}) {
  const dir = resolve(root, "packages");
  const commit = await git(dir, ["rev-parse", "HEAD"]);
  const dirty = (await git(dir, ["status", "--porcelain", "--untracked-files=no"])) !== "";
  const base = { commit: short(commit), pinned: null, dirty, behind: 0, incoming: [], fetched: false, error: null };
  if (!upstream) return base;
  let pinned;
  try {
    pinned = await git(root, ["rev-parse", `${upstream}:packages`]);
  } catch {
    return { ...base, error: `${upstream} carries no packages submodule` };
  }
  if (fetch) {
    try {
      await git(dir, ["fetch", "origin"]);
      base.fetched = true;
    } catch (err) {
      return { ...base, pinned: short(pinned), error: err.message };
    }
  }
  const behind = await countBehind(dir, pinned);
  if (behind === null) return { ...base, pinned: short(pinned), error: `the pinned commit ${short(pinned)} is not here yet; the update fetches it` };
  return { ...base, pinned: short(pinned), behind, incoming: pinned === commit ? [] : await incoming(dir, pinned) };
}

/** Both checkouts in one answer, the packages measured against the runtime's upstream pin. */
export async function checkouts(root, { fetch = false } = {}) {
  const runtime = await runtimeState(root, { fetch });
  const packages = await packagesState(root, runtime.upstream, { fetch });
  return { root, checkedAt: new Date().toISOString(), runtime, packages, node: process.version };
}
