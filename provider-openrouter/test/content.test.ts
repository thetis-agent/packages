import { test } from "node:test";
import assert from "node:assert/strict";
import { assetPart, textPart } from "@thetis/runtime/lib/content";
import type { AssetRef, ProviderContext } from "@thetis/runtime/contracts";
import { wireContent, wireToolResult } from "../src/content.js";
import { accepts, createProvider, mediaGate } from "../src/index.js";
import { createServer } from "node:http";

const asset: AssetRef = { id: "a", size: 3, mediaType: "image/png", name: "picture.png" };
const context: ProviderContext = { assets: { read: async () => ({ asset, data: "AAEC" }), put: async () => asset } };

test("the adapter translates ordered text and image assets without mutating the conversation", async () => {
  const message = { role: "user" as const, content: [textPart("look"), assetPart(asset.id, asset.mediaType)] };
  const before = structuredClone(message);
  assert.deepEqual(await wireContent(message, context), [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } }]);
  assert.deepEqual(message, before);
  assert.equal(await wireContent({ role: "assistant", content: [textPart("one"), textPart("two")] }), "onetwo");
});

test("audio and PDF translation use asset metadata and explicit transport formats", async () => {
  for (const [mediaType, expected] of [
    ["audio/mpeg", { type: "input_audio", input_audio: { data: "AAEC", format: "mp3" } }],
    ["application/pdf", { type: "file", file: { filename: "file.pdf", file_data: "data:application/pdf;base64,AAEC" } }],
  ] as const) {
    const assets = { ...context.assets, read: async () => ({ asset: { ...asset, mediaType, name: "file.pdf" }, data: "AAEC" }) };
    assert.deepEqual(await wireContent({ role: "user", content: [assetPart("a", mediaType)] }, { assets }), [expected]);
  }
});

test("unsupported content produces an explicit provider error before a network request", async () => {
  const call = { model: "model", messages: [{ role: "user" as const, content: [{ type: "@example/mesh", data: null }] }], tools: [], params: {} };
  const events = [];
  for await (const event of createProvider({ apiKey: "test", baseUrl: "http://must-not-be-called.invalid" }).call(call)) events.push(event);
  assert.deepEqual(events, [{ type: "error", message: "OpenRouter does not support content type @example/mesh", retryable: false, kind: "other" }]);
  await assert.rejects(wireContent({ role: "user", content: [assetPart("a", "audio/wav")] }, context), /different media type/);
  await assert.rejects(wireContent({ role: "tool", content: [assetPart("a", "image/png")] }, context), /role tool/);
});

test("a tool result's image goes in a user message after the run of tool messages, text stays in the tool message", async () => {
  let posted: { messages: { role: string; content: unknown; tool_call_id?: string }[] } | undefined;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url?.endsWith("/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ data: [{ id: "sees", architecture: { input_modalities: ["text", "image"] } }, { id: "blind", architecture: { input_modalities: ["text"] } }] }));
    }
    posted = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    const messages = [
      { role: "user" as const, content: [textPart("look at the page")] },
      { role: "assistant" as const, content: [], toolCalls: [{ id: "c1", name: "browser_screenshot", args: {} }, { id: "c2", name: "browser_status", args: {} }] },
      { role: "tool" as const, toolCallId: "c1", name: "browser_screenshot", content: [textPart("path: browser/x.png"), assetPart("a", "image/png", "x.png")] },
      { role: "tool" as const, toolCallId: "c2", name: "browser_status", content: [textPart("fine")] },
      { role: "assistant" as const, content: [textPart("I see it")] },
    ];
    const run = async (model: string) => { for await (const _ of provider.call({ model, messages, tools: [], params: {} }, undefined, context)) void _; return posted!; };

    const seen = await run("sees");
    assert.deepEqual(seen.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "user", "assistant"]);
    assert.equal(seen.messages[2].content, "path: browser/x.png\n[x.png: attached in the next message]");
    assert.equal(seen.messages[2].tool_call_id, "c1");
    assert.equal(seen.messages[3].content, "fine");
    assert.deepEqual(seen.messages[4].content, [
      { type: "text", text: "[x.png, returned by browser_screenshot (c1)]" },
      { type: "image_url", image_url: { url: "data:image/png;base64,AAEC" } },
    ]);

    const blind = await run("blind");
    assert.deepEqual(blind.messages.map((m) => m.role), ["user", "assistant", "tool", "tool", "assistant"]);
    assert.equal(blind.messages[2].content, "path: browser/x.png\n[x.png: not shown, this model does not take image input]");
    assert.deepEqual(messages[2].content, [textPart("path: browser/x.png"), assetPart("a", "image/png", "x.png")]);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a tool result whose media cannot be read says so in its text instead of failing the call", async () => {
  const broken: ProviderContext = { assets: { ...context.assets, read: async () => { throw new Error("asset is gone"); } } };
  const out = await wireToolResult({ role: "tool", toolCallId: "c", content: [textPart("t"), assetPart("a", "image/png", "p.png")] }, broken);
  assert.deepEqual(out, { text: "t\n[p.png: could not be sent: asset is gone]", media: [] });
  assert.deepEqual(await wireToolResult({ role: "tool", toolCallId: "c", content: [textPart("only text")] }, context), { text: "only text", media: [] });
});

