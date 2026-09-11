/** Guard the tray's own arithmetic, and hold it to the limits the host actually enforces; ADR 0038 §1.
 *
 * `assets/lib/attach.js` decides what may be attached before anything is uploaded, so that a person who
 * drops a 30 MB photograph learns it will not go while they are still looking at it, rather than after
 * waiting for the upload to be refused. That makes the rules true in two places at once, which is a thing
 * that rots — so the first test here reads both copies and fails if they have drifted apart.
 *
 * There is no DOM harness in this repository and adding one (jsdom, linkedom) would buy these tests a
 * dependency the house rules do not want. It is not needed. The decisions live in their own module,
 * apart from the tray that draws them, exactly as `assets/lib/dispatch.js` does: it is handed plain
 * `{name, type, size}` records rather than reaching for `File`, and it returns what to keep and what to
 * say rather than keeping or saying anything. The module is loaded the way `lib/package-loader/load.ts`
 * loads a package entry — a dynamic import taken as `unknown` and narrowed, never an `any`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';
import { settings } from './index.ts';

type Review = (files: unknown, held: unknown, bounds?: unknown) => unknown;
type Describe = (value: unknown) => unknown;

const here = dirname(fileURLToPath(import.meta.url));
const loaded: unknown = await import(pathToFileURL(join(here, 'assets/lib/attach.js')).href);
assert.ok(isObject(loaded), 'assets/lib/attach.js should load as a module namespace object.');

function named<T>(key: string, is: (value: unknown) => value is T): T {
  const value: unknown = isObject(loaded) ? loaded[key] : undefined;
  assert.ok(is(value), `assets/lib/attach.js should export ${key}.`);
  return value;
}
const isFunction = (value: unknown): value is Review & Describe => typeof value === 'function';

const limits = named('limits', isObject);
const reviewFiles = named('reviewFiles', isFunction);
const describeSize = named('describeSize', isFunction);
const summarise = named('summarise', isFunction);
const uploadPath = named('uploadPath', isFunction);
const readAnswer = named('readAnswer', isFunction);
const nameOf = named('nameOf', isFunction);

/** Reads the sorted batch back as untyped data, so the test checks the shape rather than trusting it. */
function review(files: unknown, held = 0): { accept: Record<string, unknown>[]; refusals: string[] } {
  const value: unknown = reviewFiles(files, held);
  assert.ok(isObject(value) && Array.isArray(value['accept']) && Array.isArray(value['refusals']), 'reviewFiles should return {accept, refusals}.');
  return { accept: value['accept'].filter(isObject), refusals: value['refusals'].filter((item): item is string => typeof item === 'string') };
}

function image(name: string, size: number, type = 'image/png'): Record<string, unknown> {
  return { name, size, type };
}

await test('the tray states the same three limits the host enforces', () => {
  assert.equal(limits['bytes'], settings.attachmentBytes, 'assets/lib/attach.js and gateway-web/index.ts disagree about the size limit.');
  assert.equal(limits['count'], settings.attachments, 'assets/lib/attach.js and gateway-web/index.ts disagree about how many may go.');
  assert.deepEqual(limits['types'], settings.attachmentTypes, 'assets/lib/attach.js and gateway-web/index.ts disagree about which types may go.');
});

await test('an ordinary batch of images is accepted in the order it arrived', () => {
  const files = [image('a.png', 1024), image('b.jpg', 2048, 'image/jpeg'), image('c.webp', 4096, 'image/webp')];
  const result = review(files);
  assert.deepEqual(result.accept, files);
  assert.deepEqual(result.refusals, []);
});

await test('anything that is not an allowed image is refused, and the refusal says only that', () => {
  const result = review([image('notes.pdf', 512, 'application/pdf'), image('page.html', 512, 'text/html'), image('mark.svg', 512, 'image/svg+xml'), image('none', 512, '')]);
  assert.deepEqual(result.accept, []);
  assert.deepEqual(result.refusals, ['Only images can be attached.'], 'four wrong files are one thing to say, not four.');
});

await test('an image over the limit is refused by name, and one exactly at the limit is not', () => {
  const result = review([image('huge.png', settings.attachmentBytes + 1), image('exact.png', settings.attachmentBytes)]);
  assert.deepEqual(result.accept.map(file => file['name']), ['exact.png']);
  assert.deepEqual(result.refusals, ['huge.png is too large — the limit is 8 MB.']);
  const unnamed = review([{ name: '', size: settings.attachmentBytes + 1, type: 'image/png' }]);
  assert.deepEqual(unnamed.refusals, ['That image is too large — the limit is 8 MB.']);
});

await test('an empty file is refused rather than uploaded to be refused', () => {
  const result = review([image('empty.png', 0), { name: 'odd.png', size: undefined, type: 'image/png' }]);
  assert.deepEqual(result.accept, []);
  assert.deepEqual(result.refusals, ['empty.png is empty.', 'odd.png is empty.']);
});

