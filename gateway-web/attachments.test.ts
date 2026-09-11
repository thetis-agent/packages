/** Hold the attachment store to the person-scoped sandbox it promises, and to the limits index.ts names;
 * ADR 0005, ADR 0019.
 *
 * Two things are being proved here and they are not the same thing. One is the arithmetic: 8 MiB, eight of
 * them, and an allow-list of image types, each refused in words a person can act on. The other is the
 * containment: an attachment lands inside its own conversation's directory and nowhere else, and a `send`
 * frame cannot talk this store into opening a file it did not write — which is the part that matters,
 * because the descriptors a frame carries are typed by a browser and every field in them is a claim.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile, symlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Attachments } from './attachments.ts';
import type { Descriptor, Limits } from './attachments.ts';
import { settings } from './index.ts';

const bounds: Limits = { attachmentBytes: 8388608, attachments: 8, attachmentTypes: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] };
const conversation = 'a1b2c3d4-e5f6-4789-abcd-ef0123456789';
const other = 'b0b0b0b0-1111-4222-8333-cccccccccccc';
/** A real, if tiny, PNG: the eight-byte signature and an IHDR, so nothing here is testing an empty buffer. */
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489', 'hex');

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'thetis-attachments-'));
  const store = Attachments.open(root, bounds); assert.ok(store.ok);
  return { root, store: store.value, close: () => rm(root, { recursive: true, force: true }) };
}

await test('the limits the served composer states are the limits this store enforces', () => {
  assert.equal(bounds.attachmentBytes, settings.attachmentBytes);
  assert.equal(bounds.attachments, settings.attachments);
  assert.deepEqual(bounds.attachmentTypes, settings.attachmentTypes);
});

await test('an allowed type whose name could not be a file suffix is refused when the store opens, not on the first upload', () => {
  const refused = Attachments.open('/tmp', { ...bounds, attachmentTypes: ['image/svg+xml'] });
  assert.ok(!refused.ok); assert.equal(refused.error.code, 'invalid-args');
  assert.ok(Attachments.open('/tmp', { ...bounds, attachmentTypes: [] }).ok, 'an empty allow-list is a refusal of everything, not a mistake in the source.');
});

await test('a saved image lands under its own conversation, is named by its content, and is described by what the wire needs', async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(conversation, 'sunset.png', 'image/png', png); assert.ok(saved.ok);
    const digest = createHash('sha256').update(png).digest('hex');
    assert.deepEqual(saved.value, { name: 'sunset.png', mime: 'image/png', bytes: png.byteLength, hash: `sha256:${digest}`,
      path: join(f.root, 'attachments', conversation, `${digest}.png`) });
    assert.deepEqual(await readFile(saved.value.path), png);
    assert.deepEqual(await readdir(join(f.root, 'attachments')), [conversation], 'nothing outside this conversation was created.');
  } finally { await f.close(); }
});

await test('the same image added twice costs one file, whatever the person called it each time', async () => {
  const f = await fixture();
  try {
    const first = await f.store.save(conversation, 'a.png', 'image/png', png); assert.ok(first.ok);
    const second = await f.store.save(conversation, 'b.png', 'image/png', png); assert.ok(second.ok);
    assert.equal(second.value.path, first.value.path);
    assert.equal(second.value.name, 'b.png', 'the label follows the person, the file follows the bytes.');
    assert.equal((await readdir(join(f.root, 'attachments', conversation))).length, 1);
  } finally { await f.close(); }
});

await test('a name that names a path, or nothing at all, becomes a label that names neither', async () => {
  const f = await fixture();
  try {
    const climbing = await f.store.save(conversation, '../../etc/passwd', 'image/png', png); assert.ok(climbing.ok);
    assert.equal(climbing.value.name, '.. .. etc passwd');
    assert.equal(climbing.value.path, join(f.root, 'attachments', conversation, `${createHash('sha256').update(png).digest('hex')}.png`));
    const unnamed = await f.store.save(conversation, undefined, 'image/png', png); assert.ok(unnamed.ok);
    assert.equal(unnamed.value.name, 'image.png', 'a pasted picture has no filename and still needs something to show.');
  } finally { await f.close(); }
});

