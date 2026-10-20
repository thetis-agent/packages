// The host writes a trial's files into the person's own home, because that is where their fence -- and
// @thetis/reflections inside it -- can read them. But the host is the daemon's user, and the person's fence
// can write that home: a link planted there, or swapped in while the host is mid-write, would aim the host's
// write anywhere the daemon may write. So every read and write in a person's space runs in a jail: a
// bubblewrap with that person's userspace directory as the only writable path and nothing of the host's
// data mounted at all, where a link leads only back into their own space or to nothing. Inside, the same
// segment-by-segment checks run again (safe-fs.js).
//
// The jail binds `<home>/userspaces/<user>`, the userspace root, rather than its `home`: the root is the
// mount point of the person's fence and cannot be replaced from inside it, and its parent is not visible
// to any fence, so the directory bound is the one meant. Without bubblewrap (a test machine) the same
// operations run in this process, checked by safe-fs alone.
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { assert, fail } from "./error.js";
import { applyOps } from "./jail-worker.js";

const LIB = dirname(fileURLToPath(import.meta.url));
const WORKER = resolve(LIB, "jail-worker.js");
const OS_DIRS = ["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/etc"];

let bwrapped;
/** Whether bubblewrap runs here. Asked once: it is a fact about the machine. */
export function hasBwrap() {
  if (bwrapped === undefined) bwrapped = spawnSync("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"], { stdio: "ignore" }).status === 0;
  return bwrapped;
}

/** For tests: force the in-process path (false) or the jail (true), or forget the answer (undefined). */
export function setBwrapForTests(value) {
  bwrapped = value;
}

/** The userspace root of `user` under the service-plane home, which must be a plain directory. */
export function userspaceRoot(home, user) {
  const root = resolve(home, "userspaces", user);
  const st = lstatSync(root);
  assert(!st.isSymbolicLink() && st.isDirectory(), `the userspace of ${user} is not a plain directory`, "unauthorized");
  return root;
}

function jailArgs(root) {
  const args = ["--unshare-all", "--die-with-parent", "--new-session", "--cap-drop", "ALL", "--proc", "/proc", "--dev", "/dev"];
  for (const dir of OS_DIRS) {
    if (!existsSync(dir)) continue;
    const st = lstatSync(dir);
    args.push(...(st.isSymbolicLink() ? ["--symlink", readlinkSync(dir), dir] : ["--ro-bind", dir, dir]));
  }
  const prefix = dirname(dirname(process.execPath));
  if (!OS_DIRS.some((d) => prefix === d || prefix.startsWith(d + "/"))) args.push("--ro-bind", prefix, prefix);
  args.push("--ro-bind", LIB, LIB, "--bind", root, root, "--chdir", root);
  return [...args, "--", process.execPath, WORKER];
}

/**
 * Runs `ops` against the userspace root `root`, each `{op: "read"|"write"|"append"|"list"|"remove", path,
 * content?}` with `path` relative to it, and answers one result per op: `{ok: true, value?}` or
 * `{ok: false, error, code}`. One process per call, so batch what goes together.
 */
export function jail(root, ops) {
  if (!hasBwrap()) return applyOps(root, ops);
  const run = spawnSync("bwrap", jailArgs(root), { input: JSON.stringify({ root, ops }), maxBuffer: 256 * 1024 * 1024, timeout: 60_000 });
  if (run.status !== 0) fail(`the file jail failed: ${String(run.stderr ?? "").trim().slice(0, 300) || `exit ${run.status ?? run.signal}`}`, "jail");
  return JSON.parse(String(run.stdout));
}

/** One op whose failure is the caller's failure. */
export function jailOne(root, op) {
  const [r] = jail(root, [op]);
  if (!r.ok) fail(r.error, r.code ?? "invalid");
  return r.value;
}
