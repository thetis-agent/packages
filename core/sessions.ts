/** Route turns only through locally persisted conversation identities; KS-004, TE-009. */
import { stat } from 'node:fs/promises';
import type { SessionCreateParams } from '@/contracts/kernel-socket/types.ts';
import type { Input, Message, Envelope } from '@/contracts/turn-events/types.ts';
import type { Stage } from '@/lib/events/stages.ts';
import { frozen } from '@/lib/events/stages.ts';
import type { Clock } from '@/lib/events/index.ts';
import type { Schemas, Result } from '@/lib/schema/index.ts';
import { failure } from '@/lib/schema/index.ts';
import type { Provider } from '@/lib/provider/index.ts';
import { Loop } from './index.ts';
import type { Options } from './index.ts';
import { Conversation } from './conversation.ts';
import { SessionStore } from './session-store.ts';
import type { Now } from './session-store.ts';
import type { SessionInfo } from './types.ts';

export const sessionLimits = { loaded: 8, fileBytes: 1024 * 1024, inputBytes: 65536, writes: 32, reads: 8 };
/** `now` is epoch milliseconds for stored conversation stamps, separate from `clock` on purpose: `clock.now()`
 * is `performance.now()`, which is monotonic since process start and meaningless to a browser (session-store.ts). */
export interface Runtime { observe?: (event: Envelope) => void; stages: readonly Stage[]; schemas: Schemas; clock: Clock; now?: Now; provider: Provider; options: Omit<Options, 'conversation' | 'refresh'>; report?: (params: Record<string, unknown>) => Promise<Result<void>> }

/** The newest assistant text in a conversation, which is what a finished row previews: the sidebar's
 * second line answers "where is this conversation now", and after a turn that is the reply, not the
 * question. Empty when the turn produced no text at all — `record` then leaves the preview standing. */
function reply(history: readonly Message[]): string {
  const last = history.findLast(message => message.role === 'assistant');
  return (last?.content ?? []).map(part => part.type === 'text' ? part.text : '').join('');
}

type Entry = { history: Conversation; loop: Loop };
type Slot = { users: number; loading: Promise<Result<Entry>> };
type Lease = { loading: Promise<Result<Entry>>; release(): void };

export class Sessions {
  readonly #store: SessionStore;
  readonly #runtime: Runtime;
  readonly #slots = new Map<string, Slot>();
  readonly #active = new Map<string, AbortController>();
  readonly #writes = new Set<Promise<unknown>>();
  #paused = false;
  #reading = 0;
  #generation: number | undefined;
  private constructor(store: SessionStore, runtime: Runtime) {
    this.#store = store; const { model, provider, token, space, system, roots, mode, modelOptions, maxIterations, excludedSkills } = runtime.options;
    this.#runtime = { ...runtime, stages: [...runtime.stages], options: frozen({ model, provider, token, space, system, roots, mode, ...(modelOptions ? { modelOptions } : {}), ...(excludedSkills ? { excludedSkills } : {}), ...(maxIterations !== undefined ? { maxIterations } : {}) }) };
  }

