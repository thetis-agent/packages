// Wire adapter for OpenAI-compatible chat completion bodies, which is what OpenRouter takes.
//
// A marker is `cache_control` on the last content part of a message. A string content becomes one
// text part carrying the marker. OpenRouter forwards markers on system, user, assistant and tool
// messages to Anthropic; markers on tool definitions are not forwarded, so none are written there.

import type { CachePolicy, CacheTtl } from "./policy.js";
import { planBreakpoints, type Slot } from "./plan.js";

export interface OpenAiContentPart {
  type: string;
  text?: string;
  cache_control?: CacheControl;
  [key: string]: unknown;
}

export interface OpenAiWireMessage {
  role: string;
  content: string | OpenAiContentPart[] | null;
  [key: string]: unknown;
}

export interface CacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

/** Applies the policy to a body in place. Returns the number of breakpoints written. */
export function applyOpenAiCompatible(body: { messages: OpenAiWireMessage[] }, policy: CachePolicy | undefined): number {
  if (!policy || policy.strategy !== "breakpoints") return 0;
  const messages = body.messages;
  if (!Array.isArray(messages) || messages.length === 0) return 0;

  const hasSystem = messages[0].role === "system" && markable(messages[0]);
  const offset = messages[0].role === "system" ? 1 : 0;
  const slots: Slot[] = messages.slice(offset).map((m) => ({ role: m.role, markable: markable(m) }));
  const plan = planBreakpoints(slots, { hasSystem, anchorStride: policy.anchorStride, max: policy.maxBreakpoints });

  let written = 0;
  if (plan.system && mark(messages[0], policy.systemTtl)) written++;
  for (const i of plan.messages) if (mark(messages[i + offset], policy.ttl)) written++;
  return written;
}

export function cacheControl(ttl: CacheTtl): CacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

/** True when the message has content a marker can sit on. An empty message is left alone rather than made invalid. */
export function markable(m: OpenAiWireMessage): boolean {
  const c = m.content;
  if (typeof c === "string") return c.trim().length > 0;
  if (Array.isArray(c) && c.length > 0) {
    const last = c[c.length - 1];
    return !!last && typeof last === "object" && (last.type !== "text" || String(last.text ?? "").trim().length > 0);
  }
  return false;
}

/** Attaches a marker to the last content part, converting a string content to parts first. */
export function mark(m: OpenAiWireMessage, ttl: CacheTtl): boolean {
  if (!markable(m)) return false;
  const control = cacheControl(ttl);
  if (typeof m.content === "string") {
    m.content = [{ type: "text", text: m.content, cache_control: control }];
    return true;
  }
  const parts = m.content as OpenAiContentPart[];
  parts[parts.length - 1] = { ...parts[parts.length - 1], cache_control: control };
  return true;
}
