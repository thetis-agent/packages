// The objdef path confinement, tested directly.
//
// This is the boundary mooR's own MCP host does NOT have: its four objdef
// tools take a caller-supplied path and use ordinary filesystem calls with no
// sandbox, so an assistant driving it can read or overwrite any file the
// process can. Its skill says so in as many words. That is the gap this test
// exists to keep closed.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { readObjdefFile, writeObjdefFile } from "./tools.js";

const home = await fs.mkdtemp(path.join(os.tmpdir(), "moo-confine-"));
const env = { cwd: home, config: { username: "u", password: "p" } };
const root = path.join(home, "workspace/torchship-objdef");
await fs.mkdir(root, { recursive: true });

// A secret outside the root, of the sort a real home has plenty of.
await fs.writeFile(path.join(home, "secret.txt"), "do not read me", "utf8");

let pass = 0;
const t = async (name, fn) => {
  try { await fn(); pass++; } catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
};

// --- what must work ---------------------------------------------------------
await t("writes and reads inside the root", async () => {
  await writeObjdefFile({ path: "objects/thing.moo", contents: "object #1\nendobject" }, env);
  const out = await readObjdefFile({ path: "objects/thing.moo" }, env);
  assert.match(out, /endobject/);
});

await t("the write is atomic (no .tmp left behind)", async () => {
  const entries = await fs.readdir(path.join(root, "objects"));
  assert.deepEqual(entries.filter((e) => e.includes(".tmp")), []);
});

// --- what must be refused ---------------------------------------------------
const escapes = [
  ["parent traversal", "../../secret.txt"],
  ["deep traversal", "objects/../../../secret.txt"],
  ["absolute path", "/etc/passwd"],
  ["absolute path in home", path.join(home, "secret.txt")],
  ["bare dotdot", ".."],
  ["single dot", "."],
];
for (const [label, p] of escapes) {
  await t(`refuses read: ${label}`, async () => {
    await assert.rejects(() => readObjdefFile({ path: p }, env), /objdef path|missing path/);
  });
  await t(`refuses write: ${label}`, async () => {
    await assert.rejects(() => writeObjdefFile({ path: p, contents: "x" }, env), /objdef path|missing path/);
  });
}

await t("the secret was never touched", async () => {
  assert.equal(await fs.readFile(path.join(home, "secret.txt"), "utf8"), "do not read me");
});

// A symlink inside the root pointing out of it is the subtle one: the path
// itself contains no traversal at all.
await t("refuses a symlink that escapes the root", async () => {
  await fs.symlink(path.join(home, "secret.txt"), path.join(root, "sneaky.moo"));
  await assert.rejects(() => readObjdefFile({ path: "sneaky.moo" }, env), /symlink/);
});

await t("refuses a symlinked directory that escapes the root", async () => {
  const outside = path.join(home, "outside");
  await fs.mkdir(outside, { recursive: true });
  await fs.symlink(outside, path.join(root, "linkdir"));
  await assert.rejects(
    () => writeObjdefFile({ path: "linkdir/x.moo", contents: "x" }, env),
    /symlink/,
  );
  // And nothing was created through the link.
  assert.deepEqual(await fs.readdir(outside), []);
});

await t("refuses when env.cwd is absent rather than guessing a root", async () => {
  await assert.rejects(() => readObjdefFile({ path: "objects/thing.moo" }, { config: {} }), /env\.cwd/);
});

await fs.rm(home, { recursive: true, force: true });
console.log(`${pass} passed`);
