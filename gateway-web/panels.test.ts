/** Guard what a contributed panel may serve and declare; contract/surface, ADR 0038 §1. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Schemas } from '@/lib/schema/index.ts';
import type { Table } from '@/lib/assets/index.ts';
import { compose } from './panels.ts';

const own: Table = { root: '/surface-own', assets: [{ path: '/app.js', file: 'app.js', type: 'text/javascript', size: 1, sha256: 'a', absolute: '/surface-own/app.js' }] };

async function schemas(): Promise<Schemas> { const value = new Schemas(); await value.load(); return value; }

interface Contributor { name: string; provides?: Record<string, string>; surface?: unknown; assets?: { path: string; file: string; type: string }[]; files?: string[] }

async function root(contributors: readonly Contributor[]): Promise<string> {
  const base = await mkdtemp('/tmp/panels-');
  for (const value of contributors) {
    const directory = join(base, value.name);
    await mkdir(join(directory, 'surface'), { recursive: true });
    for (const file of value.files ?? ['surface/panel.js']) await writeFile(join(directory, file), 'export const a = 1;\n');
    await writeFile(join(directory, 'package.json'), JSON.stringify({
      name: value.name, version: '1.0.0', requires: {}, settings: {},
      provides: value.provides ?? { 'panel/skills': '1.0.0' },
      envelope: { requires: [], provides: [], spawn: { scope: 'person', network: 'none' } },
      ...(value.surface === undefined ? {} : { surface: value.surface }),
    }));
    await writeFile(join(directory, 'assets.json'), JSON.stringify({ assets: value.assets ?? [{ path: `/surface/${value.name}/panel.js`, file: 'surface/panel.js', type: 'text/javascript' }] }));
  }
  return base;
}

const declares = (name: string) => ({ v: '1', panels: [{ id: 'skills', label: 'Skills', entry: `/surface/${name}/panel.js` }] });

await test('a contributor is discovered and joined into the served table', async () => {
  const base = await root([{ name: 'demo', surface: declares('demo') }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(composed.ok);
    assert.deepEqual(composed.value.table.assets.map(asset => asset.path).sort(), ['/app.js', '/surface/demo/panel.js']);
    assert.deepEqual(composed.value.contribution.panels.map(panel => panel.id), ['skills']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a package that provides no surface name contributes nothing', async () => {
  const base = await root([{ name: 'plain', provides: { 'stage/retrieve': '1.0.0' }, surface: declares('plain') }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(composed.ok);
    assert.deepEqual(composed.value.contribution.panels, []);
    assert.deepEqual(composed.value.table.assets.map(asset => asset.path), ['/app.js']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a contributor serving outside its own name is refused by name', async () => {
  const base = await root([{ name: 'greedy', surface: declares('greedy'),
    assets: [{ path: '/surface/greedy/panel.js', file: 'surface/panel.js', type: 'text/javascript' },
      { path: '/app.js', file: 'surface/other.js', type: 'text/javascript' }], files: ['surface/panel.js', 'surface/other.js'] }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(!composed.ok);
    assert.match(composed.error.message, /greedy serves \/app\.js, which is outside \/surface\/greedy\//u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a declared entry its manifest does not serve is refused', async () => {
  const base = await root([{ name: 'absent', surface: { v: '1', panels: [{ id: 'skills', label: 'Skills', entry: '/surface/absent/missing.js' }] } }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(!composed.ok);
    assert.match(composed.error.message, /asset manifest does not serve/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a surface block that violates its contract is refused rather than skipped', async () => {
  const base = await root([{ name: 'broken', surface: { panels: [{ id: 'skills', label: 'Skills', entry: '/surface/broken/panel.js' }] } }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(!composed.ok);
    assert.match(composed.error.message, /broken provides a surface name but its surface block/u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('two contributors claiming one panel id are refused', async () => {
  const base = await root([{ name: 'first', surface: declares('first') }, { name: 'second', surface: declares('second') }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.ok(!composed.ok);
    assert.match(composed.error.message, /Two packages contribute the panel skills\./u);
  } finally { await rm(base, { recursive: true, force: true }); }
});
