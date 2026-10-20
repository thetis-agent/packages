// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. This package keeps three things per
// conversation, all under the person's home: the context snapshot and usage ledger the Context dock reads
// (`harness-core/context/<s>.json`), a "retry now" request that was never taken (`harness-core/retry/<s>.json`),
// the effort chosen for it (its key in `effort/sessions.json`), and what each turn ran with (the stamps in
// `harness-core/turns/<s>.jsonl` and the prompt and tool snapshots under `harness-core/snapshots/<s>/`). The
// preview lists the last, which is the one a person would not guess is kept. Nothing here blocks a forget,
// and every part is idempotent: a file already gone is not an error and is not reported as removed.
import { access, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { effortSessionsPath } from "./effort.js";
import { retryRequestPath } from "./retry.js";
import { snapshotsPath, turnsPath } from "./stamp.js";

/** What the gateway passes: the phase, the conversation forgotten, its whole subtree (root first) and this package's dialog choices. */
export interface ForgetArgs {
  phase: "preview" | "forget";
  session: string;
  sessions: string[];
  options?: Record<string, boolean>;
}

export type ForgetAnswer = { items?: { id: string; label: string; optional?: boolean; default?: boolean }[]; block?: string } | { removed: string[]; kept?: string[] };

const SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** Unlinks one file; true when it was there. Any failure but "not there" is the caller's to see. */
async function removeFile(file: string): Promise<boolean> {
  try {
    await unlink(file);
    return true;
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return false;
    throw e;
  }
}

/** Drops the ids' keys from the effort map, rewritten whole and renamed into place. Answers how many went. */
async function dropEfforts(home: string, ids: Set<string>): Promise<number> {
  const file = resolve(home, effortSessionsPath());
  let map: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return 0;
    map = parsed as Record<string, unknown>;
  } catch {
    // Missing or unreadable: there is no choice of these conversations to remove.
    return 0;
  }
  const gone = Object.keys(map).filter((k) => ids.has(k));
  if (!gone.length) return 0;
  for (const k of gone) delete map[k];
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await writeFile(tmp, JSON.stringify(map, null, 2) + "\n");
    await rename(tmp, file);
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {});
    throw e;
  }
  return gone.length;
}

const exists = (path: string): Promise<boolean> => access(path).then(() => true, () => false);

/** Removes one conversation's stamps and snapshots; true when either was there. */
async function removeTurns(home: string, s: string): Promise<boolean> {
  const dir = resolve(home, snapshotsPath(s));
  const had = await exists(dir);
  if (had) await rm(dir, { recursive: true, force: true });
  return (await removeFile(resolve(home, turnsPath(s)))) || had;
}

/** The one preview item: what each turn ran with, never optional. */
export const TURNS_ITEM = { id: "turns", label: "What each turn ran with (versions, prompt and tools)" } as const;

/**
 * `thetis.sessions.forget`: the preview names what each turn ran with when any of the conversations has it;
 * on forget, the snapshot, the retry request, the effort choice and the stamps of every id.
 */
export async function forgetSession(args: ForgetArgs, env: { cwd: string }): Promise<ForgetAnswer> {
  const ids = (Array.isArray(args?.sessions) ? args.sessions : []).filter((s): s is string => typeof s === "string" && SESSION_ID.test(s));
  if (args?.phase === "preview") {
    for (const s of ids) if ((await exists(resolve(env.cwd, turnsPath(s)))) || (await exists(resolve(env.cwd, snapshotsPath(s))))) return { items: [{ ...TURNS_ITEM }] };
    return {};
  }
  if (args?.phase !== "forget") return {};
  let snapshots = 0;
  let retries = 0;
  let turns = 0;
  for (const s of ids) {
    if (await removeFile(resolve(env.cwd, "harness-core/context", `${s}.json`))) snapshots++;
    if (await removeFile(resolve(env.cwd, retryRequestPath(s)))) retries++;
    if (await removeTurns(env.cwd, s)) turns++;
  }
  const efforts = await dropEfforts(env.cwd, new Set(ids));
  const removed: string[] = [];
  if (snapshots) removed.push(`The context snapshot and usage of ${plural(snapshots, "conversation")}.`);
  if (retries) removed.push(`${plural(retries, "retry request")} that had not been taken.`);
  if (efforts) removed.push(`The effort chosen for ${plural(efforts, "conversation")}.`);
  if (turns) removed.push(`What each turn ran with (versions, prompt and tools) in ${plural(turns, "conversation")}.`);
  return { removed };
}
