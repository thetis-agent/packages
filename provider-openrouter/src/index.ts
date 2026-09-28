import { wireContent, wireToolResult } from "./content.js";
import { parseSchema } from "@thetis/runtime/lib/validation";
import { ToolCallSchema } from "@thetis/runtime/schemas";
import { ModelReasoningSchema, ModelsResponseSchema, ProviderErrorSchema, StreamChunkSchema, ToolArgumentsSchema } from "./schemas.js";
import type { z } from "zod";
// OpenRouter provider: OpenAI-compatible chat completions with SSE streaming and tool calls.
// Prompt caching is applied at the wire. The policy comes from this package's own `cache` config; a
// `cache` hint on the call may tune it within the configured `hints` mode.
import type { Message, ModelDescriptor, Provider, ProviderCall, ProviderContext, ProviderEvent, ToolCall } from "@thetis/runtime/contracts";
import { applyHint, applyOpenAiCompatible, normalizeUsage, readHint, resolvePolicy, type CacheConfig, type OpenAiContentPart, type OpenAiWireMessage } from "@thetis/prompt-cache";

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Request fields sent with every call, under `call.params`. For example `provider: { order: ["anthropic"] }`. */
  defaults?: Record<string, unknown>;
  /** Prompt caching policy. See packages/prompt-cache/README.md. */
  cache?: CacheConfig;
  /** How many times a refused request is retried when the refusal is transient (rate limit, in-flight budget, server error). Default 3. */
  retries?: number;
  /**
   * How long the whole attempt to get a response may take: every retry and every wait between them, counted
   * from the first request. Node's fetch has no timeout of its own, so without this a connection that opens
   * and then says nothing waits for ever. Default 180000.
   */
  requestTimeoutMs?: number;
  /**
   * How long an open stream may produce no bytes at all before it is abandoned. Not a limit on the reply: a
   * model that is thinking still sends SSE traffic, and each byte resets this. Default 120000.
   */
  streamStallMs?: number;
}

/** The defaults, exported so the manifest, the README and the tests cannot drift from the code. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 180_000;
export const DEFAULT_STREAM_STALL_MS = 120_000;

/** Statuses worth a second try: the request was sound, the moment was wrong. */
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504, 529]);
const MAX_WAIT_MS = 120_000;

/**
 * The wait before retrying a refused request, or undefined when the refusal is final. OpenRouter answers
 * 402 both for an empty account (final) and for an in-flight budget that the settling of other requests
 * frees (transient); the body says which. A Retry-After header wins over the backoff.
 */
export function retryAfterMs(status: number, body: string, retryAfter: string | null, attempt: number): number | undefined {
  const inFlight = status === 402 && /in_flight_budget/.test(body);
  if (!inFlight && !TRANSIENT.has(status)) return undefined;
  return askedWaitMs(body, retryAfter) ?? backoffMs(attempt);
}

/** The wait a refusal asked for: the Retry-After header in seconds, else the hint in the body; undefined when it asked for none. */
export function askedWaitMs(body: string, retryAfter: string | null): number | undefined {
  const header = Number(retryAfter);
  if (retryAfter && Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_WAIT_MS);
  const hinted = /"Retry-After"\s*:\s*"?(\d+)/.exec(body);
  if (hinted) return Math.min(Number(hinted[1]) * 1000, MAX_WAIT_MS);
  return undefined;
}

const backoffMs = (attempt: number): number => Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);

interface WireMessage extends OpenAiWireMessage {
  tool_calls?: { id: string; type: "function"; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
  name?: string;
}

export function createProvider(config: OpenRouterConfig = {}): Provider {
  const baseUrl = (config.baseUrl ?? "https://openrouter.ai/api/v1").replace(/\/$/, "");
  const apiKey = config.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
  const cacheConfig: CacheConfig = config.cache ?? {};
  const requestTimeoutMs = positive(config.requestTimeoutMs) ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const streamStallMs = positive(config.streamStallMs) ?? DEFAULT_STREAM_STALL_MS;
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/thetis",
    "X-Title": "Thetis",
    ...(config.headers ?? {}),
  };

