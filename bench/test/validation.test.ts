import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { loadSuite } from "../src/suite.js";
import { readCapture } from "../src/capture.js";
import { loadCorpus } from "../src/corpus.js";

test("suite files reject mistyped task fields at their source", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-suite-schema-"));
  try {
    writeFileSync(join(dir, "suite.json"), JSON.stringify({ id: "suite", version: "1", probe: "A", tasks: [{ id: "task", query: "query", split: "training" }] }));
    assert.throws(() => loadSuite(dir), /suite.*tasks.*split/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("capture files reject corrupt measurements with line context", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-capture-schema-"));
  try {
    const path = join(dir, "capture.jsonl");
    writeFileSync(path, JSON.stringify({ canaryDirect: [], bytes: {}, run: 3 }) + "\n");
    assert.throws(() => readCapture(path), /capture.*1.*run/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a valid corpus digest does not make record fields trustworthy", () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-corpus-schema-"));
  try {
    const body = JSON.stringify({ id: "cap", name: "cap", description: "description", body: 42, tags: [], canary: "marker" }) + "\n";
    const sha256 = `sha256:${createHash("sha256").update(body).digest("hex")}`;
    writeFileSync(join(dir, "corpus.json"), JSON.stringify({ id: "corpus", version: "1", sha256, records: 1, file: "records.jsonl", seed: "seed" }));
    writeFileSync(join(dir, "records.jsonl"), body);
    assert.throws(() => loadCorpus(dir), /corpus.*records.jsonl.*line 1.*body/i);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
