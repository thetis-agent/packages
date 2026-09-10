/** Cover the granted and ungranted shapes of the update-status service without any apply path here; ADR 0048. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { socketFrames, send } from '@/lib/ndjson/socket.ts';
import { updateNotice } from './update-notice.ts';

async function serving(respond: (frame: unknown) => unknown) {
  const root = await mkdtemp(join(tmpdir(), 'update-notice-'));
  const path = join(root, 'update-status.sock');
  const server = createServer(socket => {
    void (async () => {
      for await (const frame of socketFrames(socket)) { if (frame.ok) await send(socket, respond(frame.value)); return; }
    })();
  });
  await new Promise<void>(resolve => { server.listen(path, resolve); });
  return { path, async close() { server.close(); await rm(root, { recursive: true, force: true }); } };
}

await test('an available, verified update produces the exact status line', async () => {
  const f = await serving(() => ({ ok: true, value: { known: true, current: 'v1', available: 'v2', verified: true, checkedAt: Date.UTC(2026, 0, 1, 12, 0) } }));
  try { assert.equal(await updateNotice(f.path), 'update: v2 available (verified 12:00)'); } finally { await f.close(); }
});

await test('a known status with no available version prints nothing extra', async () => {
  const f = await serving(() => ({ ok: true, value: { known: true, current: 'v1', verified: true, checkedAt: 0 } }));
  try { assert.equal(await updateNotice(f.path), undefined); } finally { await f.close(); }
});

await test('an unknown status (the host timer has not run) prints nothing extra', async () => {
  const f = await serving(() => ({ ok: true, value: { known: false } }));
  try { assert.equal(await updateNotice(f.path), undefined); } finally { await f.close(); }
});

await test('a refusal from the service prints nothing extra, not an error', async () => {
  const f = await serving(() => ({ ok: false, error: { code: 'invalid-args', message: 'refused' } }));
  try { assert.equal(await updateNotice(f.path), undefined); } finally { await f.close(); }
});

await test('an absent service (no socket at all) prints nothing extra', async () => {
  const root = await mkdtemp(join(tmpdir(), 'update-notice-absent-'));
  try { assert.equal(await updateNotice(join(root, 'update-status.sock')), undefined); } finally { await rm(root, { recursive: true, force: true }); }
});
