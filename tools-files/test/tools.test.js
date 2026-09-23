// End-to-end tool tests against a temp home: read_path's byte-budget footer, edit_path's
// not-found/not-unique messages, write_path's overwrite refusal, search_files' partial footer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir, chmod, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { readPath } from "../lib/read-path.js";
import { editPath } from "../lib/edit-path.js";
import { writePath } from "../lib/write-path.js";
import { searchFiles } from "../lib/search-files.js";

async function makeHome() {
  const home = await mkdtemp(resolve(tmpdir(), "tf-tools-"));
  return { home, env: { cwd: home, shared: null } };
}

test("editing and overwriting an executable preserve its mode, including bits outside the current umask", async (t) => {
  const { home, env } = await makeHome();
  t.after(() => rm(home, { recursive: true, force: true }));
  const file = resolve(home, "run.sh");
  await writeFile(file, "#!/bin/sh\necho before\n");
  await chmod(file, 0o775);

  await editPath({ path: "run.sh", old_text: "before", new_text: "after" }, env);
  assert.equal((await stat(file)).mode & 0o777, 0o775);
  assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho after\n");

  await writePath({ path: "run.sh", contents: "#!/bin/sh\necho replaced\n", overwrite: true }, env);
  assert.equal((await stat(file)).mode & 0o777, 0o775);
  assert.equal(await readFile(file, "utf8"), "#!/bin/sh\necho replaced\n");
});

test("read_path's footer reports the byte budget when it stops the window first", async () => {
  const { home, env } = await makeHome();
  // 500 lines of 200 chars each: well within the 2000-line default cap, but over the
  // 24000-byte budget, so the byte bound must be what stops it.
  const lines = [];
  for (let i = 0; i < 500; i++) lines.push("y".repeat(200));
  await writeFile(resolve(home, "big.txt"), lines.join("\n"));

  const out = await readPath({ path: "big.txt", limit: 2000 }, env);
  assert.match(out, /stopped at the output size limit/);
  assert.match(out, /read on with offset/);
  await rm(home, { recursive: true, force: true });
});

test("read_path reports completion footer when the whole file fits", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "small.txt"), "a\nb\nc");
  const out = await readPath({ path: "small.txt" }, env);
  assert.match(out, /\[lines 1-3 of 3\]/);
  await rm(home, { recursive: true, force: true });
});

test("read_path on a missing file", async () => {
  const { home, env } = await makeHome();
  await assert.rejects(readPath({ path: "nope.txt" }, env), /nope\.txt does not exist/);
  await rm(home, { recursive: true, force: true });
});

test("edit_path reports not-found clearly", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "f.txt"), "hello world\n");
  await assert.rejects(
    editPath({ path: "f.txt", old_text: "goodbye", new_text: "hi" }, env),
    /old_text was not found in f\.txt\. Read the file first/
  );
  await rm(home, { recursive: true, force: true });
});

test("edit_path reports ambiguity when old_text isn't unique", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "f.txt"), "foo\nfoo\nfoo\n");
  await assert.rejects(
    editPath({ path: "f.txt", old_text: "foo", new_text: "bar" }, env),
    /old_text appears 3 times in f\.txt/
  );
  await rm(home, { recursive: true, force: true });
});

test("edit_path replace_all changes every occurrence and returns a snippet", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "f.txt"), "foo\nfoo\nfoo\n");
  const out = await editPath({ path: "f.txt", old_text: "foo", new_text: "bar", replace_all: true }, env);
  assert.match(out, /replaced 3 occurrence\(s\)/);
  await rm(home, { recursive: true, force: true });
});

test("write_path refuses to overwrite without the flag", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "f.txt"), "one\ntwo\n");
  await assert.rejects(
    writePath({ path: "f.txt", contents: "new" }, env),
    /f\.txt exists \(3 lines\)\. Use edit_path/
  );
  const out = await writePath({ path: "f.txt", contents: "new", overwrite: true }, env);
  assert.match(out, /wrote f\.txt/);
  await rm(home, { recursive: true, force: true });
});

test("search_files reports a partial footer when max_results caps it", async () => {
  const { home, env } = await makeHome();
  await mkdir(resolve(home, "src"));
  for (let i = 0; i < 10; i++) {
    await writeFile(resolve(home, "src", `f${i}.txt`), "needle\nneedle\n");
  }
  const out = await searchFiles({ pattern: "needle", path: "src", max_results: 5 }, env);
  assert.match(out, /stopped at the first 5/);
  await rm(home, { recursive: true, force: true });
});

test("search_files count mode returns just a tally", async () => {
  const { home, env } = await makeHome();
  await writeFile(resolve(home, "a.txt"), "needle\nneedle\nother\n");
  const out = await searchFiles({ pattern: "needle", mode: "count" }, env);
  assert.match(out, /2 match\(es\)/);
  await rm(home, { recursive: true, force: true });
});