  // What each model takes as input, from the last model list. A model not in it is assumed to take media,
  // so that an unlisted model gets the image and says so if it cannot, rather than being blinded by a guess.
  const modalities = new Map<string, string[]>();

  return {
    async models(): Promise<ModelDescriptor[]> {
      // The model list is asked for on the path of every call that has to resolve a model, and it is cached
      // for five minutes on the kernel side. An unbounded one would wedge every call behind it.
      const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!res.ok) throw new Error(`openrouter /models failed: ${res.status} ${await res.text()}`);
      const body = parseSchema(ModelsResponseSchema, await res.json(), "OpenRouter models");
      // The keys are left out when OpenRouter lists no window or no reasoning, so a descriptor never says
      // `contextLength: undefined`, and a model that does not think carries no `reasoning` at all.
      for (const m of body.data) if (m.architecture?.input_modalities) modalities.set(m.id, m.architecture.input_modalities);
      return body.data.map((m) => ({
        id: m.id,
        name: m.name,
        ...(m.context_length !== undefined ? { contextLength: m.context_length } : {}),
        ...(m.reasoning ? { reasoning: describeReasoning(m.reasoning) } : {}),
      }));
    },

    async *call(call: ProviderCall, signal?: AbortSignal, context?: ProviderContext): AsyncIterable<ProviderEvent> {
      if (!apiKey) return yield failed("OpenRouter apiKey is not configured (set OPENROUTER_API_KEY)", { retryable: false, kind: "auth" });
      let messages: WireMessage[];
      // The model list is read once when media is about to go out and nobody has asked for it on this
      // provider yet; a failure there only means the model's modalities stay unknown.
      if (!modalities.size && carriesMedia(call)) await this.models().catch(() => {});
      try { messages = await toWire(call, context, (mediaType) => accepts(modalities.get(call.model), mediaType)); }
      catch (error) { return yield failed(reason(error), { retryable: false, kind: "other" }); }
      const body = {
        model: call.model,
        messages,
        tools: call.tools.length ? call.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
        stream: true,
        usage: { include: true },
        ...(config.defaults ?? {}),
        ...call.params,
      } as Record<string, unknown> & { messages: WireMessage[] };
      const policy = applyHint(resolvePolicy(cacheConfig, call.model), readHint(call.hints?.cache), cacheConfig.hints);
      applyOpenAiCompatible(body, policy);
      if (policy.affinity && cacheConfig.affinity !== false && body.user === undefined) body.user = policy.affinity;
      const serialized = JSON.stringify(body);
      if (call.hints?.context === true) yield { type: "request", body: JSON.parse(serialized), at: new Date().toISOString() };
      // Two bounds, and neither of them is a limit on how long a good answer may take. The first covers
      // getting a response at all -- every retry and every wait between them -- and stops the moment the
      // headers arrive. The second covers the open stream, and any byte at all resets it, so a model that
      // thinks for twenty minutes while sending SSE keepalives is never touched by it. What they rule out is
      // the one shape neither of them describes: a socket that is open and silent, for ever.
      //
      // One request per call. Once the headers are in, nothing here asks again: a failure after that point is
      // one `error` event that says whether asking again could help (`retryable`) and what kind of failure it
      // was, and the harness, which owns the round and can throw its half away, decides. Two retry policies
      // stacked on one another is how a zero-byte cut once became an instant loop nobody could see.
      const request = requestScope(signal, requestTimeoutMs);
      let beat: ReturnType<typeof setInterval> | undefined;
      // Whether anything at all has reached the consumer: text, reasoning, a tool call's progress, usage.
      let produced = false;
      let saidText = false;
      let ended: "done" | "cut" = "cut";
      try {
        let res: Response;
        try {
          res = await post(`${baseUrl}/chat/completions`, headers, serialized, config.retries ?? 1, request);
        } catch (err) {
          if (signal?.aborted) return; // the caller gave up; it is not waiting for an explanation
          return yield failed(request.reason ?? `openrouter request failed: ${reason(err)}`, { retryable: true, kind: request.reason ? "timeout" : "connection" });
        }
        if (!res.ok || !res.body) {
          const text = await res.text();
          return yield failed(refusal(res.status, text), classifyRefusal(res.status, text, res.headers.get("retry-after")));
        }
        request.arrived();
        let lastByte = Date.now();
        beat = setInterval(() => {
          if (Date.now() - lastByte >= streamStallMs) request.abort(`the openrouter stream was open but sent nothing for ${Math.round(streamStallMs / 1000)}s, so it was abandoned`);
        }, Math.max(250, Math.min(5_000, Math.floor(streamStallMs / 4))));
        beat.unref?.();

        const pending = new Map<number, { id: string; name: string; args: string }>();
        let lastProgress = 0;
        let finish: string | undefined;
        const lines: AsyncIterable<string> = sse(res.body, () => (lastByte = Date.now()));
        const reading = lines[Symbol.asyncIterator]();
        for (;;) {
          let step: IteratorResult<string>;
          try {
            step = await reading.next();
          } catch (err) {
            if (signal?.aborted) return;
            return yield failed(request.reason ?? `the openrouter stream failed: ${reason(err)}`, { retryable: true, kind: request.reason ? "timeout" : "connection" });
          }
          if (step.done) break;
          const data = step.value;
          if (data === "[DONE]") {
            ended = "done";
            break;
          }
          let chunk;
          try {
            chunk = parseSchema(StreamChunkSchema, JSON.parse(data), "OpenRouter stream");
          } catch (error) {
            return yield failed(`OpenRouter stream: ${reason(error)}`, { retryable: false, kind: "other" });
          }
          if (chunk.error) return yield failed(chunk.error.message ?? JSON.stringify(chunk.error), classifyStreamError(chunk.error));
          if (typeof chunk.choices?.[0]?.finish_reason === "string") finish = chunk.choices[0].finish_reason;
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === "string") {
            if (delta.content) {
              produced = saidText = true;
              yield { type: "text", delta: delta.content };
            }
          } else if (delta?.content != null) return yield failed("OpenRouter returned an unsupported content delta", { retryable: false, kind: "other" });
          if (delta?.images || delta?.audio) return yield failed("This OpenRouter adapter does not yet decode generated image or audio streams", { retryable: false, kind: "other" });
          // A reasoning model sends its thinking beside the answer, and two spellings are in the wild:
          // `reasoning`, which is OpenRouter's normalization, and `reasoning_content`, which is what DeepSeek
          // and llama.cpp emit and OpenRouter passes through for some upstreams. Take whichever came. It is
          // yielded as its own kind and never folded into the text: the thinking is not the reply.
          const thought = delta?.reasoning ?? delta?.reasoning_content;
          if (thought) {
            produced = true;
            yield { type: "reasoning", delta: thought };
          }
          for (const tc of delta?.tool_calls ?? []) {
            const slot = pending.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            pending.set(tc.index ?? 0, slot);
            // A tool call is only yielded whole, at the end of the stream, and its arguments can take minutes to
            // arrive: a model writing a 50 KB file sends nothing else meanwhile. To whoever watches the stream
            // that is indistinguishable from a wedged request, and was cancelled as one. So the arguments
            // arriving are reported as they grow, a few times a minute, as a sign of life and of progress.
            produced = true;
            if (Date.now() - lastProgress >= TOOL_PROGRESS_MS) {
              lastProgress = Date.now();
              yield { type: "extension", name: "tool_call.progress", data: { index: tc.index ?? 0, name: slot.name, chars: slot.args.length } };
            }
          }
          if (chunk.usage) {
            produced = true;
            yield { type: "usage", usage: normalizeUsage(chunk.usage) };
          }
        }
        // A stream that ends with neither the provider's [DONE] nor a finish_reason was cut under the reply:
        // the connection dropped, or the upstream gave up without a word. Before this was noticed the adapter
        // ended quietly and the harness took the empty message as the model finishing, so a turn simply stopped
        // mid-work and nothing anywhere said so. It is reported, and reported as worth asking again: no tool
        // of this reply has run, since tool calls are only yielded when a stream finishes. A [DONE] without a
        // finish_reason is taken as the provider's word that it finished; the empty-reply check below still
        // stands over it.
        if (finish === undefined && ended === "cut") {
          return yield failed(`the connection closed before the reply finished${produced ? ", part-way through it" : ", before any of it arrived"}: no finish reason was sent`, { retryable: true, kind: "connection" });
        }
        // A reply cut off at the output limit is not an answer: its tool call arguments are half a JSON document,
        // and reasoning may have used the whole allowance with nothing said. Say so instead of ending quietly.
        // Neither of these is worth the same request again; the harness decides what else to try.
        const cut = stopMessage(finish, body.max_tokens);
        if (cut) return yield failed(cut, { retryable: false, kind: finish === "length" ? "output-limit" : "filter" });
        // A finished reply that says nothing and calls nothing is not the model finishing either: a turn that
        // ended on it would end mid-work with nothing to show, which reads as the agent dying. The reason is
        // named so the person can see what came back. A second sample usually says something.
        if (!saidText && !pending.size) return yield failed(`the model returned an empty reply (finish_reason: ${finish ?? "none"}${produced ? ", reasoning only" : ""})`, { retryable: true, kind: "other" });
        let calls: ToolCall[];
        try {
          calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([i, slot]) =>
            parseSchema(ToolCallSchema, { id: slot.id || `call_${i}`, name: slot.name, args: parseArgs(slot.args) }, "OpenRouter tool call"));
        } catch (error) {
          // Nearly always a reply cut short inside the arguments; a second sample usually closes them.
          return yield failed(reason(error), { retryable: true, kind: "other" });
        }
        for (const toolCall of calls) yield { type: "tool_call", call: toolCall };
        return;
      } finally {
        // Reached on a return, on a throw, and on the consumer abandoning the iteration, which is the case
        // that matters: an abandoned request must not leave its socket and its two timers behind.
        if (beat) clearInterval(beat);
        request.release();
      }
    },
  };
}

