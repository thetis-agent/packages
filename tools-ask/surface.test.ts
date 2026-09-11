/** Guard this package's contribution the way gateway-web guards its own served tree; ADR 0038 §1.
 *
 * A contributed panel is refused by name and skipped when it is malformed (gateway-web/panels.ts), so
 * a mistake here does not fail loudly at runtime — it shows up as a tab that is quietly missing. These
 * checks are that refusal, moved to where it can be read: the surface block matches contract/surface,
 * every path it claims sits under this package's own segment, every module it serves parses, its
 * import graph is closed except for the one seam module, and nothing it serves carries markup the
 * surface's CSP (lib/assets' `default-src 'self'`) would block.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, extname, join, posix } from 'node:path';
import { Schemas, isObject } from '@/lib/schema/index.ts';
import type { Surface } from '@/contracts/surface/types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const name = 'tools-ask';
const prefix = `/surface/${name}/`;
/** The one module a contributed panel may import; contract/surface, gateway-web/assets/lib/surface.js. */
const seam = '/lib/surface.js';
/** Mirrors lib/assets' own per-file limit, named here per the house rule about bounding everything. */
export const limits = { fileBytes: 4 * 1024 * 1024 };

interface Row { path: string; file: string; type: string }

async function manifest(): Promise<Row[]> {
  const raw: unknown = JSON.parse(await readFile(join(here, 'assets.json'), 'utf8'));
  assert.ok(isObject(raw) && Array.isArray(raw['assets']), 'assets.json must hold an "assets" array.');
  const rows: Row[] = [];
  for (const item of isObject(raw) && Array.isArray(raw['assets']) ? raw['assets'] : []) {
    assert.ok(isObject(item) && typeof item['path'] === 'string' && typeof item['file'] === 'string' && typeof item['type'] === 'string', 'every row needs string path/file/type.');
    if (isObject(item) && typeof item['path'] === 'string' && typeof item['file'] === 'string' && typeof item['type'] === 'string') rows.push({ path: item['path'], file: item['file'], type: item['type'] });
  }
  return rows;
}

async function served(): Promise<string[]> {
  const entries = await readdir(join(here, 'surface'), { withFileTypes: true });
  // `.d.ts` files declare the browser modules for the tests and are never served; ADR 0037's artifact
  // build skips them too, which is why they can sit beside the modules they describe.
  return entries.filter(entry => entry.isFile() && !entry.name.endsWith('.d.ts')).map(entry => `surface/${entry.name}`).sort();
}

async function sources(rows: readonly Row[]): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const row of rows) files.set(row.file, await readFile(join(here, row.file), 'utf8'));
  return files;
}

await test('the manifest and the surface directory name exactly the same files', async () => {
  const rows = await manifest();
  assert.deepEqual(rows.map(row => row.file).sort(), await served());
});

await test('every served path sits under this package\'s own segment and is unique', async () => {
  const seen = new Set<string>();
  for (const row of await manifest()) {
    assert.ok(row.path.startsWith(prefix), `${row.path} is outside ${prefix}.`);
    assert.ok(!row.path.includes('..') && !row.path.includes('?'), `${row.path} is not a servable path.`);
    assert.ok(!seen.has(row.path), `${row.path} is listed twice.`);
    seen.add(row.path);
  }
});

await test('the surface block matches contract/surface and declares only paths this package serves', async () => {
  const schemas = new Schemas(); await schemas.load();
  const valid = schemas.validator<Surface>('surface', 'surface');
  const raw: unknown = JSON.parse(await readFile(join(here, 'package.json'), 'utf8'));
  assert.ok(isObject(raw));
  assert.equal(raw['name'], name, 'the served segment is the package name, never a panel id.');
  const declared = raw['surface'];
  assert.ok(valid(declared), 'the surface block must satisfy contract/surface.');
  const rows = new Set((await manifest()).map(row => row.path));
  const entries = [...declared.panels ?? [], ...declared.renderers ?? []];
  assert.ok(entries.length > 0, 'a contributor with nothing to contribute is not one.');
  for (const entry of entries) {
    assert.ok(entry.entry.startsWith(prefix), `${entry.entry} is outside ${prefix}.`);
    assert.ok(rows.has(entry.entry), `${entry.entry} is declared but not served.`);
  }
  /* This package does claim the two tool row kinds, which is the one thing gateway-web's panels.ts
   * permits exactly one contributor of: a question is a form a person fills in where it was asked, so
   * it has to be a transcript row and there is no other kind for it to be. `skills-l1` claims the same
   * two for its `load_skill` rows, and whichever is read first (readdir order, so `skills-l1`) wins —
   * the other is refused by name and loses its panel and its commands with it. Asserted here so the
   * clash is a line in a test rather than a tab that is silently missing. */
  assert.deepEqual((declared.renderers ?? []).map(renderer => renderer.kind), ['tool-call', 'tool-result']);
  assert.deepEqual(Object.keys(isObject(raw['provides']) ? raw['provides'] : {}), ['panel/questions', 'renderer/tool-call', 'renderer/tool-result']);
  // A command with no panel to send it is refused by panels.ts, by name, and the package goes with it.
  assert.deepEqual((declared.commands ?? []).map(command => command.verb), ['asked', 'reply']);
});

