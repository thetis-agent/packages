// Sizing and choosing: how big a run of messages is, where a cut may fall, and which cut keeps the tail.
// The estimate here is a ranking device -- ceil(chars / 4) over every string a message carries -- and is
// never the sole trigger when a provider count exists (see measure.ts). It is deterministic and cheap,
// which is what a decision made on every round needs.
import type { Message } from "@thetis/runtime/contracts";
import type { CompactionState } from "./schemas.js";
import { note } from "./project.js";

/** The characters of one message: content parts, tool call names and arguments, and the tool name. */
function charsOf(message: Message): number {
  let chars = 0;
  for (const part of message.content ?? []) {
    if (part.type === "text") chars += String((part.data as { text?: unknown })?.text ?? "").length;
    else chars += JSON.stringify(part.data ?? null).length;
  }
  for (const call of message.toolCalls ?? []) chars += call.name.length + JSON.stringify(call.args ?? {}).length;
  if (message.name) chars += message.name.length;
  return chars;
}

/** Estimated tokens of a run of messages, or of one string. */
export function estimate(input: Message[] | Message | string): number {
  if (typeof input === "string") return Math.ceil(input.length / 4);
  const messages = Array.isArray(input) ? input : [input];
  let chars = 0;
  for (const message of messages) chars += charsOf(message);
  return Math.ceil(chars / 4);
}

/**
 * Every index a cut may fall on: a tool message always belongs to the assistant message before it, so a
 * round may start anywhere else. Index 0 is never a boundary: a cut there summarizes nothing.
 */
export function boundaries(conversation: Message[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < conversation.length; i++) if (conversation[i].role !== "tool") out.push(i);
  return out;
}

/**
 * The largest boundary after `oldCut` that still leaves at least `keepTokens` (estimated) after it, so the
 * most recent part of the conversation is always sent verbatim. Undefined when nothing older than the kept
 * tail lies past the old cut. Suffix sizes are accumulated from the end so this is one pass.
 */
export function chooseCut(conversation: Message[], oldCut: number, keepTokens: number): number | undefined {
  const candidates = new Set(boundaries(conversation));
  let tailChars = 0;
  for (let i = conversation.length - 1; i > oldCut; i--) {
    tailChars += charsOf(conversation[i]);
    if (candidates.has(i) && Math.ceil(tailChars / 4) >= keepTokens) return i;
  }
  return undefined;
}

/** What a compaction to `newCut` takes out of the projection: the messages it covers, plus the old note it rewrites. */
export function shed(conversation: Message[], state: CompactionState, newCut: number): number {
  return estimate(conversation.slice(state.cut, newCut)) + (state.summary ? estimate([note(state)]) : 0);
}

/**
 * True when the last assistant message asked for tools that have no result yet. A summary request built
 * on such a prefix would be refused by the provider; only possible mid-loop, so this is a defensive check.
 */
export function dangling(conversation: Message[]): boolean {
  let at = conversation.length - 1;
  while (at >= 0 && conversation[at].role === "tool") at--;
  if (at < 0 || conversation[at].role !== "assistant") return false;
  const answered = new Set(conversation.slice(at + 1).map((m) => m.toolCallId));
  return (conversation[at].toolCalls ?? []).some((call) => !answered.has(call.id));
}