/** The failure kinds an `error` event names, shared with the harness and the kernel's turn record. */
export type FailureKind = "connection" | "rate-limit" | "overloaded" | "timeout" | "credits" | "context" | "output-limit" | "filter" | "auth" | "other";

/** What an `error` event says besides its message: whether asking again could help, and why it failed. */
export interface FailureInfo {
  retryable: boolean;
  kind: FailureKind;
  status?: number;
  retryAfterMs?: number;
}

/** One `error` event. The extra fields are optional in the contract, so a consumer that knows none of them loses nothing. */
function failed(message: string, info: FailureInfo): ProviderEvent {
  return { type: "error", message, ...info } as ProviderEvent;
}

/**
 * What a refusal is, read from its status and body: whether the same request could succeed later, and
 * which kind of failure a person should be told about. `retryAfterMs` is the wait the refusal asked for,
 * from the Retry-After header or the hint OpenRouter puts in a 402's body, when it asked for one.
 */
export function classifyRefusal(status: number, body: string, retryAfter: string | null): FailureInfo {
  const asked = askedWaitMs(body, retryAfter);
  const wait = asked !== undefined ? { retryAfterMs: asked } : {};
  if (status === 402) return /in_flight_budget/.test(body) ? { retryable: true, kind: "rate-limit", status, ...wait } : { retryable: false, kind: "credits", status };
  if (status === 429) return { retryable: true, kind: "rate-limit", status, ...wait };
  if (status === 408 || status === 504) return { retryable: true, kind: "timeout", status, ...wait };
  if (status === 409 || status === 425) return { retryable: true, kind: "other", status, ...wait };
  if (status >= 500) return { retryable: true, kind: "overloaded", status, ...wait };
  if (status === 401 || status === 403) return { retryable: false, kind: "auth", status };
  if (status === 400 || status === 413) return { retryable: false, kind: CONTEXT.test(body) ? "context" : "other", status };
  return { retryable: false, kind: "other", status };
}

