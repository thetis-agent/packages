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
import { brandDefaults, settings } from './index.ts';
import type { Brand } from './index.ts';
import type { Contribution } from './panels.ts';
import { Attachments } from './attachments.ts';
import type { Descriptor } from './attachments.ts';
import { SurfaceRequests } from './surface-request.ts';
import { Admin } from './admin.ts';
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
/** The signed-in roles whose sidebar may ask for everyone's conversations, mirroring `observeOthers`
 * on the configured principal (lib/deployment). The kernel is what actually refuses; checking here
 * first turns a routing refusal into a sentence, and keeps `person: '*'` out of a user's reach. */
const observers = ['admin', 'reviewer'];
export class Wire {
  readonly #peer: Peer; readonly #schemas: Schemas; readonly #clock: Clock; readonly #identity: ConnectKernel; readonly #role: string; readonly #send: Send;
  readonly #contribution: Contribution; readonly #brand: Brand;
  readonly #attachments: Attachments;
  readonly #requests: SurfaceRequests;
  readonly #admin: Admin;
  readonly #streams = new Map<string, SessionClient>();
  readonly #turns = new Set<string>();
  readonly #opening = new Set<string>();
  #closed = false;
  constructor(peer: Peer, schemas: Schemas, clock: Clock, identity: ConnectKernel, role: string, send: Send, contribution: Contribution = { panels: [], renderers: [], declared: [] }, brand: Brand = brandDefaults, attachments: Attachments = localStore()) {
    this.#peer = peer; this.#schemas = schemas; this.#clock = clock; this.#identity = identity; this.#role = role; this.#send = send; this.#contribution = contribution; this.#brand = brand;
    this.#attachments = attachments;
    this.#requests = new SurfaceRequests(contribution.declared, role, id => this.#streams.get(id), send);
    this.#admin = new Admin(peer, role, send);
  }
  async command(input: Contract): Promise<Result<void>> {
    if (this.#closed) return failure('switching', 'The gateway connection is closed.');
    if (input.type === 'hello') {
      // `agent` sits beside `user` rather than inside it: `user` is who this socket belongs to, and the
      // two are frozen apart by service.test.ts. The page was already served with the same name filled in,
      // so this is what keeps a script that builds text — the composer's prompt, an avatar's letter —
      // reading one value instead of carrying a second copy of it.
      return this.#send({ type: 'user', user: { name: this.#identity.person, role: this.#role },
        agent: { name: this.#brand.agentName, accent: this.#brand.accent },
        capabilities: ['list', 'new', 'open', 'send', 'turn-cancel', 'cursor-replay', 'env-reset', 'attach', 'rename', 'archive', 'unarchive', 'everyone', 'choices', 'choose'],
        panels: this.#contribution.panels, renderers: this.#contribution.renderers });
    }
    if (input.type === 'list') return this.#list(input.scope ?? 'mine');
    if (input.type === 'choices') return this.#choices();
    if (input.type === 'new') {
      const result = await this.#peer.call('session.create', { surface: 'web' }); if (!result.ok) return result;
      if (!isObject(result.value) || typeof result.value['id'] !== 'string') return failure('protocol', 'The environment returned invalid conversation metadata.');
      return this.#open(result.value['id']);
    }
    if (SurfaceRequests.claims(input)) return this.#requests.handle(input);
    if (input.type === 'env-reset') return this.#envReset();
    if (input.type.startsWith('admin.')) return this.#admin.command(input);
    if (!['open', 'send', 'turn-cancel', 'rename', 'archive', 'unarchive', 'choose'].includes(input.type)) return failure('unsupported', 'The requested gateway capability is unavailable.');
    if (!input.id) return failure('invalid-args', 'The gateway command requires a conversation id.');
    if (input.type === 'open') return this.#open(input.id, input.from);
    if (input.type === 'turn-cancel') { const result = await this.#peer.call('session.cancel', { conversation: input.id }); return result.ok ? this.#send({ type: 'cancelled', session: input.id, result: result.value }) : result; }
    if (input.type === 'archive' || input.type === 'unarchive') return this.#archive(input.id, input.type === 'archive');
    if (input.type === 'choose') return this.#choose(input.id, input.model, input.mode);
    if (input.type === 'rename') return input.title === undefined ? failure('invalid-args', 'The gateway rename requires a name.') : this.#rename(input.id, input.title);
    if (typeof input.text !== 'string') return failure('invalid-args', 'The gateway turn requires text.');
    /* Everything the browser said about an attachment is re-derived from the conversation, the hash and the
     * type before it is believed; see attachments.ts. The refusal messages are the store's own, so what the
     * page shows after an upload and what it shows after a send are the same sentences. */
    const attachments = await this.#attachments.accept(input.id, input.attachments); if (!attachments.ok) return attachments;
    return this.#turn(input.id, input.text, attachments.value);
  }
  /* One list carries both the live conversations and the archived ones, because the sidebar draws an
   * Archived section under the live rows and every row already says which it is; asking twice would
   * leave the client stitching two replies that can cross. `scope` decides only *whose*: the kernel
   * reads `person: '*'` as everyone whose environment is running and stamps each row with its owner.
   * The reply echoes the scope it answered, so a reply to the previous setting cannot be mistaken for
   * the current one after the switch is flipped. */
  async #list(scope: 'mine' | 'everyone'): Promise<Result<void>> {
    if (scope === 'everyone' && !observers.includes(this.#role)) return failure('forbidden', 'This account can only see its own conversations.');
    const result = await this.#peer.call('session.list', { archived: true, ...(scope === 'everyone' ? { person: '*' } : {}) });
    return result.ok ? this.#send({ type: 'sessions', scope, sessions: result.value }) : result;
  }
  /* Both reply with an acknowledgement and nothing else. The row's new state comes from the next
   * `list`, which the client asks for on the acknowledgement: the store caps and collapses a name
   * (core/session-store.ts `rename`), so echoing back what was typed would show a title the
   * environment does not hold. */
  async #rename(id: string, title: string): Promise<Result<void>> {
    const result = await this.#peer.call('session.rename', { conversation: id, title });
    return result.ok ? this.#send({ type: 'renamed', session: id }) : result;
  }
  async #archive(id: string, archived: boolean): Promise<Result<void>> {
    const result = await this.#peer.call('session.archive', { conversation: id, archived });
    return result.ok ? this.#send({ type: 'archived', session: id, archived }) : result;
  }
  /* What a conversation here may be set to, and the setting of it.
   *
   * An environment that never negotiated these answers an empty list rather than a refusal — the same
   * shape `#envStatus` established for a withheld capability — because the surface's honest response to
   * "there is nothing to choose" is to draw no picker, not to show a broken one. The models are the
   * provider's own answer to `describe`; the gateway invents none and reorders none.
   *
   * Setting one answers with what was set rather than with the stored row, and the client asks for the
   * list afterwards, exactly as `rename` and `archive` do: the environment is what decides whether a
   * choice was honoured, and a page that echoed back what it sent would show a setting nothing holds. */
  async #choices(): Promise<Result<void>> {
    if (!this.#peer.supports('session.choices')) return this.#send({ type: 'choices', models: [] });
    const choices = await this.#peer.call('session.choices', {}); if (!choices.ok) return choices;
    if (!isObject(choices.value)) return failure('protocol', 'The environment returned invalid conversation choices.');
    return this.#send({ type: 'choices', models: [], ...choices.value });
  }
  async #choose(id: string, model?: string, mode?: string): Promise<Result<void>> {
    if (!this.#peer.supports('session.choose')) return failure('unsupported', 'The requested gateway capability is unavailable.');
    if (model === undefined && mode === undefined) return failure('invalid-args', 'The gateway choice names nothing to set.');
    const chosen = await this.#peer.call('session.choose', { conversation: id, ...(model === undefined ? {} : { model }), ...(mode === undefined ? {} : { mode }) });
    return chosen.ok ? this.#send({ type: 'chosen', session: id, ...(model === undefined ? {} : { model }), ...(mode === undefined ? {} : { mode }) }) : chosen;
  }

  async #open(id: string, from?: number): Promise<Result<void>> {
    if (this.#streams.has(id)) {
      if (from !== undefined) return failure('invalid-args', 'An existing subscription cannot change its cursor.');
      const sent = await this.#send({ type: 'opened', session: id }); return sent.ok ? this.#envStatus() : sent;
    }
    if (this.#opening.has(id) || this.#streams.size + this.#opening.size >= settings.streams) return failure('budget', 'The gateway subscription pool is full.');
    this.#opening.add(id);
    try {
      const resumed = from === undefined ? undefined : await this.#subscribe(id, from);
      if (resumed && (resumed.ok || resumed.error.code !== 'not-found')) return resumed;
      /* The environment retains a bounded window of events (lib/session/index.ts's `historyBytes`) and
       * starts counting afresh when it restarts, so a cursor can fall off either end of it. Refusing the
       * open would leave the person looking at a conversation that silently stopped; subscribing plainly
       * instead costs one extra round trip on the rarest path and gets them the saved transcript plus
       * everything from here on. `gap` is how app.js knows to say so, once, in the conversation it
       * happened to — the surface is the only place that can phrase it for a person. */
      return await this.#subscribe(id, undefined, resumed !== undefined);
    } finally { this.#opening.delete(id); }
  }
  async #subscribe(id: string, from?: number, gap = false): Promise<Result<void>> {
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
      ...(gap ? { gap: true } : {}), ...(subscribed.value.history ? { history: subscribed.value.history } : {}) });
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
