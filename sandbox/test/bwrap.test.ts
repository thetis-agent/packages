// The fence's own cgroup, bound read-only inside it at the path `/proc/self/cgroup` names: where the
// argument list puts it, why it is that path and not the mount root, and what it gives the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "@thetis/contracts";
import { bwrapArgs, hasBwrap, type BwrapLayout } from "../src/bwrap.js";
import { CGROUP_MOUNT, fenceMount } from "../src/cgroup.js";

function space(root: string): Userspace {
  return { id: "alice", root, home: root, store: join(root, "store"), run: join(root, "run"), mounts: [] } as unknown as Userspace;
}

const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };
/** What a delegated kernel under `thetis-runtime.service` names one fence's group. */
const FENCE_DIR = `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`;

/** The index of a flag followed by its first operand, or -1. */
function at(args: string[], flag: string, src?: string): number {
  return args.findIndex((a, i) => a === flag && (src === undefined || args[i + 1] === src));
}

/** This process's own cgroup v2 directory, when the host has one and it is readable. */
function ownCgroupDir(): string | undefined {
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8").split("\n").find((l) => l.startsWith("0::"));
    const dir = line && join(CGROUP_MOUNT, line.slice(3).trim());
    return dir && existsSync(join(dir, "memory.max")) ? dir : undefined;
  } catch {
    return undefined;
  }
}

test("the destination mirrors /proc/self/cgroup, and on the host it is the directory itself", () => {
  const mount = fenceMount(FENCE_DIR);
  // A runtime resolves its own group by appending the `/proc/self/cgroup` line to the mount point. The
  // fence sees the host's line (it is in no cgroup namespace), so the group has to sit at exactly that
  // path: mount point + `/system.slice/thetis-runtime.service/fence-alice`.
  assert.equal(mount.dest, `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`);
  assert.equal(mount.dest, mount.dir, "the mount point is the same inside the fence as on the host");
  assert.notEqual(mount.dest, CGROUP_MOUNT, "never the mount root: that is what broke .NET");
});

test("the fence's own cgroup is bound read-only at that path, before the userspace", () => {
  const root = "/srv/thetis/users/alice";
  const args = bwrapArgs(space(root), { ...layout, cgroup: fenceMount(FENCE_DIR) }, {});

  const bind = at(args, "--ro-bind-try", FENCE_DIR);
  assert.ok(bind >= 0, `no --ro-bind-try of the fence cgroup in ${args.join(" ")}`);
  assert.equal(args[bind + 2], `${CGROUP_MOUNT}/system.slice/thetis-runtime.service/fence-alice`);
  // Bubblewrap makes the intermediate directories of a destination itself, so the nested path needs no
  // `--dir` of its own. The whole cgroup tree is named exactly twice — the source and the destination of
  // this one read-only bind — so the mount root is never a destination, writable or otherwise.
  assert.deepEqual(args.filter((a) => a.startsWith(CGROUP_MOUNT)), [FENCE_DIR, args[bind + 2]]);
  assert.equal(args.includes(CGROUP_MOUNT), false, "/sys/fs/cgroup itself is never a bind destination");
  // `-try` and not `--ro-bind`: the directory appears while the launch gate is still shut, and when limits
  // are off it never appears at all. Neither case may fail the fence.
  for (const writable of ["--bind", "--dev-bind", "--bind-try", "--dev-bind-try", "--tmpfs"]) {
    assert.equal(at(args, writable, FENCE_DIR), -1, `the cgroup is never ${writable}`);
  }

  // It sits after the read-only host and before the writable userspace, so a later bind cannot be shadowed by it.
  assert.ok(bind > at(args, "--proc", "/proc"), "after the OS view");
  assert.ok(bind < at(args, "--bind", root), "before the userspace bind");
  assert.ok(bind < args.indexOf("--unshare-user"), "before the namespace flags");
});

