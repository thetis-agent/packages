/** The pack is only worth shipping if lib/skills accepts it as installed; findings §8, SK-001-009. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, readFile, rm, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Schemas } from '@/lib/schema/index.ts';
import { loadPack } from '@/lib/skills/index.ts';

const source = fileURLToPath(new URL('.', import.meta.url));

async function installed() {
  const manifest: unknown = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'));
  const version = typeof manifest === 'object' && manifest !== null && 'version' in manifest ? String(manifest.version) : '';
  // The alias carries a unique name because /packages is one tmpfs shared by every test file in the run.
  const name = `skills-core-${randomUUID()}`;
  const path = join('/packages', `${name}@${version}`);
  await mkdir(path, { recursive: true });
  await cp(join(source, 'skills'), join(path, 'skills'), { recursive: true, verbatimSymlinks: true });
  return { pack: { name, version, path }, close: () => rm(path, { recursive: true, force: true }) };
}

await test('the shipped pack loads through lib/skills with no warning', async () => {
  const { pack, close } = await installed();
  try {
    const schemas = new Schemas(); await schemas.load();
    const loaded = await loadPack(pack, schemas);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error.message);
    assert.deepEqual(loaded.value.warnings, []);
    assert.deepEqual(loaded.value.skills.map(item => item.card.id), ['skill-creator']);
  } finally { await close(); }
});

await test('skill-creator is authoring guidance, not a universal skill', async () => {
  const { pack, close } = await installed();
  try {
    const schemas = new Schemas(); await schemas.load();
    const loaded = await loadPack(pack, schemas);
    assert.ok(loaded.ok, loaded.ok ? '' : loaded.error.message);
    const [creator] = loaded.value.skills;
    assert.ok(creator);
    assert.equal(creator.card.name, 'skill-creator');
    // findings §8: a 7.8k-byte skill-creator marked universal is the mistake the validator exists to catch.
    assert.equal(creator.card.universal, false);
    assert.ok(Buffer.byteLength(creator.card.description) < 1024);
    // Nothing nests under skill-creator, so the loader's derived children stay empty.
    assert.deepEqual(creator.card.children, []);
  } finally { await close(); }
});
