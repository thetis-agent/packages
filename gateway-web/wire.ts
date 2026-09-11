/** Route authority through inherited control and content through person-scoped subscriptions; KS-004,
 * ADR 0019. The `hello` reply is a `user` frame carrying this connection's signed-in name and role,
 * per ADR 0038 D4/D2 — app.js's `.on("user", ...)` handler is the counterpart. */
import type { Peer } from '@/lib/socket/index.ts';
import type { ConnectKernel } from '@/contracts/kernel-socket/types.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { mounted } from '@/lib/session/mount.ts';
import type { SessionClient } from '@/lib/session/client.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Contract } from './types.ts';
import { render } from './render.ts';
import { settings } from './index.ts';
import type { Contribution } from './panels.ts';
import { Attachments } from './attachments.ts';
import type { Descriptor } from './attachments.ts';
export type Send = (frame: Record<string, unknown>) => Promise<Result<void>>;
/** Where a wire that was handed no store keeps attachments: this process's own working directory, which
 * is `/state` for a spawned gateway (lib/profile/target.ts sets `cwd`). service.ts names that root
 * explicitly and passes the same store the upload route writes through, so the two cannot drift apart;
 * this exists so a caller that never attaches anything — every test of the other commands — needs no
 * store at all. It throws rather than returning a Result because the only way to fail is an allow-list
 * this package writes itself, which is a mistake in the source and not a condition to handle. */
