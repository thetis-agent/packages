/** Cover the stored conversation summary the web sidebar reads — title, preview, stamps, archive; KS-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import { SessionStore, storeLimits } from './session-store.ts';

/** A counter rather than a wall clock: these stamps are asserted on, and a test may not read time. */
function ticking(start = 1_700_000_000_000, step = 1000): () => number {
  let at = start - step;
  return () => { at += step; return at; };
}

async function opened(now: () => number = ticking()) {
  const root = await mkdtemp('/tmp/session-store-');
  const schemas = new Schemas(); await schemas.load();
  const store = await SessionStore.open(join(root, 'conversations'), schemas, now);
  assert.ok(store.ok);
  return { root, store: store.value, close: () => rm(root, { recursive: true, force: true }) };
}

await test('a new conversation is stamped and unnamed, because nothing has been said in it yet', async () => {
  const f = await opened(ticking(5_000, 1000));
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.deepEqual([created.value.createdMs, created.value.updatedMs], [5000, 5000],
      'both stamps come from one reading, so a new row never looks edited after it was made.');
    assert.equal(created.value.title, undefined);
    assert.equal(created.value.preview, undefined);
    const read = await f.store.info(created.value.id); assert.ok(read.ok);
    assert.deepEqual(read.value, created.value, 'what create returns is exactly what list will read back.');
  } finally { await f.close(); }
});

await test('the first message names a conversation, and nothing said later renames it', async () => {
  const f = await opened(ticking(5_000, 1000));
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.ok((await f.store.record(created.value.id, '  Ship\n the   sidebar  ')).ok);
    const named = await f.store.info(created.value.id); assert.ok(named.ok);
    assert.equal(named.value.title, 'Ship the sidebar', 'whitespace is collapsed to one line for a one-line row.');
    assert.equal(named.value.preview, 'Ship the sidebar');
    assert.equal(named.value.updatedMs, 6000);
    assert.equal(named.value.createdMs, 5000, 'a recorded message never moves when the conversation was made.');

    assert.ok((await f.store.record(created.value.id, 'Done — the rows sort now.')).ok);
    const moved = await f.store.info(created.value.id); assert.ok(moved.ok);
    assert.equal(moved.value.title, 'Ship the sidebar', 'no wire carries a rename, so the first message keeps the name.');
    assert.equal(moved.value.preview, 'Done — the rows sort now.', 'the preview follows the conversation.');
    assert.equal(moved.value.updatedMs, 7000);
  } finally { await f.close(); }
});

await test('a summary is capped at its schema bound without splitting a character', async () => {
  const f = await opened();
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.ok((await f.store.record(created.value.id, 'x'.repeat(storeLimits.previewChars + 40))).ok);
    const capped = await f.store.info(created.value.id); assert.ok(capped.ok);
    assert.equal(Array.from(String(capped.value.title)).length, storeLimits.titleChars);
    assert.equal(Array.from(String(capped.value.preview)).length, storeLimits.previewChars);
    assert.ok(String(capped.value.title).endsWith('…'), 'a cut summary says it was cut.');

    const wide = await f.store.create({ surface: 'web' }); assert.ok(wide.ok);
    assert.ok((await f.store.record(wide.value.id, '\u{1F600}'.repeat(storeLimits.titleChars + 4))).ok);
    const emoji = await f.store.info(wide.value.id); assert.ok(emoji.ok);
    const title = String(emoji.value.title);
    assert.equal(Array.from(title).length, storeLimits.titleChars);
    assert.doesNotMatch(title, /[\uD800-\uDBFF](?![\uDC00-\uDFFF])/u, 'a cap in code units would leave half a character.');
  } finally { await f.close(); }
});

await test('a message with no words in it writes no summary but still moves the conversation', async () => {
  const f = await opened(ticking(5_000, 1000));
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.ok((await f.store.record(created.value.id, '   \n\t ')).ok);
    const blank = await f.store.info(created.value.id); assert.ok(blank.ok);
    assert.equal(blank.value.title, undefined, 'the schema requires a non-empty title, so none is written.');
    assert.equal(blank.value.preview, undefined);
    assert.equal(blank.value.updatedMs, 6000, 'a conversation just spoken to still sorts first.');

    assert.ok((await f.store.record(created.value.id, 'Real words.')).ok);
    assert.ok((await f.store.record(created.value.id, '')).ok);
    const kept = await f.store.info(created.value.id); assert.ok(kept.ok);
    assert.equal(kept.value.preview, 'Real words.', 'an empty reply leaves the standing preview rather than blanking the row.');
  } finally { await f.close(); }
});

