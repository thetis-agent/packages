// File and shell mechanics of package installation: sources, clones, builds, links, and copies.
// Who may install what, and where, is decided by the caller.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const GIT_URL = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|file:\/\/).+|\.git$/;

/** A commit pin: exactly a full object name, so nothing shorter can be mistaken for one. */
const PIN = /@([0-9a-f]{40})$/;

/**
 * A git source is `<url>`, `<url>#<directory inside the repository>`, and either of those with `@<commit>`
 * on the end. The pin is what a marketplace install records: the index says what the latest version is, and
 * the install fixes the commit it actually took, so the package cannot change underneath it later.
 */
export function splitSource(source: string): { url: string; sub?: string; ref?: string } {
  const pin = PIN.exec(source);
  const rest = pin ? source.slice(0, -pin[0].length) : source;
  const ref = pin?.[1];
  const hash = rest.indexOf("#");
  if (hash < 0) return ref ? { url: rest, ref } : { url: rest };
  const sub = rest.slice(hash + 1);
  const url = rest.slice(0, hash);
  return { url, ...(sub ? { sub } : {}), ...(ref ? { ref } : {}) };
}

/** `<url>#<dir>@<commit>`, the form the marketplace hands to install. */
export function pinnedSource(url: string, sub: string | undefined, ref: string): string {
  return `${url}${sub ? `#${sub}` : ""}@${ref}`;
}

