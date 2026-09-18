// Resource limits per fence through cgroup v2. The kernel process must sit in a delegated cgroup
// (systemd `Delegate=yes` on the unit, or `systemd-run --user --scope -p Delegate=yes`). Without one
// the fences run unlimited and the kernel says so once.
import { existsSync, mkdirSync, readFileSync, rmdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";

/** Where the cgroup v2 filesystem is mounted — on the host, and inside every fence. */
export const CGROUP_MOUNT = "/sys/fs/cgroup";

export interface FenceLimits {
  memoryMb: number;
  pids: number;
  cpuPercent: number;
}

export interface Placement {
  attach(pid: number): void;
  release(): void;
}

/** One fence's own cgroup: where it is on the host, and where the fence has to see it. */
export interface FenceCgroup {
  /** The host directory of this fence's group. */
  dir: string;
  /**
   * Where `dir` is bound inside the fence: the mount point plus the path this fence's own
   * `/proc/self/cgroup` line reports. A runtime finds its group by concatenating those two — .NET does —
   * so the group has to sit at exactly that path. Bound at the mount root instead, the concatenation
   * names a directory that does not exist, .NET's probe reads garbage, and the runtime aborts
   * (`munmap_chunk(): invalid pointer`, sometimes a segfault) at random inside every fence.
   */
  dest: string;
}

const CONTROLLERS = ["memory", "pids", "cpu"];

/**
 * Where a fence's cgroup directory has to appear inside the fence — derived here, so only this file knows
 * how a cgroup path is spelled. The directory's path relative to the filesystem root is what
 * `/proc/self/cgroup` reports inside the fence, and the mount point plus that path is where the fence, and
 * any runtime resolving its own limits, looks for it.
 */
export function fenceMount(dir: string): FenceCgroup {
  return { dir, dest: join(CGROUP_MOUNT, relative(CGROUP_MOUNT, dir)) };
}

export class Cgroups {
  private constructor(private readonly root: string) {}

  /** Adopts the kernel's own delegated cgroup: moves the kernel into a child and enables the controllers for siblings. */
  static detect(log: (line: string) => void): Cgroups | undefined {
    try {
      const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
      if (!line) return undefined;
      const root = resolve(CGROUP_MOUNT, "." + line.slice(3).trim());
      const available = readFileSync(resolve(root, "cgroup.controllers"), "utf8").split(/\s+/);
      const missing = CONTROLLERS.filter((c) => !available.includes(c));
      if (missing.length) throw new Error(`controllers not delegated: ${missing.join(", ")}`);
      mkdirSync(resolve(root, "kernel"), { recursive: true });
      writeFileSync(resolve(root, "kernel", "cgroup.procs"), String(process.pid));
      writeFileSync(resolve(root, "cgroup.subtree_control"), CONTROLLERS.map((c) => `+${c}`).join(" "));
      log(`[fence] resource limits on: ${root}`);
      return new Cgroups(root);
    } catch (err) {
      log(`[fence] resource limits off: ${(err as Error).message} (run the kernel in a delegated cgroup to enable them)`);
      return undefined;
    }
  }

  /** Where one fence's own group lives on the host. `place` creates it. */
  fenceDir(id: string): string {
    return resolve(this.root, `fence-${id}`);
  }

  /** That directory and where the fence has to see it. `place` creates it. */
  fence(id: string): FenceCgroup {
    return fenceMount(this.fenceDir(id));
  }

  /** A limited group for one fence. `attach` moves a process into it; `release` removes the group once it is empty. */
  place(id: string, limits: FenceLimits): Placement {
    const dir = this.fenceDir(id);
    mkdirSync(dir, { recursive: true });
    writeFileSync(resolve(dir, "memory.max"), String(Math.max(16, limits.memoryMb) * 1024 * 1024));
    if (existsSync(resolve(dir, "memory.swap.max"))) writeFileSync(resolve(dir, "memory.swap.max"), "0");
    writeFileSync(resolve(dir, "pids.max"), String(Math.max(8, limits.pids)));
    writeFileSync(resolve(dir, "cpu.max"), `${Math.max(1, limits.cpuPercent) * 1000} 100000`);
    return {
      attach: (pid) => writeFileSync(resolve(dir, "cgroup.procs"), String(pid)),
      release: () => {
        try {
          rmdirSync(dir);
        } catch {
          // Processes still exiting keep the group populated; the next open of this fence reuses it.
        }
      },
    };
  }
}
