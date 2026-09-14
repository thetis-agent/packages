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
