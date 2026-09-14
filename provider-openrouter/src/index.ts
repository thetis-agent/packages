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
      const res = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers, body: JSON.stringify(body) });
      if (!res.ok || !res.body) return yield { type: "error", message: `openrouter ${res.status}: ${(await res.text()).slice(0, 2000)}` };
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
