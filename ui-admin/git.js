// The git side of the package page: the commits that touched one package, one commit's files, the change
// between two points, a push, and the README. Every command runs inside the admin's fence, where the
// checkout is bound read-only (a push writes to the remote, not the tree), and asks git through
// `env.exec`, so a fence without git, or a package whose files are not in a checkout, answers nulls and
// empties rather than errors: "not in a checkout" is a fact the page shows, not a fault. Every ref that
// reaches a git command is checked first, because an argument shaped like an option would be one.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;
const HASH = /^[0-9a-f]{7,40}$/;
const WORKTREE = "WORKTREE";
/** Between one commit's header and the next, in a log that prints file names. */
const SEP = "\u001e";
/** Between the fields of one commit's header. */
const FIELD = "\u001f";

const fail = (message) => {
  throw new Error(message);
};

export const packageName = (value) => (typeof value === "string" && PACKAGE_NAME.test(value) ? value : fail("a package name looks like @scope/name"));

export const shellQuote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;

/** The package's files as they really are: the store links a package by name, and the link is not what a person looks for. */
export function realRoot(root) {
  try {
    return typeof root === "string" ? realpathSync(root) : root;
  } catch {
    return root;
  }
}

/**
 * The installed record of one package, refused in one sentence when it is not here. `loadedIn` says whose
 * workspace the record came from, because `loadedVersion` on it is that workspace's word and no other's.
 */
export async function installedPackage(env, name) {
  const installed = await env.kernel.packages.list();
  const own = installed.find((p) => p.name === name);
  if (own) return { ...own, loadedIn: env.user };
  // The admin's own list is not the whole story: a fork the admin runs replaces the original there, and a
  // package another person has may be one the admin never installed. Any workspace that holds the package
  // knows its record, and the operator channel reads every list, so the page of the original still opens.
  const elsewhere = await anyoneHas(env, name);
  return elsewhere ?? fail(`${name} is not installed in any workspace`);
}

/** The package's record from the first workspace (every person, then the system's) whose list holds it, or null. */
async function anyoneHas(env, name) {
  const operator = env.kernel.operator;
  if (typeof operator?.call !== "function") return null;
  let people = [];
  try {
    people = (await operator.call("users.list", {})) ?? [];
  } catch {
    return null;
  }
  for (const who of [...people.map((u) => u.id), "_system"]) {
    const list = await operator.call("packages.list", { user: who }).catch(() => []);
    const found = (Array.isArray(list) ? list : []).find((p) => p.name === name);
    if (found) return { ...found, loadedIn: who };
  }
  return null;
}

/** One git question. A git that is missing or refuses answers a failed result, never a throw. */
const git = (env, root, args, timeoutMs = 10_000) =>
  typeof env.exec === "function" && typeof root === "string"
    ? env.exec(`git -C ${shellQuote(root)} ${args}`, { timeoutMs }).catch(() => ({ code: 1, stdout: "", stderr: "" }))
    : Promise.resolve({ code: 1, stdout: "", stderr: "" });

/** Whether the root is inside a git checkout at all. */
async function inCheckout(env, root) {
  return (await git(env, root, "rev-parse --show-toplevel")).code === 0;
}

/**
 * The checkout the package's files are in: branch, ahead and behind its upstream, files of this package
 * changed. Null when there is none. A branch with no tracking upstream is still pushed somewhere: the
 * remote's branch of the same name, when there is one, is what it is counted against.
 */
export async function gitWord(env, root) {
  const status = await git(env, root, "status --porcelain=v1 -b -- .");
  if (status.code !== 0) return null;
  const [head, ...rest] = status.stdout.split("\n");
  const line = /^## (\S+?)(?:\.\.\.(\S+))?(?: \[(.*)\])?$/.exec(head ?? "");
  const branch = line?.[1] ?? null;
  let upstream = line?.[2] ?? null;
  const counts = line?.[3] ?? "";
  let ahead = Number(/ahead (\d+)/.exec(counts)?.[1] ?? 0);
  let behind = Number(/behind (\d+)/.exec(counts)?.[1] ?? 0);
  if (!upstream && branch && !branch.startsWith("HEAD")) {
    const against = `origin/${branch}`;
    const count = await git(env, root, `rev-list --left-right --count ${shellQuote(branch)}...${shellQuote(against)}`);
    const pair = /^(\d+)\s+(\d+)/.exec(count.stdout.trim());
    if (count.code === 0 && pair) [upstream, ahead, behind] = [against, Number(pair[1]), Number(pair[2])];
  }
  const commit = (await git(env, root, "rev-parse --short HEAD")).stdout.trim() || null;
  return { branch, upstream, ahead, behind, changed: rest.filter((l) => l.trim()).length, commit };
}

