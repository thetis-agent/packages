/** Preserve text order while projecting turn-event envelopes into the lifted gateway wire; ADR 0019, KS-020.
 * `token` batches into `delta` exactly as before (KS-020); `model.event` reasoning deltas batch the same way
 * into `reasoning`, each flushed only when the other kind (or a non-batched frame) is about to be emitted, so
 * interleaved streams keep their arrival order. `call` draws two rows from one
 * envelope, because the core reports a call only once it has been answered. */
import { isObject } from '@/lib/schema/index.ts';
import type { Batch } from '@/lib/session/types.ts';

/** `events` accepts the real generated `Batch['events']` member, plus a generic `type`/`payload`
 *  fallback: the generated union names the kinds whose payload the contract types, and a batch that
 *  arrives over a socket is validated against the schema before it reaches here either way. */
export type EventBatch = { conversation: string; cursor?: number; events: readonly (Batch['events'][number] | { type?: string; payload?: unknown })[] };

/** Bounds on what a rendered frame carries; named per house rule (AGENTS.md "bound everything"). */
export const limits = { summaryBytes: 4096 };

function textOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  return content.filter(isObject).map(part => typeof part['text'] === 'string' ? part['text'] : '').join('');
}

function errorMessage(error: unknown): string {
  return isObject(error) && typeof error['message'] === 'string' ? error['message'] : '';
}

/** Caps a summary to `limits.summaryBytes`, measured in UTF-8 bytes like every other budget in this codebase. */
function cap(value: string): string {
  const buffer = Buffer.from(value, 'utf8');
  return buffer.byteLength <= limits.summaryBytes ? value : buffer.subarray(0, limits.summaryBytes).toString('utf8');
}

function callAnswerFrame(conversation: string, answer: Record<string, unknown>): Record<string, unknown> {
  const ok = answer['ok'] === true;
  const summary = ok ? textOf(answer['content']) : errorMessage(answer['error']);
  return { type: 'event', session: conversation, kind: 'tool-result', id: answer['id'], ok, summary: cap(summary) };
}

function callRequestFrame(conversation: string, request: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof request['id'] !== 'string' || typeof request['name'] !== 'string') return undefined;
  return { type: 'event', session: conversation, kind: 'tool-call', id: request['id'], name: request['name'], args: request['args'] };
}

/** One `call` envelope is a finished call, so it draws two rows: what was asked and what came back.
 *
 * `packages/core/index.ts` emits `{ request, answer }` together — the request is not observable on its
 * own, because the core only reports a call once the dispatcher has answered it. The surface still wants
 * them as separate rows so a slow call reads the way a person expects, and the pair's shared `id` is what
 * ties the second to the first. A payload missing either half draws nothing rather than half a call. */
function callFrames(conversation: string, payload: Record<string, unknown>): Record<string, unknown>[] {
  const request = payload['request']; const answer = payload['answer'];
  if (!isObject(request) || !isObject(answer)) return [];
  const asked = callRequestFrame(conversation, request);
  return asked ? [asked, callAnswerFrame(conversation, answer)] : [];
}

/* Where one envelope of a batch sits in the conversation, so a subscriber that loses its connection
 * can ask to continue from the last frame it actually drew rather than from wherever the environment
 * happens to have reached. `batch.cursor` counts the last envelope in the batch (lib/session/index.ts
 * increments one per admitted event), so the nth of m is `cursor - (m - 1 - n)`. Undefined when the
 * caller supplied no cursor (render.test.ts's hand-built batches), which leaves the field off the
 * frame and leaves the subscriber's position where it was. */
function positionOf(batch: EventBatch, index: number): number | undefined {
  return batch.cursor === undefined ? undefined : batch.cursor - (batch.events.length - 1 - index);
}

