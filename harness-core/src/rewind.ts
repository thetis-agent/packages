// Editing a sent message: a rewind in place. The gateway checks the edit, writes a request here through
// `rewind-request`, and starts an ordinary turn whose input is the edited message. The `rewind` step, first
// of the history steps, finds the request, checks that it belongs to this turn, and answers with the
// conversation cut back to before the edited message plus the new input: the same conversation, the same id,
// and the reply carries on from there. What it cut is appended to `harness-core/edits/<s>.jsonl` and never
// sent again; `edit-versions` reads it back for the page as "Earlier versions".
//
// The request is a file under the person's home, as compaction's is: the command runs under the gateway's
// environment and the step under this package's, and the home is the one place both read the same path. The
// command env has no unlink, so a cancelled request is an empty file. A request is looked at by one turn
// only: whatever that turn makes of it, it is gone after.
//
// Both sides check the same two hashes, so a page that drew a stale record, or a turn that is not the edit's,
// never cuts anything: `expect` is the hash of the message being replaced, `input` of the text replacing it.
import { createHash } from "node:crypto";
import { appendFile, mkdir, readFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
import type { HarnessState, Message, PackageStepContext, StepResult, UiCommandEnv, UiCommandResult } from "@thetis/runtime/contracts";
import { contentText } from "@thetis/runtime/lib/content";
import { z } from "zod";
import { withoutTurnContext } from "./index.js";

const NAME = "@thetis/harness-core";
const SESSION_ID = /^[a-zA-Z0-9_-]+$/;
const HASH = /^[0-9a-f]{64}$/;

/** How old a request may be and still apply. An older one is consumed with one log line. */
export const REWIND_MAX_AGE_MS = 10 * 60_000;
/** The most text one replaced message carries in `edit-versions`. */
export const VERSION_TEXT_MAX = 20_000;
/** The most text one `edit-versions` answer carries in all, so it stays under the gateway's reply cap. */
const VERSIONS_TEXT_BUDGET = 200_000;
/** The tool whose calls are counted as subagents in an earlier version. */
const SUBAGENT_TOOL = "spawn_subagent";

const checked = (session: string): string => {
  // Session ids are kernel-issued; check at the filesystem boundary as well, since the id becomes a path.
  if (!SESSION_ID.test(session)) throw new Error("invalid session id");
  return session;
};

/** Relative to the home. */
export const rewindRequestPath = (session: string): string => `harness-core/rewind/${checked(session)}.json`;
export const editsPath = (session: string): string => `harness-core/edits/${checked(session)}.jsonl`;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The hash of one message as the gateway sees it in the record. gateway-web keeps a copy of this one-liner. */
export const messageHash = (m: Message): string => sha256(m.role + "\n" + contentText(m.content));
/** The hash of the text an edit sends. gateway-web keeps a copy of this one-liner. */
export const textHash = (text: string): string => sha256(text.trim());

const RequestSchema = z.object({ v: z.literal(1), at: z.number().int().min(0), expect: z.string().regex(HASH), input: z.string().regex(HASH), createdAt: z.string() });
type RewindRequest = z.infer<typeof RequestSchema>;

/** One line of `harness-core/edits/<s>.jsonl`. */
export interface EditRecord {
  v: 1;
  session: string;
  /** The kernel's id of the turn that applied the edit. */
  turn: string;
  /** The index of the edited message in the conversation. */
  at: number;
  editedAt: string;
  /** Every message from `at` on, as it was before the edit: the old message first. */
  replaced: Message[];
}

const sessionOf = (args: Record<string, unknown>, env: UiCommandEnv): string => {
  const session = typeof args.session === "string" && args.session ? args.session : env.session;
  if (!session) throw new Error("no conversation is open");
  return checked(session);
};

/** `rewind-request` `{ session, at, expect, input }`: the edit the next turn of `session` applies. */
export async function uiRewindRequest(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  const { at, expect, input } = args;
  if (typeof at !== "number" || !Number.isInteger(at) || at < 0) throw new Error("at must be a message index");
  if (typeof expect !== "string" || !HASH.test(expect)) throw new Error("expect must be a sha256 in hex");
  if (typeof input !== "string" || !HASH.test(input)) throw new Error("input must be a sha256 in hex");
  const request: RewindRequest = { v: 1, at, expect, input, createdAt: new Date().toISOString() };
  await env.writeFile(rewindRequestPath(session), JSON.stringify(request));
  return { data: { requested: true, session } };
}

/** `rewind-cancel` `{ session }`: the turn the request was for did not start. */
export async function uiRewindCancel(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  await env.writeFile(rewindRequestPath(session), "");
  return { data: { cancelled: true, session } };
}

/** The pending request: undefined when there is none, `null` when there is one this package cannot read. */
async function readRequest(home: string, session: string): Promise<RewindRequest | null | undefined> {
  let raw: string;
  try {
    raw = await readFile(resolve(home, rewindRequestPath(session)), "utf8");
  } catch {
    return undefined;
  }
  if (!raw.trim()) return undefined;
  try {
    return RequestSchema.safeParse(JSON.parse(raw)).data ?? null;
  } catch {
    return null;
  }
}

async function consume(home: string, session: string): Promise<void> {
  try {
    await rm(resolve(home, rewindRequestPath(session)), { force: true });
  } catch (err) {
    console.error(`${NAME}: could not consume the rewind request of ${session}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** The text of an input, as `textHash` hashes it: its text parts, without the turn context line. */
const inputText = (input: Message[]): string => input.map((m) => withoutTurnContext(contentText(m.content))).join("\n");

const ownState = (harness: HarnessState): Record<string, unknown> => {
  const own = harness?.[NAME];
  return own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
};

/**
 * history, first of this package's steps, before `resume`: applies a pending edit of this conversation.
 *
 * On a turn with input, the conversation before the input must hold the edited message's hash at `at`, and
 * the input's text must hash to the request's. On a turn with no input -- the resume of an edit's turn that a
 * crash cut before this step ran -- the last message is the edited one, and it is checked the same way. When
 * both match, the cut part is kept in the edits file first, and the conversation becomes everything before
 * `at` plus the input. `lastCall` is dropped: it priced a conversation that is no longer this one. Anything
 * else consumes the request and changes nothing, so a turn that is not the edit's never cuts.
 */
export async function rewindTurn(ctx: PackageStepContext): Promise<StepResult | void> {
  const session = ctx.session.id;
  if (!SESSION_ID.test(session)) return;
  const home = ctx.env.cwd;
  const request = await readRequest(home, session);
  if (request === undefined) return;
  await consume(home, session);
  if (request === null) return console.warn(`${NAME}: an unreadable rewind request of ${session} was dropped`);
  const age = Date.now() - Date.parse(request.createdAt);
  if (!(age > -60_000 && age <= REWIND_MAX_AGE_MS)) return console.warn(`${NAME}: a rewind request of ${session} older than ${REWIND_MAX_AGE_MS / 60_000} minutes was dropped`);

  const conversation = ctx.conversation;
  let input = ctx.turn.input;
  if (!input.length) {
    const last = conversation.at(-1);
    if (last?.role !== "user") return;
    input = [last];
  }
  if (input.length > conversation.length) return;
  const old = conversation.slice(0, conversation.length - input.length);
  const at = request.at;
  if (at >= old.length || messageHash(old[at]) !== request.expect) return;
  if (textHash(inputText(input)) !== request.input) return;

  const editedAt = new Date().toISOString();
  const record: EditRecord = { v: 1, session, turn: ctx.turn.id, at, editedAt, replaced: old.slice(at) };
  try {
    await mkdir(resolve(home, "harness-core/edits"), { recursive: true });
    await appendFile(resolve(home, editsPath(session)), JSON.stringify(record) + "\n");
  } catch (err) {
    // Nothing said is lost to an edit: when the old part cannot be kept, it is not cut either.
    console.error(`${NAME}: the edit of ${session} was not applied, because what it replaces could not be kept: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  ctx.emit({ type: "extension", name: NAME, data: { phase: "rewound", at, replaced: record.replaced.length } });
  const { lastCall: _lastCall, ...own } = ownState(ctx.harness);
  return {
    conversation: [...old.slice(0, at), ...input],
    harness: { ...ctx.harness, [NAME]: { ...own, rewound: { turn: ctx.turn.id, at } } },
  };
}

/** One replaced message as the page draws it in an earlier version. */
export interface VersionMessage {
  role: Message["role"];
  text: string;
  /** Tool calls the message made, subagents not counted. */
  tools: number;
  /** Subagents it spawned. */
  agents: number;
}

export interface EditVersion {
  at: number;
  editedAt: string;
  turn: string;
  messages: VersionMessage[];
}

/**
 * The edits of a conversation that are still on its current branch, oldest first. An edit at `at` stops
 * being one once a later edit cut further back, at an index before it: the message it was about is gone.
 */
export function liveEdits(records: EditRecord[]): EditRecord[] {
  const live: EditRecord[] = [];
  for (const r of records) {
    for (let i = live.length - 1; i >= 0; i--) if (live[i].at > r.at) live.splice(i, 1);
    live.push(r);
  }
  return live;
}

async function readEdits(env: Pick<UiCommandEnv, "readFile">, session: string): Promise<EditRecord[]> {
  let text: string;
  try {
    text = await env.readFile(editsPath(session));
  } catch {
    return [];
  }
  const out: EditRecord[] = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as EditRecord;
      if (r && typeof r.at === "number" && Array.isArray(r.replaced)) out.push(r);
    } catch {
      // A torn last line from a crash mid-append: the rest still reads.
    }
  }
  return out;
}

/**
 * `edit-versions` `{ session, at? }`: the earlier versions of the conversation's edited messages, newest
 * first, each as the old message and the replies it had, with tool work counted rather than shown. Tool
 * results are left out; the calls are counted on the assistant message that made them.
 */
export async function uiEditVersions(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = sessionOf(args, env);
  const at = args.at;
  if (at !== undefined && (typeof at !== "number" || !Number.isInteger(at) || at < 0)) throw new Error("at must be a message index");
  const edits = liveEdits(await readEdits(env, session)).filter((r) => at === undefined || r.at === at);
  let budget = VERSIONS_TEXT_BUDGET;
  const versions: EditVersion[] = edits.reverse().map((r) => ({
    at: r.at,
    editedAt: r.editedAt,
    turn: r.turn,
    messages: r.replaced
      .filter((m) => m?.role === "user" || m?.role === "assistant")
      .map((m) => {
        const calls = m.toolCalls ?? [];
        const full = m.role === "user" ? withoutTurnContext(contentText(m.content)) : contentText(m.content);
        const text = full.slice(0, Math.max(0, Math.min(VERSION_TEXT_MAX, budget)));
        budget -= text.length;
        const agents = calls.filter((c) => c.name === SUBAGENT_TOOL).length;
        return { role: m.role, text, tools: calls.length - agents, agents };
      }),
  }));
  return { data: { versions } };
}