export function isGitSource(source: string): boolean {
  return GIT_URL.test(splitSource(source).url);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * The directory name a clone gets: the repository name, made safe for a path, and the commit when the source
 * is pinned. One registry repository holds many packages, so two installs of different commits must not share
 * a directory — the second would replace the first's code underneath the link that is already using it.
 */
export function cloneSlug(url: string, ref?: string): string {
  const name = basename(url).replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-");
  return ref ? `${name}-${ref.slice(0, 12)}` : name;
}

/**
 * Without a pin, the tip of the default branch. With one, that exact commit and nothing else: fetching the
 * object directly keeps it to one shallow round trip, which a full clone followed by a checkout would not.
 */
export function cloneCommand(url: string, dir: string, ref?: string): string {
  if (!ref) return `git clone --depth 1 ${shellQuote(url)} ${shellQuote(dir)}`;
  const at = `git -C ${shellQuote(dir)}`;
  return [
    `git init --quiet ${shellQuote(dir)}`,
    `${at} remote add origin ${shellQuote(url)}`,
    `${at} fetch --quiet --depth 1 origin ${shellQuote(ref)}`,
    `${at} checkout --quiet --detach FETCH_HEAD`,
  ].join(" && ");
}

/**
 * A mirror for indexing, not for installing: the index is built from manifests alone, so only those are
 * fetched. A blobless fetch with a sparse checkout brings down about 280 KB of this registry instead of
 * 4.5 MB, and the difference is entirely files no index ever reads.
 */
export function mirrorCommand(url: string, dir: string): string {
  const at = `git -C ${shellQuote(dir)}`;
  return [
    `rm -rf ${shellQuote(dir)}`,
    `git init --quiet ${shellQuote(dir)}`,
    `${at} remote add origin ${shellQuote(url)}`,
    `${at} config core.sparseCheckout true`,
    `${at} sparse-checkout set --no-cone '/*/package.json' '/*/*/package.json'`,
    `${at} fetch --quiet --depth 1 --filter=blob:none origin HEAD`,
    `${at} checkout --quiet --detach FETCH_HEAD`,
  ].join(" && ");
}

/**
 * The commit a clone is sitting on, or undefined when there is no clone. A detached checkout writes the
 * object name straight into HEAD, so this costs a file read rather than a subprocess.
 */
export function headOf(dir: string): string | undefined {
  try {
    const head = readFileSync(resolve(dir, ".git", "HEAD"), "utf8").trim();
    return /^[0-9a-f]{40}$/.test(head) ? head : undefined;
  } catch {
    return undefined;
  }
}

/** The command that makes a package runnable, or undefined when nothing needs to run. */
export function buildCommand(m: { scripts?: Record<string, string>; dependencies?: Record<string, string> }): string | undefined {
  if (m.scripts?.build) return "npm install --no-audit --no-fund && npm run build";
  if (Object.keys(m.dependencies ?? {}).length > 0) return "npm install --omit=dev --no-audit --no-fund";
  return undefined;
}

/** True when `target` is strictly inside `base` (not equal to it, and not reached through `..`). */
export function isInside(base: string, target: string): boolean {
  const rel = relative(base, target);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

/** Replaces `link` with a symlink to `target`. Links to targets under `root` are relative, so a moved data directory keeps working. */
export function linkDir(link: string, target: string, root: string): void {
  mkdirSync(dirname(link), { recursive: true });
  if (isLink(link)) rmSync(link);
  const inside = !relative(root, target).startsWith("..");
  symlinkSync(inside ? relative(dirname(link), target) : target, link, "dir");
}

export function removeLink(link: string): void {
  if (existsSync(link) || isLink(link)) rmSync(link, { recursive: true, force: true });
}

export function hasPackageJson(dir: string): boolean {
  return existsSync(resolve(dir, "package.json"));
}

/** Copies a package directory (following the top-level link) and gives the copy a new name in its package.json. */
export function copyPackageAs(from: string, to: string, name: string): void {
  cpSync(realpathSync(from), to, { recursive: true, verbatimSymlinks: true });
  const file = resolve(to, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as { name: string };
  manifest.name = name;
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
}

export interface ForkSpec {
  /** The installed package's root (a store link is fine; it is followed). */
  from: string;
  /** The fork's directory. Must not exist. */
  to: string;
  name: string;
  version: string;
  origin: { name: string; version: string };
  /** The userspace root: links into it are relative, so a moved data directory keeps working. */
  root: string;
}

export interface ForkResult {
  manifest: ForkManifest;
  /** Dependencies satisfied with a link into the fork's node_modules instead of an npm install. */
  linked: string[];
}

/** The parts of a package.json a fork rewrites. Everything else is copied as it is. */
export interface ForkManifest {
  name: string;
  version: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  thetis: Record<string, unknown> & { forkedFrom?: { name: string; version: string } };
}

/** The version a fork gets: `<origin>-fork.N`, where N follows the fork that already carries this name. */
export function forkVersion(origin: string, current?: string): string {
  const m = current ? /-fork\.(\d+)$/.exec(current) : null;
  const n = m && current?.startsWith(`${origin}-fork.`) ? Number(m[1]) + 1 : 1;
  return `${origin}-fork.${n}`;
}

/** Where `dep` resolves from `dir`, the way Node walks up through node_modules. Undefined when it does not. */
export function findDependency(dir: string, dep: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    const candidate = resolve(d, "node_modules", dep);
    if (hasPackageJson(candidate)) return realpathSync(candidate);
    if (dirname(d) === d) return undefined;
  }
}

/**
 * Copies a package (without its node_modules) and rewrites the copy's package.json for a fork: new name and
 * version, no scripts and no devDependencies (a shipped TypeScript package cannot rebuild inside a fence,
 * so the fork runs the copied dist), `thetis.forkedFrom` set. A dependency the origin already resolves is
 * linked into the fork's node_modules and dropped from `dependencies`: a workspace package such as
 * `@thetis/marketplace` is on no registry, so an npm install could never satisfy it.
 */
export function forkPackage(spec: ForkSpec): ForkResult {
  if (existsSync(spec.to)) throw new Error(`target exists: ${spec.to}`);
  const from = realpathSync(spec.from);
  const skip = resolve(from, "node_modules");
  cpSync(from, spec.to, { recursive: true, verbatimSymlinks: true, filter: (src) => resolve(src) !== skip });
  const file = resolve(spec.to, "package.json");
  const manifest = JSON.parse(readFileSync(file, "utf8")) as ForkManifest;
  manifest.name = spec.name;
  manifest.version = spec.version;
  delete manifest.scripts;
  delete manifest.devDependencies;
  const linked: string[] = [];
  const remaining: Record<string, string> = {};
  for (const [dep, range] of Object.entries(manifest.dependencies ?? {})) {
    const found = findDependency(from, dep);
    if (found) {
      linkDir(resolve(spec.to, "node_modules", dep), found, spec.root);
      linked.push(dep);
    } else remaining[dep] = range;
  }
  if (Object.keys(remaining).length > 0) manifest.dependencies = remaining;
  else delete manifest.dependencies;
  manifest.thetis = { ...manifest.thetis, forkedFrom: { ...spec.origin } };
  writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
  return { manifest, linked };
}