export function render(batch: EventBatch): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []; let text = ''; let reasoning = '';
  /* A batched `delta` or `reasoning` carries the position recorded when its text was appended, not
   * when it is flushed: the flush happens while a later envelope is already being handled, and
   * stamping that later position would quietly skip the events in between on a resume. */
  const push = (at: number | undefined, frame: Record<string, unknown>): void => { frames.push(at === undefined ? frame : { ...frame, cursor: at }); };
  let textAt: number | undefined; let reasoningAt: number | undefined;
  const flushDelta = () => { if (text) { push(textAt, { type: 'event', session: batch.conversation, kind: 'delta', text }); text = ''; } };
  const flushReasoning = () => { if (reasoning) { push(reasoningAt, { type: 'event', session: batch.conversation, kind: 'reasoning', text: reasoning }); reasoning = ''; } };
  const flush = () => { flushDelta(); flushReasoning(); };

  for (const [index, event] of batch.events.entries()) {
    const payload = event.payload; if (!isObject(payload)) throw new Error('A validated stream event lost its payload.');
    const at = positionOf(batch, index);

    if (event.type === 'token' && typeof payload['text'] === 'string') { flushReasoning(); text += payload['text']; textAt = at; continue; }

    if (event.type === 'model.event' && isObject(payload['event']) && payload['event']['type'] === 'delta.reasoning' && typeof payload['event']['text'] === 'string') {
      flushDelta(); reasoning += payload['event']['text']; reasoningAt = at; continue;
    }

    /* A `model.event` that is not a reasoning delta projects to nothing, and must not reach `flush()`.
     * core emits one per provider event (index.ts's `#emit(state, options, 'model.event', ...)`), so a
     * token run interleaved with them flushes after every single token and KS-020's batching is lost
     * entirely — one `delta` frame per token rather than one per batch. Widening lib/session/schema.json
     * to admit `model.event` is what first exposed this; before that these never reached the gateway. */
    if (event.type === 'model.event') continue;

    flush();
    if (event.type === 'input' && typeof payload['text'] === 'string') push(at, { type: 'event', session: batch.conversation, kind: 'user', text: payload['text'] });
    if (event.type === 'call') for (const frame of callFrames(batch.conversation, payload)) push(at, frame);
    if (event.type === 'notice') push(at, { type: 'event', session: batch.conversation, kind: 'note', text: textOf(payload['content']) });
    // The whole retrieve answer, as the retriever reported it: a panel reads `score` and `how` when a
    // retriever chose to report them and says nothing about ranking when it did not.
    if (event.type === 'retrieve') push(at, { type: 'event', session: batch.conversation, kind: 'retrieve', entries: payload['entries'], dropped: payload['dropped'] });
    /* The four kinds the inspectors read. Hyphenated to match the wire's own `turn-finished` and
     * `tool-call` rather than the envelope's dotted type, and flattened like every frame above.
     * Passed through verbatim: `context` is the only source of the section split and the budget, and
     * `model.begin`'s request is the exact body sent to the provider — a summary of either answers a
     * different question than the one the Context inspector exists to answer. Neither is bounded here;
     * lib/session/batch.ts's own eventBytes limit still applies upstream, and if a bound is ever put on
     * these the agreed shape is a `truncated: true` field the inspector already draws. */
    if (event.type === 'context') push(at, { type: 'event', session: batch.conversation, kind: 'context', sections: payload['sections'], budget: payload['budget'] });
    if (event.type === 'offer') push(at, { type: 'event', session: batch.conversation, kind: 'offer', tools: payload['tools'], mode: payload['mode'] });
    if (event.type === 'model.begin') push(at, { type: 'event', session: batch.conversation, kind: 'model-begin', provider: payload['provider'], model: payload['model'], request: payload['request'] });
    if (event.type === 'model.end') push(at, { type: 'event', session: batch.conversation, kind: 'model-end', stop: payload['stop'], usage: payload['usage'] });
    if (event.type === 'output' && isObject(payload['message'])) {
      const content = payload['message']['content'];
      push(at, { type: 'event', session: batch.conversation, kind: 'assistant', text: textOf(content), usage: payload['usage'] });
    }
    if (event.type === 'end') push(at, { type: 'event', session: batch.conversation, kind: 'turn-finished', stopped_by: payload['reason'], iterations: payload['iterations'], compactions: payload['compactions'], ...(payload['code'] === undefined ? {} : { code: payload['code'] }) });
  }
  flush(); return frames;
}
