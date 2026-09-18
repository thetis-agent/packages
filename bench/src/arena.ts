// The arena: one throwaway kernel in a temporary home, with every arm staged as its own user.
//
// Hermetic rather than attached to a running daemon, for reasons that are all the same reason — the numbers
// must be a property of the packages and not of the machine they were measured on. The bench phase must not
// exist in any production configuration; the floor arm must contain exactly what the bench put there; the
// gold must sit somewhere no fence can mount; and the runner needs to read the provider's capture file,
// which the control socket does not offer.
//
// Arms are users rather than kernels because a userspace already is the isolation: package sets are per
// user, so one boot gives every arm its own fence, its own store and its own sessions.
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { SYSTEM_USER } from "@thetis/contracts";
import { createKernel, defaultConfig, T, type Kernel, type KernelConfig } from "@thetis/host";
import { memoryStore } from "@thetis/lib/store";

export const BENCH_PHASE = "bench";
export const PROBE_PACKAGE = "@thetis/bench-probe";
export const PROVIDER_PACKAGE = "@thetis/provider-bench";
const SYSTEM_SCOPE = "@thetis";

/** One thing being measured. `packages` are the package directories staged for this arm's user alone. */
export interface Arm {
  id: string;
  /** Absolute paths to package source directories. The floor arm has none. */
  packages?: string[];
  /** Per-package configuration. Global in the kernel, so the runner shards when two arms disagree. */
  config?: Record<string, Record<string, unknown>>;
}

export interface ArenaOptions {
  project: string;
  arms: Arm[];
  /** Package directories every arm gets. Defaults to the harness and the probe. */
  base?: string[];
  sandbox?: "auto" | "bwrap" | "none";
  canaries?: Record<string, string>;
  script?: unknown;
  packageConfig?: Record<string, Record<string, unknown>>;
  /** Written where an importer can read it, before the first turn of every arm. */
  corpus?: unknown;
  requestTimeoutMs?: number;
  log?: (line: string) => void;
  /** With a model, the bench provider forwards to a real one and only measures. Costs money. */
  upstream?: { model: string; package?: string; config?: Record<string, unknown>; maxCostUsd: number };
}

const slug = (armId: string): string => `bench-${armId.replace(/[^a-z0-9-]/gi, "-").toLowerCase()}`;
const scopeOf = (name: string): string => name.slice(0, name.indexOf("/"));

/**
 * A package's scope is its owner, and a userspace belongs to exactly one owner, so an arm carrying
 * `@alice/skills` must run as `alice`. System-scoped arms get a name of their own. Two arms that would need
 * the same person are a configuration error the caller has to resolve by sharding the run.
 */
export function userForArm(arm: Arm, names: readonly string[]): string {
  const owners = [...new Set(names.filter((n) => scopeOf(n) !== SYSTEM_SCOPE).map((n) => scopeOf(n).slice(1)))];
  if (owners.length > 1) throw new Error(`arm ${arm.id} carries packages of more than one owner: ${owners.join(", ")}`);
  return owners[0] ?? slug(arm.id);
}

/** A package's declared name, read straight off its manifest: the arena stages directories, not names. */
function nameOf(dir: string): string {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { name?: unknown };
  if (typeof manifest.name !== "string") throw new Error(`${dir} has no package name`);
  return manifest.name;
}

export class Arena {
  private constructor(
    readonly home: string,
    readonly kernel: Kernel,
    readonly config: KernelConfig,
    readonly capture: string,
    readonly arms: Arm[],
    private readonly users: Map<string, string>,
    private readonly local: Map<string, string[]>,
  ) {}

