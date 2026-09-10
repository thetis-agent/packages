/** Pin the fixed order, the budget cut and the determinism a no-ranking retriever promises. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { everything, stages } from './index.ts';
import { skillsFixture, skill } from '@/test/skills-fixture.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { RetrieveAnswer } from '@/contracts/skills/types.ts';

/** Bodies of a known size, so a budget in the tests below names an exact number of skills. */
const body = 'x'.repeat(40);
const request = { query: 'ignored', k: 0, budget: 4096, model: 'scripted' };

await test('universal skills lead and the rest follow by id, whatever the query asks for', async () => {
  const f = await skillsFixture({ one: skill('one', 'first', body), three: skill('three', 'third', body), two: skill('two', 'second', body, true) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = await everything(loaded.value.skills).retrieve({ ...request, query: 'one' });
    assert.deepEqual(answer.entries.map(entry => entry.id), ['two', 'one', 'three']);
    assert.deepEqual(answer.entries.map(entry => entry.how), ['universal', 'whole-corpus', 'whole-corpus']);
    assert.deepEqual(answer.entries.map(entry => entry.score), [undefined, undefined, undefined]);
  } finally { await f.close(); }
});

await test('a budget too small for the corpus drops from the end of that order and names the ids', async () => {
  const f = await skillsFixture({ one: skill('one', 'first', body), three: skill('three', 'third', body), two: skill('two', 'second', body) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    // Each body is 40 bytes, so 10 tokens: 25 pays for two whole skills and refuses to cut a third.
    const answer = await everything(loaded.value.skills).retrieve({ ...request, budget: 25 });
    assert.deepEqual(answer.entries.map(entry => entry.id), ['one', 'three']);
    assert.deepEqual(answer.dropped, ['two']);
    assert.ok(answer.entries.every(entry => typeof entry.body === 'string'));
  } finally { await f.close(); }
});

await test('identical requests produce byte-identical answers, and the query changes nothing', async () => {
  const f = await skillsFixture({ one: skill('one', 'first', body), two: skill('two', 'second', body, true) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = everything(loaded.value.skills);
    const answer = JSON.stringify(await stage.retrieve(request));
    assert.equal(JSON.stringify(await stage.retrieve(request)), answer);
    assert.equal(JSON.stringify(await stage.retrieve({ ...request, query: 'something else entirely', k: 64 })), answer);
  } finally { await f.close(); }
});

await test('an activated skill is kept without a body, and the answer still validates', async () => {
  const f = await skillsFixture({ one: skill('one', 'first', body), two: skill('two', 'second', body) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = await everything(loaded.value.skills).retrieve({ ...request, budget: 0, activate: ['two'] });
    assert.deepEqual(answer.entries.map(entry => entry.id), ['two']);
    assert.equal(answer.entries[0]?.body, undefined); assert.equal(answer.entries[0]?.['description'], 'second');
    assert.deepEqual(answer.dropped, ['one']);
    const schemas = new Schemas(); await schemas.load();
    assert.ok(schemas.validator<RetrieveAnswer>('skills', 'retrieveAnswer')(answer));
  } finally { await f.close(); }
});

await test('the stage answers nothing until init has read the corpus, then answers from it', async () => {
  const id = `attached-${randomUUID()}`;
  const alias = `pack-attached-${randomUUID()}@1.0.0`;
  const empty = await stages.retrieve(request);
  assert.deepEqual(empty, { entries: [], dropped: [] });
  await mkdir(join('/packages', alias, 'skills', id), { recursive: true });
  await writeFile(join('/packages', alias, 'skills', id, 'SKILL.md'), skill(id));
  const notices: string[] = [];
  try {
    await stages.init(undefined, { emit: notice => { notices.push(notice.content.map(part => part['text']).join('')); } });
    const answer = await stages.retrieve(request);
    assert.ok(answer.entries.some(entry => entry.id === id), JSON.stringify(answer.entries.map(entry => entry.id)));
    assert.deepEqual(notices, []);
  } finally { await rm(join('/packages', alias), { recursive: true, force: true }); }
});

await test('a pack that cannot load is reported as a notice rather than swallowed', async () => {
  const alias = `pack-broken-${randomUUID()}@1.0.0`;
  await mkdir(join('/packages', alias, 'skills'), { recursive: true });
  await symlink('/etc', join('/packages', alias, 'skills', 'linked'));
  const notices: string[] = [];
  try {
    await stages.init(undefined, { emit: notice => { notices.push(notice.content.map(part => part['text']).join('')); } });
    assert.ok(notices.some(text => text.startsWith(`${alias.slice(0, -6)}@1.0.0 was skipped:`)), notices.join('; '));
  } finally { await rm(join('/packages', alias), { recursive: true, force: true }); }
});