function localStore(): Attachments {
  const store = Attachments.open(process.cwd(), settings);
  if (!store.ok) throw new Error('The gateway attachment limits name a type it cannot store.');
  return store.value;
}
export class Wire {
  readonly #peer: Peer; readonly #schemas: Schemas; readonly #clock: Clock; readonly #identity: ConnectKernel; readonly #role: string; readonly #send: Send;
  readonly #contribution: Contribution;
  readonly #attachments: Attachments;
  readonly #streams = new Map<string, SessionClient>();
  readonly #turns = new Set<string>();
  readonly #opening = new Set<string>();
  #closed = false;
  constructor(peer: Peer, schemas: Schemas, clock: Clock, identity: ConnectKernel, role: string, send: Send, contribution: Contribution = { panels: [], renderers: [] }, attachments: Attachments = localStore()) {
    this.#peer = peer; this.#schemas = schemas; this.#clock = clock; this.#identity = identity; this.#role = role; this.#send = send; this.#contribution = contribution;
    this.#attachments = attachments;
  }
  async command(input: Contract): Promise<Result<void>> {
    if (this.#closed) return failure('switching', 'The gateway connection is closed.');
    if (input.type === 'hello') {
      return this.#send({ type: 'user', user: { name: this.#identity.person, role: this.#role },
        capabilities: ['list', 'new', 'open', 'send', 'turn-cancel', 'cursor-replay', 'env-reset', 'attach'],
        panels: this.#contribution.panels, renderers: this.#contribution.renderers });
    }
    if (input.type === 'list') {
      const result = await this.#peer.call('session.list', {}); return result.ok ? this.#send({ type: 'sessions', sessions: result.value }) : result;
    }
    if (input.type === 'new') {
      const result = await this.#peer.call('session.create', { surface: 'web' }); if (!result.ok) return result;
      if (!isObject(result.value) || typeof result.value['id'] !== 'string') return failure('protocol', 'The environment returned invalid conversation metadata.');
      return this.#open(result.value['id']);
    }
    if (input.type === 'env-reset') return this.#envReset();
    if (!['open', 'send', 'turn-cancel'].includes(input.type)) return failure('unsupported', 'The requested gateway capability is unavailable.');
    if (!input.id) return failure('invalid-args', 'The gateway command requires a conversation id.');
    if (input.type === 'open') return this.#open(input.id, input.from);
    if (input.type === 'turn-cancel') { const result = await this.#peer.call('session.cancel', { conversation: input.id }); return result.ok ? this.#send({ type: 'cancelled', session: input.id, result: result.value }) : result; }
    if (typeof input.text !== 'string') return failure('invalid-args', 'The gateway turn requires text.');
    /* Everything the browser said about an attachment is re-derived from the conversation, the hash and the
     * type before it is believed; see attachments.ts. The refusal messages are the store's own, so what the
     * page shows after an upload and what it shows after a send are the same sentences. */
    const attachments = await this.#attachments.accept(input.id, input.attachments); if (!attachments.ok) return attachments;
    return this.#turn(input.id, input.text, attachments.value);
  }
  async #open(id: string, from?: number): Promise<Result<void>> {
    if (this.#streams.has(id)) {
      if (from !== undefined) return failure('invalid-args', 'An existing subscription cannot change its cursor.');
      const sent = await this.#send({ type: 'opened', session: id }); return sent.ok ? this.#envStatus() : sent;
    }
    if (this.#opening.has(id) || this.#streams.size + this.#opening.size >= settings.streams) return failure('budget', 'The gateway subscription pool is full.');
    this.#opening.add(id);
    try { return await this.#subscribe(id, from); } finally { this.#opening.delete(id); }
  }
  async #subscribe(id: string, from?: number): Promise<Result<void>> {
    let opening = true; let pending: Record<string, unknown>[] = []; let bytes = 0;
    const stream = await mounted(this.#schemas, this.#clock, async batch => {
      const frames = render(batch);
      if (!opening) return this.#frames(frames);
      bytes += Buffer.byteLength(JSON.stringify(frames));
      if (pending.length + frames.length > settings.openingFrames || bytes > settings.messageBytes) return failure('budget', 'The opening conversation exceeds its event buffer.');
      pending.push(...frames); return { ok: true, value: undefined };
    }); if (!stream.ok) return stream;
    if (this.#closed) { stream.value.close(); return failure('switching', 'The gateway connection is closed.'); }
    this.#streams.set(id, stream.value);
    void stream.value.peer.finished().then(() => { if (this.#streams.get(id) === stream.value) this.#streams.delete(id); });
    const subscribed = await stream.value.subscribe(id, from);
    if (!subscribed.ok) { stream.value.close(); this.#streams.delete(id); return subscribed; }
    const sent = await this.#send({ type: 'opened', session: id, cursor: subscribed.value.cursor, oldest: subscribed.value.oldest,
      ...(subscribed.value.history ? { history: subscribed.value.history } : {}) });
    if (!sent.ok) return sent;
    // The UI must install its saved transcript before any live or replayed event.
    while (pending.length) {
      const frames = pending; pending = []; bytes = 0;
      const flushed = await this.#frames(frames); if (!flushed.ok) return flushed;
    }
    opening = false; return this.#envStatus();
  }
  async #frames(frames: readonly Record<string, unknown>[]): Promise<Result<void>> {
    for (const frame of frames) { const sent = await this.#send(frame); if (!sent.ok) return sent; }
    return { ok: true, value: undefined };
  }
  /* `env.status`/`env.reset` are capability-gated (KS-019): `service.ts` does not request them from the kernel
   * today, so `#peer.supports` is false and both no-op, ok, exactly as the plan anticipates for this seam. */
  async #envStatus(): Promise<Result<void>> {
    if (!this.#peer.supports('env.status')) return { ok: true, value: undefined };
    const status = await this.#peer.call('env.status', {}); if (!status.ok) return status;
    if (!isObject(status.value)) return failure('protocol', 'The environment returned an invalid status.');
    return this.#send({ type: 'env-status', ...status.value });
  }
  async #envReset(): Promise<Result<void>> {
    if (!this.#peer.supports('env.reset')) return failure('unsupported', 'The requested gateway capability is unavailable.');
    const reset = await this.#peer.call('env.reset', {}); if (!reset.ok) return reset;
    return this.#envStatus();
  }
  async #turn(id: string, text: string, attachments: readonly Descriptor[]): Promise<Result<void>> {
    if (this.#turns.has(id)) return failure('budget', 'The gateway conversation already has an active turn.');
    this.#turns.add(id);
    try {
      if (!this.#streams.has(id)) { const opened = await this.#open(id); if (!opened.ok) return opened; }
      const sent = await this.#send({ type: 'event', session: id, kind: 'turn-started' }); if (!sent.ok) return sent;
      const result = await this.#peer.call('session.submit', { conversation: id, input: { text, attachments } }, settings.turnMs);
      return result.ok ? await this.#send({ type: 'accepted', session: id }) : result;
    } finally { this.#turns.delete(id); }
  }
  close(): void { this.#closed = true; for (const stream of this.#streams.values()) stream.close(); this.#streams.clear(); }
}
