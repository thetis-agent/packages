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
    assert.deepEqual(composed.refused, []);
    assert.deepEqual(composed.table.assets.map(asset => asset.path).sort(), ['/app.js', '/surface/demo/panel.js']);
    assert.deepEqual(composed.contribution.panels.map(panel => panel.id), ['skills']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a package that provides no surface name contributes nothing', async () => {
  const base = await root([{ name: 'plain', provides: { 'stage/retrieve': '1.0.0' }, surface: declares('plain') }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.deepEqual(composed.refused, []);
    assert.deepEqual(composed.contribution.panels, []);
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a contributor serving outside its own name is refused by name', async () => {
  const base = await root([{ name: 'greedy', surface: declares('greedy'),
    assets: [{ path: '/surface/greedy/panel.js', file: 'surface/panel.js', type: 'text/javascript' },
      { path: '/app.js', file: 'surface/other.js', type: 'text/javascript' }], files: ['surface/panel.js', 'surface/other.js'] }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.equal(composed.refused.length, 1);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.match(refusal.message, /greedy serves \/app\.js, which is outside \/surface\/greedy\//u);
    // The surface still starts, and still serves everything of its own.
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
    assert.deepEqual(composed.contribution.panels, []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a declared entry its manifest does not serve is refused', async () => {
  const base = await root([{ name: 'absent', surface: { v: '1', panels: [{ id: 'skills', label: 'Skills', entry: '/surface/absent/missing.js' }] } }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.equal(composed.refused.length, 1);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.match(refusal.message, /asset manifest does not serve/u);
    // The surface still starts, and still serves everything of its own.
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
    assert.deepEqual(composed.contribution.panels, []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a surface block that violates its contract is refused rather than skipped', async () => {
  const base = await root([{ name: 'broken', surface: { panels: [{ id: 'skills', label: 'Skills', entry: '/surface/broken/panel.js' }] } }]);
  try {
    const composed = await compose(own, await schemas(), base);
    assert.equal(composed.refused.length, 1);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.match(refusal.message, /broken provides a surface name but its surface block/u);
    // The surface still starts, and still serves everything of its own.
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
    assert.deepEqual(composed.contribution.panels, []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('two contributors claiming one panel id are refused', async () => {
  const base = await root([{ name: 'first', surface: declares('first') }, { name: 'second', surface: declares('second') }]);
  try {
    const composed = await compose(own, await schemas(), base);
    // The first contributor wins by name order and the second is refused, so a late duplicate can
    // never displace a panel that is already serving.
    assert.deepEqual(composed.contribution.panels.map(panel => panel.id), ['skills']);
    assert.equal(composed.refused.length, 1);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.equal(refusal.name, 'second');
    assert.match(refusal.message, /Another package already contributes the panel skills\./u);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a manifest that is malformed or oversized is refused by name, not skipped', async () => {
  const base = await mkdtemp('/tmp/panels-');
  try {
    for (const [name, body] of [['broken-json', '{ not json'], ['huge', `{"filler":"${'x'.repeat(70000)}"}`]] as [string, string][]) {
      await mkdir(join(base, name, 'surface'), { recursive: true });
      await writeFile(join(base, name, 'package.json'), body);
    }
    const composed = await compose(own, await schemas(), base);
    // Both are named; neither stops the surface serving its own table.
    assert.deepEqual(composed.refused.map(refusal => refusal.name).sort(), ['broken-json', 'huge']);
    assert.deepEqual(composed.table.assets.map(asset => asset.path), ['/app.js']);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('a directory that is not a package at all contributes nothing and is not a refusal', async () => {
  const base = await mkdtemp('/tmp/panels-');
  try {
    await mkdir(join(base, 'not-a-package'), { recursive: true });
    const composed = await compose(own, await schemas(), base);
    assert.deepEqual(composed.refused, []);
    assert.deepEqual(composed.contribution.panels, []);
  } finally { await rm(base, { recursive: true, force: true }); }
});

await test('two contributors drawing one event kind are refused', async () => {
  const draws = (name: string) => ({ v: '1', renderers: [{ kind: 'retrieve', entry: `/surface/${name}/panel.js` }] });
  const base = await root([
    { name: 'first', provides: { 'renderer/retrieve': '1.0.0' }, surface: draws('first') },
    { name: 'second', provides: { 'renderer/retrieve': '1.0.0' }, surface: draws('second') },
  ]);
  try {
    const composed = await compose(own, await schemas(), base);
    // The browser keys renderers by kind, so the second would have silently replaced the first.
    assert.deepEqual(composed.contribution.renderers.map(renderer => renderer.kind), ['retrieve']);
    const [refusal] = composed.refused; assert.ok(refusal);
    assert.equal(refusal.name, 'second');
    assert.match(refusal.message, /Another package already draws retrieve rows\./u);
  } finally { await rm(base, { recursive: true, force: true }); }
});
