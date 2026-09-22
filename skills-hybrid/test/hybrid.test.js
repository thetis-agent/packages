// Fusion determinism, the pin reused across turns, the lexical fallback without a key or a network, the
// vector cache round trip and its pruning, the bench vector file, the importer's seeding, and the claim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { STATE, BENCH_KEY, clearCache, loadSkills, readMap } from "@thetis/skills";
import { pin, skillSearch, importCorpus, seedVectors, benchReport, SELF } from "../index.js";
import { hybridRank, denseRank, lexicalRank } from "../lib/rank.js";
import { embed, embeddingConfig, readCache, writeCache, keyOf, queryHashOf, indexTextOf, CACHE_PATH, BATCH } from "../lib/embed.js";
import { benchVectorsFor, clearVectorCache, hexOf } from "../lib/vectors.js";
import { retrieve } from "../lib/retrieve.js";
import { home, ctxOf, toolEnv, session, fakeFetch, fakeVector, withFetch, corpus } from "./helpers.js";

// The fake vectors are 8 hashed numbers, not embeddings, so their cosines sit below any real floor: off unless a test sets it.
const withKey = { embeddings: { apiKey: "test-key", model: "fake", dimensions: 8 }, denseThreshold: 0 };
const noNetwork = async () => {
  throw new Error("the network was touched");
};

function threeSkills(h) {
  h.skill("packages", "Installs packages. Use when asked to install a package.");
  h.skill("packages/forks", "Forks packages. Use when a fork is wanted.");
  h.skill("projects", "Workspaces and projects. Use when a project is mentioned.");
  h.skill("concise", "Short answers.", "Be short.\n", ['universal: "true"']);
}

test("fusion is deterministic and labels each hit with how it got there", () => {
  const skills = [{ id: "a" }, { id: "a/child" }, { id: "b" }, { id: "c" }, { id: "d/only" }, { id: "d" }];
  const dense = [{ id: "b", score: 0.9 }, { id: "a/child", score: 0.8 }, { id: "c", score: 0.5 }];
  const lexical = [{ id: "a", score: 3 }, { id: "b", score: 2 }, { id: "d/only", score: 1 }];
  const once = hybridRank(skills, { dense, lexical, weight: 0.7, limit: 10 });
  const twice = hybridRank([...skills].reverse(), { dense: [...dense], lexical: [...lexical], weight: 0.7, limit: 10 });
  assert.deepEqual(once, twice);
  assert.deepEqual(once.map((h) => h.id), ["b", "a", "c", "d/only", "d"]);
  assert.deepEqual(Object.fromEntries(once.map((h) => [h.id, h.how])), { b: "dense", a: "lexical", c: "dense", "d/only": "lexical", d: "parent-of-match" });
  assert.deepEqual(hybridRank(skills, { dense, lexical, weight: 0.7, limit: 2 }).map((h) => h.id), ["b", "a"], "the cut is after promotion");
  assert.deepEqual(hybridRank(skills, { dense, lexical, weight: 0.7, limit: 10, universal: new Set(["b"]) }).map((h) => h.id), ["a", "c", "d/only", "d"], "universals are never ranked");
  assert.deepEqual(hybridRank(skills, { dense: [], lexical, weight: 0.7 }).map((h) => h.id), ["a", "b", "d/only", "d"], "no dense list is the lexical order");
  const vectors = new Map([["a", [1, 0]], ["b", [0.6, 0.8]], ["c", [0, 1]]]);
  assert.deepEqual(denseRank(skills, vectors, [1, 0], 2), [{ id: "a", score: 1 }, { id: "b", score: 0.6 }]);
  assert.equal(lexicalRank([{ id: "x", name: "x", description: "install packages", tags: [] }], "install")[0].id, "x");
});

