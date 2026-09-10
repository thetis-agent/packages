/** Prevent private task paths from selecting material outside the approved suite; EV-002. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { suite } from './suite.ts';
import { Schemas } from '@/lib/schema/index.ts';
await test('EV-002 private suite loader verifies every task path and hashes the complete suite', async () => {
  const root = await mkdtemp('/tmp/private-suite-'); const directory = join(root, 'tasks/task'); await mkdir(join(directory, 'fixture'), { recursive: true }); await mkdir(join(directory, 'checks'));
  await writeFile(join(directory, 'checks/run.sh'), 'exit 0\n');
  const task = { id: 'task', family: 'tool', request: 'Help Alice.', mutable: { names: ['Alice'] }, requires: [], required: [], gold: { tools: [], skills: [] }, budget: { cost: 1, iterations: 3 }, checks: 'checks/run.sh' };
  await writeFile(join(directory, 'task.json'), JSON.stringify(task)); const schemas = new Schemas(); await schemas.load();
  try {
    const first = await suite(root, schemas); assert.ok(first.ok); assert.deepEqual(first, await suite(root, schemas));
    assert.match(first.value.identity, /^sha256:[a-f0-9]{64}$/u); assert.equal(first.value.tasks[0]?.checks, join(directory, 'checks/run.sh'));
    await rm(join(directory, 'checks/run.sh')); await symlink('/etc/passwd', join(directory, 'checks/run.sh'));
    const refused = await suite(root, schemas); assert.ok(!refused.ok); assert.equal(refused.error.code, 'outside-roots');
  } finally { await rm(root, { recursive: true, force: true }); }
});