  static async open(opts: ArenaOptions): Promise<Arena> {
    const home = mkdtempSync(join(tmpdir(), "thetis-bench-"));
    const sys = join(home, "system-packages");
    mkdirSync(sys);

    const project = opts.project;
    const base = opts.base ?? [resolve(project, "packages/harness-core"), resolve(project, "packages/bench-probe")];
    const provider = resolve(project, "packages/bench/fixtures/provider-bench");
    const staged = new Map<string, string>();
    const stage = (dir: string): string => {
      const name = nameOf(dir);
      if (!staged.has(name)) {
        symlinkSync(dir, join(sys, basename(dir)));
        staged.set(name, dir);
      }
      return name;
    };

    const baseNames = base.map(stage);
    stage(provider);
    // A system-scoped arm package is seeded like any other system package. A user-scoped one cannot be:
    // it belongs to a person, so it is copied into that person's home and installed from there, exactly as
    // they would install it themselves.
    const armNames = new Map<string, string[]>();
    const users = new Map<string, string>();
    const local = new Map<string, string[]>();
    for (const arm of opts.arms) {
      const dirs = arm.packages ?? [];
      const names = dirs.map(nameOf);
      users.set(arm.id, userForArm(arm, names));
      armNames.set(arm.id, dirs.filter((d) => scopeOf(nameOf(d)) === SYSTEM_SCOPE).map(stage));
      local.set(arm.id, dirs.filter((d) => scopeOf(nameOf(d)) !== SYSTEM_SCOPE));
    }
    const owners = [...users.values()];
    if (new Set(owners).size !== owners.length) {
      throw new Error("two arms need the same person; run them as separate benches");
    }

    // The provider runs in the system userspace, and under bwrap it can only see that userspace. So the
    // capture and the script live in the system fence's own home, where the provider can write and the host
    // can read. Anywhere else in the temporary home is hidden from it.
    const data = join(home, "data");
    const systemHome = join(data, "userspaces", SYSTEM_USER, "home");
    mkdirSync(systemHome, { recursive: true });
    const capture = join(systemHome, "capture.ndjson");
    const scriptPath = join(systemHome, "script.json");
    writeFileSync(scriptPath, JSON.stringify(opts.script ?? { default: { turns: [{ text: "ok" }] } }));

    const config = defaultConfig(data, project);
    config.systemPackagesDir = sys;
    config.model = "bench/adhoc/adhoc/adhoc/0";
    if (opts.upstream) config.fence.network = "egress";
    config.phases = ["history", "prompt", "tools", BENCH_PHASE, "call", "after"];
    config.fence.sandbox = opts.sandbox ?? "auto";
    config.fence.readOnly.push(sys, ...staged.values());
    config.requestTimeoutMs = opts.requestTimeoutMs ?? 120_000;
    config.systemPackages = { "*": baseNames, _system: [PROVIDER_PACKAGE] };
    for (const [armId, names] of armNames) if (names.length) config.systemPackages[users.get(armId) as string] = names;
    const upstreamPackage = opts.upstream?.package ?? "@thetis/provider-openrouter";
    if (opts.upstream) stage(resolve(project, "packages", upstreamPackage.split("/").pop() as string));
    config.packages = {
      ...opts.packageConfig,
      [PROVIDER_PACKAGE]: {
        capture,
        script: scriptPath,
        canaries: opts.canaries ?? {},
        ...(opts.upstream
          ? {
              maxCostUsd: opts.upstream.maxCostUsd,
              upstream: { package: upstreamPackage, model: opts.upstream.model, config: opts.upstream.config ?? {} },
            }
          : {}),
      },
    };

    const log = opts.log ?? (() => {});
    // Records in memory: a bench home is thrown away with the run, and the arms' packages are the only ones in its system directory.
    const kernel = await createKernel(config, (c) => c.bind(T.log, () => log).bind(T.store, () => memoryStore()));
    // Admins, because an arm may have to install a system-scoped candidate into its own userspace.
    for (const arm of opts.arms) kernel.users.create(users.get(arm.id) as string, "admin");

    const arena = new Arena(home, kernel, config, capture, opts.arms, users, local);
    if (opts.corpus !== undefined) arena.writeCorpus(opts.corpus);
    await arena.installLocal();
    return arena;
  }

  userOf(armId: string): string {
    const user = this.users.get(armId);
    if (!user) throw new Error(`no such arm: ${armId}`);
    return user;
  }

  /** Copy each user-scoped candidate into its owner's home and install it from there. */
  private async installLocal(): Promise<void> {
    for (const [armId, dirs] of this.local) {
      if (!dirs.length) continue;
      const user = this.userOf(armId);
      const record = this.kernel.users.authorize(user);
      const us = this.kernel.sessions.userspaceFor(record);
      for (const dir of dirs) {
        const at = join(us.home, "packages", basename(dir));
        mkdirSync(join(us.home, "packages"), { recursive: true });
        cpSync(dir, at, { recursive: true, dereference: true });
        await this.kernel.packages.install(us, record, `packages/${basename(dir)}`);
      }
    }
  }

  /**
   * The corpus goes where an importer reads it, in every arm's home. Written by the host before the first
   * turn, so a package never has to be told where it is and the bench never has to hand it over a wire.
   */
  writeCorpus(corpus: unknown): void {
    for (const arm of this.arms) {
      const dir = join(this.home, "data", "userspaces", this.userOf(arm.id), "home", "bench");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "corpus.json"), JSON.stringify(corpus));
    }
  }

  async close(): Promise<void> {
    await this.kernel.shutdown();
    rmSync(this.home, { recursive: true, force: true });
  }
}
