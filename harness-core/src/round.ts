// The round hook: what the loop offers another package between two model calls of one turn. A step runs
// before the first request and after the last; a long tool loop can grow the request by hundreds of
// thousands of tokens in between, and a package that manages the conversation's size (compaction) needs
// a say before each of those requests too. The loop reads `call.hints.beforeRound`, a package and an
// export, and invokes it in this fence with the live state. harness-core knows no package by name: the
// hint is set by whichever `call` step wants the seam, and the shapes here are the whole of the contract.
import { z } from "zod";
import { MessageSchema } from "@thetis/runtime/schemas";
import type { HarnessState, Message, ProviderCall, TurnEvent } from "@thetis/runtime/contracts";

/** The hint's value: which export to call. Anything else in the slot is silently no hook. */
export const RoundHookRefSchema = z.object({ package: z.string().min(1), export: z.string().min(1) });
export type RoundHookRef = z.infer<typeof RoundHookRefSchema>;

/**
 * What the hook receives. `conversation` and `call` are the loop's live values, so `call.messages` may
 * already differ from the conversation (a `call` step shaped it, or an earlier round of this hook did).
 * `priced` is `call.messages.length` when the previous request was sent, and `usage` is what the provider
 * reported for it, so a hook can put a provider-counted figure against the messages it covers and estimate
 * only the rest. `emit` is the turn's own emitter: events go to the person's page as the loop's do.
 */
export interface RoundHookArgs {
  conversation: Message[];
  call: ProviderCall;
  harness: HarnessState;
  round: number;
  usage?: Record<string, number>;
  priced: number;
  turn: { id: string };
  emit: (event: TurnEvent) => void;
}

/** What the hook may answer. `call.messages` replaces the loop's messages whole; `harness` replaces the live harness whole. Nothing else is read. */
export interface RoundHookResult {
  call?: { messages: Message[] };
  harness?: HarnessState;
}

/**
 * The answer, read leniently: an object with neither key is a hook that chose to do nothing, and an unknown
 * key is ignored. Messages are checked against the contract's shape because they are sent to the provider
 * as they are; a hook that answers something else has failed, and the loop says so and goes on unchanged.
 */
export const RoundHookResultSchema = z.looseObject({
  call: z.looseObject({ messages: z.array(MessageSchema).optional() }).optional(),
  harness: z.record(z.string(), z.unknown()).optional(),
});
