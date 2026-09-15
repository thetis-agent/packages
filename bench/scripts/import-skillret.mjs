#!/usr/bin/env node
// Builds the capability corpus and the retrieval gold from SkillRet, a public dataset of real agent skills
// with human-checked query-to-skill relevance judgements.
//
// The corpus is imported rather than written here on purpose. Gold that decides which retrieval package wins
// must not be authored by anyone who has a stake in the answer, and SkillRet was assembled by people who have
// never heard of Thetis. Everything this script does is deterministic from SEED, so the sample is a fact
// about the inputs rather than a choice made on the day.
//
//   node packages/bench/scripts/import-skillret.mjs --source <dir> [--holdback <dir>]
//
// `--source` holds the three files of the SkillRet test split, named as the dataset names them:
//   skills/test.jsonl  queries/test.jsonl  qrels/test.jsonl
// Fetch them from https://huggingface.co/datasets/ThakiCloud/SKILLRET at the revision named below.
import { createHash, createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const DATASET = {
  name: "SkillRet",
  id: "ThakiCloud/SKILLRET",
  revision: "a050ad233a504a43135bafe8cdf45574052b5729",
  url: "https://huggingface.co/datasets/ThakiCloud/SKILLRET",
  license: "Apache-2.0",
  split: "test",
};

const SEED = "thetis/bench/caps/v1";
const CORPUS_ID = "caps@1";

// Queries are sampled first and the corpus is built from what they need, plus distractors. Sampling the
// corpus first and keeping whatever queries happen to fit throws away almost everything: at a 4% sample of
// 6,006 skills, a query with two gold skills survives about one time in six hundred.
const TASKS = { tune: 30, holdout: 50, holdback: 40 };
// Records nothing asks for. This is the pressure the whole exercise is about: with no distractors an arm
// that injects the entire corpus is also the arm with perfect precision, and there is nothing to measure.
const DISTRACTORS = 90;

// The conformance rule: a description is the retrieval key and must stay small enough to list. Records that
// break it are dropped rather than trimmed, because trimming would change the key the bench scores.
const MAX_DESCRIPTION = 1024;
// One 180 kB body would dominate every byte figure in the suite. The ninetieth percentile is about 17 kB, so
// this keeps the corpus representative and bounded without editing any record that stays in it.
const MAX_BODY = 32 * 1024;

const arg = (name, fallback) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};

const readJsonl = (path) =>
  readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));

/** xorshift32 from a seed: the same sample on every machine, for ever. */
function random(seed) {
  let state = createHash("sha256").update(seed).digest().readUInt32BE(0) || 1;
  return () => {
    state ^= state << 13;
    state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5;
    state >>>= 0;
    return state / 4294967296;
  };
}

