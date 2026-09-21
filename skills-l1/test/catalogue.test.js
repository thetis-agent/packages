// The catalogue step's output and harness state, load_skill once per conversation with the re-injection on
// the next turn, the closest-names refusal, and the bench claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { STATE, BENCH_KEY, clearCache } from "@thetis/skills";
import { catalogue, loadSkill, importCorpus, benchReport, SELF } from "../index.js";
import { readLoaded } from "../lib/loaded.js";

function home() {
  const dir = mkdtempSync(resolve(tmpdir(), "skills-l1-"));
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

const session = { id: "s-1", user: "alice" };
const ctxOf = (env, extra = {}) => ({ session, env, packages: { list: () => [] }, call: { model: "m", system: "BASE", messages: [], tools: [], params: {} }, harness: {}, config: {}, ...extra });
const toolEnv = (env) => ({ ...env, session, config: {}, kernel: { packages: { list: async () => [] } } });

test("catalogue lists one brief per top-level skill, then the universal bodies; the state is recorded", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("packages", "Installs packages. Use when asked to install.");
    h.skill("packages/forks", "Forks packages.");
    h.skill("concise", "Short answers.", "Be short.\n", ['universal: "true"']);
    const out = await catalogue(ctxOf(h.env));
    assert.equal(
      out.call.system,
      "BASE\n\n# Skills you can load\nOne line per skill. load_skill with the name reads one; skill_fetch reads a nested skill or a file beside one.\n\n`concise` — Short answers.\n`packages` — Installs packages.\n\n# Skills always in force\n\n## concise\nBe short.\n",
    );
    const state = out.harness[STATE];
    assert.equal(state.loader, SELF);
    assert.deepEqual(state.universal, ["concise"]);
    assert.deepEqual(state.catalogue, ["concise", "packages"]);
    assert.deepEqual(state.loaded, []);
    assert.deepEqual(state.pinned, []);
    assert.deepEqual(state.notes, []);
  } finally {
    h.rm();
  }
});

test("without skills the call is untouched", async () => {
  const h = home();
  try {
    clearCache();
    const out = await catalogue(ctxOf(h.env));
    assert.equal(out.call, undefined);
    assert.deepEqual(out.harness[STATE].catalogue, []);
  } finally {
    h.rm();
  }
});

test("load_skill returns the body once per conversation; the next turn's prompt carries it", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("packages", "Installs packages.", "How to install.\n");
    h.skill("concise", "Short.", "Be short.\n", ['universal: "true"']);
    const env = toolEnv(h.env);
    const first = await loadSkill({ name: "packages" }, env);
    assert.match(first, /^How to install\.\n\nSkill directory: /);
    const second = await loadSkill({ name: "packages" }, env);
    assert.match(second, /^already loaded: packages/);
    assert.match(await loadSkill({ name: "concise" }, env), /always in force/);
    const loaded = await readLoaded(h.env, session);
    assert.equal(loaded.length, 1);
    assert.equal(loaded[0].id, "packages");
    assert.equal(loaded[0].contentHash.length, 64);
    // Another conversation starts empty.
    assert.match(await loadSkill({ name: "packages" }, { ...env, session: { id: "s-2" } }), /^How to install/);

    const out = await catalogue(ctxOf(h.env));
    assert.deepEqual(out.harness[STATE].loaded, ["packages"]);
    assert.ok(out.call.system.endsWith("# Skills loaded in this conversation\n\n## packages\nHow to install.\n"));
    const again = await catalogue(ctxOf(h.env));
    assert.equal(again.call.system, out.call.system, "bytes are stable from then on");
  } finally {
    h.rm();
  }
});

test("load_skill refuses an unknown name with the closest ids, and a switched-off skill", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("packages", "Installs packages.");
    h.skill("projects", "Workspaces.");
    const env = toolEnv(h.env);
    await assert.rejects(loadSkill({ name: "package" }, env), /no skill named package; closest: packages, projects/);
    await assert.rejects(loadSkill({}, env), /name is required/);
    await h.env.writeFile("projects/sessions.json", JSON.stringify({ "s-1": "p_00000001" }));
    await h.env.writeFile("projects/p_00000001.json", JSON.stringify({ id: "p_00000001", skills: { disable: ["projects"] } }));
    await assert.rejects(loadSkill({ name: "projects" }, env), /no skill named projects/);
    const out = await catalogue(ctxOf(h.env));
    assert.deepEqual(out.harness[STATE].catalogue, ["packages"]);
    assert.deepEqual(out.harness[STATE].excluded, ["projects"]);
  } finally {
    h.rm();
  }
});

test("another loader in the harness is noted", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("a", "A.");
    const out = await catalogue(ctxOf(h.env, { harness: { [STATE]: { loader: "@thetis/skills-all" } } }));
    assert.match(out.harness[STATE].notes[0], /another skills loader is installed: @thetis\/skills-all/);
  } finally {
    h.rm();
  }
});

test("the bench: import, catalogue, report; offered is the catalogue in corpus ids, direct is what was loaded", async () => {
  const h = home();
  try {
    clearCache();
    const records = ["cap.x.one", "cap.x.two"].map((id, i) => ({
      id,
      name: id.split(".").pop(),
      description: `Record ${i}. Use for ${i}.`,
      tags: ["T"],
      canary: `⟦c:${i}⟧`,
      body: `---\nname: ${id.split(".").pop()}\ndescription: Record ${i}.\n---\n⟦c:${i}⟧\nbody ${i}\n`,
    }));
    await h.env.writeFile("bench/corpus.json", JSON.stringify({ id: "caps@t", version: "1", sha256: "sha256:t", records }));
    let ctx = ctxOf(h.env);
    ctx = { ...ctx, harness: (await importCorpus(ctx)).harness };
    const cat = await catalogue(ctx);
    assert.ok(cat.call.system.includes("`one` (cap.x.one) — Record 0."), "the brief names the corpus id");
    assert.ok(!cat.call.system.includes("⟦c:0⟧"), "no body in the prompt");
    ctx = { ...ctx, harness: cat.harness, call: cat.call };
    let report = await benchReport(ctx);
    assert.deepEqual(report.harness[BENCH_KEY].claims[SELF], { package: SELF, direct: [], offered: ["cap.x.one", "cap.x.two"], reach: "catalogue" });

    await loadSkill({ name: "two" }, toolEnv(h.env));
    const next = await catalogue({ ...ctx, harness: report.harness });
    assert.ok(next.call.system.includes("⟦c:1⟧"));
    report = await benchReport({ ...ctx, harness: next.harness, call: next.call });
    assert.deepEqual(report.harness[BENCH_KEY].claims[SELF], { package: SELF, direct: ["cap.x.two"], offered: ["cap.x.one"], reach: "catalogue" });
    assert.equal(report.harness[BENCH_KEY].imports[SELF].imported, 2);
  } finally {
    h.rm();
  }
});
