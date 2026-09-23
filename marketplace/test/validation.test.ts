import { test } from "node:test";
import assert from "node:assert/strict";
import { readIndex, type FileEnv } from "../src/index-file.js";

test("the marketplace rejects corrupt entries instead of trusting the index version", async () => {
  const env: FileEnv = {
    shared: "/shared", writeFile: async () => {},
    readFile: async () => JSON.stringify({ version: 1, updatedAt: "today", registries: [], packages: [{ name: "@thetis/tool", tools: [42] }] }),
  };
  assert.equal(await readIndex(env), undefined);
});

test("the marketplace preserves future index metadata", async () => {
  const index = { version: 1, updatedAt: "today", registries: [], packages: [], future: { channel: "stable" } };
  const env: FileEnv = { shared: "/shared", writeFile: async () => {}, readFile: async () => JSON.stringify(index) };
  assert.deepEqual(await readIndex(env), index);
});
