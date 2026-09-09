/** Exercise both shipped CLI entries with inherited authority rather than a process mock; KS-001–005. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cliProcess, cliRequest } from '../../test/cli-process.ts';
import { isObject } from '../../lib/schema/index.ts';

await test('KS-001 the one-shot CLI consumes inherited authority and writes a bounded scoped result', async () => {
  const f = await cliProcess('main', ['status']);
  try {
    const stdout = f.process.running.process.stdout; assert.ok(stdout); const chunks: Buffer[] = []; let bytes = 0;
    for await (const chunk of stdout) { const value: unknown = chunk; assert.ok(Buffer.isBuffer(value)); bytes += value.length; assert.ok(bytes <= 65536); chunks.push(value); }
    const exited = await f.process.running.exited; assert.equal(exited.code, 0);
    const output = Buffer.concat(chunks).toString('utf8'); const parsed: unknown = JSON.parse(output);
    assert.deepEqual(parsed, { ok: true, value: { person: 'person', state: 'LIVE' } }); assert.ok(!output.includes(f.provider.token));
  } finally { await f.close(); }
});

await test('KS-004 a real persistent CLI creates and submits scoped conversations and resumes after drain', async () => {
  const f = await cliProcess('service');
  try {
    assert.ok((await f.process.probe()).ok);
    const created = await cliRequest(f.socket, ['new']); assert.ok(isObject(created) && created['ok'] === true && isObject(created['value']));
    const id = created['value']['id']; assert.ok(typeof id === 'string');
    const submitted = await cliRequest(f.socket, ['send', id, 'Hello']); assert.ok(isObject(submitted) && submitted['ok'] === true);
    assert.ok(f.events.some(event => event.type === 'output'));
    const unsupported = await cliRequest(f.socket, ['subscribe', id]); assert.ok(isObject(unsupported) && isObject(unsupported['error'])); assert.equal(unsupported['error']['code'], 'unsupported');
    assert.ok((await f.process.drain(30000)).ok);
    assert.ok((await f.process.control.notify({ note: 'env.updated', params: { resume: true } })).ok); assert.ok((await f.process.probe()).ok);
    const listed = await cliRequest(f.socket, ['list']); assert.ok(isObject(listed) && listed['ok'] === true);
  } finally { await f.close(); }
});