/** Wording that says the request is larger than the model's window. */
const CONTEXT = /context.{0,20}(length|window|limit)|too (long|large)|maximum.{0,20}tokens|prompt is too long|reduce the length/i;

/**
 * An error OpenRouter sends inside an open stream: an upstream that failed after the headers. Its `code` is
 * an HTTP status when it has one; an overloaded or failing upstream is worth asking again.
 */
export function classifyStreamError(error: { message?: string; code?: unknown }): FailureInfo {
  const code = typeof error.code === "number" ? error.code : typeof error.code === "string" && /^\d{3}$/.test(error.code) ? Number(error.code) : undefined;
  const text = error.message ?? "";
  if (code !== undefined && code !== 200) {
    const byCode = classifyRefusal(code, text, null);
    if (byCode.retryable || code !== 400) return byCode;
  }
  if (/overloaded|capacity/i.test(text)) return { retryable: true, kind: "overloaded", ...(code ? { status: code } : {}) };
  if (/rate.?limit/i.test(text)) return { retryable: true, kind: "rate-limit", ...(code ? { status: code } : {}) };
  if (/timed? ?out|timeout/i.test(text)) return { retryable: true, kind: "timeout", ...(code ? { status: code } : {}) };
  if (/upstream|provider returned error|internal|unavailable|connection/i.test(text)) return { retryable: true, kind: "overloaded", ...(code ? { status: code } : {}) };
  if (CONTEXT.test(text)) return { retryable: false, kind: "context", ...(code ? { status: code } : {}) };
  return { retryable: false, kind: "other", ...(code ? { status: code } : {}) };
}

