/** Script the complete provider wire without a model or a key; PR-014. */
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { RequestEvent, ResponseEvent, ModelCap } from '../../contracts/provider/types.ts';
import type { Authority, Provider, Description } from '../../lib/provider/index.ts';
import type { Budgets } from '../../lib/provider/index.ts';
import { ProviderEngine } from '../../lib/provider/engine.ts';
import type { Contract as Configuration } from './types.ts';
import type { Vendor } from '../../lib/provider/engine.ts';

export const stages = {};
export const spawn = [{ id: 'provider', cmd: 'node', args: [fileURLToPath(new URL('./service.ts', import.meta.url))], env: {}, health: { rpc: 'health.probe' }, restart: 'on-failure', scope: 'deployment', network: 'none' }];
export const settings = { modelId: 'scripted', requestBytes: 4 * 1024 * 1024, cacheEntries: 256, scriptEvents: 4096, scriptBytes: 4194304, captureBytes: 1048576, maximumCost: 0.01, scripts: [] };
export const model: ModelCap = {
  id: 'scripted', contextWindow: 200000, maxOutput: 4096, tools: true,
  images: true, seed: true, reasoning: true, cache: 'explicit'
};
type Script = readonly ResponseEvent[];
type Begin = Extract<RequestEvent, { type: 'begin' }>;
type Counters = Extract<ResponseEvent, { type: 'usage' }>['counters'];

class ScriptedVendor implements Vendor {
  readonly #cache = new Map<string, number>();
  readonly #scripts: readonly Script[];
  readonly #settings: Configuration;
  #capturedBytes = 0;
  calls = 0;
  readonly capturedPrefixes: string[] = [];

  constructor(scripts: readonly Script[], configuration: Configuration) {
    this.#settings = structuredClone(configuration);
    if (scripts.length > configuration.scriptEvents || scripts.reduce((count, script) => count + script.length, 0) > configuration.scriptEvents || Buffer.byteLength(JSON.stringify(scripts)) > configuration.scriptBytes) throw new Error('Mock scripts exceed their event limit.');
    this.#scripts = structuredClone(scripts);
  }

  describe(): Promise<Description> { return Promise.resolve({ ok: true, value: { models: [{ ...structuredClone(model), id: this.#settings.modelId }] } }); }

  estimate(request: readonly RequestEvent[]): number {
    const begin = request[0]; if (begin?.type === 'begin' && begin.model !== this.#settings.modelId) return 0;
    return Math.max(this.#settings.maximumCost, ...Array.from(this.#scripts[this.calls] ?? [], event => event.type === 'usage' ? event.counters.cost : 0));
  }

  async *exchange(request: readonly RequestEvent[], signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const begin = request[0];
    if (begin?.type !== 'begin') throw new Error('The normalized request lost begin.');
    if (begin.model !== this.#settings.modelId) { yield { type: 'error', code: 'provider', message: 'The requested model is not registered.' }; return; }
    yield* this.#response(begin, this.#usage(begin, request), signal);
  }

  #usage(begin: Begin, frames: readonly RequestEvent[]): Counters {
    const messages = frames.filter(frame => frame.type === 'message');
    const prefix = JSON.stringify([
      ...messages.slice(0, (begin.cache?.prefixThrough ?? -1) + 1),
      ...frames.filter(frame => frame.type === 'tool')
    ]);
    const key = createHash('sha256').update(begin.model).update(prefix).digest('hex');
    const prefixTokens = Math.ceil(Buffer.byteLength(prefix) / 4);
    const cached = this.#cache.get(key) ?? 0;
    if (this.#cache.size >= this.#settings.cacheEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    this.#cache.set(key, prefixTokens);
    while (this.capturedPrefixes.length && (this.capturedPrefixes.length >= this.#settings.cacheEntries || this.#capturedBytes + Buffer.byteLength(prefix) > this.#settings.captureBytes)) {
      const removed = this.capturedPrefixes.shift(); if (removed !== undefined) this.#capturedBytes -= Buffer.byteLength(removed);
    }
    if (Buffer.byteLength(prefix) <= this.#settings.captureBytes) { this.capturedPrefixes.push(prefix); this.#capturedBytes += Buffer.byteLength(prefix); }
    const input = Math.max(prefixTokens, Math.ceil(Buffer.byteLength(JSON.stringify(frames)) / 4));
    return { cost: 0.001, in: input, out: 1, cached, cached_write: cached ? 0 : prefixTokens };
  }

  async *#response(begin: Begin, counters: Counters, signal: AbortSignal): AsyncGenerator<ResponseEvent> {
    const script = this.#scripts[this.calls++] ?? [{ type: 'delta.text', text: 'Hello.' }];
    yield { type: 'start', id: begin.id, model: begin.model };
    let reason: 'end' | 'tool_calls' | 'length' | 'cancel' = 'end';
    let usage = counters;
    for (const event of script) {
      await Promise.resolve();
      if (signal.aborted) { reason = 'cancel'; break; }
      if (event.type === 'stop') { reason = event.reason; break; }
      if (event.type === 'usage') { usage = event.counters; yield structuredClone(event); continue; }
      yield structuredClone(event);
      if (event.type === 'error') return;
    }
    if (signal.aborted) reason = 'cancel';
    yield { type: 'usage', counters: usage };
    yield { type: 'stop', reason };
  }
}

/** Keep the mock on the same authentication and budget path as every adapter; PR-014. */
export class MockProvider implements Provider {
  readonly #vendor: ScriptedVendor;
  readonly #engine: ProviderEngine;
  constructor(scripts: readonly Script[], authority: Authority, budgets: Budgets, configuration: Configuration = settings, scope: 'person' | 'deployment' = 'deployment') {
    this.#vendor = new ScriptedVendor(scripts, configuration);
    this.#engine = new ProviderEngine(this.#vendor, authority, budgets, scope, { requestBytes: configuration.requestBytes, requestFrames: 8192, responseEvents: 65536 });
  }
  get capturedPrefixes(): readonly string[] { return [...this.#vendor.capturedPrefixes]; }
  get vendorCalls(): number { return this.#vendor.calls; }
  describe(): Promise<Description> { return this.#engine.describe(); }
  run(request: AsyncIterable<RequestEvent>, token: string, signal: AbortSignal): AsyncIterable<ResponseEvent> {
    return this.#engine.run(request, token, signal);
  }
}
