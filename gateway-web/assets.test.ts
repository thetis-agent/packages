/** Guard the served web UI offline: table/disk parity, syntax, a closed import graph, index.html
 * references, a per-file size bound, that nothing served carries an absolute URL other than the
 * `/login` sign-in redirect, and (mirrored for gateway-login) that no served page carries markup
 * lib/assets' CSP would block; ADR 0005, ADR 0037. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile, readdir, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, posix, extname } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const assetsRoot = join(here, 'assets');
const manifestPath = join(here, 'assets.json');

/** Named per house rule ("bound everything with named settings + defaults"); mirrors lib/assets' own limit. */
export const limits = { fileBytes: 4 * 1024 * 1024 };

interface ManifestEntry { path: string; file: string; type: string }

async function manifest(): Promise<ManifestEntry[]> {
  const raw: unknown = JSON.parse(await readFile(manifestPath, 'utf8'));
  assert.ok(isObject(raw) && Array.isArray(raw['assets']), 'assets.json must have an "assets" array.');
  const rows: ManifestEntry[] = [];
  for (const item of isObject(raw) && Array.isArray(raw['assets']) ? raw['assets'] : []) {
    assert.ok(isObject(item) && typeof item['path'] === 'string' && typeof item['file'] === 'string' && typeof item['type'] === 'string', 'every assets.json row needs string path/file/type fields.');
    if (isObject(item) && typeof item['path'] === 'string' && typeof item['file'] === 'string' && typeof item['type'] === 'string') rows.push({ path: item['path'], file: item['file'], type: item['type'] });
  }
  return rows;
}

async function filesOnDisk(root: string, prefix = ''): Promise<string[]> {
  const entries = await readdir(join(root, prefix), { withFileTypes: true });
  const rows: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) rows.push(...(await filesOnDisk(root, relative)));
    else rows.push(relative);
  }
  return rows;
}

await test('every manifest row names a file that exists under assets/, and every file under assets/ has a manifest row', async () => {
  const table = await manifest();
  const referenced = new Set(table.map(row => row.file));
  const onDisk = new Set(await filesOnDisk(assetsRoot));
  for (const row of table) assert.ok(onDisk.has(row.file), `${row.file} is listed in assets.json but does not exist on disk.`);
  for (const file of onDisk) assert.ok(referenced.has(file), `${file} exists on disk but has no assets.json row.`);
});

await test('every manifest path is root-relative, unique, and free of query strings', async () => {
  const table = await manifest();
  const seen = new Set<string>();
  for (const row of table) {
    assert.ok(row.path.startsWith('/'), `${row.path} must start with "/".`);
    assert.ok(!row.path.includes('..'), `${row.path} must not contain "..".`);
    assert.ok(!row.path.includes('?'), `${row.path} must not contain a query string.`);
    assert.ok(!seen.has(row.path), `${row.path} is listed twice.`);
    seen.add(row.path);
  }
});

await test('every .js row is syntactically valid', async () => {
  const table = await manifest();
  for (const row of table) {
    if (extname(row.file) !== '.js') continue;
    assert.doesNotThrow(() => execFileSync(process.execPath, ['--check', join(assetsRoot, row.file)], { stdio: 'pipe' }), `${row.file} failed node --check.`);
  }
});

