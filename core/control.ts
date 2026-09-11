/** Keep session control separate from the provider stream inside the environment; KS-004, ADR 0019. */
import { connect } from '@/lib/ndjson/socket.ts';
import { Peer } from '@/lib/socket/index.ts';
import type { Handler } from '@/lib/socket/index.ts';
import type { Method, Note } from '@/contracts/kernel-socket/types.ts';
import type { Input } from '@/contracts/turn-events/types.ts';
import { ProviderClient } from '@/lib/provider/client.ts';
import { clock } from '@/lib/events/index.ts';
import type { Stage } from '@/lib/events/stages.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Runtime } from '@/lib/package-loader/types.ts';
import { Sessions } from './sessions.ts';
import { capabilities, publicCapabilities } from './protocol.ts';
import { SessionEvents } from '@/lib/session/index.ts';
import { historyTail } from '@/lib/session/history.ts';
import { Service, serviceLimits } from '@/lib/service/lifecycle.ts';

class SessionControl {
  readonly #sessions: Sessions;
  readonly #schemas: Schemas;
  readonly #person: string;
  readonly #connections: () => number;
  readonly events: SessionEvents;
  #drained: Promise<Result<void>> | undefined;
  constructor(sessions: Sessions, schemas: Schemas, person: string, events: SessionEvents, connections: () => number) { this.#sessions = sessions; this.#schemas = schemas; this.#person = person; this.events = events; this.#connections = connections; }

  handlers(): ReadonlyMap<Method, Handler> {
    return new Map<Method, Handler>([
      ['health.probe', async () => {
        const drained = await this.#drained; if (drained && !drained.ok) return drained;
        return { ok: true, value: { ready: true, active: this.#sessions.active, connections: this.#connections(), draining: this.#drained !== undefined } };
      }],
      ['session.list', params => {
        const { person, archived } = params;
        if (person !== undefined && person !== this.#person) return Promise.resolve(failure('forbidden', 'The conversation list belongs to this environment.'));
        if (archived !== undefined && typeof archived !== 'boolean') return Promise.resolve(failure('invalid-args', 'The conversation list arguments are invalid.'));
        return this.#sessions.list({ archived: archived === true });
      }],
      ['session.create', params => {
        const { surface, project } = params;
        if (typeof surface !== 'string' || project !== undefined && typeof project !== 'string') return Promise.resolve(failure('invalid-args', 'The conversation metadata is invalid.'));
        return this.#sessions.create({ surface, ...(project === undefined ? {} : { project }) });
      }],
      ['session.submit', params => {
        const input = params['input']; const conversation = params['conversation'];
        if (typeof conversation !== 'string' || !this.#schemas.validator<Input>('turn-events', 'input')(input)) return Promise.resolve(failure('invalid-args', 'The input violates the turn-event schema.'));
        return this.#sessions.submit(conversation, input);
      }],
      ['session.cancel', params => Promise.resolve(typeof params['conversation'] === 'string' ? this.#sessions.cancel(params['conversation']) : failure('invalid-args', 'The conversation id is invalid.'))],
      // Metadata, not turns: renaming and archiving touch the stored row and never the loop, so both
      // stay available while a conversation is mid-turn and neither goes through the drain.
      ['session.rename', params => {
        const { conversation, title } = params;
        if (typeof conversation !== 'string' || typeof title !== 'string') return Promise.resolve(failure('invalid-args', 'The conversation name is invalid.'));
        return this.#sessions.rename(conversation, title);
      }],
      ['session.archive', params => {
        const { conversation, archived } = params;
        if (typeof conversation !== 'string' || typeof archived !== 'boolean') return Promise.resolve(failure('invalid-args', 'The conversation archive flag is invalid.'));
        return this.#sessions.archive(conversation, archived);
      }]
    ]);
  }

  public(client: Peer): { handlers: ReadonlyMap<Method, Handler>; close(): void } {
    const handlers = new Map(this.handlers()); let unsubscribe: (() => void) | undefined; let subscribing = false; let closed = false;
    handlers.set('session.submit', () => Promise.resolve(failure('forbidden', 'Turns must enter through inherited kernel control so their outcomes are observed.')));
    handlers.set('session.subscribe', async params => {
      const conversation = params['conversation']; const from = params['from'];
      if (typeof conversation !== 'string' || from !== undefined && (typeof from !== 'number' || !Number.isSafeInteger(from) || from < 0)) return failure('invalid-args', 'The session subscription is invalid.');
      if (unsubscribe || subscribing) return failure('budget', 'This connection already has a conversation subscription.');
      subscribing = true;
      try {
        return await this.#sessions.withHistory(conversation, messages => {
          if (closed) return failure('io', 'The subscription connection closed while loading history.');
          const subscription = this.events.subscribe(conversation, from, params => client.notify({ note: 'notice', params }), () => { client.close(); });
          if (!subscription.ok) return subscription;
          unsubscribe = () => { subscription.value.close(); };
          return { ok: true, value: { ...subscription.value.result, ...(from === undefined ? { history: historyTail(messages) } : {}) } };
        });
      } finally { subscribing = false; }
    });
    return { handlers, close: () => { closed = true; unsubscribe?.(); } };
  }

  async note(note: Note): Promise<Result<void>> {
    if (note.note === 'notice' && note.params['boundaryFailure'] === 'frame-too-large') this.#drained ??= this.#sessions.crash('frame-too-large').then(() => ({ ok: true, value: undefined }), () => failure('io', 'The environment could not end its failed turns.'));
    if (note.note === 'run.stop') this.#drained ??= this.#sessions.pause().then(() => ({ ok: true, value: undefined }), () => failure('io', 'The environment could not drain its conversations.'));
    if (note.note === 'env.updated' && note.params['resume'] === true) {
      const drained = await this.#drained; if (drained && !drained.ok) return drained;
      if (typeof note.params['generation'] === 'number') { const changed = this.#sessions.changed(note.params['generation']); if (!changed.ok) return changed; }
      this.#sessions.resume(); this.#drained = undefined;
    }
    return { ok: true, value: undefined };
  }
}

export async function control(config: Runtime, stages: readonly Stage[], schemas: Schemas): Promise<Result<Peer>> {
  if (!config.controlPath) return failure('io', 'The environment monitor endpoint is absent.');
  const events = new SessionEvents(clock);
  const sessions = await Sessions.open(config.root, { stages, schemas, clock, observe: event => { events.observe(event); }, provider: new ProviderClient(config.providerSocket, schemas, config.token), options: config,
    report: params => peer.notify({ note: 'turn.report', params }) });
  if (!sessions.ok) return sessions;
  if (config.generation !== undefined) { const changed = sessions.value.changed(config.generation); if (!changed.ok) return changed; }
  const opened = await connect(config.controlPath); if (!opened.ok) return opened;
  const endpoint = config.endpoint ? new Service(clock, serviceLimits, 'io') : undefined;
  const handler = new SessionControl(sessions.value, schemas, config.person, events, () => endpoint?.connections ?? 0);
  const peer = new Peer(opened.value, schemas, clock, capabilities, { handlers: handler.handlers(), note: note => handler.note(note) });
  const connected = await peer.connect(); if (!connected.ok) return connected;
  if (config.endpoint && endpoint) {
    const opened = await endpoint.open(config.endpoint, async connection => {
      const methods = new Map<Method, Handler>();
      const client = new Peer(connection.socket, schemas, clock, publicCapabilities, { handlers: methods, note: () => Promise.resolve(failure('forbidden', 'Only inherited control can stop an environment.')) });
      const session = handler.public(client); for (const [method, handle] of session.handlers) methods.set(method, handle);
      try {
        const accepted = await client.accept({ person: config.person, scope: 'person' });
        if (!accepted.ok) return accepted; connection.admitted(); return await client.finished();
      } finally { session.close(); client.close(); }
    }, outcome => { if (!outcome.ok) process.stderr.write(`${JSON.stringify(outcome)}\n`); });
    if (!opened.ok) { peer.close(); await peer.finished(); return opened; }
    void peer.finished().then(async () => { const stopped = await endpoint.stop(); if (!stopped.ok) process.stderr.write(`${JSON.stringify(stopped)}\n`); });
  }
  return { ok: true, value: peer };
}
