// Where the package is, and where the target already holds it. This is the half of the package that knows
// about the two sources.
//
// A userspace package at `<home>/packages/<slug>` is not a git repository at all: the registry is cloned
// into the work directory, the package's directory is copied in, and the clone is what gets committed.
//
// A package inside a checkout that is already the target repository is the maintainer's case, and it is
// the one the whole design turns on. Their `packages/` directory is four things at once: the shipped
// package source, their git work tree, their marketplace registry, and the push origin the rest of the
// world's Thetis installations trust. Copying it into a clone of itself would be absurd, so the checkout
// is the work tree, and the only thing that changes is that the commit names one directory instead of
// whatever else is lying around in the tree.
//
// Detection is exactly: the resolved package path is inside a git work tree, that tree has an `origin`,
// and `origin` and the target's url are the same repository by `git-url.js`. Anything less certain falls
// to the copy path, which is safe wherever it lands because it commits in a clone of our own making.
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, realpath, rm } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { refuse } from "./refuse.js";
import { safeName } from "./config.js";
import { sameRepository } from "./git-url.js";
import { currentBranch, git, lines, mustGit, originOf, out, refExists, topLevelOf } from "./git.js";
import { manifestProblem, readManifest } from "./manifest.js";
import { compareVersions } from "./semver.js";

/**
 * The package to publish: a name installed in this workspace, or a path. The kernel is asked first,
 * because a name is what a person says and `packages.list` is the only thing that knows where a name
 * lives. The path is then made real: a shipped package in a userspace is a symlink into the checkout,
 * and the checkout is where the git work tree is, so a publish that did not resolve the link would never
 * find the maintainer's case at all.
 */
export async function resolvePackage(env, spec) {
  const asked = typeof spec === "string" ? spec.trim() : "";
  if (!asked) refuse("no-package", "publish needs a package: the name of one installed here, such as @thetis/exa, or a path to its directory.");
  let installed;
  try {
    installed = (await env.kernel?.packages?.list?.())?.find?.((p) => p.name === asked);
  } catch {
    installed = undefined; // the kernel is not reachable from every caller; a path still works
  }
  const raw = installed?.root ?? resolve(env.cwd, asked);
  let path;
  try {
    path = await realpath(raw);
  } catch {
    refuse("not-found", `${asked} is neither a package installed here nor a directory I can reach. Give the name of an installed package, or a path to one under home.`);
  }
  const { manifest, text, error } = await readManifest(env, path);
  if (error) refuse("not-found", `${error}, so there is nothing to publish from there.`);
  return {
    name: typeof manifest.name === "string" ? manifest.name : null,
    version: typeof manifest.version === "string" ? manifest.version : null,
    path,
    directory: basename(path),
    manifest,
    text,
    installed: Boolean(installed),
    problem: await manifestProblem(manifest, path),
  };
}

/**
 * The target repository as this publish will use it, and what it already holds for the package.
 * `mode` is `checkout` when the package is already inside the target repository and `copy` when it is not.
 *
 * `alsoName` is a second package to look up in the same tree, which is how a fork asks whether the target
 * already holds the package it was copied from. It is answered on the copy path only: there, the clone has
 * just been reset onto the registry's branch, so the registry's whole tree is on disk and the lookup is
 * free. In a checkout the directory a package sits in is the directory the registry keeps it in, so a
 * publish there has only one thing it can be and nothing to ask about.
 */
export async function locate(env, pkg, target, workDir, alsoName) {
  const top = await topLevelOf(env, pkg.path);
  if (top) {
    const origin = await originOf(env, top);
    if (origin && sameRepository(origin, target.url)) return locateInCheckout(env, pkg, target, top, origin);
  }
  return locateInClone(env, pkg, target, workDir, alsoName);
}