test("modalities: unknown takes everything, pdf is a file, audio and image by kind", () => {
  assert.equal(accepts(undefined, "image/png"), true);
  assert.equal(accepts(["text", "image"], "image/jpeg"), true);
  assert.equal(accepts(["text"], "image/jpeg"), false);
  assert.equal(accepts(["text", "file"], "application/pdf"), true);
  assert.equal(accepts(["text", "image"], "audio/mpeg"), false);
});

test("past maxImages the oldest images are left out in steps of half the limit, each leaving a line, so the ones sent stay put", () => {
  const shots = (n: number) => ({ model: "m", tools: [], params: {}, messages: Array.from({ length: n }, (_, i) => ({ role: "tool" as const, toolCallId: `c${i}`, content: [textPart("shot"), assetPart(`a${i}`, "image/jpeg", `s${i}.jpg`)] })) });
  const leftOut = (n: number, max = 20, takes = (_: string) => true) => {
    const gate = mediaGate(shots(n), max, takes);
    return Array.from({ length: n }, () => gate("image/jpeg")).filter((note) => note !== undefined).length;
  };
  assert.equal(leftOut(20), 0);
  assert.equal(leftOut(21), 10);
  assert.equal(leftOut(30), 10);
  assert.equal(leftOut(31), 20);
  assert.equal(leftOut(5, 1), 4);
  // a model that takes no images is not sent them anyway, so they do not count against the budget
  const blind = mediaGate(shots(25), 20, () => false);
  assert.match(blind("image/jpeg") ?? "", /does not take image input/);
  const gate = mediaGate(shots(21), 20, () => true);
  assert.match(gate("image/jpeg") ?? "", /an earlier image, no longer attached: a request carries at most 20 images/);
  // audio and PDFs are not images and pass
  assert.equal(mediaGate(shots(40), 20, () => true)("application/pdf"), undefined);
});

test("a chat with 21 screenshots sends the latest 11 and a line for each earlier one, from users and tools alike", async () => {
  let posted: { messages: { role: string; content: unknown }[] } | undefined;
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url?.endsWith("/models")) { res.writeHead(200, { "Content-Type": "application/json" }); return res.end(JSON.stringify({ data: [] })); }
    posted = JSON.parse(Buffer.concat(chunks).toString());
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.end('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const provider = createProvider({ apiKey: "k", baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}` });
    const messages = [{ role: "user" as const, content: [textPart("look"), assetPart("a", "image/png", "upload.png")] }];
    for (let i = 1; i < 21; i++) {
      messages.push({ role: "assistant" as const, content: [], toolCalls: [{ id: `c${i}`, name: "browser_screenshot", args: {} }] } as never);
      messages.push({ role: "tool" as const, toolCallId: `c${i}`, name: "browser_screenshot", content: [textPart(`shot ${i}`), assetPart("a", "image/png", `s${i}.png`)] } as never);
    }
    for await (const _ of provider.call({ model: "m", messages, tools: [], params: {} }, undefined, context)) void _;
    const images = posted!.messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((p: { type: string }) => p.type === "image_url");
    assert.equal(images.length, 11);
    assert.deepEqual(posted!.messages[0].content, [{ type: "text", text: "look" }, { type: "text", text: "[upload.png: an earlier image, no longer attached: a request carries at most 20 images, the latest ones]" }]);
    const tools = posted!.messages.filter((m) => m.role === "tool").map((m) => m.content as string);
    assert.equal(tools[8], "shot 9\n[s9.png: an earlier image, no longer attached: a request carries at most 20 images, the latest ones]");
    assert.equal(tools[9], "shot 10\n[s10.png: attached in the next message]");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
