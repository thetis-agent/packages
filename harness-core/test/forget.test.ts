import { textContent } from "@thetis/runtime/lib/content";
// The forget hook over a temporary home, and the one budget the guide is held to.
import { test, after } from "node:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { PackageStepContext } from "@thetis/runtime/contracts";
import { forgetSession, systemPrompt } from "../src/index.js";

const homes: string[] = [];
after(() => homes.forEach((h) => rmSync(h, { recursive: true, force: true })));

function home(): string {
  const h = mkdtempSync(join(tmpdir(), "thetis-forget-test-"));
  homes.push(h);
  for (const d of ["harness-core/context", "harness-core/retry", "effort"]) mkdirSync(join(h, d), { recursive: true });
  return h;
}

const put = (h: string, rel: string, text = "{}") => writeFileSync(join(h, rel), text);

test("preview answers nothing: this package never blocks a forget and offers no choice", async () => {
  const h = home();
  put(h, "harness-core/context/s_a.json");
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_a", sessions: ["s_a"] }, { cwd: h }), {});
  assert.ok(existsSync(join(h, "harness-core/context/s_a.json")), "a preview removes nothing");
});

test("forget removes the snapshot, the retry request and the effort key of every id, and leaves the rest", async () => {
  const h = home();
  put(h, "harness-core/context/s_a.json");
  put(h, "harness-core/context/s_b.json");
  put(h, "harness-core/context/s_keep.json");
  put(h, "harness-core/retry/s_b.json");
  put(h, "effort/sessions.json", JSON.stringify({ s_a: "high", s_keep: "low" }, null, 2) + "\n");
  put(h, "effort/prefs.json", JSON.stringify({ default: "high" }));
  const out = await forgetSession({ phase: "forget", session: "s_a", sessions: ["s_a", "s_b"] }, { cwd: h });
  assert.deepEqual(out, {
    removed: ["The context snapshot and usage of 2 conversations.", "1 retry request that had not been taken.", "The effort chosen for 1 conversation."],
  });
  assert.ok(!existsSync(join(h, "harness-core/context/s_a.json")));
  assert.ok(!existsSync(join(h, "harness-core/context/s_b.json")));
  assert.ok(!existsSync(join(h, "harness-core/retry/s_b.json")));
  assert.ok(existsSync(join(h, "harness-core/context/s_keep.json")));
  assert.deepEqual(JSON.parse(readFileSync(join(h, "effort/sessions.json"), "utf8")), { s_keep: "low" });
  assert.deepEqual(JSON.parse(readFileSync(join(h, "effort/prefs.json"), "utf8")), { default: "high" }, "the remembered choice is nobody's conversation");
});

test("forget is idempotent: a second run, or a home that never had anything, reports nothing removed", async () => {
  const h = home();
  put(h, "harness-core/context/s_a.json");
  const args = { phase: "forget" as const, session: "s_a", sessions: ["s_a"] };
  assert.equal((await forgetSession(args, { cwd: h }) as { removed: string[] }).removed.length, 1);
  assert.deepEqual(await forgetSession(args, { cwd: h }), { removed: [] });
  const empty = mkdtempSync(join(tmpdir(), "thetis-forget-empty-"));
  homes.push(empty);
  assert.deepEqual(await forgetSession(args, { cwd: empty }), { removed: [] });
});

test("forget ignores ids that could not be a session, rather than resolving them as paths", async () => {
  const h = home();
  put(h, "effort/sessions.json", JSON.stringify({ "../x": "high" }));
  assert.deepEqual(await forgetSession({ phase: "forget", session: "s_a", sessions: ["../x", ""] }, { cwd: h }), { removed: [] });
});

/** A top-level session's context, as the prompt step receives it. */
function promptCtx(over: Partial<PackageStepContext> = {}): PackageStepContext {
  return {
    emit: () => {},
    signal: new AbortController().signal,
    session: { id: "s_0123456789ab", user: "alice" },
    turn: { id: "t1", input: [{ role: "user", content: textContent("hi") }] },
    conversation: [{ role: "user", content: textContent("hi") }],
    call: { model: "vendor/model", messages: [], tools: [], params: {} },
    harness: {},
    config: {},
    env: { cwd: "/home/alice" },
    packages: { has: () => false, get: () => undefined, list: () => [] },
    ...over,
  } as unknown as PackageStepContext;
}

test("the guide stays within 1,400 characters, for a top-level session and for a subagent", async () => {
  const top = (await systemPrompt(promptCtx())).call?.system ?? "";
  const child = (await systemPrompt(promptCtx({ session: { id: "s_0123456789ab", user: "alice", parent: "s_parent" } }))).call?.system ?? "";
  assert.ok(top.length > 0);
  assert.ok(top.length <= 1400, `the guide is ${top.length} characters; it is policy, not a manual, and every turn pays for it`);
  assert.ok(child.length <= 1400, `the subagent guide is ${child.length} characters`);
});
