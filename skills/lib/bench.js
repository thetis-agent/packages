// The bench seams every loader shares. The importer writes the corpus records as ordinary skills under the
// home, so a loader under the bench sees skills and nothing else; the map from corpus id to skill id is
// kept beside them, because a claim must name corpus ids. `claim` is the harness spread of the reference
// arms: the kernel replaces `harness`, so what is already there is carried forward.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { yamlString } from "./frontmatter.js";
import { NAME_RE, TAG_RE } from "./skill.js";

/** The harness key every loader writes its state under. */
export const STATE = "@thetis/skills";
/** The harness key the bench reads claims from. */
export const BENCH_KEY = "@thetis/bench";

export const CORPUS_PATH = "bench/corpus.json";
export const MAP_PATH = "bench/map.json";
export const MARKER_PATH = "bench/imported.json";

/** Leaves an import record, a claim, or both under `harness["@thetis/bench"]` without disturbing the rest. */
export function claim(ctx, self, importRecord, benchClaim) {
  const prev = ctx.harness?.[BENCH_KEY] && typeof ctx.harness[BENCH_KEY] === "object" ? ctx.harness[BENCH_KEY] : {};
  return {
    harness: {
      ...ctx.harness,
      [BENCH_KEY]: {
        ...prev,
        ...(importRecord ? { imports: { ...(prev.imports ?? {}), [self]: importRecord } } : {}),
        ...(benchClaim ? { claims: { ...(prev.claims ?? {}), [self]: { package: self, ...benchClaim } } } : {}),
      },
    },
  };
}

async function readJson(env, path) {
  let text;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if (e?.code === "ENOENT") return null;
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** A directory name for a record: the last segment of its id, made to fit the name rule when it does not. */
export function slugOf(record) {
  const last = String(record.id ?? "").split(".").pop() ?? "";
  if (NAME_RE.test(last)) return last;
  const cleaned = last.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return NAME_RE.test(cleaned) ? cleaned : `record-${createHash("sha256").update(String(record.id)).digest("hex").slice(0, 8)}`;
}

const tagOf = (t) => {
  const s = String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return TAG_RE.test(s) ? s : null;
};

/** The record's text after its own frontmatter, verbatim: that is where the canary lives. */
export function bodyOf(record) {
  const body = String(record.body ?? "").replace(/\r\n/g, "\n");
  const m = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(body);
  const rest = m ? body.slice(m[0].length) : body;
  return record.canary && !rest.includes(record.canary) ? body : rest;
}

/**
 * One SKILL.md for a record. The frontmatter is generated, not copied: the corpus frontmatters use YAML the
 * format does not read. The title is the corpus id, so a brief names the record and a catalogue claim can be
 * verified by the bench; the description and the body stay as the record has them.
 */
export function skillFileOf(record, slug) {
  const tags = [...new Set((record.tags ?? []).map(tagOf).filter(Boolean))].slice(0, 32);
  const lines = ["---", `name: ${slug}`, `description: ${yamlString(record.description)}`, "metadata:", `  title: ${yamlString(record.id)}`];
  if (tags.length) lines.push(`  tags: [${tags.map(yamlString).join(", ")}]`);
  lines.push("---", "");
  return `${lines.join("\n")}${bodyOf(record)}`;
}

/**
 * Writes `bench/corpus.json` as `skills/<id>/SKILL.md` under the home, once per corpus sha256 (a marker file
 * says which corpus is on disk). Returns the import record for `harness["@thetis/bench"]`, or nothing when
 * there is no corpus: a suite without one (`assembly-cost@1`) calls the importer too.
 */
export async function importCorpus(ctx, self) {
  const corpus = await readJson(ctx.env, CORPUS_PATH);
  if (!corpus || !Array.isArray(corpus.records)) return;
  const sha = String(corpus.sha256 ?? "");
  const marker = await readJson(ctx.env, MARKER_PATH);
  if (marker && marker.sha256 === sha && existsSync(resolve(ctx.env.cwd, MAP_PATH))) {
    return claim(ctx, self, { imported: marker.skills, representation: marker.representation, bytesOnDisk: marker.bytes, builtMs: 0 });
  }
  const t0 = Date.now();
  const ids = {};
  const used = new Set();
  let bytes = 0;
  for (const record of corpus.records) {
    let slug = slugOf(record);
    for (let n = 2; used.has(slug); n++) slug = `${slugOf(record)}-${n}`;
    used.add(slug);
    const dir = resolve(ctx.env.cwd, "skills", slug);
    mkdirSync(dir, { recursive: true });
    const text = skillFileOf(record, slug);
    writeFileSync(resolve(dir, "SKILL.md"), text);
    bytes += Buffer.byteLength(text, "utf8");
    ids[record.id] = slug;
  }
  const representation = `${corpus.records.length} skills under skills/, one SKILL.md each with a generated frontmatter; bench/map.json maps corpus ids to skill ids`;
  mkdirSync(resolve(ctx.env.cwd, "bench"), { recursive: true });
  writeFileSync(resolve(ctx.env.cwd, MAP_PATH), JSON.stringify({ corpus: corpus.id, sha256: sha, ids }, null, 2));
  writeFileSync(resolve(ctx.env.cwd, MARKER_PATH), JSON.stringify({ sha256: sha, skills: corpus.records.length, bytes, representation }));
  return claim(ctx, self, { imported: corpus.records.length, representation, bytesOnDisk: bytes, builtMs: Date.now() - t0 });
}

/** The map the importer left: `toCorpus` (skill id to corpus id) and `toSkill`, or null outside a bench. */
export function readMap(env) {
  try {
    const raw = JSON.parse(readFileSync(resolve(env.cwd, MAP_PATH), "utf8"));
    const toSkill = new Map(Object.entries(raw.ids ?? {}));
    const toCorpus = new Map([...toSkill].map(([c, s]) => [s, c]));
    return { corpus: raw.corpus, sha256: raw.sha256, toSkill, toCorpus };
  } catch {
    return null;
  }
}

/** Skill ids to corpus ids through the map; an id the corpus does not know is left out. */
export function corpusIds(map, ids) {
  if (!map) return [];
  return ids.map((id) => map.toCorpus.get(id)).filter(Boolean);
}
