// File and shell mechanics of package installation: sources, clones, builds, links, and copies.
// Who may install what, and where, is decided by the caller.
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const GIT_URL = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/|file:\/\/).+|\.git$/;

/** A git source is `<url>` or `<url>#<directory inside the repository>`. */
export function splitSource(source: string): { url: string; sub?: string } {
  const hash = source.indexOf("#");
  if (hash < 0) return { url: source };
  const sub = source.slice(hash + 1);
  return sub ? { url: source.slice(0, hash), sub } : { url: source.slice(0, hash) };
}

export function isGitSource(source: string): boolean {
  return GIT_URL.test(splitSource(source).url);
}

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The directory name a clone of `url` gets: the repository name, made safe for a path. */
export function cloneSlug(url: string): string {
  return basename(url).replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-");
}

export function cloneCommand(url: string, dir: string): string {
  return `git clone --depth 1 ${shellQuote(url)} ${shellQuote(dir)}`;
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
