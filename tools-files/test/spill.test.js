// Spill tests: a 100000-character string must produce head/tail/footer and a spill file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spill, BUDGET } from "../lib/spill.js";

test("under budget text is returned unchanged", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tf-spill-"));
  const out = await spill("short text", "read_path", { cwd: home });
  assert.equal(out, "short text");
  await rm(home, { recursive: true, force: true });
});

test("a 100000-character string is spilled with head, tail, and footer", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tf-spill-"));
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push(`line ${i} `.padEnd(20, "x"));
  const big = lines.join("\n");
  assert.ok(big.length > 90000 && big.length < 110000);

  const out = await spill(big, "read_path", { cwd: home });
  assert.ok(out.length < big.length);
  assert.match(out, /characters not shown here/);
  assert.match(out, /--- the end of the output ---/);
  assert.match(out, /Do not repeat the call: read_path with offset and limit/);
  assert.ok(out.startsWith("line 0"));
  assert.ok(out.trimEnd().split("\n").some((l) => l.includes(`line ${lines.length - 1}`.trim())) || out.includes("line 4999"));

  const files = await readdir(resolve(home, "tool-output"));
  assert.equal(files.length, 1);
  const spilled = await readFile(resolve(home, "tool-output", files[0]), "utf8");
  assert.equal(spilled, big);

  await rm(home, { recursive: true, force: true });
});

test("footer names the file relative to home", async () => {
  const home = await mkdtemp(resolve(tmpdir(), "tf-spill-"));
  const big = "x".repeat(BUDGET + 1000);
  const out = await spill(big, "search_files", { cwd: home });
  assert.match(out, /tool-output\/search_files-\d+\.txt/);
  await rm(home, { recursive: true, force: true });
});
