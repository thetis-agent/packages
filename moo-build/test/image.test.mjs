import test from "node:test";
import assert from "node:assert/strict";
import { levelSvg, splitName, toPng } from "../lib/image.js";
import { normalize } from "../lib/plan.js";

const build = normalize({ id: "#1", name: "A <b> & c", rooms: [
  { id: "#2", name: "</text><script>x</script>", x: 0, y: 0, z: 0, exits: [], edges: [] },
] });

test("names are escaped into the SVG, never markup", () => {
  const { svg } = levelSvg(build, 0);
  assert.ok(!svg.includes("<script>"));
  assert.ok(svg.includes("&lt;/text&gt;"));
  assert.ok(svg.includes("A &lt;b&gt; &amp; c"));
});

test("the editor's name split: ten a line, broken at a space", () => {
  assert.deepEqual(splitName("Plaza"), ["Plaza", ""]);
  assert.deepEqual(splitName("South Steps"), ["South", "Steps"]);
  assert.deepEqual(splitName("The Long Guardhouse Barracks"), ["The Long", "Guardhous…"]);
});

test("a large build is scaled to fit, a small one up to 1.5x", async () => {
  const small = await toPng(levelSvg(build, 0));
  assert.equal(small.scale, 1.5);
  const wide = normalize({ id: "#1", name: "Wide", rooms: Array.from({ length: 40 }, (_, i) => ({ id: `#${i + 2}`, name: "r", x: i, y: 0, z: 0, exits: [], edges: [] })) });
  const big = await toPng(levelSvg(wide, 0));
  assert.ok(Math.max(big.width, big.height) <= 1600);
});