/** How often a tool call whose arguments are still arriving is reported as `tool_call.progress`. */
export const TOOL_PROGRESS_MS = 5_000;

/** Why a reply ended early, when the reason is one the caller should act on; undefined for a normal stop. */
export function stopMessage(finish: string | undefined, maxTokens: unknown): string | undefined {
  if (finish === "length") return `the reply stopped at the output limit${typeof maxTokens === "number" ? ` of ${maxTokens} tokens (max_tokens)` : ""}; reasoning counts against it, so raise defaults.max_tokens or ask for less at once`;
  if (finish === "content_filter") return "the provider's content filter stopped the reply";
  return undefined;
}

/**
 * What a model descriptor says about reasoning, in this provider's own words. OpenRouter's fields are
 * passed through under camelCase, and only the ones it sent: `supportedEfforts` is the allowlist in
 * descending order, or absent when the model exposes no effort choice; `null` inside it (OpenRouter's
 * "any value") is dropped. `mandatory` is always answered, false when OpenRouter did not say, because a
 * page deciding whether to offer "off" must not have to guess.
 */
export function describeReasoning(r: z.infer<typeof ModelReasoningSchema>): ModelReasoning {
  const efforts = Array.isArray(r.supported_efforts) ? r.supported_efforts.filter((e): e is string => typeof e === "string" && e.length > 0) : undefined;
  return {
    mandatory: r.mandatory === true,
    ...(typeof r.default_enabled === "boolean" ? { defaultEnabled: r.default_enabled } : {}),
    ...(typeof r.default_effort === "string" && r.default_effort ? { defaultEffort: r.default_effort } : {}),
    ...(efforts && efforts.length ? { supportedEfforts: efforts } : {}),
    ...(r.supports_max_tokens === true ? { supportsMaxTokens: true } : {}),
  };
}