await test('the batch stops at the limit, counting what the tray already holds', () => {
  const many = Array.from({ length: settings.attachments + 2 }, (_, index) => image(`n${String(index)}.png`, 64));
  const fresh = review(many);
  assert.equal(fresh.accept.length, settings.attachments);
  assert.deepEqual(fresh.refusals, [`You can attach up to ${String(settings.attachments)} images to a message.`]);

  const nearlyFull = review(many, settings.attachments - 1);
  assert.equal(nearlyFull.accept.length, 1, 'one space left takes one more image.');
  assert.equal(nearlyFull.refusals.length, 1);

  const full = review(many, settings.attachments);
  assert.deepEqual(full.accept, []);
  assert.equal(full.refusals.length, 1);
});

await test('a batch with one bad file in it still attaches the rest', () => {
  const result = review([image('good.png', 64), image('notes.pdf', 64, 'application/pdf'), image('also-good.gif', 64, 'image/gif')]);
  assert.deepEqual(result.accept.map(file => file['name']), ['good.png', 'also-good.gif']);
  assert.deepEqual(result.refusals, ['Only images can be attached.']);
});

await test('nothing at all, and nothing usable, are both quiet rather than wrong', () => {
  for (const files of [[], undefined, null, [null, undefined, false]]) {
    const value: unknown = reviewFiles(files, 0);
    assert.ok(isObject(value));
    assert.deepEqual(value['accept'], []);
    assert.deepEqual(value['refusals'], []);
  }
});

await test('sizes are said the way a person would say them', () => {
  assert.equal(describeSize(0), '0 B');
  assert.equal(describeSize(512), '512 B');
  assert.equal(describeSize(2048), '2 KB');
  assert.equal(describeSize(1572864), '1.5 MB');
  assert.equal(describeSize(settings.attachmentBytes), '8.0 MB');
  for (const bad of [undefined, null, 'lots', -1, Number.NaN]) assert.equal(describeSize(bad), '');
});

await test('the line under the tray says how many are going and how much they weigh', () => {
  assert.equal(summarise([]), '');
  assert.equal(summarise(undefined), '');
  assert.equal(summarise([{ size: 1048576 }]), '1 image · 1.0 MB');
  assert.equal(summarise([{ size: 1048576 }, { size: 1048576 }]), '2 images · 2.0 MB');
  assert.equal(summarise([{ size: 1024 }, {}]), '2 images · 1 KB', 'a file whose size never arrived still counts as one file.');
});

await test('an upload address is relative and carries the name as a query, never as a path', () => {
  const conversation = '11111111-2222-3333-4444-555555555555';
  assert.equal(uploadPath(conversation, 'sunset.png'), `./api/attachments/${conversation}?name=sunset.png`);
  assert.equal(uploadPath(conversation, ''), `./api/attachments/${conversation}`);
  assert.equal(uploadPath(conversation, '../../etc/passwd'), `./api/attachments/${conversation}?name=..%2F..%2Fetc%2Fpasswd`);
  assert.equal(uploadPath('../elsewhere', 'x'), './api/attachments/..%2Felsewhere?name=x');
});

await test('a file with no name of its own still has something to show', () => {
  assert.equal(nameOf({ name: '  sunset.png  ' }), 'sunset.png');
  assert.equal(nameOf({}), '');
  assert.equal(nameOf(undefined), '');
  const long: unknown = nameOf({ name: 'x'.repeat(400) });
  assert.ok(typeof long === 'string'); assert.equal(long.length, 128);
});

await test('the upload answer is read for the five fields the wire needs, and a refusal is repeated in the host\'s own words', () => {
  const value = { name: 'a.png', mime: 'image/png', bytes: 12, hash: 'sha256:ab', path: '/state/attachments/c/ab.png' };
  assert.deepEqual(readAnswer({ ok: true, value }), { ok: true, value });
  assert.deepEqual(readAnswer({ ok: true, value: { ...value, extra: 'ignored' } }), { ok: true, value }, 'only the contracted fields travel on.');
  assert.deepEqual(readAnswer({ ok: false, error: { code: 'budget', message: 'That image is too large — the limit is 8 MB.' } }),
    { ok: false, message: 'That image is too large — the limit is 8 MB.' });
  for (const broken of [undefined, null, 'nonsense', {}, { ok: true }, { ok: true, value: { ...value, bytes: '12' } }, { ok: false, error: {} }]) {
    const answer: unknown = readAnswer(broken);
    assert.ok(isObject(answer) && answer['ok'] === false, `${JSON.stringify(broken)} is not a usable answer.`);
    assert.equal(answer['message'], 'That image could not be added. Try again.');
  }
});