await test('only the allowed image types may be saved, and the refusal says so in one sentence', async () => {
  const f = await fixture();
  try {
    for (const type of ['application/pdf', 'text/html', 'image/svg+xml', 'image/png; charset=utf-8', '', undefined]) {
      const refused = await f.store.save(conversation, 'thing', type, png);
      assert.ok(!refused.ok, `${String(type)} should not be storable.`);
      assert.equal(refused.error.message, 'Only images can be attached.');
    }
    for (const type of bounds.attachmentTypes) assert.ok((await f.store.save(conversation, 'ok', type, png)).ok);
  } finally { await f.close(); }
});

await test('an image over the limit is refused, and the refusal names the limit as a person would say it', async () => {
  const f = await fixture();
  try {
    const large = Buffer.alloc(bounds.attachmentBytes + 1, 7);
    const refused = await f.store.save(conversation, 'big.png', 'image/png', large);
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'budget');
    assert.equal(refused.error.message, 'That image is too large — the limit is 8 MB.');
    assert.ok((await f.store.save(conversation, 'just.png', 'image/png', Buffer.alloc(bounds.attachmentBytes, 7))).ok, 'exactly the limit still goes.');
    const empty = await f.store.save(conversation, 'nothing.png', 'image/png', Buffer.alloc(0));
    assert.ok(!empty.ok); assert.equal(empty.error.message, 'That file is empty.');
  } finally { await f.close(); }
});

await test('anything that is not a conversation identifier stores nothing and leaves no directory behind', async () => {
  const f = await fixture();
  try {
    for (const id of ['..', '../..', 'not-a-conversation', `${conversation}/..`, '', conversation.toUpperCase()]) {
      const refused = await f.store.save(id, 'x.png', 'image/png', png);
      assert.ok(!refused.ok, `${id} should name no conversation.`); assert.equal(refused.error.code, 'not-found');
    }
    assert.deepEqual(await readdir(f.root), [], 'a refused conversation creates nothing to hold its refusal.');
  } finally { await f.close(); }
});

/** `#directory` canonicalises through resolvePath, so a conversation directory replaced by a link out of
 *  the tree is refused rather than followed — the one way a write could otherwise escape the person. */
await test('a conversation directory that has been turned into a link out of the store is refused', async () => {
  const f = await fixture();
  const outside = await mkdtemp(join(tmpdir(), 'thetis-elsewhere-'));
  try {
    await mkdir(join(f.root, 'attachments'), { recursive: true });
    await symlink(outside, join(f.root, 'attachments', conversation));
    const refused = await f.store.save(conversation, 'x.png', 'image/png', png);
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'not-found');
    assert.deepEqual(await readdir(outside), [], 'nothing was written through the link.');
  } finally { await f.close(); await rm(outside, { recursive: true, force: true }); }
});

await test('a message may name at most the allowed number of images', async () => {
  const f = await fixture();
  try {
    const saved: Descriptor[] = [];
    for (let index = 0; index <= bounds.attachments; index++) {
      const one = await f.store.save(conversation, `n${String(index)}.png`, 'image/png', Buffer.concat([png, Buffer.from([index])]));
      assert.ok(one.ok); saved.push(one.value);
    }
    assert.ok((await f.store.accept(conversation, saved.slice(0, bounds.attachments))).ok);
    const refused = await f.store.accept(conversation, saved);
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'budget');
    assert.equal(refused.error.message, 'You can attach up to 8 images to a message.');
    assert.deepEqual(await f.store.accept(conversation, undefined), { ok: true, value: [] });
    assert.deepEqual(await f.store.accept('not-a-conversation', []), { ok: true, value: [] }, 'naming nothing needs no conversation to name it in.');
  } finally { await f.close(); }
});

