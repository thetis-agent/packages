// importCorpus: idempotent by the corpus sha256, one skill per record with the canary kept, the id map; and
// the claim spread that keeps other packages' harness state.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { importCorpus, readMap, corpusIds, claim, skillFileOf, slugOf, STATE, BENCH_KEY } from "../lib/bench.js";
import { loadSkills, clearCache } from "../lib/load.js";
import { lint } from "../lib/skill.js";
import { fakeEnv, makeHome, smallCorpus } from "./helpers.js";

test("importCorpus writes one skill per record, keeps the canary, maps ids, and reports the import", async () => {
  const { home, rm } = makeHome();
  try {
    const env = fakeEnv(home);
    const corpus = smallCorpus();
    await env.writeFile("bench/corpus.json", JSON.stringify(corpus));
    const out = await importCorpus({ env, harness: { other: 1 } }, "@x/loader");
    const rec = out.harness[BENCH_KEY].imports["@x/loader"];
    assert.equal(rec.imported, 3);
    assert.equal(out.harness.other, 1);
    assert.match(rec.representation, /3 skills under skills\//);
    clearCache();
    const skills = loadSkills(env, []);
    assert.deepEqual(skills.map((s) => s.id), ["alpha", "beta", "gamma-ray"]);
    assert.deepEqual(lint(skills).filter((p) => p.level === "error"), []);
    for (const r of corpus.records) {
      const s = skills.find((x) => x.id === slugOf(r));
      assert.ok(s.body.includes(r.canary), `${r.id} keeps its canary`);
      assert.equal(s.description, r.description);
      assert.equal(s.title, r.id, "the title is the corpus id, so a brief names the record");
      assert.equal(s.body.startsWith("---"), false, "the record's own frontmatter is not repeated in the body");
    }
    assert.deepEqual(skills.find((s) => s.id === "alpha").tags, ["first-group", "alpha"]);
    const map = readMap(env);
    assert.equal(map.sha256, corpus.sha256);
    assert.deepEqual([...map.toSkill], [["cap.a.alpha", "alpha"], ["cap.a.beta", "beta"], ["cap.b.Gamma Ray", "gamma-ray"]]);
    assert.deepEqual(corpusIds(map, ["beta", "unknown", "alpha"]), ["cap.a.beta", "cap.a.alpha"]);
    assert.deepEqual(corpusIds(null, ["beta"]), []);
  } finally {
    rm();
  }
});

test("importCorpus is idempotent by the corpus sha256 and re-imports when it changes", async () => {
  const { home, rm } = makeHome();
  try {
    const env = fakeEnv(home);
    const corpus = smallCorpus();
    await env.writeFile("bench/corpus.json", JSON.stringify(corpus));
    await importCorpus({ env, harness: {} }, "@x/loader");
    const file = resolve(home, "skills", "alpha", "SKILL.md");
    const before = statSync(file).mtimeMs;
    writeFileSync(file, "tampered");
    const again = await importCorpus({ env, harness: {} }, "@x/loader");
    assert.equal(readFileSync(file, "utf8"), "tampered", "the same corpus is not written twice");
    assert.equal(again.harness[BENCH_KEY].imports["@x/loader"].builtMs, 0);
    assert.equal(again.harness[BENCH_KEY].imports["@x/loader"].imported, 3);
    await env.writeFile("bench/corpus.json", JSON.stringify({ ...corpus, sha256: "sha256:changed" }));
    await importCorpus({ env, harness: {} }, "@x/loader");
    assert.notEqual(readFileSync(file, "utf8"), "tampered");
    assert.ok(statSync(file).mtimeMs >= before);
  } finally {
    rm();
  }
});

test("importCorpus does nothing without a corpus", async () => {
  const { home, rm } = makeHome();
  try {
    const env = fakeEnv(home);
    assert.equal(await importCorpus({ env, harness: {} }, "@x/loader"), undefined);
    assert.equal(existsSync(resolve(home, "skills")), false);
    assert.equal(readMap(env), null);
  } finally {
    rm();
  }
});

test("skillFileOf generates a frontmatter the parser reads and keeps the text after the record's own", () => {
  const record = smallCorpus().records[1];
  const text = skillFileOf(record, "beta");
  assert.ok(text.startsWith("---\nname: beta\ndescription: "));
  assert.ok(!text.includes("allowed-tools"));
  assert.ok(text.includes(record.canary));
  assert.equal(slugOf({ id: "cap.x.Gamma Ray" }), "gamma-ray");
  assert.equal(slugOf({ id: "cap.x.ok-name" }), "ok-name");
  assert.match(slugOf({ id: "cap.x.---" }), /^record-[0-9a-f]{8}$/);
});

test("claim spreads the harness and merges imports and claims under the bench key", () => {
  const ctx = { harness: { [STATE]: { loader: "@x" }, [BENCH_KEY]: { imports: { "@y": { imported: 1 } }, claims: { "@y": { package: "@y", direct: [] } } } } };
  const out = claim(ctx, "@x", { imported: 2, representation: "r" }, { direct: ["cap.a"], offered: [], reach: "direct" });
  assert.deepEqual(out.harness[STATE], { loader: "@x" });
  assert.deepEqual(Object.keys(out.harness[BENCH_KEY].imports).sort(), ["@x", "@y"]);
  assert.deepEqual(out.harness[BENCH_KEY].claims["@x"], { package: "@x", direct: ["cap.a"], offered: [], reach: "direct" });
  assert.deepEqual(out.harness[BENCH_KEY].claims["@y"], { package: "@y", direct: [] });
  assert.equal(STATE, "@thetis/skills");
});
