// The three-way line merge an out-of-date proposal is updated with: clean, conflict, identical sides,
// whitespace that counts as a change, and the size limit.
import { test } from "node:test";
import assert from "node:assert/strict";
import { MERGE_BYTES, hunks, merge3 } from "../lib/merge.js";

const BEFORE = "# Nova\n\nRule one.\n\nRule two.\n";

test("clean: changes in different places both land", () => {
  const change = "# Nova\n\nRule one.\n\nRule two.\n\nRule three.\n";
  const current = "# Nova, the island\n\nRule one.\n\nRule two.\n";
  assert.deepEqual(merge3(BEFORE, change, current), { ok: true, text: "# Nova, the island\n\nRule one.\n\nRule two.\n\nRule three.\n" });
  // A line changed on one side beside a line changed on the other.
  assert.deepEqual(merge3("a\nb\nc\nd\n", "a\nB\nc\nd\n", "a\nb\nC\nd\n"), { ok: true, text: "a\nB\nC\nd\n" });
  // Both added at the end: the current file's first, then the change's.
  assert.deepEqual(merge3("a\n", "a\nfrom the change\n", "a\nfrom today\n"), { ok: true, text: "a\nfrom today\nfrom the change\n" });
});

test("conflict: both sides changed the same lines", () => {
  assert.deepEqual(merge3(BEFORE, BEFORE.replace("Rule one.", "Rule one, firmly."), BEFORE.replace("Rule one.", "Rule 1.")), { ok: false });
  // An addition inside lines the other side replaced.
  assert.deepEqual(merge3("a\nb\nc\n", "a\nb\nb2\nc\n", "a\nX\n"), { ok: false });
  // Both added at one point in the middle: which goes first is not known.
  assert.deepEqual(merge3("a\nb\n", "a\nmine\nb\n", "a\ntheirs\nb\n"), { ok: false });
  // A new file that someone else wrote meanwhile.
  assert.deepEqual(merge3(null, "---\nname: x\n---\n", "written by hand\n"), { ok: false });
});

test("identical: no change, the same change on both sides, or the change already there", () => {
  assert.deepEqual(merge3(BEFORE, BEFORE, BEFORE), { ok: true, text: BEFORE });
  const change = BEFORE.replace("Rule two.", "Rule two, said once.");
  assert.deepEqual(merge3(BEFORE, change, BEFORE), { ok: true, text: change }, "today's file did not move");
  assert.deepEqual(merge3(BEFORE, BEFORE, change), { ok: true, text: change }, "the proposal changes nothing");
  assert.deepEqual(merge3(BEFORE, change, change), { ok: true, text: change }, "both made the same change");
  const both = change.replace("# Nova", "# Nova, the island");
  assert.deepEqual(merge3(BEFORE, both, change), { ok: true, text: both }, "a hunk both sides made is taken once");
});

test("whitespace is a change like any other", () => {
  const spaced = BEFORE.replace("Rule one.", "Rule one.  ");
  assert.deepEqual(merge3(BEFORE, BEFORE.replace("Rule one.", "Rule one, firmly."), spaced), { ok: false }, "trailing spaces on the same line conflict");
  assert.deepEqual(merge3(BEFORE, BEFORE.replace("Rule two.", "Rule 2."), spaced), { ok: true, text: spaced.replace("Rule two.", "Rule 2.") });
  assert.deepEqual(merge3("a\nb\n", "a\nb", "a\nb\n"), { ok: true, text: "a\nb" }, "a dropped final newline is kept");
});

test("over the size limit, or not text, it does not try", () => {
  const big = "x\n".repeat(MERGE_BYTES / 2 + 1);
  assert.deepEqual(merge3(big, `${big}y\n`, `z\n${big}`), { ok: false });
  assert.deepEqual(merge3(BEFORE, 42, BEFORE), { ok: false });
  assert.deepEqual(merge3(null, "a\n", null), { ok: true, text: "a\n" }, "nothing before and nothing now is a new file");
});

test("hunks: the lines of before each one replaces", () => {
  assert.deepEqual(hunks("a\nb\nc", "a\nB\nc"), [{ s: 1, e: 2, lines: ["B"] }]);
  assert.deepEqual(hunks("a\nc", "a\nb\nc"), [{ s: 1, e: 1, lines: ["b"] }]);
  assert.deepEqual(hunks("", "a"), [{ s: 0, e: 0, lines: ["a"] }]);
});
