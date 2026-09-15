// The page's two commands: `plan` answers the conversation's plan as data, `mark` validates like todo_mark,
// writes the plan the tools read, and answers the plan it left. Both refuse when no conversation is open.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { uiPlan, uiMark } from "../lib/ui-commands.js";
import { todoWrite, todoRead } from "../lib/todo-tools.js";

async function makeHome() {
  const home = await mkdtemp(resolve(tmpdir(), "tp-ui-"));
  return { home, toolEnv: { cwd: home, session: { id: "s-1" } }, uiEnv: { cwd: home, session: "s-1", user: "dev", role: "user" } };
}

test("plan answers the items and the tally of the session's plan, empty when there is none", async () => {
  const { home, toolEnv, uiEnv } = await makeHome();
  assert.deepEqual(await uiPlan({}, uiEnv), { data: { items: [], done: 0, total: 0 } });
  await todoWrite({ items: ["a", { text: "b", stage: "done", note: "why" }] }, toolEnv);
  const out = await uiPlan({}, uiEnv);
  assert.deepEqual(out.data, { items: [{ id: "t-1", text: "a", stage: "pending", note: "" }, { id: "t-2", text: "b", stage: "done", note: "why" }], done: 1, total: 2 });
  await rm(home, { recursive: true, force: true });
});

test("plan and mark refuse without a session", async () => {
  const { home } = await makeHome();
  await assert.rejects(uiPlan({}, { cwd: home, user: "dev", role: "user" }), /no conversation is open/);
  await assert.rejects(uiMark({ id: "t-1", stage: "done" }, { cwd: home, user: "dev", role: "user" }), /no conversation is open/);
  await rm(home, { recursive: true, force: true });
});

test("mark writes the plan the tools read and answers the plan it left", async () => {
  const { home, toolEnv, uiEnv } = await makeHome();
  await todoWrite({ items: ["a", "b"] }, toolEnv);
  const out = await uiMark({ id: "t-1", stage: "done" }, uiEnv);
  assert.equal(out.text, undefined);
  assert.deepEqual(out.data.items.map((i) => [i.id, i.stage]), [["t-1", "done"], ["t-2", "pending"]]);
  assert.equal(out.data.done, 1);
  assert.match(await todoRead({}, toolEnv), /\[x\] t-1 a/);
  await rm(home, { recursive: true, force: true });
});

test("mark validates like todo_mark: the stage, the id, and the single-active rule with its note", async () => {
  const { home, toolEnv, uiEnv } = await makeHome();
  await todoWrite({ items: ["a", { text: "b", stage: "active" }] }, toolEnv);
  await assert.rejects(uiMark({ id: "t-1", stage: "later" }, uiEnv), /stage must be one of/);
  await assert.rejects(uiMark({ id: "t-9", stage: "done" }, uiEnv), /unknown id\(s\): t-9/);
  await assert.rejects(uiMark({ stage: "done" }, uiEnv), /id is required/);
  const out = await uiMark({ id: "t-1", stage: "active" }, uiEnv);
  assert.match(out.text, /only one item can be active; t-2 stays active/); // the later item wins, as in todo_mark
  assert.deepEqual(out.data.items.map((i) => i.stage), ["pending", "active"]);
  await rm(home, { recursive: true, force: true });
});
