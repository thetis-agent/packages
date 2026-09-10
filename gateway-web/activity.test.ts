/** Cover the served sidebar's pure logic and hold the served scripts to the CSP the host sends; ADR 0005, ADR 0019. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, join, extname } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const run = promisify(execFile);

/** Bounds the child test runner, so a hung check fails this suite instead of the whole run. */
export const limits = { checksMs: 60_000 };

/* assets/lib/activity.js is a served ES module with no declarations, and this repository type-checks
 * `.ts` only (tsconfig.base.json sets no `allowJs`), so importing it from here would need a silencing
 * cast the house rules forbid. Its assertions live in activity.checks.mjs and run under node's own
 * test runner in a child; this test is the thing that makes them part of `npm run test`, and reports
 * what the child said so a failure names the case rather than an exit code. */
await test('assets/lib/activity.js passes its own branch checks', async () => {
  // `NODE_TEST_CONTEXT` is how node's runner tells a child it is a test worker: inherited, it switches
  // the child to the serialized worker protocol and leaves stdout empty, so the report below would be
  // blank whether the checks passed or failed. Dropped, the child reports plain TAP for its own sake.
  const environment = { ...process.env };
  delete environment['NODE_TEST_CONTEXT'];
  const finished = await run(process.execPath, ['--test', '--test-reporter=tap', join(here, 'activity.checks.mjs')],
    { timeout: limits.checksMs, encoding: 'utf8', env: environment })
    .catch((error: unknown) => error);
  const said = (stream: string): string => isObject(finished) && typeof finished[stream] === 'string' ? finished[stream] : '';
  const output = `${said('stdout')}\n${said('stderr')}`;
  assert.ok(!(finished instanceof Error), `activity.checks.mjs failed:\n${output}`);
  assert.match(output, /# fail 0/, `activity.checks.mjs reported failures:\n${output}`);
});

/* lib/assets sends `default-src 'self'` with no `style-src` exception, which blocks a `style=`
 * attribute as surely as it blocks an inline <script>. The sidebar's sheen still needs one value per
 * row (`--phase`), and views/sessions.js sets it through CSSOM — `element.style.setProperty` — which
 * the CSP does not govern. assets.test.ts guards the markup; this guards the scripts, which is where
 * the temptation to write `style:` back into an `el(...)` call actually lives. */
await test('no served script sets a style attribute, which the CSP would drop silently', async () => {
  const raw: unknown = JSON.parse(await readFile(join(here, 'assets.json'), 'utf8'));
  assert.ok(isObject(raw) && Array.isArray(raw['assets']), 'assets.json must have an "assets" array.');
  const files = (isObject(raw) && Array.isArray(raw['assets']) ? raw['assets'] : [])
    .filter(isObject).map(row => row['file']).filter((file): file is string => typeof file === 'string');
  let scripts = 0;
  for (const file of new Set(files)) {
    if (extname(file) !== '.js') continue;
    /* A vendored third-party bundle is not authored here and cannot be held to this rule: mermaid
     * styles the SVG it builds from inside its own code. That inline styling is inert under this
     * CSP — verified in a browser against the production header — and assets/lib/mermaid.js rehomes
     * both the <style> element and the surviving attributes through CSSOM, which the policy does not
     * gate. lib/mermaid.js is first-party and IS covered below; the bundle it drives is not. */
    if (file.startsWith('vendor/')) continue;
    scripts++;
    const source = await readFile(join(here, 'assets', file), 'utf8');
    assert.doesNotMatch(source, /\bstyle\s*:/u, `${file} passes a style property to an element factory.`);
    assert.doesNotMatch(source, /setAttribute\(\s*["']style["']/u, `${file} sets a style attribute directly.`);
  }
  assert.ok(scripts > 0, 'the manifest should list served scripts to check.');
});
