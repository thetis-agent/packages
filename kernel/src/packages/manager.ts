import { existsSync, readdirSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { SYSTEM_SCOPE, SYSTEM_USER, type DeletedPackage, type ExecResult, type Fences, type Manifest, type PackageInfo, type PackageRecord, type PackageSource, type UserRecord, type Userspace } from "@thetis/contracts";
import { assert, CodedError, errorMessage } from "@thetis/lib/error";
import { buildCommand, cloneCommand, cloneSlug, copyPackageAs, hasPackageJson, isGitSource, isInside, linkDir, removeLink, splitSource } from "@thetis/lib/pkg-fs";
import type { KernelConfig } from "../config.js";
import { readManifest, scopeOf, toInfo } from "./manifest.js";
import type { PackageRegistry } from "./registry.js";

/** Peers the platform itself satisfies. They are types for package authors, never installed into a userspace. */
const PLATFORM_PEERS = new Set(["@thetis/kernel", "@thetis/contracts", "@thetis/lib"]);
const BUILD_TIMEOUT_MS = 300_000;

export interface PackageListener {
  installed(us: Userspace, pkg: PackageInfo): Promise<void>;
  uninstalled(us: Userspace, pkg: PackageInfo): Promise<void>;
}

/**
 * Decides what may be installed where, and records it. Clones and builds run inside the fence of the
 * userspace that receives the package; the link into its store and the registry row are the kernel's.
 */
export class PackageManager {
  private listener?: PackageListener;

  constructor(
    private readonly config: KernelConfig,
    private readonly registry: PackageRegistry,
    private readonly fences: Fences,
  ) {}

  /** One observer of installs and uninstalls, for the service supervisor. */
  observe(listener: PackageListener): void {
    this.listener = listener;
  }

  /** Installed packages of a userspace, with their live manifests, in install order. */
  installed(us: Userspace): PackageInfo[] {
    const out: PackageInfo[] = [];
    const everyone = new Set(this.forEveryone());
    const mark = (info: PackageInfo, rec: PackageRecord) => ({ ...info, ...(everyone.has(info.name) ? { everyone: true } : {}), ...(rec.replaced ? { replaced: rec.replaced } : {}) });
    for (const rec of this.registry.installedIn(us.id)) {
      const root = this.linkPath(us, rec.name);
      if (!hasPackageJson(root)) {
        const relinked = this.relink(us, rec);
        if (relinked) out.push(mark(relinked, rec));
        else console.error(`[packages] ${rec.name} is recorded for ${us.id} but its files are missing`);
        continue;
      }
      try {
        out.push(mark(toInfo(readManifest(root), root), rec));
      } catch (err) {
        console.error(`[packages] skipping ${rec.name}: ${errorMessage(err)}`);
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
    const everyone = us.id === SYSTEM_USER ? [] : this.forEveryone();
    const names = [...everyone, ...(this.config.systemPackages[us.id] ?? [])];
    for (const name of new Set(names)) {
      if (!this.registry.get(name)?.userspaces.includes(us.id)) this.installSystem(us, name);
    }
  }

  /** The packages every person gets: the `"*"` list, every promoted package, and every package marked for everyone. */
  forEveryone(): string[] {
    return [...(this.config.systemPackages["*"] ?? []), ...this.promoted(), ...this.registry.everyone()];
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

  installSystem(us: Userspace, name: string, replaced?: { replaced: string; replacedSource: PackageSource }): PackageInfo {
    assert(scopeOf(name) === SYSTEM_SCOPE, `not a system package: ${name}`);
    const dir = this.systemPackageDir(name);
    assert(dir, `unknown system package: ${name}`);
    const manifest = readManifest(dir);
    this.link(us, name, dir);
    const rec = { name, version: manifest.version, type: manifest.thetis.type, owner: SYSTEM_USER, source: { kind: "system" as const, ref: dir }, forkedFrom: manifest.thetis.forkedFrom };
    this.registry.record({ ...rec, ...replaced }, us.id);
    return toInfo(manifest, this.linkPath(us, name));
  }

  /**
   * Installs from a git URL, a path inside the userspace, or a @thetis/* name (admins only). A fork whose
   * origin is installed here replaces it in one operation: the origin's service stops and its link goes
   * before the fork's link and service come, so tool names and sockets never clash.
   */
  async install(us: Userspace, actor: UserRecord, source: string): Promise<PackageInfo> {
    if (scopeOf(source) === SYSTEM_SCOPE && !source.includes("/", SYSTEM_SCOPE.length + 1)) {
      assert(actor.role !== "user", "only admins can install system packages", "unauthorized");
      const dir = this.systemPackageDir(source);
      const replaced = dir ? await this.displace(us, readManifest(dir)) : undefined;
      const info = this.installSystem(us, source, replaced);
      await this.listener?.installed(us, info);
      return info;
    }
    const kind: PackageSource["kind"] = isGitSource(source) ? "git" : "local";
    const dir = kind === "git" ? await this.clone(us, source) : this.localDir(us, source);
    const manifest = readManifest(dir);
    this.checkOwnership(manifest, us, actor);
    this.checkPeers(manifest, us);
    await this.build(us, dir, manifest);
    const replaced = await this.displace(us, manifest);
    this.link(us, manifest.name, dir);
    const rec = { name: manifest.name, version: manifest.version, type: manifest.thetis.type, owner: us.id, source: { kind, ref: source }, forkedFrom: manifest.thetis.forkedFrom };
    this.registry.record({ ...rec, ...replaced }, us.id);
    const info = { ...toInfo(manifest, this.linkPath(us, manifest.name)), ...(replaced ? { replaced: replaced.replaced } : {}) };
    await this.listener?.installed(us, info);
    return info;
  }

  /** Removes the link and the record. When the package had displaced its origin, the origin comes back, service and all. */
  async uninstall(us: Userspace, name: string): Promise<PackageInfo | undefined> {
    const rec = this.registry.get(name);
    const pkg = this.installed(us).find((p) => p.name === name);
    if (pkg) await this.listener?.uninstalled(us, pkg);
    removeLink(this.linkPath(us, name));
    this.registry.unlink(name, us.id);
    return rec?.replaced ? this.restore(us, rec.replaced, rec.replacedSource) : undefined;
  }

  /** Uninstalls a package of the userspace's own scope and deletes its files. Only files under the home go. */
  async delete(us: Userspace, name: string): Promise<DeletedPackage> {
    const rec = this.registry.get(name);
    assert(rec && scopeOf(name) === `@${us.id}` && rec.userspaces.includes(us.id), `${name} is not a package of ${us.id}`, "unauthorized");
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : undefined;
    assert(dir && isInside(us.home, dir), `${name} does not live under the home directory; uninstall it instead`, "unauthorized");
    const restored = await this.uninstall(us, name);
    rmSync(dir, { recursive: true, force: true });
    return { name, path: dir, ...(restored ? { restored: restored.name } : {}) };
  }

  /** The fork rule: when a manifest names an origin that is installed here, the origin is stopped and unlinked first. */
  private async displace(us: Userspace, m: Manifest): Promise<{ replaced: string; replacedSource: PackageSource } | undefined> {
    const origin = m.thetis.forkedFrom?.name;
    const rec = origin && origin !== m.name ? this.registry.get(origin) : undefined;
    if (!rec?.userspaces.includes(us.id)) return undefined;
    await this.uninstall(us, rec.name);
    return { replaced: rec.name, replacedSource: rec.source };
  }

  /** Puts a displaced origin back: a system package by name, anything else from where it was installed from. */
  private async restore(us: Userspace, name: string, source?: PackageSource): Promise<PackageInfo | undefined> {
    const own = source && source.kind !== "system" ? { name, version: "", type: "", owner: us.id, source, userspaces: [] } : undefined;
    const info = own ? this.relink(us, own) : this.systemPackageDir(name) ? this.installSystem(us, name) : undefined;
    if (!info) return undefined;
    if (own) this.registry.record({ ...own, version: info.version, type: info.type }, us.id);
    await this.listener?.installed(us, info);
    return info;
  }

  /** Where a @thetis/* package lives: the shipped directory first, then the promoted one. */
  systemPackageDir(name: string): string | undefined {
    for (const base of [this.config.systemPackagesDir, this.config.promotedPackagesDir]) {
      if (!existsSync(base)) continue;
      for (const entry of readdirSync(base)) {
        const dir = resolve(base, entry);
        if (!hasPackageJson(dir)) continue;
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
    copyPackageAs(this.linkPath(us, name), target, promoted);
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
      if (PLATFORM_PEERS.has(peer)) continue;
      assert(present.has(peer), `${m.name} requires ${peer}, which is not installed in this userspace`, "peer");
    }
  }

  private async clone(us: Userspace, source: string): Promise<string> {
    const { url, sub } = splitSource(source);
    const dir = this.cloneDir(us, url);
    rmSync(dir, { recursive: true, force: true });
    await this.exec(us, cloneCommand(url, dir), us.store);
    return this.subdir(dir, sub);
  }

  private cloneDir(us: Userspace, url: string): string {
    return resolve(us.store, "src", cloneSlug(url));
  }

  /** The package directory inside a clone. It must stay inside the clone. */
  private subdir(dir: string, sub: string | undefined): string {
    if (!sub) return dir;
    const inner = resolve(dir, sub);
    assert(isInside(dir, inner), `package directory must be inside the repository: ${sub}`, "unauthorized");
    return inner;
  }

  private localDir(us: Userspace, source: string): string {
    const dir = isAbsolute(source) ? source : resolve(us.home, source);
    assert(isInside(us.root, dir), `package path must be inside the userspace: ${source}`, "unauthorized");
    assert(hasPackageJson(dir), `no package.json at ${source}`);
    return dir;
  }

  private async build(us: Userspace, dir: string, m: Manifest): Promise<void> {
    const cmd = buildCommand(m);
    if (cmd) await this.exec(us, cmd, dir);
    if (m.main) assert(existsSync(resolve(dir, m.main)), `${m.name}: main entry ${m.main} does not exist after build`);
  }

  private async exec(us: Userspace, cmd: string, cwd: string): Promise<void> {
    const r = (await this.fences.request(us, "exec", { cmd, cwd, timeoutMs: BUILD_TIMEOUT_MS })) as ExecResult;
    if (r.code !== 0) throw new CodedError(`command failed (${r.code}): ${cmd}\n${r.stderr || r.stdout}`.slice(0, 4000), "build");
  }

  /** Repairs a dead store link after the checkout or the data directory moved. */
  private relink(us: Userspace, rec: PackageRecord): PackageInfo | undefined {
    if (rec.source.kind === "system") return this.systemPackageDir(rec.name) ? this.installSystem(us, rec.name) : undefined;
    const git = splitSource(rec.source.ref);
    const dir = rec.source.kind === "local" ? resolve(us.home, rec.source.ref) : this.subdir(this.cloneDir(us, git.url), git.sub);
    if (!hasPackageJson(dir)) return undefined;
    this.link(us, rec.name, dir);
    return toInfo(readManifest(dir), this.linkPath(us, rec.name));
  }

  private link(us: Userspace, name: string, target: string): void {
    linkDir(this.linkPath(us, name), target, us.root);
  }

  private linkPath(us: Userspace, name: string): string {
    return resolve(us.store, "node_modules", name);
  }
}
