// The watcher over a temporary home: the snapshot first, a change with the files' facts and the revision
// after a tool wrote, a removal, nothing for temporary files, and an end on abort. It leans on inotify, so
// the waits are generous.
import { test } from "node:test";
import assert from "node:assert/strict";
import { canvasCreate, canvasDelete, canvasLayout, canvasWriteBoard, uiWatch } from "../index.js";
import { idIn, makeEnv, page } from "./helpers.js";

async function next(iterator, ms = 3000) {
  let timer;
  const clock = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("no event in time")), ms); });
  try {
    return (await Promise.race([iterator.next(), clock])).value;
  } finally {
    clearTimeout(timer);
  }
}

test("snapshot, changed after a write, removed after a delete, and the end on abort", async (t) => {
  const { env, done } = await makeEnv();
  const control = new AbortController();
  const it = uiWatch({}, { ...env, signal: control.signal })[Symbol.asyncIterator]();
  t.after(async () => {
    control.abort();
    await it.return?.().catch(() => {});
    await done();
  });
  const snapshot = await next(it);
  assert.equal(snapshot.ev, "snapshot");
  assert.deepEqual(snapshot.canvases, []);
  const id = idIn(await canvasCreate({ title: "Live" }, env));
  const made = await next(it);
  assert.deepEqual({ ...made, updatedAt: "" }, { ev: "changed", canvas: id, rev: 1, title: "Live", project: null, updatedAt: "", files: {}, assets: [] });
  await canvasWriteBoard({ canvas: id, file: "Main.html", html: page() }, env);
  let changed = await next(it);
  // The HTML and the index are two renames; the debounce usually folds them, but a second event is fine too.
  if (changed.rev !== 2) changed = await next(it);
  assert.equal(changed.rev, 2);
  assert.equal(changed.files["Main.html"].size, page().length);
  await env.writeFile(`canvases/${id}/.Main.html.tmp-1`, "half");
  await new Promise((r) => setTimeout(r, 400));
  await canvasDelete({ canvas: id }, env);
  const gone = await next(it);
  assert.deepEqual(gone, { ev: "removed", canvas: id }, "a temporary file made no event of its own");
  const ended = it.next();
  control.abort();
  assert.deepEqual(await Promise.race([ended, new Promise((_, reject) => setTimeout(() => reject(new Error("did not end")), 2000))]), { value: undefined, done: true });
});

test("every write of a run is heard, though the watcher reports only the temporary names after a few renames", async (t) => {
  const { env, done } = await makeEnv();
  const control = new AbortController();
  const it = uiWatch({}, { ...env, signal: control.signal })[Symbol.asyncIterator]();
  t.after(async () => {
    control.abort();
    await it.return?.().catch(() => {});
    await done();
  });
  await next(it);
  const id = idIn(await canvasCreate({ title: "Run" }, env));
  await next(it);
  let rev = 1;
  for (let i = 0; i < 6; i++) {
    await new Promise((r) => setTimeout(r, 250));
    await canvasLayout({ canvas: id, title: `Run ${i}` }, env);
    rev++;
    let event = await next(it);
    while (event.rev < rev) event = await next(it);
    assert.equal(event.rev, rev, `write ${i + 1} was heard`);
    assert.equal(event.title, `Run ${i}`);
  }
});
