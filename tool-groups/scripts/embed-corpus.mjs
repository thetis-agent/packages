#!/usr/bin/env node
// Embeds the tool-recall@1 corpus and the suite's task queries once, so a bench run ranks densely without a
// key and gives the same answer on every machine. Run from the runtime root with OPENROUTER_API_KEY in the
// environment:
//
//   set -a; . ./.env; set +a; node packages/tool-groups/scripts/embed-corpus.mjs
//
// The groups are derived from the same manifests the bench fixture installs (packages/bench/fixtures/tool-corpus),
// through the same deriveGroups a run uses, so the content hashes in the file are the ones a run looks up. The
// key is read from the environment and appears nowhere.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { embed, embeddingConfig, queryHashOf, queryTextOf, benchVectorsPath, hexOf } from "@thetis/skills";
import { packageInfoOf } from "../../bench/fixtures/tool-corpus/lib/manifest.js";
import { deriveGroups } from "../lib/groups.js";
import { contentHashOf, indexTextOf, VECTORS_DIR } from "../lib/dense.js";

const here = dirname(fileURLToPath(import.meta.url));
const suiteDir = resolve(here, "../../bench/suites/tool-recall-v1");

function loadCorpus(dir) {
  const meta = JSON.parse(readFileSync(resolve(dir, "corpus.json"), "utf8"));
  const body = readFileSync(resolve(dir, meta.file), "utf8");
  const sha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (sha !== meta.sha256) throw new Error(`corpus ${meta.id} does not match its recorded digest`);
  const records = body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
  if (records.length !== meta.records) throw new Error(`corpus ${meta.id} claims ${meta.records} records and holds ${records.length}`);
  return { id: meta.id, version: meta.version, sha256: meta.sha256, records };
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

  const { groups } = deriveGroups(corpus.records.map((r) => packageInfoOf(r)), {});
  if (groups.length !== corpus.records.length) throw new Error(`derived ${groups.length} groups for ${corpus.records.length} records`);
  const groupTexts = groups.map(indexTextOf);
  const queryTexts = [...new Set(tasks.map((x) => queryTextOf(x.query)))];
  process.stdout.write(`embedding ${groupTexts.length} groups and ${queryTexts.length} queries with ${cfg.model} (${cfg.dimensions} dimensions) at ${cfg.baseUrl}\n`);
  const vectors = await embed([...groupTexts, ...queryTexts], cfg);

  const out = { model: cfg.model, dimensions: cfg.dimensions, corpus: { id: corpus.id, version: corpus.version, sha256: corpus.sha256, records: corpus.records.length }, vectors: {}, queries: {} };
  const byHash = new Map(groups.map((g, i) => [contentHashOf(g), vectors[i]]));
  for (const hash of [...byHash.keys()].sort()) out.vectors[hash] = byHash.get(hash);
  const byQuery = new Map(queryTexts.map((q, i) => [queryHashOf(q), vectors[groupTexts.length + i]]));
  for (const hash of [...byQuery.keys()].sort()) out.queries[hash] = byQuery.get(hash);

  const path = benchVectorsPath(hexOf(corpus.sha256), VECTORS_DIR);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(out)}\n`);
  process.stdout.write(`wrote ${path}: ${Object.keys(out.vectors).length} group vectors, ${Object.keys(out.queries).length} query vectors\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    process.stderr.write(`${e?.message ?? e}\n`);
    process.exit(1);
  },
);
