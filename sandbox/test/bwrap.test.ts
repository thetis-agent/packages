// The fence's own cgroup, bound read-only at /sys/fs/cgroup: the argument list, and what it gives the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Userspace } from "@thetis/contracts";
import { bwrapArgs, hasBwrap, type BwrapLayout } from "../src/bwrap.js";

function space(root: string): Userspace {
  return { id: "alice", root, home: root, store: join(root, "store"), run: join(root, "run"), mounts: [] } as unknown as Userspace;
}

const layout: BwrapLayout = { readOnly: [], hidden: [], sharedDir: "/nowhere", resolvConf: "/nowhere", network: "host" };

/** The index of a flag followed by its first operand, or -1. */
function at(args: string[], flag: string, src?: string): number {
  return args.findIndex((a, i) => a === flag && (src === undefined || args[i + 1] === src));
}

test("the fence's own cgroup is bound read-only at /sys/fs/cgroup, before the userspace", () => {
  const root = "/srv/thetis/users/alice";
  const dir = "/sys/fs/cgroup/system.slice/thetis-runtime.service/fence-alice";
  const args = bwrapArgs(space(root), { ...layout, cgroupDir: dir }, {});

  const bind = at(args, "--ro-bind-try", dir);
  assert.ok(bind >= 0, `no --ro-bind-try of the fence cgroup in ${args.join(" ")}`);
  assert.equal(args[bind + 2], "/sys/fs/cgroup");
  // `-try` and not `--ro-bind`: the directory appears while the launch gate is still shut, and when limits
  // are off it never appears at all. Neither case may fail the fence.
  assert.equal(args.filter((a) => a === "/sys/fs/cgroup").length, 1, "/sys/fs/cgroup is a destination once and nothing else");
  assert.equal(at(args, "--bind", dir), -1, "the cgroup is never writable");
  assert.equal(at(args, "--dev-bind", dir), -1, "the cgroup is never writable");

  // It sits after the read-only host and before the writable userspace, so a later bind cannot be shadowed by it.
  assert.ok(bind > at(args, "--proc", "/proc"), "after the OS view");
  assert.ok(bind < at(args, "--bind", root), "before the userspace bind");
  assert.ok(bind < args.indexOf("--unshare-user"), "before the namespace flags");
});

test("no delegated cgroup means no bind at all, and never the host's whole tree", () => {
  const args = bwrapArgs(space("/srv/thetis/users/alice"), layout, {});
  assert.equal(args.includes("/sys/fs/cgroup"), false, "nothing is mounted at /sys/fs/cgroup");
  assert.equal(args.includes("--ro-bind-try"), false);
  // Mode `none` never reaches here, and cgroups v1 and an undelegated kernel both leave `cgroupDir` unset.
  assert.equal(args.some((a) => a.startsWith("/sys")), false, "no part of /sys is bound");
});

test("under bubblewrap the agent reads its own limits there, and cannot write them", { skip: !hasBwrap() && "bubblewrap is not available" }, () => {
  const tmp = mkdtempSync(join(tmpdir(), "thetis-cgroup-"));
  const root = join(tmp, "userspace");
  const dir = join(tmp, "fence-alice");
  mkdirSync(root);
  mkdirSync(dir);
  // Stands in for the fence's group: `Cgroups.place` writes the same file names into the real one.
  writeFileSync(join(dir, "memory.max"), "1073741824\n");
  writeFileSync(join(dir, "memory.events"), "oom 0\noom_kill 3\n");

  const args = bwrapArgs(space(root), { ...layout, cgroupDir: dir }, {});
  const read = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", "cat /sys/fs/cgroup/memory.max /sys/fs/cgroup/memory.events; ls /sys"], { encoding: "utf8" });
  assert.equal(read.status, 0, read.stderr);
  assert.match(read.stdout, /1073741824/);
  assert.match(read.stdout, /oom_kill 3/);
  assert.equal(read.stdout.trim().split("\n").pop(), "fs", "only /sys/fs exists inside; no other part of /sys");

  const write = spawnSync("bwrap", [...args, "--", "/bin/sh", "-c", "echo 1 > /sys/fs/cgroup/memory.max"], { encoding: "utf8" });
  assert.notEqual(write.status, 0, "the fence must not be able to change its own limits");
  assert.match(write.stderr, /[Rr]ead-only/);
});