await test('archiving round-trips through the list and refuses an id outside this environment', async () => {
  const f = await opened();
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.ok((await f.store.archive(created.value.id, true)).ok);
    const listed = await f.store.list({ archived: true }); assert.ok(listed.ok);
    assert.deepEqual(listed.value.map(row => row.archived), [true]);
    assert.ok((await f.store.archive(created.value.id, false)).ok);
    const restored = await f.store.list({ archived: true }); assert.ok(restored.ok);
    assert.deepEqual(restored.value.map(row => row.archived), [false]);

    const missing = await f.store.archive('00000000-0000-0000-0000-000000000001', true);
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'not-found',
      'a well-formed id for a conversation this environment does not hold is absent, not broken.');
    const bad = await f.store.record('../conversations', 'Hello');
    assert.ok(!bad.ok); assert.equal(bad.error.code, 'not-found');
  } finally { await f.close(); }
});

await test('a summary that violates the metadata schema is refused on write and on read', async () => {
  const f = await opened();
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    const path = join(f.root, 'conversations', created.value.id, 'metadata.json');
    const stored: unknown = JSON.parse(await readFile(path, 'utf8'));
    assert.ok(stored !== null && typeof stored === 'object');
    await writeFile(path, JSON.stringify({ ...stored, title: 'x'.repeat(storeLimits.titleChars + 1) }));
    const listed = await f.store.list(); assert.ok(!listed.ok); assert.equal(listed.error.code, 'io');
    const refused = await f.store.record(created.value.id, 'Hello');
    assert.ok(!refused.ok); assert.equal(refused.error.code, 'io');

    await writeFile(path, JSON.stringify({ ...stored, archived: 'yes' }));
    const wrong = await f.store.info(created.value.id); assert.ok(!wrong.ok); assert.equal(wrong.error.code, 'io');
  } finally { await f.close(); }
});

await test('an ordinary list leaves the archive out, and asking for it adds those rows rather than replacing them', async () => {
  const f = await opened();
  try {
    const kept = await f.store.create({ surface: 'web' }); assert.ok(kept.ok);
    const filed = await f.store.create({ surface: 'web' }); assert.ok(filed.ok);
    assert.ok((await f.store.archive(filed.value.id, true)).ok);
    const live = await f.store.list(); assert.ok(live.ok);
    assert.deepEqual(live.value.map(row => row.id), [kept.value.id],
      'the archive is out of the way by default, so a caller that asks for nothing gets the live conversations.');
    const both = await f.store.list({ archived: true }); assert.ok(both.ok);
    assert.deepEqual(both.value.map(row => row.id).sort(), [kept.value.id, filed.value.id].sort(),
      'asking for the archive adds it to the live rows; a sidebar draws both at once and asks once.');
  } finally { await f.close(); }
});

await test('renaming replaces a title the first message set, collapses it and moves the conversation', async () => {
  const f = await opened(ticking(5_000, 1000));
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    assert.ok((await f.store.record(created.value.id, 'Ship the sidebar')).ok);
    assert.ok((await f.store.rename(created.value.id, '  Sidebar\n  parity  ')).ok);
    const read = await f.store.info(created.value.id); assert.ok(read.ok);
    assert.equal(read.value.title, 'Sidebar parity', 'a typed name is collapsed to one line exactly as a derived one is.');
    assert.equal(read.value.preview, 'Ship the sidebar', 'renaming says nothing about what was last said.');
    assert.ok((read.value.updatedMs ?? 0) > (created.value.updatedMs ?? 0), 'the sidebar orders by this stamp, and the row changed.');
  } finally { await f.close(); }
});

await test('a conversation cannot be renamed to nothing, or past the cap a stored title keeps', async () => {
  const f = await opened();
  try {
    const created = await f.store.create({ surface: 'web' }); assert.ok(created.ok);
    for (const empty of ['', '   ', '\n\t']) {
      const refused = await f.store.rename(created.value.id, empty);
      assert.ok(!refused.ok); assert.equal(refused.error.code, 'invalid-args');
    }
    assert.ok((await f.store.rename(created.value.id, 'x'.repeat(storeLimits.titleChars * 2))).ok);
    const read = await f.store.info(created.value.id); assert.ok(read.ok);
    assert.equal(Array.from(read.value.title ?? '').length, storeLimits.titleChars);
    const missing = await f.store.rename('00000000-0000-0000-0000-000000000001', 'Anything');
    assert.ok(!missing.ok); assert.equal(missing.error.code, 'not-found');
  } finally { await f.close(); }
});
