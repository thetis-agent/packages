// OpenRouter provider: OpenAI-compatible chat completions with SSE streaming and tool calls.
// Prompt caching is applied at the wire. The policy comes from this package's own `cache` config; a
// `cache` hint on the call may tune it within the configured `hints` mode.
import type { Message, ModelDescriptor, Provider, ProviderCall, ProviderEvent, ToolCall } from "@thetis/contracts";
import { applyHint, applyOpenAiCompatible, normalizeUsage, readHint, resolvePolicy, type CacheConfig, type OpenAiWireMessage } from "@thetis/prompt-cache";

export interface OpenRouterConfig {
  apiKey?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  /** Request fields sent with every call, under `call.params`. For example `provider: { order: ["anthropic"] }`. */
  defaults?: Record<string, unknown>;
  /** Prompt caching policy. See docs/16-prompt-cache.md. */
  cache?: CacheConfig;
  /** How many times a refused request is retried when the refusal is transient (rate limit, in-flight budget, server error). Default 3. */
  retries?: number;
}

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
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "HTTP-Referer": "https://github.com/thetis",
    "X-Title": "Thetis",
    ...(config.headers ?? {}),
  };

  return {
    async models(): Promise<ModelDescriptor[]> {
      const res = await fetch(`${baseUrl}/models`, { headers });
      if (!res.ok) throw new Error(`openrouter /models failed: ${res.status} ${await res.text()}`);
      const body = (await res.json()) as { data: { id: string; name?: string }[] };
      return body.data.map((m) => ({ id: m.id, name: m.name }));
    },

    async *call(call: ProviderCall): AsyncIterable<ProviderEvent> {
      if (!apiKey) return yield { type: "error", message: "OpenRouter apiKey is not configured (set OPENROUTER_API_KEY)" };
      const body = {
        model: call.model,
        messages: toWire(call),
        tools: call.tools.length ? call.tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })) : undefined,
        stream: true,
        usage: { include: true },
        ...(config.defaults ?? {}),
        ...call.params,
      } as Record<string, unknown> & { messages: WireMessage[] };
      const policy = applyHint(resolvePolicy(cacheConfig, call.model), readHint(call.hints?.cache), cacheConfig.hints);
      applyOpenAiCompatible(body, policy);
      if (policy.affinity && cacheConfig.affinity !== false && body.user === undefined) body.user = policy.affinity;
      const res = await post(`${baseUrl}/chat/completions`, headers, JSON.stringify(body), config.retries ?? 3);
      if (!res.ok || !res.body) return yield { type: "error", message: refusal(res.status, await res.text()) };
      const pending = new Map<number, { id: string; name: string; args: string }>();
      for await (const data of sse(res.body)) {
        if (data === "[DONE]") break;
        let chunk: any;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) return yield { type: "error", message: chunk.error.message ?? JSON.stringify(chunk.error) };
        const delta = chunk.choices?.[0]?.delta;
        if (delta?.content) yield { type: "text", delta: String(delta.content) };
        for (const tc of delta?.tool_calls ?? []) {
          const slot = pending.get(tc.index ?? 0) ?? { id: "", name: "", args: "" };
          if (tc.id) slot.id = tc.id;
          if (tc.function?.name) slot.name += tc.function.name;
          if (tc.function?.arguments) slot.args += tc.function.arguments;
          pending.set(tc.index ?? 0, slot);
        }
        if (chunk.usage) yield { type: "usage", usage: normalizeUsage(chunk.usage) };
      }
      for (const [i, slot] of [...pending.entries()].sort((a, b) => a[0] - b[0])) {
        yield { type: "tool_call", call: { id: slot.id || `call_${i}`, name: slot.name, args: parseArgs(slot.args) } };
      }
    },
  };
}

/** One sentence for a refused request: OpenRouter's own message and reason when the body is its JSON, else the raw text. */
export function refusal(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as { error?: { message?: string; metadata?: { reason?: string } } };
    const message = parsed.error?.message;
    if (message) return `openrouter ${status}: ${message}${parsed.error?.metadata?.reason ? ` (${parsed.error.metadata.reason})` : ""}`;
  } catch {
    // not JSON: fall through to the raw text
  }
  return `openrouter ${status}: ${body.slice(0, 500)}`;
}

/** Posts the request, waiting and trying again on a transient refusal. The last refusal is returned as is. */
async function post(url: string, headers: Record<string, string>, body: string, retries: number): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: "POST", headers, body });
    if (res.ok || attempt >= retries) return res;
    const text = await res.clone().text();
    const wait = retryAfterMs(res.status, text, res.headers.get("retry-after"), attempt);
    if (wait === undefined) return res;
    process.stderr.write(`[provider-openrouter] ${res.status} on attempt ${attempt + 1}; retrying in ${Math.round(wait / 1000)}s\n`);
    await new Promise((r) => setTimeout(r, wait));
  }
}

function toWire(call: ProviderCall): WireMessage[] {
  const out: WireMessage[] = [];
  if (call.system) out.push({ role: "system", content: call.system });
  for (const m of call.messages) out.push(messageToWire(m));
  return out;
}

function messageToWire(m: Message): WireMessage {
  if (m.role === "assistant" && m.toolCalls?.length) {
    return {
      role: "assistant",
      content: m.content || null,
      tool_calls: m.toolCalls.map((tc: ToolCall) => ({ id: tc.id, type: "function", function: { name: tc.name, arguments: JSON.stringify(tc.args) } })),
    };
  }
  if (m.role === "tool") return { role: "tool", content: m.content, tool_call_id: m.toolCallId, name: m.name };
  return { role: m.role, content: m.content };
}

function parseArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) return {};
  try {
    const v = JSON.parse(raw);
    return v && typeof v === "object" ? v : { value: v };
  } catch {
    return { _raw: raw };
  }
}

async function* sse(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).replace(/\r$/, "");
      buf = buf.slice(nl + 1);
      if (line.startsWith("data:")) yield line.slice(5).trim();
    }
  }
}
