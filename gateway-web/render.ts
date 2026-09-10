/** Preserve text order while projecting turn-event envelopes into the lifted gateway wire; ADR 0019, KS-020.
 * `token` batches into `delta` exactly as before (KS-020); `model.event` reasoning deltas batch the same way
 * into `reasoning`, each flushed only when the other kind (or a non-batched frame) is about to be emitted, so
 * interleaved streams keep their arrival order. `input`, `call` (request and answer) and `notice` are new,
 * forward-looking mappings: nothing in the running kernel emits them onto this wire yet (`lib/session/schema.json`
 * still narrows `session.events` to token/output/end), so these branches are exercised only by render.test.ts
 * until that schema is widened. */
import { isObject } from '@/lib/schema/index.ts';
import type { Batch } from '@/lib/session/types.ts';

/** `events` accepts the real generated `Batch['events']` member for the kinds `lib/session/schema.json`
 *  already names (`token`/`output`/`end`, each carrying the full envelope now that the generator
 *  parenthesizes `allOf: [envelope, oneOf(...)]` before intersecting it), plus a generic `type`/`payload`
 *  fallback for `input`, `call` (request and answer), `model.event` and `notice`: forward-looking kinds
 *  nothing running emits onto this wire yet, so no schema types their shape, and only `render.test.ts`
 *  exercises them until `lib/session/schema.json` is widened to name them. */
export type EventBatch = { conversation: string; events: readonly (Batch['events'][number] | { type?: string; payload?: unknown })[] };

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

/** A `call` envelope carries either the request or its answer; the answer is the only shape with `ok`. */
function callAnswerFrame(conversation: string, payload: Record<string, unknown>): Record<string, unknown> {
  const ok = payload['ok'] === true;
  const summary = ok ? textOf(payload['content']) : errorMessage(payload['error']);
  return { type: 'event', session: conversation, kind: 'tool-result', id: payload['id'], ok, summary: cap(summary) };
}

function callRequestFrame(conversation: string, payload: Record<string, unknown>): Record<string, unknown> | undefined {
  if (typeof payload['id'] !== 'string' || typeof payload['name'] !== 'string') return undefined;
  return { type: 'event', session: conversation, kind: 'tool-call', id: payload['id'], name: payload['name'], args: payload['args'] };
}

export function render(batch: EventBatch): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []; let text = ''; let reasoning = '';
  const flushDelta = () => { if (text) { frames.push({ type: 'event', session: batch.conversation, kind: 'delta', text }); text = ''; } };
  const flushReasoning = () => { if (reasoning) { frames.push({ type: 'event', session: batch.conversation, kind: 'reasoning', text: reasoning }); reasoning = ''; } };
  const flush = () => { flushDelta(); flushReasoning(); };

  for (const event of batch.events) {
    const payload = event.payload; if (!isObject(payload)) throw new Error('A validated stream event lost its payload.');

    if (event.type === 'token' && typeof payload['text'] === 'string') { flushReasoning(); text += payload['text']; continue; }

    if (event.type === 'model.event' && isObject(payload['event']) && payload['event']['type'] === 'delta.reasoning' && typeof payload['event']['text'] === 'string') {
      flushDelta(); reasoning += payload['event']['text']; continue;
    }

    flush();
    if (event.type === 'input' && typeof payload['text'] === 'string') frames.push({ type: 'event', session: batch.conversation, kind: 'user', text: payload['text'] });
    if (event.type === 'call') { const frame = payload['ok'] === undefined ? callRequestFrame(batch.conversation, payload) : callAnswerFrame(batch.conversation, payload); if (frame) frames.push(frame); }
    if (event.type === 'notice') frames.push({ type: 'event', session: batch.conversation, kind: 'note', text: textOf(payload['content']) });
    // The whole retrieve answer, as the retriever reported it: a panel reads `score` and `how` when a
    // retriever chose to report them and says nothing about ranking when it did not.
    if (event.type === 'retrieve') frames.push({ type: 'event', session: batch.conversation, kind: 'retrieve', entries: payload['entries'], dropped: payload['dropped'] });
    if (event.type === 'output' && isObject(payload['message'])) {
      const content = payload['message']['content'];
      frames.push({ type: 'event', session: batch.conversation, kind: 'assistant', text: textOf(content), usage: payload['usage'] });
    }
    if (event.type === 'end') frames.push({ type: 'event', session: batch.conversation, kind: 'turn-finished', stopped_by: payload['reason'], iterations: payload['iterations'], compactions: payload['compactions'], ...(payload['code'] === undefined ? {} : { code: payload['code'] }) });
  }
  flush(); return frames;
}
