import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { KernelConfig } from "../config.js";
import type { FencePool } from "../fence/pool.js";
import type { ExecResult } from "../fence/fence.js";
import { SYSTEM_SCOPE, SYSTEM_USER, type Manifest, type PackageInfo, type PackageRecord, type UserRecord, type Userspace } from "../types.js";
import { assert, KernelError } from "../util.js";
import { readManifest, scopeOf, toInfo } from "./manifest.js";
import type { PackageRegistry } from "./registry.js";

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

/**
 * Installs packages into a userspace's store and records them in the registry.
 * Builds run inside the fence; linking and bookkeeping are done by the kernel.
 */
export interface PackageListener {
  installed(us: Userspace, pkg: PackageInfo): Promise<void>;
  uninstalled(us: Userspace, pkg: PackageInfo): Promise<void>;
}

export class PackageManager {
  private listener?: PackageListener;

  constructor(
    private readonly config: KernelConfig,
    private readonly registry: PackageRegistry,
    private readonly fences: FencePool,
  ) {}

  /** One observer of installs and uninstalls, for the service supervisor. */
  observe(listener: PackageListener): void {
    this.listener = listener;
  }

  /** Installed packages of a userspace, with their live manifests, in install order. */
  installed(us: Userspace): PackageInfo[] {
    const out: PackageInfo[] = [];
    for (const rec of this.registry.installedIn(us.id)) {
      const root = this.linkPath(us, rec.name);
      if (!existsSync(resolve(root, "package.json"))) {
        const relinked = this.relink(us, rec);
        if (relinked) out.push(relinked);
        else console.error(`[packages] ${rec.name} is recorded for ${us.id} but its files are missing`);
        continue;
      }
      try {
        out.push(toInfo(readManifest(root), root));
      } catch (err) {
        console.error(`[packages] skipping ${rec.name}: ${(err as Error).message}`);
      }
    }
    return out;
  }

  /**
   * Links the system packages into a fresh userspace: for a person, the `"*"` list, every promoted
   * package, and every package an admin marked for everyone; the userspace's own list always. The
   * system userspace is not a person. Idempotent.
   */
  seedSystem(us: Userspace): void {
    const everyone = us.id === SYSTEM_USER ? [] : [...(this.config.systemPackages["*"] ?? []), ...this.promoted(), ...this.registry.everyone()];
    const names = [...everyone, ...(this.config.systemPackages[us.id] ?? [])];
    for (const name of new Set(names)) if (!this.registry.get(name)?.userspaces.includes(us.id)) this.installSystem(us, name);
  }

  /** Marks a shipped system package as the default for everyone. New people are seeded with it. */
  markEveryone(name: string, on: boolean): void {
    assert(scopeOf(name) === SYSTEM_SCOPE && this.systemPackageDir(name), `not a system package: ${name}`, "invalid");
    this.registry.setEveryone(name, on);
  }

  /** The names of the promoted packages: everything in the promoted directory with a valid manifest. */
  promoted(): string[] {
    const base = this.config.promotedPackagesDir;
    if (!existsSync(base)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(base)) {
      try {
        out.push(readManifest(resolve(base, entry)).name);
      } catch {
        continue;
      }
    }
    return out;
  }

  installSystem(us: Userspace, name: string): PackageInfo {
    assert(scopeOf(name) === SYSTEM_SCOPE, `not a system package: ${name}`);
    const dir = this.systemPackageDir(name);
    assert(dir, `unknown system package: ${name}`);
    const manifest = readManifest(dir);
    this.link(us, name, dir);
    this.registry.record({ name, version: manifest.version, type: manifest.thetis.type, owner: "_system", source: { kind: "system", ref: dir } }, us.id);
    return toInfo(manifest, this.linkPath(us, name));
  }

  /** Installs from a git URL, a path inside the userspace, or a @thetis/* name (admins only). */
  async install(us: Userspace, actor: UserRecord, source: string): Promise<PackageInfo> {
    if (scopeOf(source) === SYSTEM_SCOPE && !source.includes("/", SYSTEM_SCOPE.length + 1)) {
      assert(actor.role !== "user", "only admins can install system packages", "unauthorized");
      const info = this.installSystem(us, source);
      await this.listener?.installed(us, info);
      return info;
    }
    const kind = isGitSource(source) ? "git" : "local";
    const dir = kind === "git" ? await this.clone(us, source) : this.localDir(us, source);
    const manifest = readManifest(dir);
    this.checkOwnership(manifest, us, actor);
    this.checkPeers(manifest, us);
    await this.build(us, dir, manifest);
    this.link(us, manifest.name, dir);
    this.registry.record({ name: manifest.name, version: manifest.version, type: manifest.thetis.type, owner: us.id, source: { kind, ref: source } }, us.id);
    const info = toInfo(manifest, this.linkPath(us, manifest.name));
    await this.listener?.installed(us, info);
    return info;
  }

  async uninstall(us: Userspace, name: string): Promise<void> {
    const pkg = this.installed(us).find((p) => p.name === name);
    if (pkg) await this.listener?.uninstalled(us, pkg);
    const link = this.linkPath(us, name);
    if (existsSync(link) || isLink(link)) rmSync(link, { recursive: true, force: true });
    this.registry.unlink(name, us.id);
  }

