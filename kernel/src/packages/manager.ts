import { existsSync, lstatSync, mkdirSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import type { KernelConfig } from "../config.js";
import type { FencePool } from "../fence/pool.js";
import type { ExecResult } from "../fence/fence.js";
import { SYSTEM_SCOPE, type Manifest, type PackageInfo, type PackageRecord, type UserRecord, type Userspace } from "../types.js";
import { assert, KernelError } from "../util.js";
import { readManifest, scopeOf, toInfo } from "./manifest.js";
import type { PackageRegistry } from "./registry.js";

const GIT_URL = /^(https?:\/\/|git@|git:\/\/|ssh:\/\/).+|\.git$/;

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

  /** Links the configured @thetis/* packages into a fresh userspace. Idempotent. */
  seedSystem(us: Userspace): void {
    const names = [...(this.config.systemPackages["*"] ?? []), ...(this.config.systemPackages[us.id] ?? [])];
    for (const name of names) if (!this.registry.get(name)?.userspaces.includes(us.id)) this.installSystem(us, name);
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
    const kind = GIT_URL.test(source) ? "git" : "local";
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

  systemPackageDir(name: string): string | undefined {
    const base = this.config.systemPackagesDir;
    for (const entry of readdirSync(base)) {
      const dir = resolve(base, entry);
      const file = resolve(dir, "package.json");
      if (!existsSync(file)) continue;
      try {
        if (readManifest(dir).name === name) return dir;
      } catch {
        continue;
      }
    }
    return undefined;
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

  private async clone(us: Userspace, url: string): Promise<string> {
    const slug = basename(url).replace(/\.git$/, "").replace(/[^a-z0-9._-]/gi, "-");
    const dir = resolve(us.store, "src", slug);
    rmSync(dir, { recursive: true, force: true });
    await this.exec(us, `git clone --depth 1 ${shellQuote(url)} ${shellQuote(dir)}`, us.store);
    return dir;
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
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : resolve(us.store, "src", basename(rec.source.ref).replace(/\.git$/, ""));
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
