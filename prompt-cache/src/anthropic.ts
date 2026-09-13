// Wire adapter for the native Anthropic Messages API body, for a provider that talks to Anthropic
// (or Bedrock, Vertex, Foundry) directly. The same plan as the OpenAI-compatible adapter, applied to
// `system` blocks and message content blocks. A user message made only of tool_result blocks is a
// tool position for the lookback arithmetic.

import type { CachePolicy } from "./policy.js";
import { cacheControl } from "./openai.js";
import { planBreakpoints, type Slot } from "./plan.js";

export interface AnthropicBlock {
  type: string;
  text?: string;
  cache_control?: { type: "ephemeral"; ttl?: "1h" };
  [key: string]: unknown;
}

export interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicBlock[];
}

export interface AnthropicBody {
  system?: string | AnthropicBlock[];
  messages: AnthropicMessage[];
  [key: string]: unknown;
}

/** Applies the policy to a Messages API body in place. Returns the number of breakpoints written. */
export function applyAnthropicMessages(body: AnthropicBody, policy: CachePolicy | undefined): number {
  if (!policy || policy.strategy !== "breakpoints") return 0;
  const hasSystem = hasContent(body.system);
  const slots: Slot[] = body.messages.map((m) => ({ role: roleOf(m), markable: hasContent(m.content) }));
  const plan = planBreakpoints(slots, { hasSystem, anchorStride: policy.anchorStride, max: policy.maxBreakpoints });

  let written = 0;
  if (plan.system) {
    body.system = markBlocks(body.system as string | AnthropicBlock[], policy.systemTtl);
    written++;
  }
  for (const i of plan.messages) {
    body.messages[i].content = markBlocks(body.messages[i].content, policy.ttl);
    written++;
  }
  return written;
}

function roleOf(m: AnthropicMessage): string {
  if (m.role === "user" && Array.isArray(m.content) && m.content.length > 0 && m.content.every((b) => b.type === "tool_result")) return "tool";
  return m.role;
}

function hasContent(c: string | AnthropicBlock[] | undefined): boolean {
  if (typeof c === "string") return c.trim().length > 0;
  if (!Array.isArray(c) || c.length === 0) return false;
  const last = c[c.length - 1];
  return last.type !== "text" || String(last.text ?? "").trim().length > 0;
}

function markBlocks(c: string | AnthropicBlock[], ttl: CachePolicy["ttl"]): AnthropicBlock[] {
  const control = cacheControl(ttl);
  if (typeof c === "string") return [{ type: "text", text: c, cache_control: control }];
  const blocks = [...c];
  blocks[blocks.length - 1] = { ...blocks[blocks.length - 1], cache_control: control };
  return blocks;
}
