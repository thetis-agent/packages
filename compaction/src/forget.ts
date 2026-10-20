// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. Everything else this package knows about a
// conversation (the summary, the ledger, the failure) lives in the session's own harness and goes with
// the session; the one thing outside it is the dock's request file, `compaction/requests/<s>.json`. A
// request the step already consumed is an empty file: it is removed too, but it is not reported, because
// nothing of the conversation was in it.
import { readFile, unlink } from "node:fs/promises";
import { resolve } from "node:path";

/** What the gateway passes: the phase, the conversation forgotten, its whole subtree (root first) and this package's dialog choices. */
export interface ForgetArgs {
  phase: "preview" | "forget";
  session: string;
  sessions: string[];
  options?: Record<string, boolean>;
}

export type ForgetAnswer = { items?: { id: string; label: string; optional?: boolean; default?: boolean }[]; block?: string } | { removed: string[]; kept?: string[] };

const SESSION_ID = /^[a-zA-Z0-9_-]+$/;

/** `thetis.sessions.forget`: nothing to preview; on forget, the request file of every id. Idempotent. */
export async function forgetSession(args: ForgetArgs, env: { cwd: string }): Promise<ForgetAnswer> {
  if (args?.phase !== "forget") return {};
  let pending = 0;
  for (const s of Array.isArray(args.sessions) ? args.sessions : []) {
    if (typeof s !== "string" || !SESSION_ID.test(s)) continue;
    const file = resolve(env.cwd, "compaction/requests", `${s}.json`);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (e) {
      if ((e as { code?: string })?.code === "ENOENT") continue;
      throw e;
    }
    try {
      await unlink(file);
    } catch (e) {
      if ((e as { code?: string })?.code === "ENOENT") continue;
      throw e;
    }
    if (text.trim()) pending++;
  }
  return { removed: pending ? [`${pending} compaction request${pending === 1 ? "" : "s"} not yet carried out.`] : [] };
}
