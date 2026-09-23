// The neutral corpus. One body of content every mechanism imports into whatever shape it likes, so that a
// comparison varies the mechanism and holds the content still. Nothing here knows how any package stores it.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityRecord, Corpus } from "@thetis/runtime/contracts";

export interface CorpusFile extends Omit<Corpus, "records"> {
  records: number;
  file: string;
  seed: string;
  dataset?: { name: string; id: string; revision: string; url: string; license: string; split: string };
  sampling?: Record<string, unknown>;
}

export interface LoadedCorpus extends Corpus {
  meta: CorpusFile;
  canaries: Record<string, string>;
  bytesOf: Record<string, number>;
}

export function loadCorpus(dir: string): LoadedCorpus {
  const meta = JSON.parse(readFileSync(join(dir, "corpus.json"), "utf8")) as CorpusFile;
  const body = readFileSync(join(dir, meta.file), "utf8");
  const sha = `sha256:${createHash("sha256").update(body).digest("hex")}`;
  if (sha !== meta.sha256) {
    throw new Error(`corpus ${meta.id} does not match its recorded digest: the records say ${sha}, corpus.json says ${meta.sha256}`);
  }
  const records = body
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as CapabilityRecord);
  if (records.length !== meta.records) throw new Error(`corpus ${meta.id} claims ${meta.records} records and holds ${records.length}`);

  const canaries: Record<string, string> = {};
  const bytesOf: Record<string, number> = {};
  for (const record of records) {
    if (!record.body.includes(record.canary)) throw new Error(`corpus ${meta.id}: ${record.id} does not contain its own canary`);
    canaries[record.id] = record.canary;
    bytesOf[record.id] = Buffer.byteLength(record.body, "utf8");
  }
  return { id: meta.id, version: meta.version, sha256: meta.sha256, records, meta, canaries, bytesOf };
}

export const hasCorpus = (dir: string): boolean => existsSync(join(dir, "corpus.json"));

/**
 * Words a variant must not touch. A mutated query exists to check that a matcher keys on the task rather
 * than on a name or a number in it; if the mutator is free to delete the words the corpus matches on, the
 * number it produces measures the mutator instead.
 */
export function stoplist(corpus: Corpus): Set<string> {
  const stop = new Set<string>();
  for (const record of corpus.records) {
    for (const text of [record.name, record.description, ...record.tags]) {
      for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) if (word.length > 2) stop.add(word);
    }
  }
  return stop;
}

/** What a mechanism holding this corpus must be able to give back, unchanged, to be conformant. */
export function conformanceOf(corpus: Corpus): { id: string; name: string; description: string; tags: string[] }[] {
  return corpus.records.map((r) => ({ id: r.id, name: r.name, description: r.description, tags: r.tags }));
}