  static async open(root: string, runtime: Runtime): Promise<Result<Sessions>> {
    const store = await SessionStore.open(root, runtime.schemas, runtime.now);
    return store.ok ? { ok: true, value: new Sessions(store.value, runtime) } : store;
  }
  list(): Promise<Result<SessionInfo[]>> { return this.#read(() => this.#store.list()); }
  create(input: SessionCreateParams): Promise<Result<SessionInfo>> {
    return this.#write(() => this.#store.create(input));
  }
  exists(id: string): Promise<Result<SessionInfo>> { return this.#read(() => this.#store.info(id)); }
  archive(id: string, archived: boolean): Promise<Result<void>> { return this.#write(() => this.#store.archive(id, archived)); }
  get active(): number { return this.#active.size; }
  changed(generation: number): Result<void> {
    if (!Number.isSafeInteger(generation) || generation < 1) return failure('invalid-args', 'The announced generation is invalid.');
    this.#generation = Math.max(this.#generation ?? 1, generation); return { ok: true, value: undefined };
  }

  history(id: string): Promise<Result<Message[]>> { return this.withHistory(id, history => ({ ok: true, value: history })); }
  /** Join a durable snapshot to its live subscription without yielding between them. */
  withHistory<T>(id: string, take: (history: Message[]) => Result<T>): Promise<Result<T>> { return this.#read(() => this.#history(id, take)); }
  async #history<T>(id: string, take: (history: Message[]) => Result<T>): Promise<Result<T>> {
    const lease = this.#lease(id); if (!lease.ok) return lease;
    try {
      const entry = await lease.value.loading;
      return entry.ok ? take(entry.value.history.project().history) : entry;
    } finally { lease.value.release(); }
  }

  submit(id: string, input: Input): Promise<Result<{ conversation: string; head: string | null }>> {
    return this.#write(() => this.#submit(id, input));
  }

  async #submit(id: string, input: Input): Promise<Result<{ conversation: string; head: string | null }>> {
    if (this.#paused) return failure('switching', 'The environment is quiescing.');
    if (Buffer.byteLength(JSON.stringify(input)) > sessionLimits.inputBytes) return failure('budget', 'The input exceeds the conversation byte limit.');
    const lease = this.#lease(id); if (!lease.ok) return lease;
    try {
      const loaded = await lease.value.loading; if (!loaded.ok) return loaded;
      const info = await this.#store.info(id); if (!info.ok) return info;
      const generation = this.#generation;
      const refresh = generation !== undefined && info.value.prefixGeneration !== generation && loaded.value.history.project().prefix ? [`generation ${String(generation)}`] : [];
      if (this.#quiescing()) return failure('switching', 'The environment is quiescing.');
      if (this.#active.has(id)) return failure('budget', 'The conversation already has an active turn.');
      const cancel = new AbortController(); this.#active.set(id, cancel);
      try {
        // Named and previewed before the vendor is called, so a conversation carries its own name from the
        // moment it is spoken to rather than only once a reply lands — including a turn that never finishes.
        const named = await this.#store.record(id, input.text); if (!named.ok) return named;
        const result = await loaded.value.loop.turn(input, { ...this.#runtime.options, conversation: id, refresh }, cancel.signal);
        const report = loaded.value.loop.report;
        if (!report) throw new Error('A completed turn has no diagnostic report.');
        const sent = await this.#runtime.report?.(report.ok ? report.value : { conversation: id, reportError: report.error });
        if (sent && !sent.ok) return sent;
        if (!report.ok) return report;
        if (result.ok && generation !== undefined && info.value.prefixGeneration !== generation) { const saved = await this.#store.prefixGeneration(id, generation); if (!saved.ok) return saved; }
        if (!result.ok) return result;
        const previewed = await this.#store.record(id, reply(loaded.value.history.project().history)); if (!previewed.ok) return previewed;
        return { ok: true, value: { conversation: id, head: loaded.value.history.head } };
      } finally { this.#active.delete(id); }
    } finally { lease.value.release(); }
  }

  cancel(id: string): Result<{ cancelled: boolean }> {
    const active = this.#active.get(id); active?.abort();
    return { ok: true, value: { cancelled: active !== undefined } };
  }

  async crash(code: string): Promise<void> {
    const reason = new Error(code); reason.name = 'BoundaryFailure'; this.#paused = true;
    for (const active of this.#active.values()) active.abort(reason);
    await Promise.all([...this.#writes]);
  }

  async pause(): Promise<void> { this.#paused = true; await Promise.all([...this.#writes]); }
  resume(): void { this.#paused = false; }
  #quiescing(): boolean { return this.#paused; }

  #write<T>(start: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#paused) return Promise.resolve(failure('switching', 'The environment is quiescing.'));
    if (this.#writes.size >= sessionLimits.writes) return Promise.resolve(failure('budget', 'The conversation write queue is full.'));
    const work = start();
    const tracked = work.finally(() => { this.#writes.delete(tracked); }); this.#writes.add(tracked);
    return tracked;
  }

  async #read<T>(start: () => Promise<Result<T>>): Promise<Result<T>> {
    if (this.#reading >= sessionLimits.reads) return failure('budget', 'The conversation read queue is full.');
    this.#reading++;
    try { return await start(); } finally { this.#reading--; }
  }

  #lease(id: string): Result<Lease> {
    let slot = this.#slots.get(id);
    if (!slot) {
      if (this.#slots.size >= sessionLimits.loaded) return failure('budget', 'The active conversation pool is full.');
      slot = { users: 0, loading: this.#load(id) }; this.#slots.set(id, slot);
    }
    slot.users++; const held = slot;
    return { ok: true, value: { loading: held.loading, release: () => {
      held.users--; if (!held.users) this.#slots.delete(id);
    } } };
  }

  async #load(id: string): Promise<Result<Entry>> {
    const info = await this.#store.info(id); if (!info.ok) return info;
    const path = await this.#store.path(id, 'conversation.jsonl', true); if (!path.ok) return path;
    try {
      const existing = await stat(path.value).catch((error: unknown) => {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return undefined;
        throw error;
      });
      if (existing && (!existing.isFile() || existing.size > sessionLimits.fileBytes)) return failure('budget', 'The conversation exceeds its loading byte limit.');
      const history = new Conversation(path.value, this.#runtime.schemas); const loaded = await history.load(); if (!loaded.ok) return loaded;
      const { stages, schemas, clock, provider } = this.#runtime;
      const observed = this.#runtime.observe;
      const handlers = observed ? [...stages, { source: 'core-session', gateway: true, observe: observed }] : stages;
      const entry = { history, loop: new Loop(handlers, schemas, clock, provider, history) };
      return { ok: true, value: entry };
    } catch { return failure('io', 'The conversation could not be opened.'); }
  }
}
