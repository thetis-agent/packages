/** Bound HTTP bodies and remove authentication material from all returned text; EXA-005, EXA-007. */
import { failure } from '@/lib/schema/index.ts';
import type { Result } from '@/lib/schema/index.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { ApiRequest } from './request.ts';
import type { Settings } from './types.ts';
export type Fetcher = (url: string, options: RequestInit) => Promise<Response>;
type Code = 'invalid-args' | 'budget' | 'deadline' | 'io' | 'tool' | 'not-found';
async function body(response: Response, maximum: number): Promise<Result<unknown, Code>> {
  if (!response.body) return failure('io', 'Exa returned no response body.');
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) return failure('budget', 'The Exa response exceeds its byte limit.');
      chunks.push(chunk.value);
    }
    const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
    return { ok: true, value };
  } catch { return failure('io', 'Exa returned invalid JSON or an incomplete response.'); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
function status(code: number): Result<never, Code> {
  if (code === 401 || code === 403) return failure('tool', 'The Exa secret was rejected.');
  if (code === 402) return failure('budget', 'The Exa account has insufficient credit.');
  if (code === 429) return failure('budget', 'The Exa request limit was reached.');
  if (code === 400 || code === 422) return failure('invalid-args', 'Exa rejected the request arguments.');
  if (code === 404) return failure('not-found', 'The Exa resource was not found.');
  return failure('io', 'The Exa API request failed.');
}
export class Http {
  readonly #key: string; readonly #settings: Settings; readonly #clock: Clock; readonly #fetch: Fetcher;
  #active = 0;
  constructor(key: string, settings: Settings, clock: Clock, fetcher: Fetcher = fetch) { this.#key = key; this.#settings = settings; this.#clock = clock; this.#fetch = fetcher; }
  redact(value: string): string { return value.replaceAll(this.#key, '[redacted]'); }
  async request(request: ApiRequest, deadlineMs: number, signal: AbortSignal): Promise<Result<unknown, Code>> {
    if (this.#active >= this.#settings.concurrency) return failure('budget', 'The Exa connection pool is full.');
    if (signal.aborted) return failure('deadline', 'The Exa request was cancelled.');
    const controller = new AbortController(); const timer = new AbortController(); this.#active++;
    const cancel = (): void => { controller.abort(); }; signal.addEventListener('abort', cancel, { once: true });
    const waiting = this.#clock.wait(Math.min(deadlineMs, this.#settings.deadlineMs), timer.signal).then(() => { if (!timer.signal.aborted) cancel(); });
    try {
      const response = await this.#fetch(`https://api.exa.ai${request.path}`, { method: request.method, redirect: 'error', signal: controller.signal,
        headers: { 'x-api-key': this.#key, 'content-type': 'application/json', accept: 'application/json', ...(request.beta ? { 'Exa-Beta': request.beta } : {}) },
        ...(request.body ? { body: JSON.stringify(request.body) } : {}) });
      if (!response.ok) { await response.body?.cancel(); return status(response.status); }
      const result = await body(response, this.#settings.responseBytes);
      return controller.signal.aborted ? failure('deadline', 'The Exa request exceeded its deadline or was cancelled.') : result;
    } catch { return failure(controller.signal.aborted ? 'deadline' : 'io', controller.signal.aborted ? 'The Exa request exceeded its deadline or was cancelled.' : 'The Exa connection failed.'); }
    finally { timer.abort(); controller.abort(); signal.removeEventListener('abort', cancel); await waiting; this.#active--; }
  }
}