function shuffled(items, seed) {
  const out = [...items];
  const draw = random(seed);
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(draw() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * An opaque token the bench can look for in an assembled prompt. A mechanism may reformat a body however it
 * likes and must keep this; that is what lets the bench verify what actually reached the model without
 * knowing anything about how the mechanism works.
 */
const canaryOf = (id) => `⟦c:${createHmac("sha256", SEED).update(id).digest("hex").slice(0, 10)}⟧`;

/** Placed after the front matter so it survives a mechanism that reformats or re-wraps the prose. */
function withCanary(body, canary) {
  const end = body.startsWith("---") ? body.indexOf("\n---", 3) : -1;
  const at = end < 0 ? 0 : end + 4;
  return `${body.slice(0, at)}\n${canary}\n${body.slice(at)}`;
}

function main() {
  const source = resolve(arg("source", "/tmp/skillret"));
  const outDir = resolve(arg("out", "packages/bench/suites/skill-recall-v1"));
  const holdbackDir = arg("holdback") ? resolve(arg("holdback")) : null;

  const skills = readJsonl(join(source, "skills", "test.jsonl"));
  const queries = readJsonl(join(source, "queries", "test.jsonl"));
  const qrels = readJsonl(join(source, "qrels", "test.jsonl"));
  console.error(`read ${skills.length} skills, ${queries.length} queries, ${qrels.length} judgements`);

  const eligible = skills.filter(
    (s) => s.body && s.description && Buffer.byteLength(s.description) <= MAX_DESCRIPTION && Buffer.byteLength(s.body) <= MAX_BODY,
  );
  console.error(
    `${skills.length - eligible.length} records dropped: no body, a description over ${MAX_DESCRIPTION} bytes, or a body over ${MAX_BODY} bytes`,
  );
  const byId = new Map(eligible.map((s) => [s.id, s]));

  const goldOf = new Map();
  for (const row of qrels) {
    if (!row.relevance) continue;
    goldOf.set(row.query_id, [...(goldOf.get(row.query_id) ?? []), row.skill_id]);
  }

  // A query is usable when every skill it needs survived the filters above.
  const usable = queries.filter((q) => {
    const gold = goldOf.get(q.id) ?? q.skill_ids ?? [];
    return gold.length > 0 && gold.every((id) => byId.has(id));
  });
  const want = TASKS.tune + TASKS.holdout + TASKS.holdback;
  const chosen = shuffled(usable, `${SEED}:tasks`).slice(0, want);
  console.error(`${usable.length} usable queries; ${chosen.length} sampled`);

  const needed = new Set();
  for (const q of chosen) for (const id of goldOf.get(q.id) ?? q.skill_ids ?? []) needed.add(id);

  // Distractors are stratified by the dataset's own taxonomy, so the noise a retriever must see past looks
  // like the corpus rather than like one corner of it.
  const rest = eligible.filter((s) => !needed.has(s.id));
  const byMajor = new Map();
  for (const skill of rest) byMajor.set(skill.major ?? "Unclassified", [...(byMajor.get(skill.major ?? "Unclassified") ?? []), skill]);
  const majors = [...byMajor.keys()].sort();
  const perMajor = Math.ceil(DISTRACTORS / majors.length);
  const distractors = [];
  for (const major of majors) distractors.push(...shuffled(byMajor.get(major), `${SEED}:distract:${major}`).slice(0, perMajor));

  const corpusSkills = [...needed].map((id) => byId.get(id)).concat(shuffled(distractors, `${SEED}:distract`).slice(0, DISTRACTORS));
  console.error(`corpus: ${needed.size} records some task needs, ${Math.min(DISTRACTORS, distractors.length)} distractors`);

  const records = corpusSkills
    .map((s) => {
      const id = `cap.${s.major ?? "misc"}.${s.name}`.toLowerCase().replace(/[^a-z0-9.]+/g, "-").replace(/-+/g, "-");
      const canary = canaryOf(id);
      return {
        id,
        source: s.id,
        name: s.name,
        description: s.description,
        tags: [s.major, s.sub, s.domain, s.primary_action].filter(Boolean),
        canary,
        body: withCanary(s.body, canary),
      };
    })
    .sort((a, b) => a.id.localeCompare(b.id));
  const bySource = new Map(records.map((r) => [r.source, r]));

  const taskOf = (q, split) => {
    const gold = (goldOf.get(q.id) ?? q.skill_ids ?? []).map((sourceId) => bySource.get(sourceId)?.id).filter(Boolean).sort();
    return {
      id: q.id,
      query: q.query,
      required: gold,
      split,
      tags: [gold.length > 1 ? "multi-capability" : "single-capability", ...new Set(gold.map((id) => id.split(".")[1]))],
      turns: 1,
      source: `${DATASET.id}@${DATASET.revision}#${q.id}`,
    };
  };

  const take = (from, n, split) => chosen.slice(from, from + n).map((q) => taskOf(q, split));
  const tune = take(0, TASKS.tune, "tune");
  const holdout = take(TASKS.tune, TASKS.holdout, "holdout");
  const holdback = take(TASKS.tune + TASKS.holdout, TASKS.holdback, "holdback");

  // A control task is one no capability in the corpus should help with. Without these, an arm that injects
  // everything looks perfect: it can only be caught where the right answer is to inject nothing.
  const controls = [
    "Say hello.",
    "What does the word fence mean in this system?",
    "Explain in two sentences why a prompt cache prefix has to stay byte identical.",
    "Do you think a three level skill cache is worth the complexity?",
    "What time zone is UTC+2 in summer?",
    "Give me a two sentence summary of what you just did.",
    "Repeat the last thing I asked, word for word.",
    "How many turns has this conversation had?",
    "Count from one to five.",
    "Is it going to rain tomorrow?",
  ].map((query, i) => ({
    id: `ctl-${String(i + 1).padStart(3, "0")}`,
    query,
    required: [],
    control: true,
    split: "holdout",
    tags: ["control", "negative"],
    turns: 1,
    source: "authored: a task no capability should help with",
  }));

  const corpusBody = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
  const sha = `sha256:${createHash("sha256").update(corpusBody).digest("hex")}`;

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "corpus.jsonl"), corpusBody);
  writeFileSync(
    join(outDir, "corpus.json"),
    `${JSON.stringify(
      {
        id: CORPUS_ID,
        version: "1.0.0",
        sha256: sha,
        records: records.length,
        file: "corpus.jsonl",
        seed: SEED,
        dataset: DATASET,
        sampling: {
          strata: majors,
          distractors: DISTRACTORS,
          maxDescriptionBytes: MAX_DESCRIPTION,
          maxBodyBytes: MAX_BODY,
          rule: "queries sampled first from a seeded shuffle; the corpus is every skill they need plus distractors stratified by the dataset's major category",
        },
      },
      null,
      2,
    )}\n`,
  );
  const visible = [...tune, ...holdout, ...controls].sort((a, b) => a.id.localeCompare(b.id));
  writeFileSync(join(outDir, "tasks.jsonl"), `${visible.map((t) => JSON.stringify(t)).join("\n")}\n`);

  if (holdbackDir) {
    mkdirSync(holdbackDir, { recursive: true });
    writeFileSync(join(holdbackDir, "tasks.jsonl"), `${holdback.map((t) => JSON.stringify(t)).join("\n")}\n`);
    console.error(`held back ${holdback.length} tasks in ${holdbackDir} — outside the packages tree and outside every fence`);
  } else {
    console.error(`skipped the held-back split: pass --holdback <dir> to write it somewhere no package can read`);
  }

  console.error(`wrote ${records.length} records (${(corpusBody.length / 1e6).toFixed(2)} MB) and ${visible.length} visible tasks to ${outDir}`);
  console.error(`corpus ${sha}`);
}

main();
