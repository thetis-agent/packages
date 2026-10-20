// The forget hook: each forgotten conversation's routing document leaves this package's storage, another
// conversation's stays, and a second forget finds nothing.
import { test, after } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { forgetSession } from "../index.js";
import { NAMESPACE, readDoc, writeDoc } from "../lib/store.js";
import { home } from "./helpers.js";

const dirs = [];
after(() => dirs.forEach((d) => rmSync(d, { recursive: true, force: true })));
const fresh = () => {
  const { dir, env } = home();
  dirs.push(dir);
  return env;
};

test("preview answers nothing and removes nothing", async () => {
  const env = fresh();
  await writeDoc(env, "s_a", { active: ["files"], loaded: {} });
  assert.deepEqual(await forgetSession({ phase: "preview", session: "s_a", sessions: ["s_a"] }, env), {});
  assert.deepEqual((await readDoc(env, "s_a")).active, ["files"]);
});

test("forget deletes the documents of the subtree under the package's sessions namespace, and keeps the rest", async () => {
  const env = fresh();
  await writeDoc(env, "s_a", { active: ["files"], loaded: { web: "search" } });
  await writeDoc(env, "s_child", { active: ["shell"], loaded: {} });
  await writeDoc(env, "s_keep", { active: ["files"], loaded: {} });
  const out = await forgetSession({ phase: "forget", session: "s_a", sessions: ["s_a", "s_child", "s_none"] }, env);
  assert.deepEqual(out, { removed: ["The tool groups chosen for 2 conversations."] });
  assert.equal(await env.storage(NAMESPACE).get("s_a"), undefined);
  assert.equal(await env.storage(NAMESPACE).get("s_child"), undefined);
  assert.deepEqual((await readDoc(env, "s_keep")).active, ["files"]);
});

test("forget is idempotent, skips ids that could not be a key, and refuses an env without storage", async () => {
  const env = fresh();
  await writeDoc(env, "s_a", { active: [], loaded: {} });
  const args = { phase: "forget", session: "s_a", sessions: ["s_a", "../x"] };
  assert.equal((await forgetSession(args, env)).removed.length, 1);
  assert.deepEqual(await forgetSession(args, env), { removed: [] });
  await assert.rejects(forgetSession(args, { cwd: "/nowhere" }), /no storage/);
});
