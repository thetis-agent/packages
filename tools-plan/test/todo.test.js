// Todo tool tests: ids keep counting across writes, the 64-item cap refuses new items
// rather than dropping old ones, and only one item can be active at a time.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { todoWrite, todoAdd, todoMark, todoOrder, todoRead } from "../lib/todo-tools.js";

async function makeEnv() {
  const home = await mkdtemp(resolve(tmpdir(), "tp-home-"));
  return { home, env: { cwd: home, session: { id: "s-1" } } };
}

test("todo_write mints t-1, t-2, ... and ids keep counting across writes", async () => {
  const { home, env } = await makeEnv();
  const out1 = await todoWrite({ items: ["first", "second"] }, env);
  assert.match(out1, /\[ \] t-1 first/);
  assert.match(out1, /\[ \] t-2 second/);

  // a second write replaces the items but must not reuse t-1/t-2
  const out2 = await todoWrite({ items: ["third"] }, env);
  assert.match(out2, /\[ \] t-3 third/);
  assert.doesNotMatch(out2, /t-1|t-2/);
  await rm(home, { recursive: true, force: true });
});

test("todo_add appends without disturbing existing ids", async () => {
  const { home, env } = await makeEnv();
  await todoWrite({ items: ["a", "b"] }, env);
  const out = await todoAdd({ items: ["c"] }, env);
  assert.match(out, /t-1 a/);
  assert.match(out, /t-2 b/);
  assert.match(out, /t-3 c/);
  await rm(home, { recursive: true, force: true });
});

test("todo_add refuses to exceed the 64-item cap, keeping old items intact", async () => {
  const { home, env } = await makeEnv();
  const sixty = Array.from({ length: 60 }, (_, i) => `item ${i}`);
  await todoWrite({ items: sixty }, env);
  await assert.rejects(
    todoAdd({ items: Array.from({ length: 10 }, (_, i) => `extra ${i}`) }, env),
    /exceed the 64-item plan cap/
  );
  const after = await todoRead({}, env);
  assert.match(after, /t-1 item 0/);
  assert.match(after, /60 pending/);
  await rm(home, { recursive: true, force: true });
});

test("only one item can be active at a time; marking a second demotes the first", async () => {
  const { home, env } = await makeEnv();
  await todoWrite({ items: ["a", "b"] }, env);
  await todoMark({ ids: ["t-1"], stage: "active" }, env);
  const out = await todoMark({ ids: ["t-2"], stage: "active" }, env);
  assert.match(out, /only one item can be active/);
  assert.match(out, /\[ \] t-1 a/); // demoted back to pending
  assert.match(out, /\[>\] t-2 b/);
  await rm(home, { recursive: true, force: true });
});

test("todo_mark rejects unknown ids", async () => {
  const { home, env } = await makeEnv();
  await todoWrite({ items: ["a"] }, env);
  await assert.rejects(todoMark({ ids: ["t-99"], stage: "done" }, env), /unknown id\(s\): t-99/);
  await rm(home, { recursive: true, force: true });
});

test("todo_order moves listed ids to the front, keeping the rest in relative order", async () => {
  const { home, env } = await makeEnv();
  await todoWrite({ items: ["a", "b", "c"] }, env);
  const out = await todoOrder({ ids: ["t-3", "t-1"] }, env);
  const lines = out.split("\n").filter((l) => l.startsWith("["));
  assert.equal(lines[0].includes("t-3"), true);
  assert.equal(lines[1].includes("t-1"), true);
  assert.equal(lines[2].includes("t-2"), true);
  await rm(home, { recursive: true, force: true });
});

test("todo_read on an empty plan renders a zero tally", async () => {
  const { home, env } = await makeEnv();
  const out = await todoRead({}, env);
  assert.match(out, /0 done · 0 active · 0 pending/);
  await rm(home, { recursive: true, force: true });
});

test("plans are isolated per session id", async () => {
  const { home } = await makeEnv();
  const envA = { cwd: home, session: { id: "s-a" } };
  const envB = { cwd: home, session: { id: "s-b" } };
  await todoWrite({ items: ["only in a"] }, envA);
  const outB = await todoRead({}, envB);
  assert.match(outB, /0 done · 0 active · 0 pending/);
  await rm(home, { recursive: true, force: true });
});
