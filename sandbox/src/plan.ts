// What a fence mounts, as data rather than as a sequence of calls.
//
// Bubblewrap applies its mount options in the order they are given, and a mount at a path lands on top of
// whatever was mounted beneath it. Building that list by pushing flags in the right order works until the
// paths move, and then it fails silently: the flag is still there, still accepted, and simply has no
// effect. That is not a hypothetical. `fence.hidden` masks `$THETIS_HOME` with an empty tmpfs, and the
// mask was pushed before the read-only binds of the operating system; when the data directory moved under
// `/opt` on 2026-09-18 the later `--ro-bind /opt /opt` landed on top of it and the mask stopped existing.
// Every fence could then read the service plane -- the journal, the password file, every other userspace --
// and connect to the control socket. Nothing failed, no test broke, and the flag was still in the command
// line. The cgroup destination and `--unshare-cgroup` came apart the same way twice before that.
//
// So the plan is built declaratively, ordered by one rule, and rendered last. The rule is that a shallower
// target is mounted before a deeper one, which is the only order in which every intent survives: a later
// mount can then only ever be *inside* an earlier one, never on top of it. A mask under a bound parent
// still applies, and a bind under a mask still shows through -- both verified against a real bubblewrap in
// `test/plan.test.ts`. Getting the order right is no longer something a reader has to hold in their head.
import { posix } from "node:path";

/** What one entry of the plan does. The names are the fence's vocabulary, not bubblewrap's spelling. */
export type IntentKind = "dev" | "proc" | "tmpfs" | "ro" | "rw" | "symlink";

export interface MountIntent {
  kind: IntentKind;
  /** Where it appears inside the fence. */
  target: string;
  /** The host path for `ro` and `rw`, or the link target for `symlink`. Not used by the others. */
  source?: string;
  /** Bubblewrap's `-try`: a source that is not there is skipped instead of failing the fence. */
  optional?: boolean;
  /** One phrase naming who asked for this, so a conflict report can say what collided with what. */
  why: string;
}

export interface PlanConflict {
  target: string;
  message: string;
}

/** How deep a path is, so the plan can be ordered parents-first. `/` is 0, `/opt` is 1. */
function depth(path: string): number {
  return posix.normalize(path).split("/").filter(Boolean).length;
}

/**
 * The plan in the order bubblewrap has to receive it: shallower targets first, and entries of equal depth
 * in the order they were declared. Ordering by depth is what makes every intent survive, because a mount
 * can then only land inside an earlier one and never over it. Two cases the fence depends on, and which
 * the previous hand-ordered list got wrong in one direction or the other:
 *
 * - `/opt` read-only, then a tmpfs over `$THETIS_HOME` beneath it: the mask applies, and the service plane
 *   is hidden even though its parent was bound first.
 * - that tmpfs, then a read-only bind of the promoted packages inside it: the packages show through the
 *   mask, because the bind is deeper and therefore later.
 *
 * Declaration order still decides between entries at the same depth, which is how a person's `rw` mount
 * beats a read-only bind of the same path: mounts are declared last.
 */
export function orderIntents(intents: MountIntent[]): MountIntent[] {
  return intents.map((intent, at) => ({ intent, at })).sort((a, b) => depth(a.intent.target) - depth(b.intent.target) || a.at - b.at).map((e) => e.intent);
}

/**
 * What an ordered plan cannot deliver. Shadowing is structurally impossible once the plan is ordered --
 * a later entry is deeper, so it lands inside its predecessor rather than over it -- which leaves two
 * things worth saying out loud: two entries claiming the same path, where only the last one happens, and
 * an entry that names no source when its kind needs one.
 */
export function validateIntents(ordered: MountIntent[]): PlanConflict[] {
  const conflicts: PlanConflict[] = [];
  const seen = new Map<string, MountIntent>();
  for (const intent of ordered) {
    const target = posix.normalize(intent.target);
    const earlier = seen.get(target);
    if (earlier && !(earlier.kind === intent.kind && earlier.source === intent.source)) {
      conflicts.push({ target, message: `${earlier.kind} (${earlier.why}) is replaced by ${intent.kind} (${intent.why}); only the second one happens` });
    }
    if ((intent.kind === "ro" || intent.kind === "rw" || intent.kind === "symlink") && !intent.source) {
      conflicts.push({ target, message: `${intent.kind} (${intent.why}) names no source` });
    }
    seen.set(target, intent);
  }
  return conflicts;
}

/** The bubblewrap options for one ordered plan. Rendering is the last step and makes no decisions. */
export function renderIntents(ordered: MountIntent[]): string[] {
  const args: string[] = [];
  for (const i of ordered) {
    switch (i.kind) {
      case "dev":
        args.push("--dev", i.target);
        break;
      case "proc":
        args.push("--proc", i.target);
        break;
      case "tmpfs":
        args.push("--tmpfs", i.target);
        break;
      case "symlink":
        args.push("--symlink", i.source as string, i.target);
        break;
      case "ro":
        args.push(i.optional ? "--ro-bind-try" : "--ro-bind", i.source as string, i.target);
        break;
      case "rw":
        args.push(i.optional ? "--bind-try" : "--bind", i.source as string, i.target);
        break;
    }
  }
  return args;
}
