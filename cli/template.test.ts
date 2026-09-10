/** Keep the shipped headless recipe schema-valid and scoped to separate person services; KS-004, KS-009. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '../../lib/schema/index.ts';
import { validator } from '../../lib/profile/schema.ts';
import { catalog } from '../../lib/profile/catalog.ts';
import { kernelRoot } from '../../lib/profile/packages-root.ts';
import type { Recipe, Process } from '../../lib/profile/types.ts';
await test('KS-009 the shipped two-account recipe resolves only existing packages and isolated person mounts', async () => {
  const schemas = new Schemas(); await schemas.load();
  const input: unknown = JSON.parse(await readFile(join(kernelRoot(), 'profiles/examples/two-account.recipe.json'), 'utf8'));
  assert.ok((await validator<Recipe>(schemas, 'recipe'))(input));
  const found = await catalog(kernelRoot()); assert.ok(found.ok);
  const names = new Set(found.value.map(source => source.name));
  for (const target of [...input.targets, input.discovery]) for (const name of target.selection) assert.ok(names.has(name), name);
  const spaces: string[] = [];
  for (const id of ['alice', 'bob']) {
    const environment: Process | undefined = input.targets.find(target => target.id === id); const cli: Process | undefined = input.targets.find(target => target.id === `${id}-cli`);
    assert.ok(environment && cli); assert.equal(environment.owner, id); assert.equal(cli.owner, id);
    assert.equal(environment.scope, 'person'); assert.equal(cli.scope, 'person');
    assert.deepEqual(cli.services, [{ id, mount: '/services/environment' }]);
    const space: NonNullable<Process['mounts']>[number] | undefined = environment.mounts?.find(mount => mount.path === '/space'); assert.ok(space); spaces.push(space.source);
    assert.equal(space.maximumBytes, 536870912); assert.equal(environment.selection.includes('lib/evaluation'), false);
  }
  assert.equal(new Set(spaces).size, 2);
});
