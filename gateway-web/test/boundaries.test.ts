import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import type { IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";
import { HttpError, readJson } from "../src/http.js";
import { GatewayStore } from "../src/store.js";

const request = (body: string): IncomingMessage => Readable.from([Buffer.from(body)]) as IncomingMessage;

for (const body of ["[]", "null", "42", '"text"', "true"]) {
  test(`JSON body rejects ${body} instead of treating it as an empty object`, async () => {
    await assert.rejects(readJson(request(body)), (err: unknown) => err instanceof HttpError && err.status === 400);
  });
}

test("JSON bodies retain unknown structured fields and accept an empty body", async () => {
  assert.deepEqual(await readJson(request("")), {});
  assert.deepEqual(await readJson(request('{"input":[{"type":"image","data":{"asset":"a1"}}]}')), { input: [{ type: "image", data: { asset: "a1" } }] });
});

for (const [file, value] of [
  ["sessions/alice/s1.json", { archived: "false" }],
  ["sessions/alice/s1.json", { usage: { 1: { cost: null } } }],
  ["prefs/alice.json", { model: 2 }],
] as const) {
  test(`persisted ${file} rejects malformed fields`, () => {
    const dir = mkdtempSync(join(tmpdir(), "thetis-gateway-boundary-"));
    try {
      mkdirSync(join(dir, "sessions/alice"), { recursive: true });
      mkdirSync(join(dir, "prefs"), { recursive: true });
      writeFileSync(join(dir, file), JSON.stringify(value));
      assert.throws(() => new GatewayStore(dir), /gateway.*(?:archived|usage|model)/i);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test("legacy migration validates the entire record before writing any conversation files", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-gateway-migration-"));
  try {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ titles: { "alice/s1": "keep" }, archived: { alice: "s1" } }));
    assert.throws(() => new GatewayStore(dir), /gateway.*archived/i);
    assert.equal(existsSync(join(dir, "sessions/alice/s1.json")), false);
    assert.equal(existsSync(join(dir, "state.json")), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("gateway storage preserves extension fields when saving validated records", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-gateway-extension-"));
  try {
    mkdirSync(join(dir, "sessions/alice"), { recursive: true });
    const file = join(dir, "sessions/alice/s1.json");
    writeFileSync(file, JSON.stringify({ title: "before", custom: { future: true } }));
    new GatewayStore(dir).setTitle("alice", "s1", "after");
    assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { title: "after", custom: { future: true } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("UI commands validate returned data before sending it to the browser", async () => {
  const { runCommand } = await import("../src/ui.js");
  const dir = mkdtempSync(join(tmpdir(), "thetis-ui-result-"));
  try {
    const root = join(dir, "node_modules/@test/command");
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ type: "module", main: "index.js" }));
    writeFileSync(join(root, "index.js"), "export const reply = ({ value }) => value;");
    const ctx = {
      store: dir,
      env: {} as never,
      kernel: {
        packages: { list: async () => [{ name: "@test/command", version: "1.0.0", type: "tool", root, thetis: { type: "tool", ui: { commands: [{ verb: "reply", export: "reply" }] } } }] },
        config: { effective: async () => ({}) },
      } as never,
    };
    const run = (value: unknown) => runCommand(ctx, { id: "alice", role: "user" }, "@test", "command", "reply", { args: { value } });
    for (const value of [12, null, [], { text: 12 }, { data: { value: Infinity } }]) {
      await assert.rejects(run(value), (error: unknown) => error instanceof HttpError && error.status === 502);
    }
    assert.deepEqual(await run(undefined), {});
    assert.deepEqual(await run("hello"), { text: "hello" });
    assert.deepEqual(await run({ text: "hello", data: { extension: [1, null, true] } }), { text: "hello", data: { extension: [1, null, true] } });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
