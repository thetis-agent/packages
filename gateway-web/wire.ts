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
import { host } from './host.ts';
export type Send = (frame: Record<string, unknown>) => Promise<Result<void>>;
/** What the foot of the page reports about the software it is part of. Either may be empty, and an
 *  empty one leaves its item off the bar rather than drawing a blank: `agent` is this package's own
 *  manifest version, `setup` whatever version the kernel's profile answer carries, which today is
 *  none. See service.ts, which reads both. */
export interface Versions { agent: string; setup: string }
export class Wire {
  readonly #peer: Peer; readonly #schemas: Schemas; readonly #clock: Clock; readonly #identity: ConnectKernel; readonly #role: string; readonly #send: Send;
  readonly #contribution: Contribution; readonly #versions: Versions;
  readonly #streams = new Map<string, SessionClient>();
  readonly #turns = new Set<string>();
  readonly #opening = new Set<string>();
  #closed = false;
  /** When the status bar last cost the kernel an `env.status` call; see `#status`. */
  #asked = Number.NEGATIVE_INFINITY;
  constructor(peer: Peer, schemas: Schemas, clock: Clock, identity: ConnectKernel, role: string, send: Send, contribution: Contribution = { panels: [], renderers: [] }, versions: Versions = { agent: '', setup: '' }) {
    this.#peer = peer; this.#schemas = schemas; this.#clock = clock; this.#identity = identity; this.#role = role; this.#send = send; this.#contribution = contribution; this.#versions = versions;
  }
  async command(input: Contract): Promise<Result<void>> {
    if (this.#closed) return failure('switching', 'The gateway connection is closed.');
    if (input.type === 'hello') {
      return this.#send({ type: 'user', user: { name: this.#identity.person, role: this.#role },
        capabilities: ['list', 'new', 'open', 'send', 'turn-cancel', 'cursor-replay', 'env-reset', 'status', 'env-logs'],
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
    if (input.type === 'status') return this.#status();
    if (input.type === 'env-logs') return this.#envLogs(input.limit);
    if (input.type === 'env-reset') return this.#envReset();
    if (!['open', 'send', 'turn-cancel'].includes(input.type)) return failure('unsupported', 'The requested gateway capability is unavailable.');
    if (!input.id) return failure('invalid-args', 'The gateway command requires a conversation id.');
    if (input.type === 'open') return this.#open(input.id, input.from);
    if (input.type === 'turn-cancel') { const result = await this.#peer.call('session.cancel', { conversation: input.id }); return result.ok ? this.#send({ type: 'cancelled', session: input.id, result: result.value }) : result; }
    if (typeof input.text !== 'string') return failure('invalid-args', 'The gateway turn requires text.');
    if (input.attachments?.length) return failure('unsupported', 'The gateway attachment capability is unavailable.');
    return this.#turn(input.id, input.text);
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
  /* The environment methods are capability-gated (KS-019) and `service.ts` requests all three, but a
   * deployment is free to withhold any of them — so each is guarded rather than assumed, and a
   * withheld one leaves the foot of the page quieter instead of erroring. `logs` rides along on the
   * status because the bar's "recent activity" affordance has no other way to learn whether asking
   * for output would be answered; a bar that offers a button the kernel refuses is worse than one
   * that never offers it. */
  async #envStatus(): Promise<Result<void>> {
    if (!this.#peer.supports('env.status')) return { ok: true, value: undefined };
    const status = await this.#peer.call('env.status', {}); if (!status.ok) return status;
    if (!isObject(status.value)) return failure('protocol', 'The environment returned an invalid status.');
    return this.#send({ type: 'env-status', ...status.value, logs: this.#peer.supports('env.logs') });
  }
  /* The status bar asks; nothing pushes. The two halves of its answer cost very different things:
   * `system-status` is read out of this process and is free, while a fresh `env-status` is a kernel
   * call, so the poll is allowed to refresh the first on every tick and the second only once per
   * `settings.statusMs`. That is what bounds the kernel's share of this feature no matter how many
   * tabs a person opens or how fast a client decides to ask. */
  async #status(): Promise<Result<void>> {
    const sent = await this.#send({ type: 'system-status', ...this.#versions,
      conversations: this.#streams.size, turns: this.#turns.size, host: await host() });
    if (!sent.ok) return sent;
    const now = this.#clock.now();
    if (now - this.#asked < settings.statusMs) return { ok: true, value: undefined };
    this.#asked = now;
    return this.#envStatus();
  }
  /* The kernel already bounds a log reply by rows and by bytes; this bounds the ask as well, so the
   * frame stays a tail rather than a transcript however large the journal has grown and whatever a
   * client puts in `limit`. */
  async #envLogs(limit?: number): Promise<Result<void>> {
    if (!this.#peer.supports('env.logs')) return failure('unsupported', 'The requested gateway capability is unavailable.');
    const rows = Math.min(typeof limit === 'number' && Number.isSafeInteger(limit) && limit > 0 ? limit : settings.logRows, settings.logRows);
    const logs = await this.#peer.call('env.logs', { limit: rows }); if (!logs.ok) return logs;
    if (!isObject(logs.value)) return failure('protocol', 'The environment returned invalid output.');
    return this.#send({ type: 'env-logs', ...logs.value });
  }
  async #envReset(): Promise<Result<void>> {
    if (!this.#peer.supports('env.reset')) return failure('unsupported', 'The requested gateway capability is unavailable.');
    const reset = await this.#peer.call('env.reset', {}); if (!reset.ok) return reset;
    return this.#envStatus();
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
