// The composer's attachments, without a browser: what a paste or a drop yields, how the tray's list moves
// through uploading / ready / failed, and the exact `TurnInput` a message with pictures is sent as. The
// upload is injected, so a slow or a failing server is a promise this file controls.
import { test } from "node:test";
import assert from "node:assert/strict";
import { Attachments, buildInput, localContent, MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES, nameFor, pickFiles } from "../assets/lib/attachments.js";
import { sendTurn } from "../assets/lib/turn-send.js";
import { store } from "../assets/lib/store.js";

const file = (name, type, size = 10) => ({ name, type, size });

/** A `DataTransfer` as a paste or a drop hands it over: items with a kind, and a files list. */
function transfer(files, { text = false } = {}) {
  const items = files.map((f) => ({ kind: "file", type: f.type, getAsFile: () => f }));
  if (text) items.unshift({ kind: "string", type: "text/plain", getAsFile: () => null });
  return { items, files, types: files.length ? ["Files"] : ["text/plain"] };
}

function deferredUpload() {
  const pending = [];
  const upload = (f, name) => new Promise((resolve, reject) => pending.push({ f, name, resolve, reject }));
  return { upload, pending };
}

const settle = () => new Promise((r) => setTimeout(r, 0));

test("a paste of text carries no files and is left to the textarea", () => {
  const { taken, refused } = pickFiles(transfer([], { text: true }));
  assert.deepEqual(taken, []);
  assert.deepEqual(refused, []);
  assert.deepEqual(pickFiles(null), { taken: [], refused: [] });
});

test("a pasted screenshot is taken; a file of a kind the model cannot read is reported apart", () => {
  const shot = file("image.png", "image/png");
  const zip = file("a.zip", "application/zip");
  const { taken, refused } = pickFiles(transfer([shot, zip]));
  assert.deepEqual(taken, [shot]);
  assert.deepEqual(refused, [zip]);
});

test("a drop whose items list is empty falls back to its files", () => {
  const shot = file("a.jpg", "image/jpeg");
  const { taken } = pickFiles({ items: [], files: [shot] });
  assert.deepEqual(taken, [shot]);
});

test("a pasted image gets a name with a clock in it; a real file keeps its own", () => {
  const at = new Date("2026-09-23T13:47:05.123Z");
  assert.equal(nameFor(file("image.png", "image/png"), at), "pasted-20260923-134705Z.png");
  assert.equal(nameFor(file("blob", "image/jpeg"), at), "pasted-20260923-134705Z.jpg");
  assert.equal(nameFor(file("diagram.png", "image/png"), at), "diagram.png");
});

test("an added file uploads at once, holds the send while travelling, and is ready with its asset", async () => {
  const { upload, pending } = deferredUpload();
  let changes = 0;
  const tray = new Attachments({ upload, onChange: () => changes++ });
  const refused = tray.add([file("diagram.png", "image/png", 2048)]);
  assert.deepEqual(refused, []);
  assert.equal(tray.length, 1);
  assert.equal(tray.busy, true);
  assert.deepEqual(tray.parts(), []);
  assert.equal(pending[0].name, "diagram.png");
  pending[0].resolve({ id: "a_1", mediaType: "image/png", name: "diagram.png", size: 2048 });
  await settle();
  assert.equal(tray.busy, false);
  assert.deepEqual(tray.parts(), [{ type: "asset", data: { id: "a_1", mediaType: "image/png", name: "diagram.png" } }]);
  assert.equal(changes, 2, "once when added, once when ready");
});

test("a failed upload is shown as failed, kept out of the message, and can be retried", async () => {
  const { upload, pending } = deferredUpload();
  const tray = new Attachments({ upload });
  tray.add([file("a.png", "image/png")]);
  pending[0].reject(new Error("The server is away."));
  await settle();
  assert.equal(tray.items[0].status, "failed");
  assert.equal(tray.items[0].error, "The server is away.");
  assert.equal(tray.busy, false);
  assert.deepEqual(tray.parts(), []);
  tray.retry(tray.items[0].key);
  assert.equal(tray.items[0].status, "uploading");
  pending[1].resolve({ id: "a_2", mediaType: "image/png" });
  await settle();
  assert.equal(tray.items[0].status, "ready");
  assert.deepEqual(tray.parts().map((p) => p.data.id), ["a_2"]);
});

test("an attachment removed while its upload travels does not come back when the upload lands", async () => {
  const { upload, pending } = deferredUpload();
  const tray = new Attachments({ upload });
  tray.add([file("a.png", "image/png")]);
  tray.remove(tray.items[0].key);
  assert.equal(tray.length, 0);
  pending[0].resolve({ id: "a_1", mediaType: "image/png" });
  await settle();
  assert.equal(tray.length, 0);
  assert.deepEqual(tray.parts(), []);
});

test("too large, of the wrong kind, or one too many are refused with a reason and never uploaded", () => {
  const { upload, pending } = deferredUpload();
  const tray = new Attachments({ upload });
  const refused = tray.add([
    file("huge.png", "image/png", MAX_ATTACHMENT_BYTES + 1),
    file("notes.txt", "text/plain"),
    ...Array.from({ length: MAX_ATTACHMENTS + 1 }, (_, i) => file(`p${i}.png`, "image/png")),
  ]);
  assert.equal(tray.length, MAX_ATTACHMENTS);
  assert.equal(pending.length, MAX_ATTACHMENTS);
  assert.equal(refused.length, 3);
  assert.match(refused[0].reason, /8 MB/);
  assert.match(refused[1].reason, /cannot read/);
  assert.match(refused[2].reason, new RegExp(`at most ${MAX_ATTACHMENTS}`));
});

test("clear and restore give a refused send its attachments back", () => {
  const { upload } = deferredUpload();
  const tray = new Attachments({ upload });
  tray.add([file("a.png", "image/png")]);
  const kept = tray.items;
  tray.clear();
  assert.equal(tray.length, 0);
  tray.restore(kept);
  assert.equal(tray.length, 1);
  assert.equal(tray.items[0], kept[0]);
});

test("text alone is sent as the string every gateway knows; with attachments it is one user message of parts", () => {
  assert.equal(buildInput("  hello ", []), "hello");
  const parts = [{ type: "asset", data: { id: "a_1", mediaType: "image/png", name: "a.png" } }];
  assert.deepEqual(buildInput("look", parts), { role: "user", content: [{ type: "text", data: { text: "look" } }, ...parts] });
  assert.deepEqual(buildInput("   ", parts), { role: "user", content: parts }, "a picture with no words is still a message");
  assert.equal(localContent("hello"), "hello");
  assert.deepEqual(localContent(buildInput("look", parts)), [{ type: "text", data: { text: "look" } }, ...parts]);
});

test("sendTurn posts `{ text }` for a string and `{ input }` for a message with parts", async (t) => {
  const previous = globalThis.fetch;
  const bodies = [];
  globalThis.fetch = (path, init) => { bodies.push([path, JSON.parse(init.body)]); return Promise.resolve(new Response("{}", { status: 202 })); };
  t.after(() => { globalThis.fetch = previous; store.set({ running: new Set() }); });
  store.set({ running: new Set() });
  await sendTurn("s_a", "hello");
  const message = { role: "user", content: [{ type: "text", data: { text: "look" } }, { type: "asset", data: { id: "a_1", mediaType: "image/png" } }] };
  await sendTurn("s_a", message);
  assert.deepEqual(bodies, [
    ["api/sessions/s_a/send", { text: "hello" }],
    ["api/sessions/s_a/send", { input: message }],
  ]);
});
