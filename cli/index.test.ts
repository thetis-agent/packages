/** Verify headless session commands against real kernel RPC and conversation state; KS-004–005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, run, settings } from './index.ts';
import { cliFixture } from '@/test/cli-fixture.ts';
import { failure, isObject } from '@/lib/schema/index.ts';
import { command } from './command.ts';

await test('KS-004 CLI creates, lists and submits through the scoped session API without a person argument', async () => {
  const f = await cliFixture();
  try {
    const created = await execute(['new'], f.peer); assert.ok(created.ok && isObject(created.value));
    const id = created.value['id']; assert.ok(typeof id === 'string');
    const listed = await execute(['list'], f.peer); assert.ok(listed.ok && Array.isArray(listed.value)); assert.equal(listed.value.length, 1);
    const rows: string[] = [];
    assert.ok((await run(['send', id, 'Hello', 'there'], f.peer, { write: value => { rows.push(value); return Promise.resolve({ ok: true, value: undefined }); } })).ok);
    assert.equal(rows.length, 1); assert.ok(!rows[0]?.includes('Hello.')); assert.ok(f.events.some(event => event.type === 'output'));
    const status = await execute(['status'], f.peer); assert.deepEqual(status, { ok: true, value: { person: 'person', state: 'LIVE' } });
    const missing = await execute(['reset'], f.peer); assert.ok(!missing.ok); assert.equal(missing.error.code, 'unsupported');
  } finally { await f.close(); }
});

await test('KS-015 CLI refuses origin impersonation, invalid arguments and unavailable direct streams', async () => {
  const f = await cliFixture();
  try {
    for (const args of [['default', 'set', 'digest', '1', 'code'], ['secret', 'set', 'name', 'value']]) {
      const refused = await execute(args, f.peer); assert.ok(!refused.ok); assert.equal(refused.error.code, 'forbidden');
    }
    const unavailable = await execute(['subscribe', 'conversation'], f.peer); assert.ok(!unavailable.ok); assert.equal(unavailable.error.code, 'unsupported');
    const bounded = await execute(['send', 'conversation', 'x'.repeat(settings.argumentBytes + 1)], f.peer); assert.ok(!bounded.ok); assert.equal(bounded.error.code, 'budget');
    for (const args of [[], ['unknown'], ['toString'], ['constructor'], ['send', 'conversation'], ['cancel'], ['list', 'other-person'], ['subscribe', 'id', '-1']]) assert.ok(!command(args).ok);
    assert.deepEqual(command(['new', 'project']), { ok: true, value: { method: 'session.create', params: { surface: 'cli', project: 'project' } } });
    assert.deepEqual(command(['subscribe', 'id', '3']), { ok: true, value: { method: 'session.subscribe', params: { conversation: 'id', from: 3 } } });
    const output = await run(['health'], f.peer, { write: () => Promise.resolve(failure('io', 'closed')) }); assert.ok(!output.ok); assert.equal(output.error.code, 'io');
  } finally { await f.close(); }
});
