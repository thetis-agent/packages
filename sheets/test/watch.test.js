// The watcher over a temporary home: the snapshot first, a change with the revision and who made it after a
// tool wrote and after the page saved (every write of a run of them), nothing for the lock or temporary
// files, a removal, one sheet only when asked, and an end on abort. It leans on inotify, so the waits are
// generous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmdirSync } from "node:fs";
import { resolve } from "node:path";
import { sheetCreate, sheetDelete, sheetWrite, uiSave, uiWatch } from "../index.js";
import { idIn, makeEnv } from "./helpers.js";

async function next(iterator, ms = 3000) {
  let timer;
  const clock = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error("no event in time")), ms);
  });
  try {
    return (await Promise.race([iterator.next(), clock])).value;
  } finally {
    clearTimeout(timer);
  }
}

const settle = (ms = 400) => new Promise((r) => setTimeout(r, ms));

test("snapshot, changed after a tool's write and a page's save, removed after a delete, and the end on abort", async (t) => {
  const { env, done } = await makeEnv({ session: "s_1" });
  const control = new AbortController();
  const it = uiWatch({}, { ...env, signal: control.signal })[Symbol.asyncIterator]();
  t.after(async () => {
    control.abort();
    await it.return?.().catch(() => {});
    await done();
  });
  const snapshot = await next(it);
  assert.deepEqual(snapshot, { ev: "snapshot", sheets: [], projects: [] });

  const id = idIn(await sheetCreate({ title: "Live", rows: [[1, 2]] }, env));
  const made = await next(it);
  assert.deepEqual({ ...made, updatedAt: "" }, { ev: "changed", sheet: id, rev: 1, title: "Live", project: null, updatedAt: "", tabs: 1, cells: 2, by: "agent", session: "s_1" });

  await sheetWrite({ sheet: id, cells: { C1: 3 } }, env);
  const wrote = await next(it);
  assert.equal(wrote.rev, 2);
  assert.equal(wrote.cells, 3);
  assert.equal(wrote.by, "agent");

  await uiSave({ id, ops: [{ op: "set", tab: "t1", cells: { D1: 4 } }] }, { ...env, session: { id: "s_page" } });
  const saved = await next(it);
  assert.deepEqual([saved.rev, saved.by, saved.session], [3, "person", "s_page"]);

  // Node's recursive watch follows inodes and soon reports only the temporary name of a rename; every write is still heard.
  for (let n = 0; n < 4; n++) {
    await sheetWrite({ sheet: id, cells: { E1: n } }, env);
    assert.equal((await next(it)).rev, 4 + n);
  }

  const lock = resolve(env.cwd, "sheets", id, ".lock");
  mkdirSync(lock);
  rmdirSync(lock);
  await env.writeFile(`sheets/${id}/.sheet.json.tmp-1`, "half");
  await settle();
  await sheetDelete({ sheet: id }, env);
  const gone = await next(it);
  assert.deepEqual(gone, { ev: "removed", sheet: id }, "the lock and a temporary file made no event of their own");

  const ended = it.next();
  control.abort();
  assert.deepEqual(await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("did not end")), 2000))]), { value: undefined, done: true });
});

test("watching one sheet hears only that sheet", async (t) => {
  const { env, done } = await makeEnv();
  const a = idIn(await sheetCreate({ title: "A" }, env));
  const b = idIn(await sheetCreate({ title: "B" }, env));
  const control = new AbortController();
  const it = uiWatch({ sheet: a }, { ...env, signal: control.signal })[Symbol.asyncIterator]();
  t.after(async () => {
    control.abort();
    await it.return?.().catch(() => {});
    await done();
  });
  assert.equal((await next(it)).sheets.length, 2);
  await sheetWrite({ sheet: b, cells: { A1: 1 } }, env);
  await settle();
  await sheetWrite({ sheet: a, cells: { A1: 1 } }, env);
  const heard = await next(it);
  assert.equal(heard.sheet, a);
  assert.equal(heard.rev, 2);
});
