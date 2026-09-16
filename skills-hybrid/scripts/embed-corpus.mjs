#!/usr/bin/env node
// Embeds the bench corpus and the suite's task queries once, so a bench run ranks densely without a key and
// gives the same answer on every machine. Run from the runtime root with OPENROUTER_API_KEY in the environment:
//
//   set -a; . ./.env; set +a; node packages/skills-hybrid/scripts/embed-corpus.mjs
//
// The corpus goes through importCorpus, the same code path the bench importer uses, so the content hashes in
// the file are the ones a run will look up. The key is read from the environment and appears nowhere.
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { importCorpus, loadSkills } from "@thetis/skills";
import { DEFAULTS, embed, embeddingConfig, indexTextOf, queryHashOf, queryTextOf } from "../lib/embed.js";
import { benchVectorsPath, hexOf } from "../lib/vectors.js";

const here = dirname(fileURLToPath(import.meta.url));
const suiteDir = resolve(here, "../../bench/suites/skill-recall-v1");

function loadCorpus(dir) {
  const meta = JSON.parse(readFileSync(resolve(dir, "corpus.json"), "utf8"));
  const body = readFileSync(resolve(dir, meta.file), "utf8");
  const sha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (sha !== meta.sha256) throw new Error(`corpus ${meta.id} does not match its recorded digest`);
  const records = body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (records.length !== meta.records) throw new Error(`corpus ${meta.id} claims ${meta.records} records and holds ${records.length}`);
  return { id: meta.id, version: meta.version, sha256: meta.sha256, records };
}

function homeEnv(dir) {
  return {
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
}

async function main() {
  const apiKey = String(process.env.OPENROUTER_API_KEY ?? "").trim();
  if (!apiKey) {
    process.stderr.write("OPENROUTER_API_KEY is not set in the environment; nothing embedded.\n");
    return 2;
  }
  const cfg = embeddingConfig({ embeddings: { apiKey, baseUrl: process.env.THETIS_EMBED_BASE_URL, model: process.env.THETIS_EMBED_MODEL, dimensions: Number(process.env.THETIS_EMBED_DIMENSIONS) || undefined } });
  const corpus = loadCorpus(suiteDir);
  const tasks = readFileSync(resolve(suiteDir, "tasks.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));

  const home = mkdtempSync(resolve(tmpdir(), "embed-corpus-"));
  let skills;
  try {
    const env = homeEnv(home);
    await env.writeFile("bench/corpus.json", JSON.stringify(corpus));
    await importCorpus({ env, harness: {} }, "@thetis/skills-hybrid");
    skills = loadSkills(env, []);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  if (skills.length !== corpus.records.length) throw new Error(`imported ${skills.length} skills for ${corpus.records.length} records`);

  const skillTexts = skills.map(indexTextOf);
  const queryTexts = [...new Set(tasks.map((t) => queryTextOf(t.query)))];
  process.stdout.write(`embedding ${skillTexts.length} skills and ${queryTexts.length} queries with ${cfg.model} (${cfg.dimensions} dimensions) at ${cfg.baseUrl}\n`);
  const vectors = await embed([...skillTexts, ...queryTexts], cfg);

  const out = { model: cfg.model, dimensions: cfg.dimensions, corpus: { id: corpus.id, version: corpus.version, sha256: corpus.sha256, records: corpus.records.length }, skills: {}, queries: {} };
  const byHash = new Map(skills.map((s, i) => [s.contentHash, vectors[i]]));
  for (const hash of [...byHash.keys()].sort()) out.skills[hash] = byHash.get(hash);
  const byQuery = new Map(queryTexts.map((q, i) => [queryHashOf(q), vectors[skillTexts.length + i]]));
  for (const hash of [...byQuery.keys()].sort()) out.queries[hash] = byQuery.get(hash);

  const path = benchVectorsPath(hexOf(corpus.sha256));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out)}\n`);
  process.stdout.write(`wrote ${path}: ${Object.keys(out.skills).length} skill vectors, ${Object.keys(out.queries).length} query vectors\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  },
);
