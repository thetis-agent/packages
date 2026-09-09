/** Route authority through inherited control and content through person-scoped subscriptions; KS-004, ADR 0019. */
import type { Peer } from '../../lib/socket/index.ts';
import type { ConnectKernel } from '../../contracts/kernel-socket/types.ts';
import type { Schemas, Result } from '../../lib/schema/index.ts';
import { failure, isObject } from '../../lib/schema/index.ts';
import { mounted } from '../../lib/session/mount.ts';
import type { SessionClient } from '../../lib/session/client.ts';
import type { Clock } from '../../lib/events/index.ts';
import type { Contract } from './types.ts';
import { render } from './render.ts';
import { settings } from './index.ts';
export type Send = (frame: Record<string, unknown>) => Promise<Result<void>>;
export class Wire {
  readonly #peer: Peer; readonly #schemas: Schemas; readonly #clock: Clock; readonly #identity: ConnectKernel; readonly #send: Send;
  readonly #streams = new Map<string, SessionClient>();
  readonly #turns = new Set<string>();
  readonly #opening = new Set<string>();
  #closed = false;
  constructor(peer: Peer, schemas: Schemas, clock: Clock, identity: ConnectKernel, send: Send) {
    this.#peer = peer; this.#schemas = schemas; this.#clock = clock; this.#identity = identity; this.#send = send;
  }
  async command(input: Contract): Promise<Result<void>> {
    if (this.#closed) return failure('switching', 'The gateway connection is closed.');
    if (input.type === 'hello') return this.#send({ type: 'hello', user: { name: this.#identity.person }, capabilities: ['list', 'new', 'open', 'send', 'turn-cancel', 'cursor-replay'] });
    if (input.type === 'list') {
      const result = await this.#peer.call('session.list', {}); return result.ok ? this.#send({ type: 'sessions', sessions: result.value }) : result;
    }
    if (input.type === 'new') {
      const result = await this.#peer.call('session.create', { surface: 'web' }); if (!result.ok) return result;
      if (!isObject(result.value) || typeof result.value['id'] !== 'string') return failure('protocol', 'The environment returned invalid conversation metadata.');
      return this.#open(result.value['id']);
    }
    if (!['open', 'send', 'turn-cancel'].includes(input.type)) return failure('unsupported', 'The requested gateway capability is unavailable.');
    if (!input.id) return failure('invalid-args', 'The gateway command requires a conversation id.');
    if (input.type === 'open') return this.#open(input.id, input.from);
    if (input.type === 'turn-cancel') { const result = await this.#peer.call('session.cancel', { conversation: input.id }); return result.ok ? this.#send({ type: 'cancelled', session: input.id, result: result.value }) : result; }
    if (typeof input.text !== 'string') return failure('invalid-args', 'The gateway turn requires text.');
    if (input.attachments?.length) return failure('unsupported', 'The gateway attachment capability is unavailable.');
    return this.#turn(input.id, input.text);
  }
  async #open(id: string, from?: number): Promise<Result<void>> {
    if (this.#streams.has(id)) return from === undefined ? this.#send({ type: 'opened', session: id }) : failure('invalid-args', 'An existing subscription cannot change its cursor.');
    if (this.#opening.has(id) || this.#streams.size + this.#opening.size >= settings.streams) return failure('budget', 'The gateway subscription pool is full.');
    this.#opening.add(id);
    try { return await this.#subscribe(id, from); } finally { this.#opening.delete(id); }
  }
  async #subscribe(id: string, from?: number): Promise<Result<void>> {
    const stream = await mounted(this.#schemas, this.#clock, async batch => {
      for (const frame of render(batch)) { const sent = await this.#send(frame); if (!sent.ok) return sent; }
      return { ok: true, value: undefined };
    }); if (!stream.ok) return stream;
    if (this.#closed) { stream.value.close(); return failure('switching', 'The gateway connection is closed.'); }
    this.#streams.set(id, stream.value);
    void stream.value.peer.finished().then(() => { if (this.#streams.get(id) === stream.value) this.#streams.delete(id); });
    const subscribed = await stream.value.subscribe(id, from);
    if (!subscribed.ok) { stream.value.close(); this.#streams.delete(id); return subscribed; }
    return this.#send({ type: 'opened', session: id, cursor: subscribed.value.cursor, oldest: subscribed.value.oldest });
  }
  async #turn(id: string, text: string): Promise<Result<void>> {
    if (this.#turns.has(id)) return failure('budget', 'The gateway conversation already has an active turn.');
    this.#turns.add(id);
    try {
      if (!this.#streams.has(id)) { const opened = await this.#open(id); if (!opened.ok) return opened; }
      const sent = await this.#send({ type: 'event', session: id, kind: 'turn-started' }); if (!sent.ok) return sent;
      const result = await this.#peer.call('session.submit', { conversation: id, input: { text, attachments: [] } }, settings.turnMs);
      return result.ok ? await this.#send({ type: 'accepted', session: id }) : result;
    } finally { this.#turns.delete(id); }
  }
  close(): void { this.#closed = true; for (const stream of this.#streams.values()) stream.close(); this.#streams.clear(); }
}
