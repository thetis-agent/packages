/** A surface package that contributes an inspector and answers the one thing that inspector may ask.
 *
 * Most of this package is still its `surface` block and the assets under `surface/`, which
 * gateway-web/panels.ts discovers by manifest (contract/surface, ADR 0038 §1). What it now also has
 * is a declared command, and the hook that answers it.
 *
 * The panel's own comments name its honest limit: an offer says what *could* be called, and nothing
 * on that wire says what actually was. A stage sees the whole of this person's environment, so the
 * tally below is information the panel could not reach by reading frames — which is the test of
 * whether a command is worth declaring at all. ADR 0051 is the record of why a panel may ask for it.
 *
 * `usage` is answered by the `call` hook and is not offered by an `offer` hook, so the model is never
 * told it exists and could not call it if it tried: `Dispatcher.call` refuses a name that was not
 * offered. The only route to it is a person clicking in the panel this package contributed.
 */
import type { Envelope, CallRequest, CallAnswer } from '@/contracts/turn-events/types.ts';
import { isObject } from '@/lib/schema/index.ts';

/** Distinct tool names remembered at once; the same cap the panel's own fold uses for one offer. A
 *  tally that grew without bound would be a memory leak keyed by whatever a package chose to name. */
export const limits = { tools: 256 };

const calls = new Map<string, number>();

export const stages = {
  /** Counts finished calls, not attempted ones: a `call` envelope carries its answer beside its
   *  request (packages/core/index.ts), and "how often has this been used" is a question about work
   *  that happened. Returns undefined, as every observer must. */
  observe(event: Envelope): void {
    if (event.type !== 'call') return;
    const request = event.payload['request'];
    if (!isObject(request) || typeof request['name'] !== 'string') return;
    const name = request['name'];
    if (!calls.has(name) && calls.size >= limits.tools) return;
    calls.set(name, (calls.get(name) ?? 0) + 1);
  },
  /** Answers the one verb this package declared, and refuses every other name by the same code a
   *  tool call would be refused by, so a request that should never have arrived reads the same
   *  whether it was the gateway or the loop that let it through. */
  call(request: CallRequest): CallAnswer {
    if (request.name !== 'usage') return { id: request.id, ok: false, error: { code: 'not-offered', message: 'That panel is not allowed to do this.' } };
    return { id: request.id, ok: true, data: Object.fromEntries(calls) };
  }
};
