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

/**
 * Runs git in a directory and answers its stdout, trimmed unless `trim` is false (porcelain output starts with
 * a meaningful space). A failure carries git's own words and the code `git`.
 */
export async function git(dir, args, { timeoutMs = 120_000, trim = true } = {}) {
  try {
    const { stdout } = await run("git", ["-C", dir, "-c", "protocol.file.allow=always", ...args], { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024, env: GIT_ENV });
    return trim ? stdout.trim() : stdout;
  } catch (err) {
    const words = String(err?.stderr || err?.stdout || err?.message || err).trim();
    throw new HostError(`git ${args.join(" ")} in ${dir}: ${words}`, "git");
  }
}

const short = (commit) => commit.slice(0, 7);

/** How many changed files a check lists. Enough to recognise a dev checkout; the host has the rest. */
const DIRTY_LIMIT = 40;

/** The files `git status` says differ from HEAD, untracked ones left out: build output and scratch are not local changes. */
async function changedFiles(dir) {
  const text = await git(dir, ["status", "--porcelain", "--untracked-files=no"], { trim: false });
  return text.split("\n").filter(Boolean).map((line) => line.slice(3));
}

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
  const dirtyFiles = await changedFiles(root);
  let upstream = null;
  try {
    upstream = await git(root, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  } catch {
    upstream = null;
  }
  const base = { branch, commit: short(commit), head: commit, dirty: dirtyFiles.length > 0, dirtyFiles: dirtyFiles.slice(0, DIRTY_LIMIT), upstream, upstreamHead: null, ahead: 0, behind: 0, incoming: [], fetched: false, error: null };
  if (!upstream) return { ...base, error: `${branch} tracks no upstream branch, so there is nothing to update from` };
  if (fetch) {
    try {
      await git(root, ["fetch", "--tags", "origin"]);
      base.fetched = true;
    } catch (err) {
      return { ...base, error: err.message };
    }
  }
  return { ...base, upstreamHead: await git(root, ["rev-parse", upstream]), ahead: Number(await git(root, ["rev-list", "--count", `${upstream}..HEAD`])), behind: (await countBehind(root, upstream)) ?? 0, incoming: await incoming(root, upstream) };
}

/**
 * The packages submodule against the commit the runtime's upstream pins for it. A submodule sits detached
 * at a pin, so "behind" means the pin has moved: what the next `git submodule update` would bring.
 */
export async function packagesState(root, upstream, { fetch = false } = {}) {
  const dir = resolve(root, "packages");
  const commit = await git(dir, ["rev-parse", "HEAD"]);
  const dirtyFiles = await changedFiles(dir);
  const base = { commit: short(commit), head: commit, pinned: null, pinnedHead: null, dirty: dirtyFiles.length > 0, dirtyFiles: dirtyFiles.slice(0, DIRTY_LIMIT), behind: 0, incoming: [], fetched: false, error: null };
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
  if (behind === null) return { ...base, pinned: short(pinned), pinnedHead: pinned, error: `the pinned commit ${short(pinned)} is not here yet; the update fetches it` };
  return { ...base, pinned: short(pinned), pinnedHead: pinned, behind, incoming: pinned === commit ? [] : await incoming(dir, pinned) };
}

/** Both checkouts in one answer, the packages measured against the runtime's upstream pin. */
export async function checkouts(root, { fetch = false } = {}) {
  const runtime = await runtimeState(root, { fetch });
  const packages = await packagesState(root, runtime.upstream, { fetch });
  return { root, checkedAt: new Date().toISOString(), runtime, packages, node: process.version };
}
