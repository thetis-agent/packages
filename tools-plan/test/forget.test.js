// The forget hook: a conversation's plan and recorded questions go, other conversations' stay, and a
// second forget finds nothing to report.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { forgetSession } from "../index.js";
import { todoWrite } from "../lib/todo-tools.js";
import { askUser } from "../lib/ask-user.js";
import { planPath, questionsPath } from "../lib/store.js";

const ask = { questions: [{ question: "Which one?", options: ["a", "b"] }] };

test("preview answers nothing and removes nothing", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tp-forget-"));
  await todoWrite({ items: ["a"] }, { cwd: home, session: { id: "s_a" } });
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_a", sessions: ["s_a"] }, { cwd: home }), {});
  assert.ok(existsSync(planPath(home, "s_a")));
  await rm(home, { recursive: true, force: true });
});

test("forget removes the plan and the questions of every id in the subtree, and nothing of another conversation", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tp-forget-"));
  await todoWrite({ items: ["a"] }, { cwd: home, session: { id: "s_a" } });
  await askUser(ask, { cwd: home, session: { id: "s_a" } });
  await todoWrite({ items: ["b"] }, { cwd: home, session: { id: "s_child" } });
  await todoWrite({ items: ["c"] }, { cwd: home, session: { id: "s_keep" } });
  const out = await forgetSession({ phase: "forget", session: "s_a", sessions: ["s_a", "s_child"] }, { cwd: home });
  assert.deepEqual(out, { removed: ["The plan of 2 conversations.", "The questions asked in 1 conversation."] });
  assert.ok(!existsSync(planPath(home, "s_a")));
  assert.ok(!existsSync(questionsPath(home, "s_a")));
  assert.ok(!existsSync(planPath(home, "s_child")));
  assert.ok(existsSync(planPath(home, "s_keep")));
  await rm(home, { recursive: true, force: true });
});

test("forget is idempotent: a second run and an empty home report nothing", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tp-forget-"));
  await todoWrite({ items: ["a"] }, { cwd: home, session: { id: "s_a" } });
  const args = { phase: "forget", session: "s_a", sessions: ["s_a"] };
  assert.equal((await forgetSession(args, { cwd: home })).removed.length, 1);
  assert.deepEqual(await forgetSession(args, { cwd: home }), { removed: [] });
  await rm(home, { recursive: true, force: true });
  assert.deepEqual(await forgetSession(args, { cwd: home }), { removed: [] });
});
