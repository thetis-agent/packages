/** Preserve text order while projecting whole token batches into the lifted gateway wire; ADR 0019, KS-020. */
import type { Batch } from '../../lib/session/types.ts';
import { isObject } from '../../lib/schema/index.ts';

export function render(batch: Batch): Record<string, unknown>[] {
  const frames: Record<string, unknown>[] = []; let text = '';
  const flush = () => { if (text) { frames.push({ type: 'event', session: batch.conversation, kind: 'delta', text }); text = ''; } };
  for (const event of batch.events) {
    const payload = event.payload; if (!isObject(payload)) throw new Error('A validated stream event lost its payload.');
    if (event.type === 'token' && typeof payload['text'] === 'string') text += payload['text'];
    else {
      flush();
      if (event.type === 'output' && isObject(payload['message'])) {
        const content = payload['message']['content'];
        const text = Array.isArray(content) ? content.filter(isObject).map(part => typeof part['text'] === 'string' ? part['text'] : '').join('') : '';
        frames.push({ type: 'event', session: batch.conversation, kind: 'assistant', text, usage: payload['usage'] });
      }
      if (event.type === 'end') frames.push({ type: 'event', session: batch.conversation, kind: 'turn-finished', stopped_by: payload['reason'], iterations: payload['iterations'], compactions: payload['compactions'], ...(payload['code'] === undefined ? {} : { code: payload['code'] }) });
    }
  }
  flush(); return frames;
}
