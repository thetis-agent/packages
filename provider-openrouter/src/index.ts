import { wireContent } from "./content.js";
import { parseSchema } from "@thetis/runtime/lib/validation";
import { ToolCallSchema } from "@thetis/runtime/schemas";
import { ModelsResponseSchema, ProviderErrorSchema, StreamChunkSchema, ToolArgumentsSchema } from "./schemas.js";
// OpenRouter provider: OpenAI-compatible chat completions with SSE streaming and tool calls.
// Prompt caching is applied at the wire. The policy comes from this package's own `cache` config; a
// `cache` hint on the call may tune it within the configured `hints` mode.
import type { Message, ModelDescriptor, Provider, ProviderCall, ProviderContext, ProviderEvent, ToolCall } from "@thetis/runtime/contracts";
import { applyHint, applyOpenAiCompatible, normalizeUsage, readHint, resolvePolicy, type CacheConfig, type OpenAiWireMessage } from "@thetis/prompt-cache";

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
const TRANSIENT = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const MAX_WAIT_MS = 120_000;

/**
 * The wait before retrying a refused request, or undefined when the refusal is final. OpenRouter answers
 * 402 both for an empty account (final) and for an in-flight budget that the settling of other requests
 * frees (transient); the body says which. A Retry-After header wins over the backoff.
 */
