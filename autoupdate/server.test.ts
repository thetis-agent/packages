/** Serve only status.status over the mounted socket and refuse every other method as unsupported; ADR 0048. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { Connection } from '@/lib/service/lifecycle.ts';
import { connect, send, socketFrames } from '@/lib/ndjson/socket.ts';
import { handler } from './server.ts';

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'autoupdate-server-'));
  const path = join(root, 'update-status.sock');
  const statusPath = join(root, 'status.json');
  const schemas = new Schemas(); await schemas.load();
  const built = await handler({ statusPath, statusBytes: 65536, pollMs: 60000 }, schemas);
  assert.ok(built.ok, JSON.stringify(built));
  const server = createServer(socket => {
    const connection: Connection = { socket, admitted: () => undefined };
    void built.value(connection);
  });
  await new Promise<void>(resolve => { server.listen(path, resolve); });
  return {
    statusPath,
    async request(frame: unknown) {
      const connected = await connect(path); assert.ok(connected.ok);
      const sent = await send(connected.value, frame); assert.ok(sent.ok);
      for await (const received of socketFrames(connected.value)) { connected.value.end(); return received; }
      throw new Error('The test socket closed before a frame arrived.');
    },
    async close() { server.close(); await rm(root, { recursive: true, force: true }); },
  };
}

await test('an unrecognized method is refused as unsupported, not invalid-args', async () => {
  const f = await fixture();
  try {
    const refused = await f.request({ method: 'apply' });
    assert.ok(refused.ok, JSON.stringify(refused)); assert.ok(isObject(refused.value));
    assert.equal(refused.value['ok'], false); assert.ok(isObject(refused.value['error']));
    assert.equal(refused.value['error']['code'], 'unsupported');
  } finally { await f.close(); }
});

await test('a request violating the wire contract is refused as invalid-args', async () => {
  const f = await fixture();
  try {
    const refused = await f.request({ notAMethod: true });
    assert.ok(refused.ok, JSON.stringify(refused)); assert.ok(isObject(refused.value));
    assert.equal(refused.value['ok'], false); assert.ok(isObject(refused.value['error']));
    assert.equal(refused.value['error']['code'], 'invalid-args');
  } finally { await f.close(); }
});

await test('status.status answers a missing status file as known:false, not an error', async () => {
  const f = await fixture();
  try {
    const answered = await f.request({ method: 'status' });
    assert.ok(answered.ok, JSON.stringify(answered)); assert.ok(isObject(answered.value));
    assert.equal(answered.value['ok'], true); assert.deepEqual(answered.value['value'], { known: false });
  } finally { await f.close(); }
});

await test('status.status answers a valid status file with its parsed, validated fields', async () => {
  const f = await fixture();
  try {
    await writeFile(f.statusPath, JSON.stringify({ version: 1, current: 'v1', available: 'v2', verified: true, checkedAt: 5, policy: 'improvements' }));
    const answered = await f.request({ method: 'status' });
    assert.ok(answered.ok, JSON.stringify(answered)); assert.ok(isObject(answered.value));
    assert.equal(answered.value['ok'], true);
    assert.deepEqual(answered.value['value'], { known: true, current: 'v1', available: 'v2', verified: true, checkedAt: 5, policy: 'improvements' });
  } finally { await f.close(); }
});