await test('a surface-only package is still a package', async () => {
  // lib/package-loader/index.ts's `discover` resolves `index.ts` in every sibling directory of the
  // registry and refuses the whole registry when one is missing, so a package that contributes only
  // assets still needs the file. Asserted here because the failure it causes lands nowhere near this
  // package: the environment fixture stops discovering, and a kernel recovery test is what goes red.
  await stat(join(here, 'index.ts'));
});

await test('every served module parses as JavaScript', async () => {
  for (const row of await manifest()) {
    if (extname(row.file) !== '.js') continue;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(here, row.file)], { stdio: 'pipe' }), `${row.file} failed node --check.`);
  }
});

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bimport\s+(?:[^'";]*?\bfrom\s+)?["']([^"']+)["']/gu)) {
    const specifier = match[1]; if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers;
}

await test('the import graph is closed, and only the entry module reaches for the seam', async () => {
  const rows = await manifest();
  const paths = new Set(rows.map(row => row.path));
  /* Three modules import the seam rather than one: the panel, the transcript rows, and the form both
   * of them draw. contract/surface bounds what a contributed module may import, not how many of them
   * may — and a form that had `el` passed into it from two callers would be a worse form. */
  const entries = ['surface/panel.js', 'surface/rows.js', 'surface/form.js'];
  for (const [file, source] of await sources(rows)) {
    if (extname(file) !== '.js') continue;
    for (const specifier of importsOf(source)) {
      if (specifier === seam) { assert.ok(entries.includes(file), `${file} imports the seam; only a declared entry may.`); continue; }
      // A sibling is named relatively or by the served path it sits at; both resolve into this
      // package's own segment, and anything that does not is not a module this package ships.
      assert.ok(specifier.startsWith('.') || specifier.startsWith(prefix), `${file} imports "${specifier}", which is neither the seam nor a sibling module.`);
      const resolved = specifier.startsWith(prefix) ? specifier : posix.join(prefix, posix.normalize(posix.join(posix.dirname(file).slice('surface'.length), specifier)));
      assert.ok(paths.has(resolved), `${file} imports "${specifier}" (${resolved}), which is not a served row.`);
    }
  }
});

await test('nothing served carries markup or code the surface\'s CSP would block', async () => {
  for (const [file, source] of await sources(await manifest())) {
    assert.doesNotMatch(source, /\bstyle\s*=\s*["']/u, `${file} sets a style attribute; per-element styling goes through CSSOM.`);
    assert.doesNotMatch(source, /setAttribute\(\s*["']style["']/u, `${file} sets a style attribute through setAttribute.`);
    assert.doesNotMatch(source, /\bnew\s+Function\b|\beval\s*\(/u, `${file} evaluates source at runtime.`);
    // A quote immediately before the scheme, so a `data:` property name is not mistaken for a URL.
    assert.doesNotMatch(source, /["'`(]\s*(?:blob|data):/u, `${file} names a blob: or data: URL; the CSP allows neither as a module source.`);
    assert.doesNotMatch(source, /https?:\/\//u, `${file} names an absolute URL; the surface is served from one origin.`);
  }
});

await test('every served file stays inside the asset byte bound', async () => {
  for (const row of await manifest()) {
    const info = await stat(join(here, row.file));
    assert.ok(info.size <= limits.fileBytes, `${row.file} is ${String(info.size)} bytes.`);
  }
});
