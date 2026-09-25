// What every suite builds on: messages of a known size, an in-memory store, a fake provider that answers
// with a summary, and the contexts the step, the hook and the UI commands receive. Sizes are chosen so the
// arithmetic in a test is readable: one `msg(400)` is 100 estimated tokens.
import { contentText, textContent } from "@thetis/runtime/lib/content";
import type { Message, ModelChoices, PackageStepContext, ProviderCall, ProviderEvent, StepEnv, ToolEnv, TurnEvent, UiCommandEnv } from "@thetis/runtime/contracts";
import type { Store } from "@thetis/runtime/contracts";
import { NAME, freshState, type CompactionState } from "../src/schemas.js";

export type Role = Message["role"];

/** One message whose text has exactly `chars` characters (a quarter as many estimated tokens). */
export function msg(chars: number, role: Role = "user", extra: Partial<Message> = {}): Message {
  return { role, content: textContent("x".repeat(chars)), ...extra };
}

/** `n` messages of `chars` each, alternating user and assistant. */
export function conversationOf(n: number, chars = 400): Message[] {
  return Array.from({ length: n }, (_, i) => msg(chars, i % 2 === 0 ? "user" : "assistant"));
}

export class MemoryStore implements Store {
  readonly docs = new Map<string, object>();
  async get<T extends object = Record<string, unknown>>(key: string): Promise<T | undefined> { return this.docs.get(key) as T | undefined; }
  async set(key: string, doc: object): Promise<void> { this.docs.set(key, structuredClone(doc)); }
  async delete(key: string): Promise<void> { this.docs.delete(key); }
  async list(prefix = ""): Promise<string[]> { return [...this.docs.keys()].filter((k) => k.startsWith(prefix)); }
  async clear(): Promise<void> { this.docs.clear(); }
}

export type Sent = { call: ProviderCall; signal?: AbortSignal };
export type ProviderFn = (call: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal) => Promise<void>;

/** A provider that answers every request with the same events and remembers what it was asked. */
export function fakeProvider(events: ProviderEvent[] | ((call: ProviderCall) => ProviderEvent[])) {
  const sent: Sent[] = [];
  const call = async (request: ProviderCall, onEvent: (e: ProviderEvent) => void, signal?: AbortSignal): Promise<void> => {
    sent.push({ call: structuredClone(request), signal });
    for (const event of typeof events === "function" ? events(request) : events) onEvent(event);
  };
  return { sent, call };
}

export const summaryEvents = (text = "<summary>short</summary>", usage: Record<string, number> = { prompt_tokens: 900, completion_tokens: 10, cost: 0.01 }): ProviderEvent[] => [
  { type: "text", delta: text },
  { type: "usage", usage },
];

export interface EnvOptions {
  provider?: ProviderFn | { call: ProviderFn };
  store?: MemoryStore | (() => never);
  models?: ModelChoices | (() => Promise<ModelChoices>);
  inspect?: (session: string) => Promise<unknown>;
  root?: string;
}

const requestFile = (path: string): string | undefined => /^compaction\/requests\/([A-Za-z0-9_-]+)\.json$/.exec(path)?.[1];

export function fakeEnv(opts: EnvOptions = {}): StepEnv {
  const store = opts.store ?? new MemoryStore();
  const docs: MemoryStore | undefined = typeof store === "function" ? undefined : store;
  const home = (): MemoryStore => { if (!docs) throw new Error("no home in this test"); return docs; };
  const models = opts.models ?? { model: "vendor/model", models: [] };
  const provider: ProviderFn = typeof opts.provider === "function" ? opts.provider : opts.provider?.call ?? (async () => { throw new Error("no provider in this test"); });
  return {
    cwd: "/cwd",
    root: opts.root ?? `/root-${Math.random().toString(36).slice(2)}`,
    store: "/store",
    shared: "/shared",
    storage: typeof store === "function" ? store : () => store,
    exec: async () => ({ code: 0, stdout: "", stderr: "" }),
    // The request file under the home is backed by the same memory store the tests seed, keyed by session id;
    // a store that throws stands for a fence with no usable home.
    readFile: async (path) => {
      const id = requestFile(path);
      const doc = id && (await home().get(id));
      if (!doc) { const err = new Error(`ENOENT: ${path}`) as NodeJS.ErrnoException; err.code = "ENOENT"; throw err; }
      return JSON.stringify(doc);
    },
    writeFile: async (path, content) => {
      const id = requestFile(path);
      if (!id) return;
      if (!content.trim()) await home().delete(id);
      else await home().set(id, JSON.parse(content));
    },
    invokeTool: async () => { throw new Error("no tools in this test"); },
    kernel: {
      models: typeof models === "function" ? models : async () => models,
      providers: { call: provider },
      sessions: { inspect: opts.inspect ?? (async () => { throw new Error("no sessions in this test"); }) },
    } as unknown as StepEnv["kernel"],
  };
}