async function locateInCheckout(env, pkg, target, top, origin) {
  const dir = relative(top, pkg.path);
  if (!dir || dir.startsWith("..")) {
    refuse("package-is-repo-root", `${pkg.path} is the root of the registry repository itself, not a package directory inside it. A registry holds each package in a directory of its own, so there is no single directory to commit.`);
  }
  const branch = target.branch ?? (await currentBranch(env, top));
  if (!branch) refuse("detached", `The checkout at ${top} is not on a branch, so there is nothing to push. Check out the branch you publish from, or set branch on the ${target.name} target.`);

  // The registry's truth is what is on the remote, not what this checkout has locally: a maintainer whose
  // tree is behind would otherwise be told a version is free when the registry already holds it, and find
  // out at the push. Fetching first is also what makes the push a fast-forward when it succeeds.
  const fetched = await git(env, top, ["fetch", "origin", branch]);
  const missingBranch = /couldn't find remote ref|not found in upstream|no such ref/i.test(`${fetched.stderr}${fetched.stdout}`);
  if (fetched.code !== 0 && !missingBranch) {
    refuse("git", `Could not reach ${target.name} at ${origin} to see what it holds: ${fetched.stderr.trim().split("\n").at(-1) ?? `git exited ${fetched.code}`}`);
  }
  const ref = `origin/${branch}`;
  const onRemote = !missingBranch && (await refExists(env, top, ref));
  const held = onRemote ? await showFile(env, top, ref, `${dir}/package.json`) : null;
  const staged = outside(lines(await git(env, top, ["diff", "--cached", "--name-only"])), dir);
  const others = onRemote ? await aheadOthers(env, top, ref, dir) : [];
  return { mode: "checkout", repo: top, url: origin, dir, branch, branchOnRemote: onRemote, holds: held?.version ?? null, holdsName: held?.name ?? null, staged, others, origin: null };
}

export async function locateInClone(env, pkg, target, workDir, alsoName) {
  const repo = join(workDir, safeName(target.name));
  await ensureClone(env, target, repo);
  const branch = target.branch ?? (await currentBranch(env, repo)) ?? "main";
  const ref = `origin/${branch}`;
  const onRemote = await refExists(env, repo, ref);
  if (onRemote) {
    // The clone is this package's scratch space and holds nothing worth keeping. Resetting it onto the
    // remote branch makes the working tree exactly the registry's tree, which is what makes it safe to
    // read what the registry holds out of it, and stops a file an earlier run left behind from riding
    // along in the next commit or, worse, being read back as if the registry held it.
    await mustGit(env, repo, ["checkout", "-B", branch, ref], `could not check ${branch} out of the ${target.name} clone`);
    await mustGit(env, repo, ["reset", "--hard", ref], `could not reset the ${target.name} clone`);
    await git(env, repo, ["clean", "-fd"]);
  } else {
    // The registry has no such branch, so it holds nothing at all on it: a first publish, however much is
    // lying about in the clone. A commit an earlier run made here and failed to push is not the registry's
    // and is not what it holds.
    if ((await currentBranch(env, repo)) !== branch) await mustGit(env, repo, ["checkout", "-B", branch], `could not start branch ${branch} in the ${target.name} clone`);
    await git(env, repo, ["reset", "--hard"]);
    await git(env, repo, ["clean", "-fd"]);
  }
  const found = onRemote ? await findPackageDir(repo, pkg.name) : null;
  const dir = found?.dir ?? pkg.directory;
  const held = onRemote ? (found ?? (await readDirManifest(env, repo, dir))) : null;
  // What the registry holds for a second package, when the caller named one: a fork asking after the
  // package it was copied from. Null both when nothing was asked and when the registry does not hold it,
  // which are the same answer to the only question anybody asks of it.
  const also = onRemote && alsoName && alsoName !== pkg.name ? await findPackageDir(repo, alsoName) : null;
  // Nothing local survives the reset above, so a clone carries no commits of its own to push: there are
  // never passengers on this path. `test/gates.test.js` plants one and proves it rather than assuming it.
  return { mode: "copy", repo, url: target.url, dir, branch, branchOnRemote: onRemote, holds: held?.version ?? null, holdsName: held?.name ?? null, staged: [], others: [], origin: also };
}

/**
 * The clone of a target, up to date. A clone that is already there is fetched rather than made again; one
 * that points somewhere else is thrown away, because the work directory is this package's own scratch
 * space and a stale clone of a registry that has since been reconfigured is worse than no clone.
 */
export async function ensureClone(env, target, repo) {
  if (existsSync(join(repo, ".git"))) {
    const origin = await originOf(env, repo);
    if (origin && sameRepository(origin, target.url)) {
      await mustGit(env, repo, ["fetch", "origin", "--prune"], `could not reach ${target.name} at ${target.url}`);
      return repo;
    }
    await rm(repo, { recursive: true, force: true });
  } else if (existsSync(repo)) {
    await rm(repo, { recursive: true, force: true });
  }
  await mkdir(dirname(repo), { recursive: true });
  await mustGit(env, dirname(repo), ["clone", target.url, basename(repo)], `could not clone ${target.name} from ${target.url}`, { timeoutMs: 600_000 });
  return repo;
}