test("the pin is ranked on the first turn and reused on every later turn, whatever the last message says", async () => {
  const h = home();
  try {
    clearCache();
    threeSkills(h);
    const fetch = fakeFetch();
    const first = await withFetch(fetch, () => pin(ctxOf(h.env, { config: withKey })));
    const state = first.harness[STATE];
    assert.equal(state.loader, SELF);
    assert.equal(state.mode, "dense");
    assert.deepEqual(state.universal, ["concise"]);
    assert.deepEqual(state.catalogue, ["concise", "packages", "projects"]);
    assert.ok(state.pinned.length >= 1 && state.pinned.length <= 6);
    assert.equal(state.pinned[0].id, "packages");
    assert.equal(state.pinned[0].contentHash.length, 64);
    assert.ok(["dense", "lexical"].includes(state.pinned[0].how));
    assert.ok(!state.pinned.some((p) => p.id === "concise"), "a universal skill is never pinned");
    assert.ok(!state.pinned.some((p) => p.id === "packages/forks"), "the child is absorbed into its parent");
    assert.deepEqual(state.notes, []);
    assert.match(first.call.system, /^BASE\n\n# Skills\n[^\n]+\n\n`concise` — Short answers\.\n`packages` — Installs packages\.\n`projects` — Workspaces and projects\.\n\n# Skills always in force\n\n## concise\nBe short\.\n\n\n# Skills retrieved for this conversation\n[^\n]+\n\n`packages` — Installs packages\.\nUse when: asked to install a package\.\nNested: forks\n/);
    assert.ok(!first.call.system.includes("Body of packages"), "cards, not bodies, by default");
    assert.equal(fetch.calls.length, 2, "one batch for the skills, one for the query");
    assert.equal(fetch.calls[0].headers.Authorization, "Bearer test-key");
    assert.deepEqual(Object.keys(fetch.calls[0].body), ["model", "input", "dimensions"]);

    // The next turn: another message, no key at all, no network. Same pin, same bytes.
    const later = ctxOf(h.env, { harness: first.harness, conversation: [...ctxOf(h.env).conversation, { role: "assistant", content: "ok" }, { role: "user", content: "now a project workspace please" }] });
    const second = await withFetch(noNetwork, () => pin(later));
    assert.deepEqual(second.harness[STATE].pinned.map((p) => p.id), state.pinned.map((p) => p.id));
    assert.equal(second.call.system, first.call.system);
    assert.deepEqual(second.harness[STATE].notes, []);

    // A pack update: the description changes, the card is re-rendered, the place is kept and noted.
    h.skill("packages", "Installs and removes packages. Use when asked to install a package.");
    clearCache();
    const third = await withFetch(noNetwork, () => pin({ ...later, harness: second.harness }));
    assert.equal(third.harness[STATE].pinned[0].id, "packages");
    assert.notEqual(third.harness[STATE].pinned[0].contentHash, state.pinned[0].contentHash);
    assert.match(third.harness[STATE].notes[0], /pinned skill packages changed since it was pinned/);
    assert.ok(third.call.system.includes("`packages` — Installs and removes packages."));

    // A skill that vanished is dropped with a note.
    rmSync(resolve(h.dir, "skills", "packages"), { recursive: true });
    clearCache();
    const fourth = await withFetch(noNetwork, () => pin({ ...later, harness: third.harness }));
    assert.deepEqual(fourth.harness[STATE].pinned.map((p) => p.id), state.pinned.map((p) => p.id).filter((id) => id !== "packages"));
    assert.match(fourth.harness[STATE].notes[0], /pinned skill packages is no longer available/);
  } finally {
    h.rm();
  }
});

test("without a key the ranking is lexical, nothing touches the network, and one note says so", async () => {
  const h = home();
  try {
    clearCache();
    threeSkills(h);
    const out = await withFetch(noNetwork, () => pin(ctxOf(h.env, { config: { embeddings: { apiKey: "${OPENROUTER_API_KEY}" } } })));
    const state = out.harness[STATE];
    assert.equal(state.mode, "lexical");
    assert.deepEqual(state.pinned.map((p) => [p.id, p.how]), [["packages", "lexical"]]);
    assert.equal(state.notes.length, 1);
    assert.match(state.notes[0], /no embeddings key.*ranking is lexical/);
    assert.ok(!state.notes[0].includes("OPENROUTER"), "the note never carries a key");
    await assert.rejects(h.env.readFile(CACHE_PATH), { code: "ENOENT" }, "nothing is cached without a vector");
    // A key that the endpoint refuses is the same fallback with a different note, and the step still returns.
    const refused = await withFetch(fakeFetch({ fail: true }), () => pin(ctxOf(h.env, { config: withKey })));
    assert.equal(refused.harness[STATE].mode, "lexical");
    assert.match(refused.harness[STATE].notes[0], /embeddings unavailable \(embeddings 503: down\)/);
    assert.ok(!refused.harness[STATE].notes[0].includes("test-key"));
    // A fetch that throws, likewise.
    const thrown = await withFetch(noNetwork, () => pin(ctxOf(h.env, { config: withKey })));
    assert.match(thrown.harness[STATE].notes[0], /embeddings request failed: the network was touched/);
  } finally {
    h.rm();
  }
});

test("pinBodies puts the bodies in, and pinLimit and fusionWeight are read", async () => {
  const h = home();
  try {
    clearCache();
    threeSkills(h);
    const out = await withFetch(noNetwork, () => pin(ctxOf(h.env, { config: { pinBodies: true, pinLimit: 1, fusionWeight: 0.5 }, conversation: [{ role: "user", content: "install a package for a project" }] })));
    assert.deepEqual(out.harness[STATE].pinned.map((p) => p.id), ["packages"]);
    assert.equal(out.harness[STATE].pinBodies, true);
    assert.ok(out.call.system.endsWith("# Skills retrieved for this conversation\nMatched the first message; the list above has the rest.\n\n## packages\nBody of packages.\n"));
    const none = await withFetch(noNetwork, () => pin(ctxOf(h.env, { config: { pinLimit: 0 } })));
    assert.deepEqual(none.harness[STATE].pinned, []);
    assert.ok(!none.call.system.includes("retrieved for this conversation"));
    const empty = await withFetch(noNetwork, () => pin(ctxOf(h.env, { conversation: [] })));
    assert.deepEqual(empty.harness[STATE].pinned, []);
    assert.deepEqual(empty.harness[STATE].notes, []);
  } finally {
    h.rm();
  }
});

test("without skills the call is untouched; another loader is noted", async () => {
  const h = home();
  try {
    clearCache();
    const out = await withFetch(noNetwork, () => pin(ctxOf(h.env)));
    assert.equal(out.call, undefined);
    assert.deepEqual(out.harness[STATE].catalogue, []);
    h.skill("a", "A.");
    const other = await withFetch(noNetwork, () => pin(ctxOf(h.env, { harness: { [STATE]: { loader: "@thetis/skills-l1", pinned: [] } } })));
    assert.match(other.harness[STATE].notes[0], /another skills loader is installed: @thetis\/skills-l1/);
    assert.equal(other.harness[STATE].loader, SELF);
  } finally {
    h.rm();
  }
});

test("the vector cache round-trips, is keyed by model, dimensions and content hash, and is pruned on write", async () => {
  const h = home();
  try {
    assert.deepEqual(await readCache(h.env), {});
    const cache = { [keyOf("fake", 8, "live1")]: [1, 2], [keyOf("fake", 8, "dead")]: [3], [keyOf("other", 4, "live2")]: [0.5], bad: "x" };
    const kept = await writeCache(h.env, cache, new Set(["live1", "live2"]));
    assert.deepEqual(Object.keys(kept), ["fake|8|live1", "other|4|live2"]);
    assert.deepEqual(await readCache(h.env), { "fake|8|live1": [1, 2], "other|4|live2": [0.5] });
    await h.env.writeFile(CACHE_PATH, "{not json");
    assert.deepEqual(await readCache(h.env), {});
    assert.deepEqual(embeddingConfig({}), { baseUrl: "https://openrouter.ai/api/v1", apiKey: "", model: "openai/text-embedding-3-small", dimensions: 1536 });
    assert.deepEqual(embeddingConfig({ embeddings: { baseUrl: "http://x/", apiKey: " k ", model: "m", dimensions: 4 } }), { baseUrl: "http://x", apiKey: "k", model: "m", dimensions: 4 });

    // A turn with a key fills the cache; the next turn reads it and embeds only the query.
    clearCache();
    threeSkills(h);
    const fetch = fakeFetch();
    await withFetch(fetch, () => pin(ctxOf(h.env, { config: withKey })));
    const skills = loadSkills(h.env, []);
    const stored = await readCache(h.env);
    assert.deepEqual(Object.keys(stored).sort(), skills.map((s) => keyOf("fake", 8, s.contentHash)).sort());
    assert.deepEqual(stored[keyOf("fake", 8, skills[0].contentHash)], fakeVector(indexTextOf(skills[0])));
    const again = fakeFetch();
    await withFetch(again, () => pin(ctxOf(h.env, { config: withKey })));
    assert.equal(again.calls.length, 1);
    assert.deepEqual(again.calls[0].body.input, ["install a package"], "the query is embedded and never cached");
    assert.deepEqual(await readCache(h.env), stored);
  } finally {
    h.rm();
  }
});

test("embed batches by 64, rounds to 6 decimals, and reports a refusal without the key", async () => {
  const cfg = embeddingConfig({ embeddings: { apiKey: "secret", model: "m", dimensions: 3 } });
  const fetch = fakeFetch();
  const texts = Array.from({ length: BATCH + 1 }, (_, i) => `text ${i}`);
  const vectors = await embed(texts, cfg, fetch);
  assert.equal(vectors.length, BATCH + 1);
  assert.equal(fetch.calls.length, 2);
  assert.equal(fetch.calls[0].body.input.length, BATCH);
  assert.equal(fetch.calls[0].url, "https://openrouter.ai/api/v1/embeddings");
  const precise = async () => ({ ok: true, json: async () => ({ data: [{ index: 0, embedding: [0.1234567891, 1] }] }) });
  assert.deepEqual(await embed(["a"], cfg, precise), [[0.123457, 1]]);
  await assert.rejects(embed(["a"], cfg, fakeFetch({ fail: true })), (e) => e.message === "embeddings 503: down");
  await assert.rejects(embed(["a"], { ...cfg, apiKey: "" }, fetch), /no embeddings key/);
  await assert.rejects(embed(["a"], cfg, async () => ({ ok: true, json: async () => ({ data: [] }) })), /answered 0 vectors for 1 inputs/);
});

test("the bench: the vector file is found by the corpus digest, seeded into the cache, and the query is looked up there", async () => {
  const h = home();
  const vectorsDir = `${mkdtempSync(resolve(tmpdir(), "vectors-"))}/`;
  try {
    clearCache();
    clearVectorCache();
    const c = corpus();
    await h.env.writeFile("bench/corpus.json", JSON.stringify(c));
    let ctx = ctxOf(h.env, { conversation: [{ role: "user", content: "fork a package" }] });
    ctx = { ...ctx, harness: (await importCorpus(ctx)).harness };
    const skills = loadSkills(h.env, []);
    assert.equal(skills.length, 4);
    // The file the script would write for this corpus, with the default model so an unconfigured run finds it.
    const file = { model: "openai/text-embedding-3-small", dimensions: 1536, corpus: { id: c.id, sha256: c.sha256 }, skills: Object.fromEntries(skills.map((s) => [s.contentHash, fakeVector(indexTextOf(s))])), queries: { [queryHashOf("fork a package")]: fakeVector("fork a package") } };
    writeFileSync(`${vectorsDir}${hexOf(c.sha256)}.json`, JSON.stringify(file));
    assert.equal(benchVectorsFor("sha256:not-a-digest", vectorsDir), null);
    assert.equal(benchVectorsFor(c.sha256, vectorsDir).dimensions, 1536);
    assert.equal(await seedVectors(ctx, vectorsDir), 4);
    assert.equal(await seedVectors(ctx, vectorsDir), 0, "seeding is idempotent");
    const cache = await readCache(h.env);
    assert.deepEqual(Object.keys(cache).length, 4);
    assert.deepEqual(cache[keyOf("openai/text-embedding-3-small", 1536, skills[0].contentHash)], file.skills[skills[0].contentHash]);

    // No key, no network: the query's vector comes from the file and the ranking is dense.
    const map = readMap(h.env);
    const dense = await retrieve(h.env, skills, "fork a package", {}, { limit: 10, deps: { fetch: noNetwork, map, vectorsDir } });
    assert.equal(dense.mode, "dense");
    assert.equal(dense.note, null);
    assert.equal(dense.hits[0].id, "fork");
    const twice = await retrieve(h.env, skills, "fork a package", {}, { limit: 10, deps: { fetch: noNetwork, map, vectorsDir } });
    assert.deepEqual(twice.hits, dense.hits);
    // A query the file does not know falls back to lexical.
    const unknown = await retrieve(h.env, skills, "something else", {}, { limit: 10, deps: { fetch: noNetwork, map, vectorsDir } });
    assert.equal(unknown.mode, "lexical");
    assert.match(unknown.note, /the query has no vector/);
    // A file for another model is not used for this configuration.
    const other = await retrieve(h.env, skills, "fork a package", { embeddings: { model: "other" } }, { limit: 10, deps: { fetch: noNetwork, map, vectorsDir } });
    assert.equal(other.mode, "lexical");
  } finally {
    h.rm();
    rmSync(vectorsDir, { recursive: true, force: true });
  }
});

test("the claim: universals direct, every other corpus id offered by search, the top 10 ranked with scores; bodies when pinned", async () => {
  const h = home();
  try {
    clearCache();
    clearVectorCache();
    const c = corpus();
    await h.env.writeFile("bench/corpus.json", JSON.stringify(c));
    let ctx = ctxOf(h.env, { conversation: [{ role: "user", content: "fork a package" }] });
    ctx = { ...ctx, harness: (await importCorpus(ctx)).harness };
    assert.equal(ctx.harness[BENCH_KEY].imports[SELF].imported, 4);
    const pinned = await withFetch(noNetwork, () => pin(ctx));
    assert.ok(pinned.call.system.includes("`fork` (cap.a.fork) — Forks a package."), "the brief names the corpus id");
    assert.ok(!pinned.call.system.includes("⟦c:fork⟧"), "no body in the prompt");
    ctx = { ...ctx, harness: pinned.harness, call: pinned.call };
    const report = await benchReport(ctx);
    const claim = report.harness[BENCH_KEY].claims[SELF];
    assert.deepEqual(claim.direct, []);
    assert.deepEqual(claim.offered, ["cap.a.install", "cap.a.fork", "cap.b.projects", "cap.b.concise"]);
    assert.equal(claim.reach, "search");
    assert.equal(claim.package, SELF);
    assert.ok(claim.ranked.length >= 1 && claim.ranked.length <= 10);
    assert.equal(claim.ranked[0], "cap.a.fork");
    assert.deepEqual(Object.keys(claim.scores), claim.ranked);
    assert.ok(Object.values(claim.scores).every((s) => typeof s === "number"));

    const withBodies = await withFetch(noNetwork, () => pin({ ...ctx, harness: {}, config: { pinBodies: true, pinLimit: 1 } }));
    assert.ok(withBodies.call.system.includes("⟦c:fork⟧"));
    const claim2 = (await benchReport({ ...ctx, harness: withBodies.harness, call: withBodies.call, config: { pinBodies: true } })).harness[BENCH_KEY].claims[SELF];
    assert.deepEqual(claim2.direct, ["cap.a.fork"]);
    assert.deepEqual(claim2.offered, ["cap.a.install", "cap.b.projects", "cap.b.concise"]);
  } finally {
    h.rm();
  }
});

test("skill_search answers brief lines with how each was found, and refuses an empty query", async () => {
  const h = home();
  try {
    clearCache();
    threeSkills(h);
    const env = toolEnv(h.env);
    await assert.rejects(skillSearch({}, env), /query is required/);
    const out = await withFetch(noNetwork, () => skillSearch({ query: "a project workspace", k: 2 }, env));
    const lines = out.split("\n");
    assert.match(lines[0], /^`projects` — Workspaces and projects\. \[lexical, [0-9.]+\]$/);
    assert.match(out, /skill_fetch with the id/);
    assert.match(out, /Note: no embeddings key/);
    assert.ok(!out.includes("`concise`"), "a universal skill is not a search result");
    const dense = await withFetch(fakeFetch(), () => skillSearch({ query: "fork a package" }, { ...env, config: withKey }));
    assert.match(dense.split("\n")[0], /^`packages` — Installs packages\. \[(dense|lexical), [0-9.]+\]$/);
    assert.ok(!dense.includes("Note:"));
    assert.equal(await withFetch(noNetwork, () => skillSearch({ query: "zzz qqq" }, env)), "no skill matched; the universal skills in your prompt are `concise`");
    // A switched-off skill is not found.
    await h.env.writeFile("projects/sessions.json", JSON.stringify({ "s-1": "p_00000001" }));
    await h.env.writeFile("projects/p_00000001.json", JSON.stringify({ id: "p_00000001", skills: { disable: ["projects"] } }));
    assert.equal(await withFetch(noNetwork, () => skillSearch({ query: "a project workspace" }, env)), "no skill matched; the universal skills in your prompt are `concise`");
    const excluded = await withFetch(noNetwork, () => pin(ctxOf(h.env)));
    assert.deepEqual(excluded.harness[STATE].excluded, ["projects"]);
    assert.deepEqual(excluded.harness[STATE].catalogue, ["concise", "packages"]);
  } finally {
    h.rm();
  }
});

test("the shipped vector file matches the bench corpus", () => {
  clearVectorCache();
  const meta = JSON.parse(require_("../../bench/suites/skill-recall-v1/corpus.json"));
  const file = benchVectorsFor(meta.sha256);
  assert.ok(file, "bench/vectors/<corpus sha256>.json exists");
  assert.equal(file.model, "openai/text-embedding-3-small");
  assert.equal(file.dimensions, 1536);
  assert.equal(Object.keys(file.skills).length, meta.records);
  assert.equal(Object.keys(file.queries).length, 90);
  for (const v of Object.values(file.skills).slice(0, 3)) assert.equal(v.length, 1536);
});

function require_(rel) {
  return readFileSync_(new URL(rel, import.meta.url));
}
import { readFileSync as readFileSync_ } from "node:fs";

test("denseThreshold: a cosine below it is not a dense hit; the pin turns lexical with a note; 0 keeps every hit", async () => {
  const h = home();
  try {
    clearCache();
    h.skill("packages", "Installs packages. Use when asked to install a package.");
    h.skill("projects", "Workspaces and projects. Use when a project is mentioned.");
    const conversation = [{ role: "user", content: "install a package for a project" }];
    const high = await withFetch(fakeFetch(), () => pin(ctxOf(h.env, { config: { ...withKey, denseThreshold: 1.01 }, conversation })));
    assert.equal(high.harness[STATE].mode, "lexical");
    assert.ok(high.harness[STATE].pinned.every((p) => p.how !== "dense"), JSON.stringify(high.harness[STATE].pinned));
    assert.deepEqual(high.harness[STATE].notes, ["no skill is within the dense threshold (1.01); the ranking is lexical"]);
    const low = await withFetch(fakeFetch(), () => pin(ctxOf(h.env, { config: { ...withKey, denseThreshold: 0 }, conversation })));
    assert.equal(low.harness[STATE].mode, "dense");
    assert.deepEqual(low.harness[STATE].notes, []);
    // The search ignores the floor: it asks for the closest thing whatever its distance.
    const found = await withFetch(fakeFetch(), () => skillSearch({ query: "install a package" }, toolEnv(h.env, { ...withKey, denseThreshold: 1.01 })));
    assert.match(found, /`packages`/);
    assert.ok(!found.includes("dense threshold"), found);
  } finally {
    h.rm();
  }
});
