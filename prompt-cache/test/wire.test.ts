import { test } from "node:test";
import assert from "node:assert/strict";
import { applyOpenAiCompatible, mark, type OpenAiWireMessage } from "../src/openai.js";
import { applyAnthropicMessages, type AnthropicBody } from "../src/anthropic.js";
import { resolvePolicy } from "../src/policy.js";

const anthropic = resolvePolicy({}, "anthropic/claude-sonnet-5");
const body = (roles: string[]) => ({ messages: roles.map((role) => ({ role, content: `${role} content` })) as OpenAiWireMessage[] });
const marked = (messages: OpenAiWireMessage[]) => messages.map((m, i) => (Array.isArray(m.content) && m.content.some((p) => p.cache_control) ? i : -1)).filter((i) => i >= 0);

test("openai: the system prompt and the latest message carry markers", () => {
  const b = body(["system", "user", "assistant", "user"]);
  assert.equal(applyOpenAiCompatible(b, anthropic), 2);
  assert.deepEqual(marked(b.messages), [0, 3]);
  assert.deepEqual(b.messages[0].content, [{ type: "text", text: "system content", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  assert.deepEqual(b.messages[3].content, [{ type: "text", text: "user content", cache_control: { type: "ephemeral" } }]);
  assert.equal(typeof b.messages[1].content, "string", "unmarked messages keep their bytes");
});

test("openai: automatic and off strategies leave the body alone", () => {
  for (const model of ["openai/gpt-5", "google/gemini-3-pro"]) {
    const b = body(["system", "user"]);
    assert.equal(applyOpenAiCompatible(b, resolvePolicy({}, model)), 0, model);
    assert.equal(typeof b.messages[0].content, "string");
  }
  assert.equal(applyOpenAiCompatible(body(["system", "user"]), undefined), 0);
  assert.equal(applyOpenAiCompatible(body(["system", "user"]), resolvePolicy({ enabled: false }, "anthropic/x")), 0);
});

test("openai: at most four markers in a long tool-heavy conversation", () => {
  const roles = ["system", ...Array(30).fill(["assistant", "tool", "tool"]).flat()];
  const b = body(roles);
  assert.ok(applyOpenAiCompatible(b, anthropic) <= 4);
  assert.ok(marked(b.messages).length <= 4);
  assert.equal(marked(b.messages).at(-1), roles.length - 1, "the last tool result writes the newest prefix");
});

test("openai: a tool-calling assistant message without text is skipped, not broken", () => {
  const b = { messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }, { role: "assistant", content: null, tool_calls: [{ id: "1" }] }] as OpenAiWireMessage[] };
  assert.equal(applyOpenAiCompatible(b, anthropic), 2);
  assert.equal(b.messages[2].content, null);
  assert.deepEqual(marked(b.messages), [0, 1]);
});

test("openai: multi-part content is marked on its last part", () => {
  const m: OpenAiWireMessage = { role: "user", content: [{ type: "text", text: "what is this" }, { type: "image_url", image_url: { url: "data:x" } }] };
  assert.ok(mark(m, "5m"));
  const parts = m.content as { cache_control?: unknown }[];
  assert.equal(parts[0].cache_control, undefined);
  assert.deepEqual(parts[1].cache_control, { type: "ephemeral" });
  assert.equal(mark({ role: "assistant", content: "  " }, "5m"), false);
});

test("anthropic: system blocks and message blocks carry markers; tool_result runs count once", () => {
  const b: AnthropicBody = {
    system: "big prompt",
    messages: [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "looking" }, { type: "tool_use", id: "1", name: "x", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "1", content: "ok" }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "2", content: "ok" }] },
    ],
  };
  assert.equal(applyAnthropicMessages(b, anthropic), 2);
  assert.deepEqual(b.system, [{ type: "text", text: "big prompt", cache_control: { type: "ephemeral", ttl: "1h" } }]);
  const last = (b.messages[3].content as { cache_control?: unknown }[])[0];
  assert.deepEqual(last.cache_control, { type: "ephemeral" });
  assert.equal(typeof b.messages[0].content, "string");
});
