// The step and the commands over a fake fence environment: a temporary home with readFile and
// writeFile relative to it, as the userspace agent gives them, and a kernel whose model list is what
// the test says.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { applyEffort, reasoningFor, uiModels, uiSet, uiState } from "../index.js";
import { effortOf, setEffort } from "../lib/store.js";

const MODELS = {
  model: "vendor/thinker",
  models: [
    { id: "vendor/thinker", reasoning: { mandatory: false, supportedEfforts: ["high", "medium", "low"], defaultEffort: "medium" } },
    { id: "vendor/forced", reasoning: { mandatory: true } },
    { id: "vendor/plain" },
  ],
};

async function makeEnv({ session, models = MODELS } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "effort-home-"));
  const env = {
    cwd: home,
    user: "alice",
    role: "user",
    session,
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    kernel: { models: async () => { if (models instanceof Error) throw models; return models; } },
  };
  return { env, done: () => rm(home, { recursive: true, force: true }) };
}

const ctxFor = (env, session, model = "vendor/thinker", params = {}) => ({ session: { id: session, user: "alice" }, call: { model, system: "", tools: [], messages: [], params }, harness: {}, env });

test("reasoningFor: a level is an effort, none is enabled false, nothing is nothing", () => {
  assert.deepEqual(reasoningFor("high"), { effort: "high" });
  assert.deepEqual(reasoningFor("none"), { enabled: false });
  assert.equal(reasoningFor(null), undefined);
  assert.equal(reasoningFor(""), undefined);
});

test("no choice anywhere: the step changes nothing", async () => {
  const { env, done } = await makeEnv();
  assert.equal(await applyEffort(ctxFor(env, "s_1")), undefined);
  await done();
});

test("a choice becomes call.params.reasoning, keeping the other params", async () => {
  const { env, done } = await makeEnv();
  await setEffort(env, "s_1", "low");
  const out = await applyEffort(ctxFor(env, "s_1", "vendor/thinker", { temperature: 0.2 }));
  assert.deepEqual(out.call.params, { temperature: 0.2, reasoning: { effort: "low" } });
  await done();
});

test("Off is enabled: false", async () => {
  const { env, done } = await makeEnv();
  await setEffort(env, "s_1", "none");
  const out = await applyEffort(ctxFor(env, "s_1"));
  assert.deepEqual(out.call.params.reasoning, { enabled: false });
  await done();
});

test("a model the list says does not think gets nothing, whatever was chosen", async () => {
  const { env, done } = await makeEnv();
  await setEffort(env, "s_1", "high");
  assert.equal(await applyEffort(ctxFor(env, "s_1", "vendor/plain")), undefined);
  await done();
});

test("a model the list does not know, or a failing list, does not block the choice", async () => {
  const known = await makeEnv();
  await setEffort(known.env, "s_1", "high");
  assert.deepEqual((await applyEffort(ctxFor(known.env, "s_1", "vendor/unlisted"))).call.params.reasoning, { effort: "high" });
  await known.done();
  const failing = await makeEnv({ models: new Error("no provider") });
  await setEffort(failing.env, "s_1", "high");
  assert.deepEqual((await applyEffort(ctxFor(failing.env, "s_1"))).call.params.reasoning, { effort: "high" });
  await failing.done();
});

test("a conversation without its own choice inherits the remembered one; Default clears both", async () => {
  const { env, done } = await makeEnv();
  await setEffort(env, "s_1", "medium");
  assert.deepEqual(await effortOf(env, "s_2"), { effort: "medium", source: "remembered" });
  assert.deepEqual(await effortOf(env, "s_1"), { effort: "medium", source: "session" });
  await setEffort(env, "s_2", "high", false);
  assert.deepEqual(await effortOf(env, "s_2"), { effort: "high", source: "session" });
  assert.deepEqual(await effortOf(env, "s_3"), { effort: "medium", source: "remembered" }, "remember: false left the remembered choice alone");
  await setEffort(env, "s_1", "");
  assert.deepEqual(await effortOf(env, "s_1"), { effort: null, source: null });
  assert.deepEqual(await effortOf(env, "s_3"), { effort: null, source: null }, "Default cleared the remembered choice too");
  await done();
});

test("a word that is not an effort is refused and nothing is written", async () => {
  const { env, done } = await makeEnv();
  await assert.rejects(setEffort(env, "s_1", "loud"), /"loud" is not an effort/);
  await assert.rejects(env.readFile("effort/sessions.json"), { code: "ENOENT" });
  await done();
});

test("a hand-edited sessions file with junk in it is read as far as it is sound", async () => {
  const { env, done } = await makeEnv();
  await env.writeFile("effort/sessions.json", JSON.stringify({ s_1: "high", s_2: "loud", s_3: 7 }));
  assert.deepEqual(await effortOf(env, "s_1"), { effort: "high", source: "session" });
  assert.deepEqual(await effortOf(env, "s_2"), { effort: null, source: null });
  await env.writeFile("effort/sessions.json", "not json");
  assert.deepEqual(await effortOf(env, "s_1"), { effort: null, source: null });
  await done();
});

test("effort-state and effort-set answer what the pill draws", async () => {
  const { env, done } = await makeEnv({ session: "s_1" });
  let { data } = await uiState({}, env);
  assert.deepEqual(data, { session: "s_1", effort: null, remembered: null, effective: null, source: null, efforts: ["max", "xhigh", "high", "medium", "low", "minimal", "none"] });
  ({ data } = await uiSet({ effort: "low" }, env));
  assert.deepEqual(data, { session: "s_1", effort: "low", remembered: "low" });
  ({ data } = await uiState({ session: "s_9" }, env));
  assert.equal(data.effort, null);
  assert.equal(data.effective, "low");
  assert.equal(data.source, "remembered");
  ({ data } = await uiSet({ session: "s_9", effort: "none", remember: false }, env));
  assert.deepEqual(data, { session: "s_9", effort: "none", remembered: "low" });
  await assert.rejects(uiSet({ effort: "high" }, { ...env, session: undefined }), /no conversation is open/);
  await done();
});

test("effort-models lists only the models that think", async () => {
  const { env, done } = await makeEnv();
  const { data } = await uiModels({}, env);
  assert.equal(data.model, "vendor/thinker");
  assert.deepEqual(Object.keys(data.reasoning).sort(), ["vendor/forced", "vendor/thinker"]);
  assert.equal(data.reasoning["vendor/forced"].mandatory, true);
  await done();
});