await test('accept rebuilds the path from the conversation, the hash and the type, and believes nothing the frame said about it', async () => {
  const f = await fixture();
  try {
    const mine = await f.store.save(conversation, 'mine.png', 'image/png', png); assert.ok(mine.ok);
    const theirs = await f.store.save(other, 'theirs.png', 'image/png', png); assert.ok(theirs.ok);
    await writeFile(join(f.root, 'secret.png'), png);

    const accepted = await f.store.accept(conversation, [mine.value]); assert.ok(accepted.ok);
    assert.deepEqual(accepted.value, [mine.value]);

    // The same bytes, so the same hash — but claimed from the other conversation's copy of them.
    const borrowed = await f.store.accept(conversation, [theirs.value]);
    assert.ok(!borrowed.ok); assert.equal(borrowed.error.message, 'That file is no longer available. Add it again.');

    for (const path of [join(f.root, 'secret.png'), '/etc/passwd', `${mine.value.path}/../../secret.png`, '']) {
      const forged = await f.store.accept(conversation, [{ ...mine.value, path }]);
      assert.ok(!forged.ok, `${path} should not be reachable.`); assert.equal(forged.error.code, 'invalid-args');
    }
    // A hash that is not a hash, and one that is but names nothing stored.
    for (const hash of ['sha256:nonsense', mine.value.hash.slice(7), `sha256:${'ab'.repeat(32)}`]) {
      assert.ok(!(await f.store.accept(conversation, [{ ...mine.value, hash }])).ok);
    }
    // A type off the list cannot be accepted even when its file is genuinely there under another name.
    const retyped = await f.store.accept(conversation, [{ ...mine.value, mime: 'image/svg+xml' }]);
    assert.ok(!retyped.ok); assert.equal(retyped.error.message, 'Only images can be attached.');
    for (const value of [null, 'a string', 42, []]) assert.ok(!(await f.store.accept(conversation, [value])).ok);
  } finally { await f.close(); }
});

await test('accept reports what is on disk rather than what the frame claimed about it', async () => {
  const f = await fixture();
  try {
    const mine = await f.store.save(conversation, 'mine.png', 'image/png', png); assert.ok(mine.ok);
    const accepted = await f.store.accept(conversation, [{ ...mine.value, bytes: 1, name: 'renamed.png' }]);
    assert.ok(accepted.ok);
    assert.deepEqual(accepted.value, [{ ...mine.value, name: 'renamed.png' }], 'the byte count is measured, never taken; the label is the one part the person owns.');
    await rm(mine.value.path);
    const gone = await f.store.accept(conversation, [mine.value]);
    assert.ok(!gone.ok); assert.equal(gone.error.code, 'not-found');
  } finally { await f.close(); }
});

await test('reading an image back accepts only a name this store could have written', async () => {
  const f = await fixture();
  try {
    const saved = await f.store.save(conversation, 'mine.png', 'image/png', png); assert.ok(saved.ok);
    const file = saved.value.path.slice(saved.value.path.lastIndexOf('/') + 1);
    const found = await f.store.file(conversation, file); assert.ok(found.ok);
    assert.deepEqual(found.value, { path: saved.value.path, mime: 'image/png', bytes: png.byteLength });

    await writeFile(join(f.root, 'attachments', conversation, 'notes.txt'), 'plain');
    for (const name of ['notes.txt', '..', '../../secret.png', file.replace('.png', '.svg'), file.replace('.png', ''), '']) {
      const refused = await f.store.file(conversation, name);
      assert.ok(!refused.ok, `${name} should not be readable.`); assert.equal(refused.error.code, 'not-found');
    }
    assert.ok(!(await f.store.file(other, file)).ok, 'another conversation cannot read this one’s images.');
  } finally { await f.close(); }
});
