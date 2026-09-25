// The projection: what the provider is sent instead of the record. The record's `conversation` is never
// edited -- every consumer keys on its indices -- so compaction is a view over it: one note standing for the
// summarized prefix, then the tail exactly as it is.
import type { Message } from "@thetis/runtime/contracts";
import { textContent } from "@thetis/runtime/lib/content";
import type { CompactionState } from "./schemas.js";

/**
 * The note that stands for `conversation[0, cut)`. It has the user role, as in the original design: a later
 * compaction then never treats a summary as summarizable model output, and the tail after it may begin with
 * any role without the provider seeing two assistant turns in a row.
 */
export function note(state: Pick<CompactionState, "cut" | "summary">): Message {
  const text =
    `[Context compacted: the first ${state.cut} messages of this conversation are summarized below. The full ` +
    `record is kept; nothing was deleted, and later messages are sent exactly as they were.]\n\n${state.summary ?? ""}`;
  return { role: "user", content: textContent(text) };
}

/** The messages to send: the note and the tail when there is a summary, else the conversation as it is. */
export function project(conversation: Message[], state: Pick<CompactionState, "cut" | "summary">): Message[] {
  if (state.cut > 0 && state.summary) return [note(state), ...conversation.slice(state.cut)];
  return [...conversation];
}

/**
 * Where conversation index `cut` falls in the projection: `cut` itself when nothing is summarized yet, else
 * one for the note plus the messages between the old cut and this one.
 */
export function projectedIndex(state: Pick<CompactionState, "cut" | "summary">, cut: number): number {
  if (state.cut > 0 && state.summary) return 1 + (cut - state.cut);
  return cut;
}