function importsOf(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/\bimport\s+(?:[^'";]*?\bfrom\s+)?["']([^"']+)["']/g)) {
    const specifier = match[1]; if (specifier !== undefined) specifiers.push(specifier);
  }
  return specifiers.filter(specifier => specifier.startsWith('.'));
}

await test('every relative import specifier resolves to another .js row, staying inside assets/', async () => {
  const table = await manifest();
  const jsFiles = new Set(table.filter(row => extname(row.file) === '.js').map(row => row.file));
  for (const file of jsFiles) {
    const source = await readFile(join(assetsRoot, file), 'utf8');
    for (const specifier of importsOf(source)) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      assert.ok(!resolved.startsWith('..'), `${file} imports "${specifier}", which escapes assets/.`);
      assert.ok(jsFiles.has(resolved), `${file} imports "${specifier}" (resolved to ${resolved}), which is not a table row.`);
    }
  }
});

await test('index.html only references assets listed in the manifest', async () => {
  const table = await manifest();
  const rows = new Set(table.map(row => row.path));
  const html = await readFile(join(assetsRoot, 'index.html'), 'utf8');
  const references: string[] = [];
  for (const match of html.matchAll(/<script[^>]*\bsrc=["']([^"']+)["']/g)) { const src = match[1]; if (src !== undefined) references.push(src); }
  for (const match of html.matchAll(/<link[^>]*\bhref=["']([^"']+)["']/g)) { const href = match[1]; if (href !== undefined) references.push(href); }
  assert.ok(references.length > 0, 'index.html should reference at least one script or stylesheet.');
  for (const reference of references) {
    const resolved = reference.startsWith('/') ? reference : posix.normalize(posix.join('/', reference));
    assert.ok(rows.has(resolved), `index.html references "${reference}" (resolved to ${resolved}), which is not a manifest row.`);
  }
});

await test(`every asset is at most ${String(limits.fileBytes)} bytes`, async () => {
  const table = await manifest();
  for (const row of table) {
    const info = await stat(join(assetsRoot, row.file));
    assert.ok(info.size <= limits.fileBytes, `${row.file} is ${String(info.size)} bytes, over the ${String(limits.fileBytes)}-byte limit.`);
  }
});

/** Reads every text/html row of a package's asset manifest (by its own root and manifest path), so the
 * CSP guard below can cover gateway-login's served pages the same way it covers this package's own. */
async function htmlAssets(root: string, path: string): Promise<{ file: string; source: string }[]> {
  const raw: unknown = JSON.parse(await readFile(path, 'utf8'));
  const rows: { file: string; source: string }[] = [];
  if (!isObject(raw) || !Array.isArray(raw['assets'])) return rows;
  const seen = new Set<string>();
  for (const item of raw['assets']) {
    if (!isObject(item) || typeof item['file'] !== 'string' || typeof item['type'] !== 'string') continue;
    if (item['type'] !== 'text/html' || seen.has(item['file'])) continue;
    seen.add(item['file']);
    rows.push({ file: item['file'], source: await readFile(join(root, item['file']), 'utf8') });
  }
  return rows;
}

/** lib/assets sends `default-src 'self'` with no `style-src` (or `script-src`) exception, so an inline
 * `<script>` without `src`, a `<style>` tag, a `style=` attribute, or an `on*=` handler attribute would
 * be silently dropped by the browser rather than run — each is a served-but-dead (or worse, confusingly
 * half-working) page, not a working one under this CSP. */
function cspViolations(source: string): string[] {
  const issues: string[] = [];
  for (const match of source.matchAll(/<script\b([^>]*)>/gi)) {
    if (!/\bsrc\s*=/i.test(match[1] ?? '')) issues.push('an inline <script> without src');
  }
  if (/<style[\s>]/i.test(source)) issues.push('a <style> tag');
  if (/\bstyle\s*=\s*["']/i.test(source)) issues.push('a style= attribute');
  if (/\bon[a-z]+\s*=\s*["']/i.test(source)) issues.push('an on*= handler attribute');
  return issues;
}

await test('no served .html (this package\'s or gateway-login\'s) carries an inline script, a style tag/attribute, or an on*= handler, all of which lib/assets\' CSP blocks', async () => {
  const loginRoot = join(here, '../gateway-login/assets'); const loginManifest = join(here, '../gateway-login/assets.json');
  const rows = [...await htmlAssets(assetsRoot, manifestPath), ...await htmlAssets(loginRoot, loginManifest)];
  assert.ok(rows.length >= 2, 'expected at least one served .html from each of gateway-web and gateway-login.');
  for (const { file, source } of rows) {
    const issues = cspViolations(source);
    assert.deepEqual(issues, [], `${file} contains ${issues.join(', ')}, which lib/assets' CSP (default-src 'self', no style-src exception) blocks.`);
  }
});

/** Every URL inside the served app must be document-relative: the reverse proxy mounts each person's
 * socket under a stripped-away prefix, so an absolute "/foo" would bypass that prefix. The sole
 * exception is the sign-in redirect to `/login`, which is deliberately absolute (it leaves this app). */
await test('no served asset contains an absolute URL other than the /login sign-in redirect', async () => {
  const table = await manifest();
  const patterns: RegExp[] = [/\b(?:href|src)\s*=\s*["'](\/[^"']*)["']/g, /\bfetch\s*\(\s*["'](\/[^"']*)["']/g, /["'](\/ws)["']/g];
  for (const row of table) {
    if (!['text/html', 'text/css', 'text/javascript'].includes(row.type)) continue;
    const source = await readFile(join(assetsRoot, row.file), 'utf8');
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const url = match[1];
        if (url === undefined) continue;
        assert.ok(url.startsWith('/login'), `${row.file} contains the absolute URL "${url}"; only relative URLs (and the /login redirect) are allowed.`);
      }
    }
  }
});

/** Parses one `import <clause> from "<specifier>"` statement's clause into the names it binds. Only
 * the named-import (braced) half is returned: a namespace (`* as x`) or default import cannot be
 * name-checked against the target's exports without knowing which export it aliases, so callers that
 * need every relative import's specifier (the graph test above) parse the statement separately. */
function namedImportsOf(clause: string): string[] {
  const braced = clause.match(/\{([^}]*)\}/);
  if (!braced) return [];
  const inner = braced[1];
  if (inner === undefined || inner.trim() === '') return [];
  return inner.split(',').map(part => part.trim()).filter(part => part !== '').map(part => (part.split(/\s+as\s+/)[0] ?? part).trim());
}

function importStatements(source: string): { clause: string; specifier: string }[] {
  const rows: { clause: string; specifier: string }[] = [];
  for (const match of source.matchAll(/import\s+([^'";]+?)\s+from\s+["']([^"']+)["']/g)) {
    const clause = match[1]; const specifier = match[2];
    if (clause !== undefined && specifier !== undefined && specifier.startsWith('.')) rows.push({ clause, specifier });
  }
  return rows;
}

/** Every name a file exports under `export function`/`export const`/`export let`/`export class`, plus
 * anything re-exported through a trailing `export { a, b as c }` list (by its exported name). */
function namedExportsOf(source: string): Set<string> {
  const names = new Set<string>();
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s*\*?\s+([A-Za-z_$][\w$]*)/g)) { const name = match[1]; if (name !== undefined) names.add(name); }
  for (const match of source.matchAll(/export\s+(?:const|let|class)\s+([A-Za-z_$][\w$]*)/g)) { const name = match[1]; if (name !== undefined) names.add(name); }
  for (const match of source.matchAll(/export\s*\{([^}]*)\}/g)) {
    const inner = match[1]; if (inner === undefined) continue;
    for (const part of inner.split(',')) {
      const trimmed = part.trim(); if (trimmed === '') continue;
      const pieces = trimmed.split(/\s+as\s+/);
      const exportedName = (pieces.length > 1 ? pieces[1] : pieces[0]) ?? trimmed;
      names.add(exportedName.trim());
    }
  }
  return names;
}

await test('every named import resolves to a named export of the file it imports from', async () => {
  const table = await manifest();
  const jsFiles = new Set(table.filter(row => extname(row.file) === '.js').map(row => row.file));
  const exportsByFile = new Map<string, Set<string>>();
  for (const file of jsFiles) {
    const source = await readFile(join(assetsRoot, file), 'utf8');
    for (const { clause, specifier } of importStatements(source)) {
      const resolved = posix.normalize(posix.join(posix.dirname(file), specifier));
      if (!jsFiles.has(resolved)) continue; // reported by the import-graph test above instead.
      if (!exportsByFile.has(resolved)) exportsByFile.set(resolved, namedExportsOf(await readFile(join(assetsRoot, resolved), 'utf8')));
      const exported = exportsByFile.get(resolved);
      assert.ok(exported !== undefined, `${resolved} could not be read while checking ${file}'s import.`);
      for (const name of namedImportsOf(clause)) {
        assert.ok(exported.has(name), `${file} imports "${name}" from "${specifier}" (resolved to ${resolved}), which has no such export.`);
      }
    }
  }
});

/** Strips `//` and `/* *\/` comments so doc-comment prose — which freely uses words this guard bans
 * from user-visible copy, and backticks for inline code that would otherwise look like a template
 * literal — never reaches the literal scan below. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function stringLiterals(source: string): string[] {
  const out: string[] = [];
  for (const match of source.matchAll(/"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`((?:[^`\\]|\\.)*)`/g)) {
    const value = match[1] ?? match[2] ?? match[3];
    if (value !== undefined) out.push(value);
  }
  return out;
}

/** Text a person reading the rendered page would never see: a CSS class list (bare, hyphenated,
 * lowercase words — this codebase's real UI copy is always capitalised prose) once any `${...}`
 * interpolation is blanked out. Covers class strings like `` `session${active ? " is-active" : ""}` ``
 * and `"toast-host"`, which name DOM structure rather than say anything to a person. */
function looksLikeIdentifierList(literal: string): boolean {
  const flattened = literal.replace(/\$\{[^}]*\}/g, ' ').trim();
  return flattened !== '' && /^[a-z0-9-\s]+$/.test(flattened);
}

function htmlLiterals(source: string): string[] {
  const withoutComments = source.replace(/<!--[\s\S]*?-->/g, ' ');
  const out: string[] = [];
  for (const match of withoutComments.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)) {
    const body = match[1]; if (body !== undefined) out.push(...stringLiterals(stripComments(body)));
  }
  const withoutScripts = withoutComments.replace(/<script[^>]*>[\s\S]*?<\/script>/g, ' ');
  for (const match of withoutScripts.matchAll(/\b(?:title|aria-label|placeholder|alt)\s*=\s*"([^"]*)"/g)) {
    const value = match[1]; if (value !== undefined) out.push(value);
  }
  for (const line of withoutScripts.replace(/<[^>]*>/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (trimmed !== '') out.push(trimmed);
  }
  return out;
}

/** ADR-08's vocabulary is a deny list as much as an allow list: `session`, `host`, `orchestrator`,
 * `backend`, `merge`, `pull`, `install`, `module` and `component` describe this system from the inside
 * and must never leak into copy a person reads. Scoped to quoted literals and rendered text — not doc
 * comments, not identifiers, not CSS class names — because those are what "the UI never says X"
 * actually means. */
const NEVER_SAY = /\b(session|host|orchestrator|backend|merge|pull|install|module|component)\b/i;

/** Vendored third-party bundles are not this project's copy. `vendor/mermaid.js` is a minified
 * library whose internal identifiers and messages ("COMPONENT", ",component:", a bundler's
 * `module.exports` probe) trip the scan roughly forty times, and none of it is text a reader of this
 * UI can ever see: the only strings mermaid renders are the diagram source the model wrote. Editing
 * a vendored bundle to satisfy a copy rule would also break its recorded hash (docs/dependencies.md),
 * so the guard is scoped to the files this project writes. */
const VENDORED = 'vendor/';

await test('no user-visible string in assets/ names a never-say vocabulary word', async () => {
  const table = await manifest();
  for (const row of table) {
    if (row.file.startsWith(VENDORED)) continue;
    if (!['text/html', 'text/javascript'].includes(row.type)) continue;
    const source = await readFile(join(assetsRoot, row.file), 'utf8');
    const literals = extname(row.file) === '.html' ? htmlLiterals(source) : stringLiterals(stripComments(source));
    for (const literal of literals) {
      if (!NEVER_SAY.test(literal) || looksLikeIdentifierList(literal)) continue;
      assert.fail(`${row.file} shows the text "${literal}", which names a never-say vocabulary word.`);
    }
  }
});
