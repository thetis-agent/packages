// Checks the manifest against the module: every declared export must exist,
// names must be unique, and every schema must be well formed. This is the
// failure the wasm original could not have — a tool whose manifest and code
// disagree — so it is worth a test.
import assert from "node:assert/strict";
import fs from "node:fs";
import * as tools from "./tools.js";

const pkg = JSON.parse(fs.readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const declared = pkg.thetis.tools;

let problems = 0;
const bad = (m) => { console.error("FAIL " + m); problems++; };

// 1. every declared export exists and is callable
for (const t of declared) {
  if (typeof tools[t.export] !== "function") bad(`${t.name}: export '${t.export}' is not a function in tools.js`);
}

// 2. names unique, and prefixed
const names = declared.map((t) => t.name);
for (const n of names) {
  if (names.indexOf(n) !== names.lastIndexOf(n)) bad(`duplicate tool name ${n}`);
  if (!n.startsWith("moo_")) bad(`${n} does not start with moo_`);
}

// 3. schemas well formed, and every required key is declared
for (const t of declared) {
  const p = t.parameters;
  assert.equal(p.type, "object", `${t.name} parameters must be an object schema`);
  for (const r of p.required ?? []) {
    if (!(r in p.properties)) bad(`${t.name}: required '${r}' is not in properties`);
  }
  if (!t.description || t.description.length < 30) bad(`${t.name}: description too thin`);
  if (p.additionalProperties !== false) bad(`${t.name}: additionalProperties should be false`);
}

// 4. no exported tool function is left undeclared (a tool nobody can call)
const exportedFns = Object.entries(tools)
  .filter(([, v]) => typeof v === "function")
  .map(([k]) => k);
const declaredExports = new Set(declared.map((t) => t.export));
const orphans = exportedFns.filter((f) => !declaredExports.has(f) && !["applyUnifiedDiff"].includes(f));
if (orphans.length) bad(`exported but not declared as tools: ${orphans.join(", ")}`);

// 5. the unified-diff applier: the property that matters is refuse-on-mismatch
const base = "line one\nline two\nline three";
const good = "@@ -1,3 +1,3 @@\n line one\n-line two\n+line TWO\n line three";
assert.equal(tools.applyUnifiedDiff(base, good), "line one\nline TWO\nline three");

const stale = "@@ -1,3 +1,3 @@\n line one\n-line WRONG\n+line TWO\n line three";
assert.throws(() => tools.applyUnifiedDiff(base, stale), /no write performed/, "a stale patch must refuse");

const badContext = "@@ -1,3 +1,3 @@\n nonexistent context\n-line two\n+x\n line three";
assert.throws(() => tools.applyUnifiedDiff(base, badContext), /no write performed/, "bad context must refuse");

assert.throws(() => tools.applyUnifiedDiff(base, "no hunks here"), /no @@ hunk/);

// a pure addition
assert.equal(
  tools.applyUnifiedDiff("a\nb", "@@ -1,2 +1,3 @@\n a\n+mid\n b"),
  "a\nmid\nb",
);

console.log(
  problems === 0
    ? `wiring ok: ${declared.length} tools, ${declared.length} exports resolved, diff applier verified`
    : `${problems} problems`,
);
process.exitCode = problems ? 1 : 0;