/** The `reasoning` field a model descriptor carries when the model thinks. */
export interface ModelReasoning {
  /** True when the model rejects `effort: "none"`: thinking cannot be turned off. */
  mandatory: boolean;
  /** Whether the model thinks when the request says nothing about reasoning. */
  defaultEnabled?: boolean;
  /** The effort OpenRouter pre-selects; `"none"` means off unless asked. */
  defaultEffort?: string;
  /** The `reasoning.effort` values the model accepts, highest first. Absent when the model exposes no effort choice. */
  supportedEfforts?: string[];
  /** True when `reasoning.max_tokens` is accepted (Anthropic-style). */
  supportsMaxTokens?: true;
}

/** One sentence for a refused request: OpenRouter's own message and reason when the body is its JSON, else the raw text. */
export function refusal(status: number, body: string): string {
  try {
    const parsed = ProviderErrorSchema.safeParse(JSON.parse(body)?.error);
    if (!parsed.success) return `openrouter ${status}: ${body.slice(0, 500)}`;
    const message = parsed.data.message;
    if (message) return `openrouter ${status}: ${message}${parsed.data.metadata?.reason ? ` (${parsed.data.metadata.reason})` : ""}`;
  } catch {
    // not JSON: fall through to the raw text
  }
  return `openrouter ${status}: ${body.slice(0, 500)}`;
}

/**
 * The life of one request: the signal every fetch of it is given, the deadline for getting a response, and
 * the reason this provider abandoned it, when it did.
 *
 * The caller's signal is linked in rather than passed through, because the deadline has to be able to abort
 * the request too, and a signal the caller owns is not ours to fire. `reason` is set only when we gave up on
 * our own bound: a caller that cancelled knows why already, and its `AbortError` is not something to report
 * back at it as a provider failure.
 */
export interface RequestScope {
  readonly signal: AbortSignal;
  reason?: string;
  abort(why: string): void;
  /** The response headers are in. The deadline was about reaching this point; from here the stream has its own bound. */
  arrived(): void;
  /** The request is over, however it ended: drop the timer, unhook the caller's signal, close the socket. */
  release(): void;
}

export function requestScope(outer: AbortSignal | undefined, timeoutMs: number): RequestScope {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const onOuter = () => controller.abort(outer?.reason);
  const scope: RequestScope = {
    signal: controller.signal,
    abort(why) {
      if (controller.signal.aborted) return;
      scope.reason = why;
      controller.abort(new Error(why));
    },
    arrived() {
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
    release() {
      if (timer) clearTimeout(timer);
      timer = undefined;
      outer?.removeEventListener("abort", onOuter);
      if (!controller.signal.aborted) controller.abort();
    },
  };
  if (outer?.aborted) controller.abort(outer.reason);
  else outer?.addEventListener("abort", onOuter, { once: true });
  timer = setTimeout(() => scope.abort(`no response from openrouter within ${Math.round(timeoutMs / 1000)}s, retries and the waits between them included, so the request was abandoned`), timeoutMs);
  timer.unref?.();
  return scope;
}

/** A positive finite number, or undefined: a configured 0 or a nonsense value must not switch a bound off. */
function positive(n: unknown): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

/** One line for whatever a fetch threw, since a DOMException's `message` is often the whole of it. */
function reason(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  const cause = (err as { cause?: unknown } | null)?.cause;
  const under = cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
  return under && !text.includes(under) ? `${text}: ${under}` : text;
}

/**
 * Posts the request, waiting and trying again on a transient refusal. The last refusal is returned as is.
 * Every attempt shares the one scope, so the deadline covers the retries and their waits rather than starting
 * again with each: three tries that each wait a minute is three minutes of somebody's evening, and the point
 * of a bound is that adding attempts cannot buy more of it.
 */
/** The longest this adapter waits between tries without the page being told. Longer waits are the harness's. */
const SILENT_WAIT_MS = 10_000;

async function post(url: string, headers: Record<string, string>, body: string, retries: number, scope: RequestScope): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    let res: Response;
    try {
      res = await fetch(url, { method: "POST", headers, body, signal: scope.signal });
    } catch (err) {
      // No response at all: `fetch failed`, a reset or a refused connection before any header. Nothing of the
      // reply exists yet, so this is a refusal like any other and waits the same way. An abort is not: it is
      // the caller or the deadline, and either one has already decided.
      if (scope.signal.aborted || attempt >= retries) throw err;
      const wait = backoffMs(attempt);
      process.stderr.write(`[provider-openrouter] no response on attempt ${attempt + 1} (${reason(err)}); retrying in ${Math.round(wait / 1000)}s\n`);
      await sleep(wait, scope.signal);
      continue;
    }
    if (res.ok || attempt >= retries) return res;
    const text = await res.clone().text();
    const wait = retryAfterMs(res.status, text, res.headers.get("retry-after"), attempt);
    // A wait long enough for a person to wonder is not spent here, where nothing on the page can show it: the
    // refusal goes back labelled with the wait it asked for, and the harness waits it out in a row that says so.
    if (wait === undefined || wait > SILENT_WAIT_MS) return res;
    process.stderr.write(`[provider-openrouter] ${res.status} on attempt ${attempt + 1}; retrying in ${Math.round(wait / 1000)}s\n`);
    await sleep(wait, scope.signal);
  }
}

