import { test } from "node:test";
import assert from "node:assert/strict";
import { assetPart, textPart } from "@thetis/runtime/lib/content";
import type { AssetRef, ProviderContext } from "@thetis/runtime/contracts";
import { wireContent } from "../src/content.js";
import { createProvider } from "../src/index.js";

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
  assert.deepEqual(events, [{ type: "error", message: "OpenRouter does not support content type @example/mesh" }]);
  await assert.rejects(wireContent({ role: "user", content: [assetPart("a", "audio/wav")] }, context), /different media type/);
  await assert.rejects(wireContent({ role: "tool", content: [assetPart("a", "image/png")] }, context), /role tool/);
});