/** The commit a pinned source names: `<url>#<dir>@<commit>`. Null for a system or local copy. */
export function pinOf(source) {
  if (source?.kind !== "git" || typeof source.ref !== "string") return null;
  const m = /@([0-9a-f]{7,40})$/.exec(source.ref);
  return m ? m[1] : null;
}

/** The registry's entry for the package: the version and the commit it holds. Null without an index entry or the library. */
async function registryEntry(env, name) {
  let lib;
  try {
    lib = await import("@thetis/marketplace");
  } catch {
    return null;
  }
  const index = await lib.readIndex(env);
  const entry = index?.packages.find((e) => e.name === name);
  return entry ? { version: entry.version, commit: entry.commit } : null;
}

/** The dependencies a package.json names, or none when the file cannot be read. */
export function dependenciesOf(root) {
  try {
    const parsed = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
    const deps = parsed?.dependencies;
    return deps && typeof deps === "object" ? Object.keys(deps) : [];
  } catch {
    return [];
  }
}

/** The commits of the upstream, as a set the log checks each commit against, so "pushed" is one lookup. */
async function pushedSet(env, root, upstream) {
  if (!upstream) return new Set();
  const out = await git(env, root, `rev-list -n 2000 ${shellQuote(upstream)}`);
  return new Set(out.code === 0 ? out.stdout.split("\n").filter(Boolean) : []);
}

/** `<hash>\u001f<short>\u001f<subject>\u001f<author>\u001f<at>` ahead of a separator, then the file names, per commit. */
function parseLog(text) {
  const out = [];
  for (const block of text.split(SEP)) {
    const lines = block.split("\n").filter((l) => l.trim());
    if (!lines.length) continue;
    const fields = lines[0].split(FIELD);
    if (fields.length < 5) continue;
    const [hash, short, subject, author, at] = fields;
    out.push({ hash, short, subject, author, at, files: lines.length - 1 });
  }
  return out;
}

/**
 * package-log: the commits touching this package, newest first, each with whether it reached the upstream
 * and whether it is the one the copy is pinned to, plus the points the page draws lanes against: the
 * head, the pin and what the registry holds.
 */
export async function packageLog(args, env) {
  const name = packageName(args.name);
  const info = await installedPackage(env, name);
  const root = realRoot(info.root);
  const limit = Math.min(200, Math.max(1, Number(args.limit) || 30));
  const empty = { branch: null, upstream: null, ahead: 0, behind: 0, head: null, pin: null, registry: await registryEntry(env, name), commits: [] };
  if (!(await inCheckout(env, root))) return { data: empty };
  const word = await gitWord(env, root);
  const [headHash, pushed, log] = await Promise.all([
    git(env, root, "rev-parse HEAD"),
    pushedSet(env, root, word?.upstream),
    git(env, root, `log --format=${shellQuote(`${SEP}%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI`)} --name-only -n ${limit} -- .`),
  ]);
  const pinHash = pinOf(info.source);
  // Without an upstream to compare against, whether a commit is pushed is unknown, not false: null says so.
  const commits = parseLog(log.code === 0 ? log.stdout : "").map((c) => ({ ...c, pushed: word?.upstream ? pushed.has(c.hash) : null, pinned: pinHash !== null && c.hash.startsWith(pinHash) }));
  const head = headHash.code === 0 && headHash.stdout.trim() ? { hash: headHash.stdout.trim(), short: headHash.stdout.trim().slice(0, 7) } : null;
  const pin = pinHash ? { hash: pinHash, short: pinHash.slice(0, 7) } : null;
  return { data: { ...empty, branch: word?.branch ?? null, upstream: word?.upstream ?? null, ahead: word?.ahead ?? 0, behind: word?.behind ?? 0, head, pin, commits } };
}

const hashOf = (value) => (typeof value === "string" && HASH.test(value) ? value : fail("a commit is 7 to 40 hex digits"));

