// The injection boundary: caller text only ever reaches MOO source as a literal.
import test from "node:test";
import assert from "node:assert/strict";
import { lit, objRef, descriptionValue, createRoomSource, linkSource, guard } from "../lib/source.js";

test("strings become escaped literals on one line", () => {
  assert.equal(lit('a "b" \\ c'), '"a \\"b\\" \\\\ c"');
  assert.equal(lit("one\ntwo\tthree\r"), '"one two three"');
  assert.equal(lit(["x", 1]), '{"x", 1}');
});

test("object references are ids or corified names, nothing else", () => {
  assert.equal(objRef("#12"), "#12");
  assert.equal(objRef("12"), "#12");
  assert.equal(objRef("#0011e5-9cb7359f34"), 'toobj("#0011E5-9CB7359F34")');
  assert.equal(objRef("$room"), "$room");
  for (const bad of ["#1; recycle(#2)", "$a; b", "player", "#-1)", ""]) assert.throws(() => objRef(bad), /must be an object id/);
});

test("a description with several lines is stored as a list of lines", () => {
  assert.equal(descriptionValue("One."), "One.");
  assert.deepEqual(descriptionValue("One.\r\nTwo."), ["One.", "Two."]);
});

test("a hostile name is inert inside the generated program", () => {
  const src = createRoomSource("#100", { x: 0, y: 0, z: 0, name: '"; recycle(#1); "' });
  assert.ok(src.includes('room:set_name("\\"; recycle(#1); \\"")'));
  assert.ok(!src.includes("\n"));
});

test("every write starts with the authority check", () => {
  const head = guard("#100");
  assert.ok(createRoomSource("#100", { x: 0, y: 0, z: 0, name: "A" }).startsWith(head));
  assert.ok(linkSource("#100", { from: "#1", to: "#2", dir: "e" }).startsWith(head));
  assert.match(head, /area in `player\.builds ! ANY => \{\}'/);
});

test("a link names both halves with the MOO's long direction names", () => {
  const src = linkSource("#100", { from: "#1", to: "#2", dir: "ne", type: "door" });
  assert.match(src, /a:set_name\("northeast"\)/);
  assert.match(src, /b:set_name\("southwest"\)/);
  assert.match(src, /etype = \$door;/);
  assert.throws(() => linkSource("#100", { from: "#1", to: "#2", dir: "in" }), /unknown direction/);
});
