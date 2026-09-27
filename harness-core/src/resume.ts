// Resuming a turn that stopped part-way. A resume is a turn with no input (`sessions.send(id, [])`): the
// pipeline runs over the saved conversation and appends nothing, so the person's message is never sent
// twice. Two things a stopped turn can leave behind would make that conversation wrong to send, and both are
// marked by `callModel` when it stops, under this package's key in `message.extensions`:
//
// - `partial`: the text of a reply that was cut. Sent as the last message it would be a prefill, which some
//   models refuse and the rest continue mid-sentence. The `resume` step drops it; the new reply replaces it.
// - `notRun`: the result `callModel` wrote for a tool call it never got to run. The resume runs that tool
//   now, before the first model call, since it never ran at all.
//
// A result the kernel wrote for a step that died ("error: the turn was interrupted: ...") carries no mark and
// is left alone: that tool may have run halfway, and the model decides what to do about it.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { Message, PackageStepContext, StepResult } from "@thetis/runtime/contracts";
import { z } from "zod";

const NAME = "@thetis/harness-core";

/** The marks this package puts on a message. */
export interface Marks {
  partial?: true;
  notRun?: true;
}

const MarksSchema = z.looseObject({ partial: z.boolean().optional(), notRun: z.boolean().optional() });

/** This package's marks on one message, or none. */
export function marksOf(message: Message): Marks {
  const own = MarksSchema.safeParse(message.extensions?.[NAME]).data;
  return { ...(own?.partial === true ? { partial: true } : {}), ...(own?.notRun === true ? { notRun: true } : {}) };
}

/** The message with one mark added beside whatever other packages keep in `extensions`. */
export function mark(message: Message, marks: Marks): Message {
  const had = message.extensions ?? {};
  const own = had[NAME] && typeof had[NAME] === "object" && !Array.isArray(had[NAME]) ? (had[NAME] as Record<string, unknown>) : {};
  return { ...message, extensions: { ...had, [NAME]: { ...own, ...marks } } };
}

const LedgerSchema = z.looseObject({ usage: z.array(z.looseObject({ status: z.string() })) });

/**
 * How the previous turn of this session ended, from this package's own usage ledger (see `context.ts`):
 * `complete`, `failed`, `cancelled`, `yielded`, or `running` for a turn the process died under. Undefined
 * when there is no ledger. Read only for records written before the marks existed.
 */
async function previousStatus(ctx: PackageStepContext): Promise<string | undefined> {
  if (!/^[a-zA-Z0-9_-]+$/.test(ctx.session.id)) return undefined;
  try {
    const raw = await readFile(resolve(ctx.env.cwd, "harness-core/context", `${ctx.session.id}.json`), "utf8");
    return LedgerSchema.safeParse(JSON.parse(raw)).data?.usage.at(-1)?.status;
  } catch {
    return undefined;
  }
}

/**
 * history, first of this package's steps: on a turn with no input, drop a trailing assistant message that was
 * cut. Marked messages are dropped always. An unmarked one -- a record written before the marks -- is dropped
 * only when it has no tool calls and the previous turn did not complete, because a finished reply is not
 * something to resume. It runs before `turn-context` and before any `call` step, so compaction's projection,
 * the prompt cache and everything else see the conversation the next request will carry.
 */
export async function resumeTurn(ctx: PackageStepContext): Promise<StepResult | void> {
  if (ctx.turn.input.length !== 0) return;
  const last = ctx.conversation.at(-1);
  if (last?.role !== "assistant") return;
  if (!marksOf(last).partial) {
    if (last.toolCalls?.length) return;
    const previous = await previousStatus(ctx);
    if (previous === undefined || previous === "complete") return;
  }
  return { conversation: ctx.conversation.slice(0, -1) };
}

/**
 * The tool calls of the last assistant message whose results are marked `notRun`, and the messages without
 * those results. `messages` is a conversation or a call's messages: the tail after the last assistant message
 * is the same in both, since a projection keeps the recent tail verbatim.
 */
export function unrun(messages: Message[]): { calls: NonNullable<Message["toolCalls"]>; rest: Message[] } {
  let at = messages.length - 1;
  while (at >= 0 && messages[at].role !== "assistant") at--;
  const calls = at >= 0 ? messages[at].toolCalls ?? [] : [];
  if (!calls.length) return { calls: [], rest: messages };
  const ids = new Set(messages.slice(at + 1).filter((m) => m.role === "tool" && marksOf(m).notRun).map((m) => m.toolCallId));
  if (!ids.size) return { calls: [], rest: messages };
  return {
    calls: calls.filter((tc) => ids.has(tc.id)),
    rest: [...messages.slice(0, at + 1), ...messages.slice(at + 1).filter((m) => !(m.role === "tool" && ids.has(m.toolCallId) && marksOf(m).notRun))],
  };
}