export interface CtxOptions {
  conversation?: Message[];
  state?: CompactionState;
  config?: Record<string, unknown>;
  env?: StepEnv;
  harness?: Record<string, unknown>;
  call?: Partial<ProviderCall>;
  turn?: string;
}

/** The step's context, with the events it emits collected on `events`. */
export function stepCtx(opts: CtxOptions = {}): { ctx: PackageStepContext; events: TurnEvent[] } {
  const events: TurnEvent[] = [];
  const conversation = opts.conversation ?? conversationOf(10);
  const ctx: PackageStepContext = {
    emit: (e) => events.push(e),
    signal: new AbortController().signal,
    session: { id: "s1", user: "alice" },
    turn: { id: opts.turn ?? "t1", input: [conversation[conversation.length - 1]] },
    conversation,
    call: {
      model: "vendor/model",
      system: "You are Thetis.",
      messages: [],
      tools: [{ name: "greet", description: "hi", parameters: {}, package: "@thetis/greet", export: "greet" }],
      params: { temperature: 0 },
      hints: { cache: { affinity: "thetis:abc" } },
      ...opts.call,
    },
    harness: { "@thetis/prompt-cache": { turns: 3 }, ...(opts.state ? { [NAME]: opts.state } : {}), ...opts.harness },
    packages: { has: () => false, get: () => undefined, list: () => [] },
    env: opts.env ?? fakeEnv(),
    config: { window: 1000, keepTokens: 200, minShedTokens: 100, ...opts.config },
  };
  return { ctx, events };
}

export function toolEnv(env: StepEnv, config: Record<string, unknown> = {}): ToolEnv {
  return { ...env, session: { id: "s1", user: "alice" }, config: { window: 1000, keepTokens: 200, minShedTokens: 100, ...config } };
}

/** `session: null` is a page with no conversation open; an explicit `undefined` would only pick the default. */
export function uiEnv(env: StepEnv, config: Record<string, unknown> = {}, session: string | null = "s1"): UiCommandEnv {
  return { ...env, user: "alice", role: "user", ...(session === null ? {} : { session }), config: { window: 1000, keepTokens: 200, minShedTokens: 100, ...config } };
}

/** A state that already holds a summary over the first `cut` messages. */
export function summarized(cut: number, over: Partial<CompactionState> = {}): CompactionState {
  const at = "2026-09-25T12:03:00.000Z";
  return {
    ...freshState(),
    cut, summary: "old summary", compactions: 1, projectedAt: at,
    last: { at, turn: "t0", round: 1, cut, from: 0, tokensBefore: 900, tokensAfter: 300, cost: 0.41, model: "vendor/model", ms: 1200, messages: cut, trigger: "auto" },
    ledger: [{ at, kind: "compact", trigger: "auto", cut, from: 0, tokensBefore: 900, tokensAfter: 300, cost: 0.41, model: "vendor/model" }],
    ...over,
  };
}

/** The `data` of an extension event, as the loose record a test reads fields off. */
export const dataOf = (event: TurnEvent): Record<string, unknown> => (event as unknown as { data: Record<string, unknown> }).data;

export const phases = (events: TurnEvent[]): string[] =>
  events.filter((e) => e.type === "extension" && e.name === NAME).map((e) => String(dataOf(e).phase));

/** The text of a message's first part. */
export const textOf = (message: Message): string => contentText(message.content);

export const stateOf = (harness: Record<string, unknown> | undefined): CompactionState => harness?.[NAME] as CompactionState;
