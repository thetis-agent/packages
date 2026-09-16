// The prompt step's output and harness state, the budget rule, the project switch, and the bench claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { STATE, BENCH_KEY, clearCache } from "@thetis/skills";
import { inject, importCorpus, benchReport, fill, SELF, DEFAULT_BUDGET } from "../index.js";

function home() {
  const dir = mkdtempSync(resolve(tmpdir(), "skills-all-"));
  const env = {
    cwd: dir,
    async readFile(p) {
      try {
        return readFileSync(resolve(dir, p), "utf8");
      } catch (e) {
        throw Object.assign(new Error(p), { code: e.code });
      }
    },
    async writeFile(p, c) {
      mkdirSync(dirname(resolve(dir, p)), { recursive: true });
      writeFileSync(resolve(dir, p), c);
    },
  };
  const skill = (id, description, body = `Body of ${id}.\n`, meta = []) => {
    mkdirSync(resolve(dir, "skills", id), { recursive: true });
    writeFileSync(resolve(dir, "skills", id, "SKILL.md"), `---\nname: ${id.split("/").pop()}\ndescription: ${description}\n${meta.length ? `metadata:\n${meta.map((m) => `  ${m}`).join("\n")}\n` : ""}---\n${body}`);
  };
  return { dir, env, skill, rm: () => rmSync(dir, { recursive: true, force: true }) };
}

const ctxOf = (env, extra = {}) => ({ session: { id: "s-1", user: "alice" }, env, packages: { list: () => [] }, call: { model: "m", system: "BASE", messages: [], tools: [], params: {} }, harness: {}, config: {}, ...extra });

test("inject puts every body in the prompt, universal first then by id, and records the state", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("zeta", "Z.");
    h.skill("alpha", "A.");
    h.skill("late", "Universal one.", "Always.\n", ['universal: "true"']);
    const out = await inject(ctxOf(h.env));
    assert.equal(out.call.system, "BASE\n\n# Skills\nEach section below is one skill in full. Apply a skill when the request matches its description.\n\n## late\nAlways.\n\n## alpha\nBody of alpha.\n\n## zeta\nBody of zeta.\n");
    const state = out.harness[STATE];
    assert.equal(state.loader, SELF);
    assert.deepEqual(state.universal, ["late"]);
    assert.deepEqual(state.injected, ["late", "alpha", "zeta"]);
    assert.deepEqual(state.catalogue, ["late", "alpha", "zeta"]);
    assert.deepEqual(state.dropped, []);
    assert.deepEqual(state.excluded, []);
    assert.equal(state.budget, DEFAULT_BUDGET);
    assert.deepEqual(state.notes, []);
  } finally {
    h.rm();
  }
});

test("without skills the call is untouched and the state is still written", async () => {
  const h = home();
  try {
    clearCache();
    const out = await inject(ctxOf(h.env, { harness: { keep: true } }));
    assert.equal(out.call, undefined);
    assert.equal(out.harness.keep, true);
    assert.deepEqual(out.harness[STATE].injected, []);
  } finally {
    h.rm();
  }
});

test("the budget from config stops at the first skill that does not fit; dropped names the rest", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("a", "A.", `${"x".repeat(100)}\n`);
    h.skill("b", "B.", `${"y".repeat(100)}\n`);
    h.skill("c", "C.", "small\n");
    const out = await inject(ctxOf(h.env, { config: { budget: 150 } }));
    const state = out.harness[STATE];
    assert.deepEqual(state.injected, ["a"]);
    assert.deepEqual(state.dropped, ["b", "c"]);
    assert.ok(state.used <= 150);
    assert.ok(!out.call.system.includes("## c"), "a smaller skill after the stop is not squeezed in");
  } finally {
    h.rm();
  }
});

test("fill is deterministic and whole-skill", () => {
  const order = [{ id: "a", body: "1234" }, { id: "b", body: "12345678" }];
  const out = fill(order, 12);
  assert.deepEqual(out.injected, ["a"]);
  assert.deepEqual(out.dropped, ["b"]);
});

test("a project's skills.disable leaves skills out; an errored skill is named in the notes; another loader is noted", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("on", "On.");
    h.skill("off", "Off.");
    mkdirSync(resolve(h.dir, "skills", "bad"), { recursive: true });
    writeFileSync(resolve(h.dir, "skills", "bad", "SKILL.md"), "no frontmatter");
    await h.env.writeFile("projects/sessions.json", JSON.stringify({ "s-1": "p_00000001" }));
    await h.env.writeFile("projects/p_00000001.json", JSON.stringify({ id: "p_00000001", skills: { disable: ["off"] } }));
    const out = await inject(ctxOf(h.env, { harness: { [STATE]: { loader: "@thetis/skills-l1" } } }));
    const state = out.harness[STATE];
    assert.deepEqual(state.injected, ["on"]);
    assert.deepEqual(state.excluded, ["off"]);
    assert.ok(!out.call.system.includes("## off"));
    assert.ok(state.notes.some((n) => /skill bad left out/.test(n)));
    assert.ok(state.notes.some((n) => /another skills loader is installed: @thetis\/skills-l1/.test(n)));
  } finally {
    h.rm();
  }
});

test("the bench: import, inject, report; the claim is in corpus ids with reach direct", async () => {
  const h = home();
  try {
    clearCache();
    const records = ["cap.x.one", "cap.x.two", "cap.y.three"].map((id, i) => ({
      id,
      name: id.split(".").pop(),
      description: `Record ${i}.`,
      tags: [],
      canary: `⟦c:${i}⟧`,
      body: `---\nname: ${id.split(".").pop()}\ndescription: Record ${i}.\n---\n⟦c:${i}⟧\n${"z".repeat(200)}\n`,
    }));
    await h.env.writeFile("bench/corpus.json", JSON.stringify({ id: "caps@t", version: "1", sha256: "sha256:t", records }));
    let ctx = ctxOf(h.env, { config: { budget: 600 } });
    const imported = await importCorpus(ctx);
    assert.equal(imported.harness[BENCH_KEY].imports[SELF].imported, 3);
    ctx = { ...ctx, harness: imported.harness };
    const injected = await inject(ctx);
    assert.ok(injected.call.system.includes("⟦c:0⟧"));
    ctx = { ...ctx, harness: injected.harness, call: injected.call };
    const reported = await benchReport(ctx);
    const c = reported.harness[BENCH_KEY].claims[SELF];
    assert.equal(c.package, SELF);
    assert.equal(c.reach, "direct");
    assert.deepEqual(c.offered, []);
    assert.equal(c.budgetBytes, 600);
    assert.deepEqual([...c.direct, ...c.droppedForBudget].sort(), ["cap.x.one", "cap.x.two", "cap.y.three"]);
    assert.ok(c.direct.length >= 1 && c.droppedForBudget.length >= 1);
    for (const id of c.direct) assert.ok(injected.call.system.includes(records.find((r) => r.id === id).canary));
    assert.equal(reported.harness[STATE].loader, SELF, "the report keeps the loader's own state");
    assert.equal(reported.harness[BENCH_KEY].imports[SELF].imported, 3, "and the import record");
  } finally {
    h.rm();
  }
});

test("benchReport without a corpus claims nothing", async () => {
  const h = home();
  try {
    clearCache();
    const out = await benchReport(ctxOf(h.env, { harness: { [STATE]: { injected: ["a"], dropped: [] } } }));
    assert.deepEqual(out.harness[BENCH_KEY].claims[SELF].direct, []);
  } finally {
    h.rm();
  }
});
