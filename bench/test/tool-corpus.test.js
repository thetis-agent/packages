// The tool-recall@1 suite's own consistency: the corpus digest, the canary in one tool description of every
// record, every routable group needed by at least three tasks, and the paraphrase tasks really avoiding the
// tags of the groups they need, which is what makes them a test of the dense path and not of the tags.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { score, tokens } from "@thetis/tool-groups/lib/groups.js";

const dir = resolve(fileURLToPath(import.meta.url), "../../suites/tool-recall-v1");
const meta = JSON.parse(readFileSync(resolve(dir, "corpus.json"), "utf8"));
const body = readFileSync(resolve(dir, meta.file), "utf8");
const records = body.split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const tasks = readFileSync(resolve(dir, "tasks.jsonl"), "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l));
const byId = new Map(records.map((r) => [r.id, r]));

test("the corpus matches its digest and every record carries its canary in one tool description and in the body", () => {
  assert.equal(`sha256:${createHash("sha256").update(body).digest("hex")}`, meta.sha256);
  assert.equal(records.length, meta.records);
  for (const r of records) {
    assert.ok(r.body.includes(r.canary), `${r.id}: canary in body`);
    assert.equal(r.tools.filter((t) => t.description.includes(r.canary)).length, 1, `${r.id}: canary in exactly one tool description`);
    assert.ok(r.tags.every((t) => /^[a-z0-9-]+$/.test(t)), `${r.id}: lowercase tags`);
  }
  assert.deepEqual(records.filter((r) => r.alwaysOn).map((r) => r.id), ["files"]);
  const names = records.flatMap((r) => r.tools.map((t) => t.name));
  assert.equal(new Set(names).size, names.length, "no tool name is in two groups");
});

test("every routable group is needed by at least three tasks, every task names known groups, and the families are labelled", () => {
  const counts = new Map();
  for (const t of tasks) {
    assert.ok(["direct", "paraphrase", "scenario", "mixed", "control"].includes(t.family), `${t.id}: family`);
    assert.equal(t.control === true, t.groups.length === 0, `${t.id}: a control needs nothing`);
    for (const id of t.groups) {
      assert.ok(byId.has(id) && !byId.get(id).alwaysOn, `${t.id}: ${id} is a routable corpus group`);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  for (const r of records.filter((r) => !r.alwaysOn)) assert.ok((counts.get(r.id) ?? 0) >= 3, `${r.id} is needed by ${counts.get(r.id) ?? 0} tasks`);
  assert.ok(tasks.length >= 60);
  assert.ok(tasks.filter((t) => t.control).length >= 3);
});

test("a direct task hits a tag of every group it needs; a paraphrase task hits none of them", () => {
  for (const t of tasks) {
    const q = tokens(t.query);
    for (const id of t.groups) {
      const s = score(byId.get(id), q);
      if (t.family === "direct" || t.family === "scenario") assert.ok(s >= 0.5, `${t.id}: ${id} scores ${s} on "${t.query}"`);
      if (t.family === "paraphrase") assert.equal(s, 0, `${t.id}: ${id} echoes a tag in "${t.query}"`);
    }
  }
});