  /** Where a @thetis/* package lives: the shipped directory first, then the promoted one. */
  systemPackageDir(name: string): string | undefined {
    for (const base of [this.config.systemPackagesDir, this.config.promotedPackagesDir]) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const dir = resolve(base, entry);
        if (!existsSync(resolve(dir, "package.json"))) continue;
        try {
          if (readManifest(dir).name === name) return dir;
        } catch {
          continue;
        }
      }
    }
    return undefined;
  }

  /**
   * Makes a user's package the default for everyone: copies it into the promoted directory under the
   * @thetis scope, from where every new userspace is seeded with it. Returns the new name. The caller
   * links it into the existing userspaces and removes the owner's original. The configuration file is
   * never written by the kernel.
   */
  promote(us: Userspace, name: string): string {
    const rec = this.registry.get(name);
    assert(rec && rec.owner === us.id && rec.source.kind !== "system" && rec.userspaces.includes(us.id), `${name} is not a package of ${us.id}`, "invalid");
    const base = name.slice(name.indexOf("/") + 1);
    const promoted = `${SYSTEM_SCOPE}/${base}`;
    const target = resolve(this.config.promotedPackagesDir, base);
    assert(!existsSync(target) && !this.systemPackageDir(promoted), `${promoted} already exists`, "invalid");
    cpSync(realpathSync(this.linkPath(us, name)), target, { recursive: true, verbatimSymlinks: true });
    const file = resolve(target, "package.json");
    const manifest = JSON.parse(readFileSync(file, "utf8")) as Manifest;
    manifest.name = promoted;
    writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
    readManifest(target);
    return promoted;
  }

  private checkOwnership(m: Manifest, us: Userspace, actor: UserRecord): void {
    const scope = scopeOf(m.name);
    const allowed = scope === `@${us.id}` || (scope === SYSTEM_SCOPE && actor.role !== "user");
    assert(allowed, `${m.name}: user ${us.id} may only install packages in scope @${us.id}/*`, "unauthorized");
  }

  private checkPeers(m: Manifest, us: Userspace): void {
    const present = new Set(this.registry.installedIn(us.id).map((r) => r.name));
    for (const peer of Object.keys(m.peerDependencies ?? {})) {
      if (peer === "@thetis/kernel") continue;
      assert(present.has(peer), `${m.name} requires ${peer}, which is not installed in this userspace`, "peer");
    }
  }

  private async clone(us: Userspace, source: string): Promise<string> {
    const { url, sub } = splitSource(source);
    const dir = this.cloneDir(us, url);
    rmSync(dir, { recursive: true, force: true });
    await this.exec(us, `git clone --depth 1 ${shellQuote(url)} ${shellQuote(dir)}`, us.store);
    return this.subdir(dir, sub);
  }

  private cloneDir(us: Userspace, url: string): string {
    return resolve(us.store, "src", basename(url).replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-"));
  }

  /** The package directory inside a clone. It must stay inside the clone. */
  private subdir(dir: string, sub: string | undefined): string {
    if (!sub) return dir;
    const inner = resolve(dir, sub);
    const rel = relative(dir, inner);
    assert(rel && !rel.startsWith("..") && !isAbsolute(rel), `package directory must be inside the repository: ${sub}`, "unauthorized");
    return inner;
  }

  private localDir(us: Userspace, source: string): string {
    const dir = isAbsolute(source) ? source : resolve(us.home, source);
    const rel = relative(us.root, dir);
    assert(rel && !rel.startsWith("..") && !isAbsolute(rel), `package path must be inside the userspace: ${source}`, "unauthorized");
    assert(existsSync(resolve(dir, "package.json")), `no package.json at ${source}`);
    return dir;
  }

  private async build(us: Userspace, dir: string, m: Manifest): Promise<void> {
    const hasDeps = Object.keys(m.dependencies ?? {}).length > 0;
    if (m.scripts?.build) await this.exec(us, "npm install --no-audit --no-fund && npm run build", dir);
    else if (hasDeps) await this.exec(us, "npm install --omit=dev --no-audit --no-fund", dir);
    if (m.main) assert(existsSync(resolve(dir, m.main)), `${m.name}: main entry ${m.main} does not exist after build`);
  }

  private async exec(us: Userspace, cmd: string, cwd: string): Promise<void> {
    const r = (await this.fences.request(us, "exec", { cmd, cwd, timeoutMs: 300_000 })) as ExecResult;
    if (r.code !== 0) throw new KernelError(`command failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`.slice(0, 4000), "build");
  }

  /** Repairs a dead store link after the checkout or the data directory moved. */
  private relink(us: Userspace, rec: PackageRecord): PackageInfo | undefined {
    if (rec.source.kind === "system") return this.systemPackageDir(rec.name) ? this.installSystem(us, rec.name) : undefined;
    const git = splitSource(rec.source.ref);
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : this.subdir(this.cloneDir(us, git.url), git.sub);
    if (!existsSync(resolve(dir, "package.json"))) return undefined;
    this.link(us, rec.name, dir);
    return toInfo(readManifest(dir), this.linkPath(us, rec.name));
  }

  /** Links inside the userspace are relative, so a moved data directory keeps working. */
  private link(us: Userspace, name: string, target: string): void {
    const link = this.linkPath(us, name);
    mkdirSync(dirname(link), { recursive: true });
    if (isLink(link)) rmSync(link);
    const inside = !relative(us.root, target).startsWith("..");
    symlinkSync(inside ? relative(dirname(link), target) : target, link, "dir");
  }

  private linkPath(us: Userspace, name: string): string {
    return resolve(us.store, "node_modules", name);
  }
}

function isLink(p: string): boolean {
  try {
    return lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}