test("no delegated cgroup means no bind at all, and never the host's whole tree", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), layout, {});
  assert.equal(args.includes(CGROUP_MOUNT), false, "nothing is mounted at /sys/fs/cgroup");
  assert.equal(args.includes("--ro-bind-try"), false);
  // Mode `none` never reaches here, and cgroups v1 and an undelegated kernel both leave `cgroup` unset.
  assert.equal(args.some((a) => a.startsWith("/sys")), false, "no part of /sys is bound");
});

test("under bubblewrap the agent reads its own limits there, sees no sibling, and cannot write", { skip: !hasBwrap() && "bubblewrap is not available" }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-cgroup-"));
  const root = join(tmp, "userspace");
  const dir = join(tmp, "fence-alice");
  mkdirSync(root);
  mkdirSync(dir);
  mkdirSync(join(tmp, "fence-bob"));
  // Stands in for the fence's group: `Cgroups.place` writes the same file names into the real one.
  writeFileSync(join(dir, "memory.max"), "1073741824\n");
  writeFileSync(join(dir, "memory.events"), "oom 0\noom_kill 3\n");

  // The host directory is the temporary one; the destination is where a delegated kernel would put it.
  const dest = fenceMount(FENCE_DIR).dest;
  const args = bwrapArgs(space(root), { ...layout, cgroup: { dir, dest } }, {});
  const show = `cat ${dest}/memory.max ${dest}/memory.events; ls ${CGROUP_MOUNT}/system.slice/thetis-runtime.service; ls /sys`;
  const read = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", show], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /1073741824/);
  assert.match(read.stdout, /oom_kill 3/);
  assert.equal(read.stdout.includes("fence-bob"), false, "no sibling fence's group is reachable");
  assert.equal(read.stdout.trim().split("\n").pop(), "fs", "only /sys/fs exists inside; no other part of /sys");

  const write = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", `echo 1 > ${dest}/memory.max`], { encoding: "utf8" });
  assert.notEqual(write.status, 0, "the fence must not be able to change its own limits");
  assert.match(write.stderr, /[Rr]ead-only/);
});

const dotnet = spawnSync("sh", ["-c", "command -v dotnet"], { encoding: "utf8" }).stdout.trim();
const own = ownCgroupDir();
const toolchain = !hasBwrap() ? "bubblewrap is not available" : !dotnet ? "dotnet is not installed" : !own ? "no readable cgroup v2 group" : false;

test("a runtime that resolves its own cgroup starts, every time", { skip: toolchain }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-dotnet-"));
  // The cgroup this process is in: inside the fence `/proc/self/cgroup` still names it, so binding it at
  // its own path is exactly what a fence sees. Bound at `/sys/fs/cgroup` instead, .NET appends that line
  // to the mount point, reads a directory that is not there, and aborts at random —
  // `munmap_chunk(): invalid pointer` or a segfault, in maybe one run out of three.
  const args = bwrapArgs(space(tmp), { ...layout, cgroup: fenceMount(own as string) }, { HOME: tmp, PATH: "/usr/local/bin:/usr/bin:/bin" });
  for (let i = 0; i < 10; i++) {
    const run = spawnSync("bwrap", [...args, "--", dotnet, "--version"], { encoding: "utf8" });
    assert.equal(run.status, 0, `run ${i + 1}: exit ${run.status} signal ${run.signal}\n${run.stderr}`);
    assert.doesNotMatch(run.stderr, /munmap_chunk|Segmentation fault|Aborted|double free/, `run ${i + 1}`);
  }
  // And it reads the fence's limit rather than the host's memory, which is the point of the bind.
  const limit = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", `cat /proc/self/cgroup; cat $(echo ${CGROUP_MOUNT}$(sed -n 's/^0:://p' /proc/self/cgroup))/memory.max`], { encoding: "utf8" });
  assert.equal(limit.status, 0, limit.stderr);
  assert.equal(limit.stdout.trim().split("\n")[0], `0::${(own as string).slice(CGROUP_MOUNT.length)}`);
});