/** Waits, or stops waiting the moment the request is abandoned. The next fetch then refuses at once. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((done) => {
    if (signal.aborted) return done();
    const timer = setTimeout(finish, ms);
    timer.unref?.();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      done();
    }
    signal.addEventListener("abort", finish, { once: true });
  });
}

async function toWire(call: ProviderCall, context?: ProviderContext, accepts: (mediaType: string) => boolean = () => true): Promise<WireMessage[]> {
  const out: WireMessage[] = [];
  if (call.system) out.push({ role: "system", content: call.system });
  // Media from tool results waits until the run of tool messages ends: an assistant's tool calls must be
  // answered by tool messages with nothing between them, so the user message that carries the media goes after.
  let pending: OpenAiContentPart[] = [];
  const flush = () => {
    if (pending.length) out.push({ role: "user", content: pending });
    pending = [];
  };
  for (const m of call.messages) {
    if (m.role === "tool") {
      const { text, media } = await wireToolResult(m, context, accepts);
      out.push({ role: "tool", content: text, tool_call_id: m.toolCallId, name: m.name });
      pending.push(...media);
      continue;
    }
    flush();
    out.push(await messageToWire(m, context));
  }
  flush();
  return out;
}

async function messageToWire(m: Message, context?: ProviderContext): Promise<WireMessage> {
  const content = await wireContent(m, context);
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: content || null,
      tool_calls: m.toolCalls.map((tc: ToolCall) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
    };
  }
  if (m.role === "tool") return { role: "tool", content, tool_call_id: m.toolCallId, name: m.name };
  return { role: m.role, content };
}

function carriesMedia(call: ProviderCall): boolean {
  return call.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type !== "text"));
}

/** Whether a model with these input modalities takes this media type. Unknown modalities take everything. */
export function accepts(modalities: string[] | undefined, mediaType: string): boolean {
  if (!modalities) return true;
  const kind = mediaType === "application/pdf" ? "file" : mediaType.split("/")[0];
  return modalities.includes(kind);
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  let value: unknown;
  try { value = JSON.parse(raw); }
  catch { throw new Error("OpenRouter tool arguments must be valid JSON"); }
  return parseSchema(ToolArgumentsSchema, value, "OpenRouter tool arguments");
}

/** `touch` is called on every read that returned bytes: it is what tells the stream watchdog the line is alive. */
async function* sse(body: ReadableStream<Uint8Array>, touch: () => void): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    touch();
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
  // SSE ends every line with a newline, but a last `finish_reason` or `[DONE]` sent without one must not be
  // read as the stream being cut under the reply.
  buf += decoder.decode();
  const last = buf.replace(/\r$/, "");
  if (last.startsWith("data:")) yield last.slice(5).trim();
}