/** A ref the diff may name: a commit, HEAD, or the working tree. Nothing else reaches git, so nothing becomes an option. */
const refOf = (value, what) => (value === "HEAD" || value === WORKTREE || (typeof value === "string" && HASH.test(value)) ? value : fail(`${what} is a commit hash, HEAD or WORKTREE`));

/** `added\tdeleted\tpath` lines, the path made relative to the package's directory in the repository. */
function parseNumstat(text, prefix) {
  const files = [];
  for (const line of text.split("\n")) {
    const m = /^(\d+|-)\t(\d+|-)\t(.+)$/.exec(line);
    if (!m) continue;
    const path = m[3].startsWith(prefix) ? m[3].slice(prefix.length) : m[3];
    files.push({ path, added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
  }
  return files;
}

/** The package directory's path inside the repository, with a trailing slash, for stripping from git's paths. */
async function repoPrefix(env, root) {
  const out = await git(env, root, "rev-parse --show-prefix");
  return out.code === 0 ? out.stdout.trim() : "";
}

/** package-commit: one commit's message and the files of this package it changed. */
export async function packageCommit(args, env) {
  const name = packageName(args.name);
  const hash = hashOf(args.hash);
  const info = await installedPackage(env, name);
  const root = realRoot(info.root);
  if (!(await inCheckout(env, root))) fail(`${name} is not in a git checkout`);
  const shown = await git(env, root, `show --numstat --format=${shellQuote(`%H${FIELD}%h${FIELD}%s${FIELD}%an${FIELD}%aI${FIELD}%b${SEP}`)} ${shellQuote(hash)} -- .`);
  if (shown.code !== 0) fail(`${hash} is not a commit of this checkout`);
  const [header, rest] = shown.stdout.split(SEP);
  const [full, short, subject, author, at, body = ""] = (header ?? "").split(FIELD);
  const word = await gitWord(env, root);
  const pushed = word?.upstream ? (await pushedSet(env, root, word.upstream)).has(full) : null;
  return { data: { hash: full, short, subject, author, at, body: body.trim(), pushed, files: parseNumstat(rest ?? "", await repoPrefix(env, root)) } };
}

/** package-diff: what changed in this package between two points, `to` may be the working tree. */
export async function packageDiff(args, env) {
  const name = packageName(args.name);
  const from = refOf(args.from, "from");
  const to = refOf(args.to, "to");
  if (from === WORKTREE) fail("from is a commit hash or HEAD");
  const info = await installedPackage(env, name);
  const root = realRoot(info.root);
  if (!(await inCheckout(env, root))) fail(`${name} is not in a git checkout`);
  const range = to === WORKTREE ? shellQuote(from) : `${shellQuote(from)} ${shellQuote(to)}`;
  const out = await git(env, root, `diff --numstat ${range} -- .`);
  if (out.code !== 0) fail(`git could not compare ${from} with ${to}`);
  const files = parseNumstat(out.stdout, await repoPrefix(env, root));
  const added = files.reduce((n, f) => n + f.added, 0);
  const deleted = files.reduce((n, f) => n + f.deleted, 0);
  const summary = files.length ? `${files.length} ${files.length === 1 ? "file" : "files"} changed, +${added} −${deleted}` : "nothing changed";
  return { data: { from, to, files, summary } };
}

/** package-push: pushes the checkout's branch. A push that fails is an answer, not a fault: the page shows what git said. */
export async function packagePush(args, env) {
  const name = packageName(args.name);
  const info = await installedPackage(env, name);
  const root = realRoot(info.root);
  if (!(await inCheckout(env, root))) return { data: { ok: false, output: `${name} is not in a git checkout` } };
  const out = await git(env, root, "push", 60_000);
  const output = [out.stderr, out.stdout].filter((s) => s && s.trim()).join("\n").trim();
  return { data: { ok: out.code === 0, output } };
}

/** package-readme: the README at the package's real root, or null. */
export async function packageReadme(args, env) {
  const name = packageName(args.name);
  const info = await installedPackage(env, name);
  const root = realRoot(info.root);
  const file = typeof root === "string" ? resolve(root, "README.md") : null;
  if (!file || !existsSync(file)) return { data: { text: null } };
  try {
    return { data: { text: readFileSync(file, "utf8") } };
  } catch {
    return { data: { text: null } };
  }
}
