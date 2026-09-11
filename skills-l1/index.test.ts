/** Hold the retrieve contract a second provider must also satisfy, and the level-2 tool; TE-005–008, TE-020. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { cataloguer, stages } from './index.ts';
import { skillsFixture, skill } from '@/test/skills-fixture.ts';
import { Schemas } from '@/lib/schema/index.ts';
import type { CallAnswer, CallRequest } from '@/contracts/turn-events/types.ts';
import type { RetrieveAnswer } from '@/contracts/skills/types.ts';

const request = { query: 'anything at all', k: 4, budget: 4096, model: 'scripted' };

function calling(name: string, args: Record<string, unknown>, mode: CallRequest['mode'] = { readOnly: false, deny: [] }): CallRequest {
  return { id: randomUUID(), name, args, mode, roots: [], deadlineMs: 1000, budget: { resultBytes: 32768 } };
}
/** What the model would read, which is the only part of an answer this stage puts in a conversation. */
function said(answer: CallAnswer): string {
  const part = answer.content?.[0];
  return part?.type === 'text' ? part.text : '';
}

await test('the catalog carries every skill by name and description, and only a universal body', async () => {
  const f = await skillsFixture({ query: skill('query', 'database query', 'Use transactions.'), house: skill('house', 'house style', 'Say less.', true) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = cataloguer(loaded.value.skills).retrieve(request);
    assert.deepEqual(answer.entries.map(entry => [entry['name'], entry['description'], entry.body]),
      [['house', 'house style', 'Say less.'], ['query', 'database query', undefined]]);
    assert.deepEqual(answer.entries.map(entry => entry.how), ['universal', 'whole-corpus']);
    assert.deepEqual(answer.dropped, []);
  } finally { await f.close(); }
});

await test('TE-005 a catalog entry that will not fit the budget is named rather than truncated', async () => {
  const f = await skillsFixture({ query: skill('query', 'Long description '.repeat(60)) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = cataloguer(loaded.value.skills).retrieve({ ...request, budget: 1 });
    assert.deepEqual(answer.entries, []); assert.deepEqual(answer.dropped, ['query']);
  } finally { await f.close(); }
});

await test('TE-006/TE-007 identical requests answer byte-identically, and the answer validates', async () => {
  const f = await skillsFixture({ query: skill('query'), house: skill('house') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = cataloguer(loaded.value.skills);
    const schemas = new Schemas(); await schemas.load();
    const answer = stage.retrieve({ ...request, future: 'ignored' });
    assert.ok(schemas.validator<RetrieveAnswer>('skills', 'retrieveAnswer')(answer));
    assert.equal(JSON.stringify(answer), JSON.stringify(stage.retrieve(request)));
  } finally { await f.close(); }
});

await test('TE-008 an activated skill carries its body even though the model never asked for it', async () => {
  const f = await skillsFixture({ query: skill('query', 'database query', 'Use transactions.') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = cataloguer(loaded.value.skills).retrieve({ ...request, activate: ['query'] });
    assert.equal(answer.entries[0]?.body, 'Use transactions.'); assert.equal(answer.entries[0].how, 'activated');
  } finally { await f.close(); }
});

await test('load_skill returns the body without its frontmatter, wrapped and listing its resources', async () => {
  const f = await skillsFixture({ rpg: skill('rpg', 'tabletop rules', 'Roll high.'), 'rpg/combat': skill('combat', 'combat rules', 'Roll higher.') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    const answer = cataloguer(loaded.value.skills).load(calling('load_skill', { name: 'rpg' }), 'one');
    assert.equal(answer.ok, true);
    assert.ok(!said(answer).includes('description:'), said(answer));
    assert.match(said(answer), /^<skill_content name="rpg">\nRoll high\.\n\nSkill directory: \/packages\/[^\n]+\/skills\/rpg\n<skill_resources><file>SKILL\.md<\/file><file>combat\/SKILL\.md<\/file><\/skill_resources>\n<\/skill_content>$/u);
  } finally { await f.close(); }
});

await test('a skill loaded twice in one conversation is not sent twice, and another conversation still gets it', async () => {
  const f = await skillsFixture({ query: skill('query', 'database query', 'Use transactions.') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = cataloguer(loaded.value.skills);
    const first = stage.load(calling('load_skill', { name: 'query' }), 'one');
    const again = stage.load(calling('load_skill', { name: 'query' }), 'one');
    const other = stage.load(calling('load_skill', { name: 'query' }), 'two');
    assert.match(said(first), /Use transactions\./u);
    assert.equal(again.ok, true); assert.equal(said(again), 'query is already loaded in this conversation.');
    assert.equal(said(other), said(first));
  } finally { await f.close(); }
});

await test('TE-020 a name outside the catalog, another tool, and a denied call are each refused by code', async () => {
  const f = await skillsFixture({ query: skill('query') });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok); const stage = cataloguer(loaded.value.skills);
    const unknown = stage.load(calling('load_skill', { name: 'invented' }), 'one');
    // The enum refuses the name before the catalog is ever consulted, and the refusal repeats it.
    assert.match(unknown.error?.message ?? '', /^invented is not a skill in this catalog\.$/u); assert.equal(unknown.error?.code, 'invalid-args');
    const missing = stage.load(calling('load_skill', {}), 'one');
    assert.match(missing.error?.message ?? '', /takes the name of a skill/u); assert.equal(missing.error?.code, 'invalid-args');
    assert.equal(stage.load(calling('read_path', { name: 'query' }), 'one').error?.code, 'gone');
    assert.equal(stage.load(calling('load_skill', { name: 'query' }, { readOnly: true, deny: ['skills-l1/load_skill'] }), 'one').error?.code, 'read-only-mode');
  } finally { await f.close(); }
});

await test('a body over the load budget is refused rather than spilled into the conversation', async () => {
  const f = await skillsFixture({ big: skill('big', 'a large skill', 'x'.repeat(300000)) });
  try {
    const loaded = await f.load(); assert.ok(loaded.ok);
    assert.equal(cataloguer(loaded.value.skills).load(calling('load_skill', { name: 'big' }), 'one').error?.code, 'budget');
  } finally { await f.close(); }
});

await test('the stage catalogues nothing until init has read the corpus, then offers exactly what it holds', async () => {
  const id = `catalogued-${randomUUID()}`;
  const alias = `pack-catalogued-${randomUUID()}@1.0.0`;
  assert.deepEqual(await stages.retrieve(request), { entries: [], dropped: [] });
  assert.deepEqual(await stages.offer({ mode: { readOnly: true, deny: [] } }), []);
  await mkdir(join('/packages', alias, 'skills', id), { recursive: true });
  await writeFile(join('/packages', alias, 'skills', id, 'SKILL.md'), skill(id));
  const notices: string[] = [];
  try {
    await stages.init(undefined, { emit: notice => { notices.push(notice.content.map(part => part['text']).join('')); } });
    const answer = await stages.retrieve(request);
    assert.ok(answer.entries.some(entry => entry.id === id && entry.body === undefined), JSON.stringify(answer.entries.map(entry => entry.id)));
    assert.deepEqual(notices, []);
    // The tool is offered in read-only mode because loading a skill only reads, and its enum is the
    // catalog itself: the model cannot name a skill this environment does not install.
    const [tool] = await stages.offer({ mode: { readOnly: true, deny: [] } }); assert.ok(tool);
    assert.equal(tool.name, 'load_skill'); assert.equal(tool.readOnly, true);
    assert.equal(JSON.stringify(tool.schema),
      JSON.stringify({ type: 'object', properties: { name: { type: 'string', enum: answer.entries.map(entry => entry.id) } }, required: ['name'] }));
    stages.observe({ type: 'input', conversation: 'wired', turn: 1, iteration: 0, seq: 0, payload: {} });
    assert.equal((await stages.call(calling('load_skill', { name: id }))).ok, true);
    assert.match(said(await stages.call(calling('load_skill', { name: id }))), /already loaded/u);
  } finally { await rm(join('/packages', alias), { recursive: true, force: true }); }
});