/**
 * The directory the registry already keeps this package in, whatever it is called. The name in the
 * manifest is the identity, not the directory, and a registry is free to have put `@thetis/exa` in
 * `exa-search`; publishing to the slug instead would leave two copies of one package in the index.
 * First and second level, the way `@thetis/marketplace` indexes a registry.
 */
export async function findPackageDir(repo, name) {
  if (!name) return null;
  for (const depth of [1, 2]) {
    for (const dir of await levelDirs(repo, depth)) {
      const file = join(repo, dir, "package.json");
      if (!existsSync(file)) continue;
      try {
        const m = JSON.parse(await readFile(file, "utf8"));
        if (m?.thetis && m.name === name) return { dir, name: m.name, version: m.version };
      } catch {
        continue;
      }
    }
  }
  return null;
}

async function levelDirs(repo, depth) {
  const skip = new Set([".git", "node_modules"]);
  let dirs = [""];
  for (let i = 0; i < depth; i++) {
    const next = [];
    for (const d of dirs) {
      let entries = [];
      try {
        entries = await readdir(join(repo, d), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) if (e.isDirectory() && !skip.has(e.name)) next.push(d ? `${d}/${e.name}` : e.name);
    }
    dirs = next;
  }
  return dirs;
}

/** The paths that are not this package's own. */
const outside = (paths, dir) => paths.filter((p) => p !== dir && !p.startsWith(`${dir}/`));

/**
 * The other packages this branch is carrying: committed here, not in the registry yet, and about to be
 * pushed with it. Scoping the commit to one directory does not scope the push, because `git push` sends
 * the branch and the branch already holds those commits. That is not a thing this package can fix by
 * committing more carefully; it can only be seen and refused.
 *
 * Each one is measured the way the person has to decide about it: a package whose version has also moved
 * past what the registry holds wants publishing in its own right, and one whose version has not moved
 * must not be pushed at all, because its code would land in the registry under a version every
 * installation already believes it has, which no update check will ever look at again.
 */
export async function aheadOthers(env, repo, ref, dir) {
  const groups = new Map();
  for (const path of outside(lines(await git(env, repo, ["diff", "--name-only", `${ref}..HEAD`])), dir)) {
    const top = path.split("/")[0];
    if (!groups.has(top)) groups.set(top, []);
    groups.get(top).push(path);
  }
  const out = [];
  for (const [top, files] of groups) out.push(await classify(env, repo, ref, top, files));
  return out.sort((a, b) => (a.package ?? a.dir).localeCompare(b.package ?? b.dir));
}

/**
 * One passenger, and the only question that matters about it: could this be published on its own? A
 * passenger that could is one the person may take responsibility for by naming it. A passenger that
 * could not may never be named, whatever anybody says, because its code would land in the registry under
 * a version that every installation already holds and no update check will look at again.
 *
 * `reason` is the machine-readable half and the sentence is built from it where the target's name is
 * known, so that this function can stay a measurement and say nothing.
 */
async function classify(env, repo, ref, dir, files) {
  const here = await showFile(env, repo, "HEAD", `${dir}/package.json`);
  const there = await showFile(env, repo, ref, `${dir}/package.json`);
  const row = { dir, files, package: here?.name ?? null, version: here?.version ?? null, holds: there?.version ?? null, holdsName: there?.name ?? null, moved: false, publishable: false, reason: null, problem: null };
  if (!here) return { ...row, reason: "not-a-package" };
  // Judged on the tree that would land: `HEAD:<dir>/<main>`, not the file sitting next to it on disk.
  const inTree = async (path) => (await git(env, repo, ["cat-file", "-e", `HEAD:${path}`])).code === 0;
  const problem = await manifestProblem(here.manifest, dir, inTree);
  if (problem) return { ...row, reason: "manifest", problem };
  if (row.holdsName && row.holdsName !== row.package) return { ...row, reason: "name-mismatch" };
  const moved = !row.holds || compareVersions(row.version, row.holds) > 0;
  return { ...row, moved, publishable: moved, reason: moved ? null : "not-newer" };
}

/** The name and version at `<dir>/package.json` in a checked-out tree, or null. */
async function readDirManifest(env, repo, dir) {
  const { manifest } = await readManifest(env, join(repo, dir));
  return manifest ? { dir, name: manifest.name, version: manifest.version } : null;
}

/** A manifest at `<ref>:<path>`, read out of the object store without checking anything out. */
async function showFile(env, repo, ref, path) {
  const r = await git(env, repo, ["show", `${ref}:${path}`]);
  if (r.code !== 0) return null;
  try {
    const m = JSON.parse(out(r));
    return { name: m.name, version: m.version, manifest: m };
  } catch {
    return null;
  }
}