export function retryAfterMs(status: number, body: string, retryAfter: string | null, attempt: number): number | undefined {
  const inFlight = status === 402 && /in_flight_budget/.test(body);
  if (!inFlight && !TRANSIENT.has(status)) return undefined;
  const header = Number(retryAfter);
  if (retryAfter && Number.isFinite(header) && header > 0) return Math.min(header * 1000, MAX_WAIT_MS);
  const hinted = /"Retry-After"\s*:\s*"?(\d+)/.exec(body);
  if (hinted) return Math.min(Number(hinted[1]) * 1000, MAX_WAIT_MS);
  return Math.min(1000 * 2 ** attempt, MAX_WAIT_MS);
}

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

  return {
    async models(): Promise<ModelDescriptor[]> {
      // The model list is asked for on the path of every call that has to resolve a model, and it is cached
      // for five minutes on the kernel side. An unbounded one would wedge every call behind it.
      const res = await fetch(`${baseUrl}/models`, { headers, signal: AbortSignal.timeout(requestTimeoutMs) });
      if (!res.ok) throw new Error(`openrouter /models failed: ${res.status} ${await res.text()}`);
      const body = parseSchema(ModelsResponseSchema, await res.json(), "OpenRouter models");
      return body.data.map((m) => ({ id: m.id, name: m.name }));
    },

    async *call(call: ProviderCall, signal?: AbortSignal, context?: ProviderContext): AsyncIterable<ProviderEvent> {
      if (!apiKey) return yield { type: "error", message: "OpenRouter apiKey is not configured (set OPENROUTER_API_KEY)" };
      let messages: WireMessage[];
      try { messages = await toWire(call, context); }
      catch (error) { return yield { type: "error", message: reason(error) }; }
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
      const request = requestScope(signal, requestTimeoutMs);
      let beat: ReturnType<typeof setInterval> | undefined;
      try {
        let res: Response;
        try {
          res = await post(`${baseUrl}/chat/completions`, headers, serialized, config.retries ?? 3, request);
        } catch (err) {
          if (signal?.aborted) return; // the caller gave up; it is not waiting for an explanation
          return yield { type: "error", message: request.reason ?? `openrouter request failed: ${reason(err)}` };
        }
        if (!res.ok || !res.body) return yield { type: "error", message: refusal(res.status, await res.text()) };
        request.arrived();
        let lastByte = Date.now();
        beat = setInterval(() => {
          if (Date.now() - lastByte >= streamStallMs) request.abort(`the openrouter stream was open but sent nothing for ${Math.round(streamStallMs / 1000)}s, so it was abandoned`);
        }, Math.max(250, Math.min(5_000, Math.floor(streamStallMs / 4))));
        beat.unref?.();

        const pending = new Map<number, { id: string; name: string; args: string }>();
        let finish: string | undefined;
        const lines: AsyncIterable<string> = sse(res.body, () => (lastByte = Date.now()));
        const reading = lines[Symbol.asyncIterator]();
        for (;;) {
          let step: IteratorResult<string>;
          try {
            step = await reading.next();
          } catch (err) {
            if (signal?.aborted) return;
            return yield { type: "error", message: request.reason ?? `the openrouter stream failed: ${reason(err)}` };
          }
          if (step.done) break;
          const data = step.value;
          if (data === "[DONE]") break;
          let chunk;
          try {
            chunk = parseSchema(StreamChunkSchema, JSON.parse(data), "OpenRouter stream");
          } catch (error) {
            return yield { type: "error", message: `OpenRouter stream: ${reason(error)}` };
          }
          if (chunk.error) return yield { type: "error", message: chunk.error.message ?? JSON.stringify(chunk.error) };
          if (typeof chunk.choices?.[0]?.finish_reason === "string") finish = chunk.choices[0].finish_reason;
          const delta = chunk.choices?.[0]?.delta;
          if (typeof delta?.content === "string") yield { type: "text", delta: delta.content };
          else if (delta?.content != null) return yield { type: "error", message: "OpenRouter returned an unsupported content delta" };
          if (delta?.images || delta?.audio) return yield { type: "error", message: "This OpenRouter adapter does not yet decode generated image or audio streams" };
          // A reasoning model sends its thinking beside the answer, and two spellings are in the wild:
          // `reasoning`, which is OpenRouter's normalization, and `reasoning_content`, which is what DeepSeek
          // and llama.cpp emit and OpenRouter passes through for some upstreams. Take whichever came. It is
          // yielded as its own kind and never folded into the text: the thinking is not the reply.
          const thought = delta?.reasoning ?? delta?.reasoning_content;
          if (thought) yield { type: "reasoning", delta: thought };
          for (const tc of delta?.tool_calls ?? []) {
            const slot = pending.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
            if (tc.id) slot.id = tc.id;
            if (tc.function?.name) slot.name += tc.function.name;
            if (tc.function?.arguments) slot.args += tc.function.arguments;
            pending.set(tc.index ?? 0, slot);
          }
          if (chunk.usage) yield { type: "usage", usage: normalizeUsage(chunk.usage) };
        }
        // A reply cut off at the output limit is not an answer: its tool call arguments are half a JSON document,
        // and reasoning may have used the whole allowance with nothing said. Say so instead of ending quietly.
        const cut = stopMessage(finish, body.max_tokens);
        if (cut) return yield { type: "error", message: cut };
        let calls: ToolCall[];
        try {
          calls = [...pending.entries()].sort((a, b) => a[0] - b[0]).map(([i, slot]) =>
            parseSchema(ToolCallSchema, { id: slot.id || `call_${i}`, name: slot.name, args: parseArgs(slot.args) }, "OpenRouter tool call"));
        } catch (error) { return yield { type: "error", message: reason(error) }; }
        for (const toolCall of calls) yield { type: "tool_call", call: toolCall };
      } finally {
        // Reached on a return, on a throw, and on the consumer abandoning the iteration, which is the case
        // that matters: an abandoned request must not leave its socket and its two timers behind.
        if (beat) clearInterval(beat);
        request.release();
      }
    },
  };
}

/** Why a reply ended early, when the reason is one the caller should act on; undefined for a normal stop. */
export function stopMessage(finish: string | undefined, maxTokens: unknown): string | undefined {
  if (finish === "length") return `the reply stopped at the output limit${typeof maxTokens === "number" ? ` of ${maxTokens} tokens (max_tokens)` : ""}; reasoning counts against it, so raise defaults.max_tokens or ask for less at once`;
  if (finish === "content_filter") return "the provider's content filter stopped the reply";
  return undefined;
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
async function post(url: string, headers: Record<string, string>, body: string, retries: number, scope: RequestScope): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body, signal: scope.signal });
    if (res.ok || attempt >= retries) return res;
    const text = await res.clone().text();
    const wait = retryAfterMs(res.status, text, res.headers.get("retry-after"), attempt);
    if (wait === undefined) return res;
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

async function toWire(call: ProviderCall, context?: ProviderContext): Promise<WireMessage[]> {
  const out: WireMessage[] = [];
  if (call.system) out.push({ role: "system", content: call.system });
  for (const m of call.messages) out.push(await messageToWire(m, context));
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
}
