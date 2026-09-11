/** Guard what the control panel computes: which sections it draws, how far a change has got, and that
 * nothing a person reads names the machinery underneath; ADR 0012, docs/08-vocabulary.md.
 *
 * DOM-free for the same reason dispatch.test.ts is. There is no DOM harness in this repository and
 * adding one would buy these tests a dependency the house rules do not want; it is not needed, because
 * `assets/lib/operator.js` was written so that every decision with a branch in it is a function of
 * frames rather than of a document. The drawing lives in views/admin.js, views/packages.js and
 * views/installing.js and is not reached from here. The module is loaded the way
 * `lib/package-loader/load.ts` loads a package entry: a dynamic import taken as `unknown` and
 * narrowed, never an `any`.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import { isObject } from '@/lib/schema/index.ts';

const here = dirname(fileURLToPath(import.meta.url));
const imported: unknown = await import(pathToFileURL(join(here, 'assets/lib/operator.js')).href);
assert.ok(isObject(imported), 'assets/lib/operator.js should load as a module namespace object.');
const loaded: Record<string, unknown> = imported;

function fn(name: string): (...args: unknown[]) => unknown {
  const value: unknown = loaded[name];
  assert.ok(typeof value === 'function', `assets/lib/operator.js should export ${name} as a function.`);
  return value as (...args: unknown[]) => unknown;
}
function rows(value: unknown): Record<string, unknown>[] {
  assert.ok(Array.isArray(value), 'expected an array.');
  return value.map(entry => { assert.ok(isObject(entry)); return entry; });
}
function object(value: unknown): Record<string, unknown> {
  assert.ok(isObject(value), 'expected an object.'); return value;
}

const visibleSections = fn('visibleSections');
const advance = fn('advance');
const inFlight = fn('inFlight');
const changeView = fn('changeView');
const packageRows = fn('packageRows');
const installChoices = fn('installChoices');
const activityLines = fn('activityLines');
const notStarted: unknown = loaded['NOT_STARTED'];
const stages = rows(loaded['STAGES']);

await test('the nav draws only the sections the host offered, in the panel\'s own order', () => {
  assert.deepEqual(rows(visibleSections([])).map(entry => entry['id']), []);
  assert.deepEqual(rows(visibleSections(['activity', 'packages', 'models'])).map(entry => entry['id']), ['models', 'packages', 'activity']);
  // A name this build has no wording for is dropped rather than shown under its own identifier.
  assert.deepEqual(rows(visibleSections(['nonsense'])).map(entry => entry['id']), []);
  assert.deepEqual(rows(visibleSections('not a list')).map(entry => entry['id']), []);
});

await test('nothing is in flight until a change has actually been reported', () => {
  assert.equal(inFlight(notStarted), false);
  // Ready before anything starts is not the ready that ends a change.
  const quiet = advance(notStarted, 'LIVE');
  assert.equal(inFlight(quiet), false);
  assert.deepEqual(quiet, notStarted);
});

await test('a change walks its steps in order and finishes on the report that it is ready', () => {
  let progress: unknown = notStarted;
  const seen: unknown[] = [];
  for (const stage of ['QUIESCING', 'FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'DRAINING']) {
    progress = advance(progress, stage);
    assert.equal(inFlight(progress), true, `${stage} should still be in flight.`);
    seen.push(object(changeView(progress))['headline']);
  }
  assert.deepEqual(seen, stages.map(stage => `${String(stage['name'])}…`));
  progress = advance(progress, 'LIVE');
  assert.equal(inFlight(progress), false);
  const finished = object(changeView(progress));
  assert.equal(finished['headline'], 'Done.');
  assert.deepEqual(rows(finished['steps']).map(step => step['mark']), stages.map(() => 'done'));
});

await test('progress never goes backwards, so a missed or reordered report costs detail and not the screen', () => {
  // Polled reports can be missed entirely, and a reconnect can deliver an older one after a newer.
  let progress: unknown = advance(advance(notStarted, 'QUIESCING'), 'PROBING');
  assert.equal(object(changeView(progress))['headline'], 'Checking it works…');
  progress = advance(progress, 'FROZEN');
  assert.equal(object(changeView(progress))['headline'], 'Checking it works…');
  // A report this build has no step for leaves the screen exactly as it was.
  assert.deepEqual(advance(progress, 'SOMETHING-ELSE'), progress);
});

await test('a change that does not start says what came back rather than what broke', () => {
  const rolling = advance(advance(notStarted, 'APPLYING'), 'ROLLING_BACK');
  const during = object(changeView(rolling));
  assert.equal(during['headline'], 'Putting things back…');
  assert.equal(during['tone'], 'warn');
  assert.equal(inFlight(rolling), true);
  const back = advance(rolling, 'LIVE');
  const after = object(changeView(back));
  assert.equal(inFlight(back), false);
  assert.match(String(after['headline']), /what you had is back/u);
  // The steps that never happened stay unmarked: a rolled-back change did not finish them.
  assert.deepEqual(rows(after['steps']).map(step => step['mark']), ['done', 'done', 'live', 'todo', 'todo', 'todo']);
  const failed = object(changeView(advance(rolling, 'FAILED')));
  assert.equal(failed['tone'], 'error');
});

await test('the table is filtered and ordered by name, and says who each package runs for in words', () => {
  const packages = [
    { name: 'provider-openai-compatible', version: '1.0.2', scope: 'deployment', internet: true, needs: [], gives: [] },
    { name: 'core', version: '1.0.0', scope: 'person', internet: false, needs: ['contract/turn-events'], gives: [] },
    { name: 'skills-core', version: '1.0.0', internet: false, needs: [], gives: ['skills/core'] },
  ];
  assert.deepEqual(rows(packageRows(packages, '')).map(row => [row['name'], row['scopeLabel']]), [
    ['core', 'Only me'], ['provider-openai-compatible', 'Everyone'], ['skills-core', 'Only me'],
  ]);
  assert.deepEqual(rows(packageRows(packages, ' CORE ')).map(row => row['name']), ['core', 'skills-core']);
  assert.deepEqual(rows(packageRows(undefined, '')), []);
  // A package that runs no service of its own has no scope, and none is invented for it.
  assert.equal(rows(packageRows(packages, 'skills'))[0]?.['scope'], 'person');
});

await test('a way of putting a version in place that no deployment offers is left out, never shown and refused', () => {
  assert.deepEqual(rows(installChoices([])), []);
  assert.deepEqual(rows(installChoices(['packages', 'activity'])), []);
  assert.deepEqual(rows(installChoices(['updates'])).map(choice => choice['label']), ['Everyone']);
  assert.deepEqual(rows(installChoices(['add', 'updates'])).map(choice => choice['label']), ['Only me', 'Everyone']);
});

await test('activity reads as sentences, newest first, and a row with no sentence is left out', () => {
  const lines = rows(activityLines([
    { cursor: 1, at: 1, kind: 'process.start', data: {} },
    { cursor: 2, at: 2, kind: 'turn.start', data: {} },
    { cursor: 3, at: 3, kind: 'generation.transition', data: { to: 'PROBING' } },
    { cursor: 4, at: 4, kind: 'process.exit', data: { reason: 'disk quota exceeded' } },
    { cursor: 5, at: 5, kind: 'something.unheard-of', data: {} },
  ]));
  assert.deepEqual(lines.map(line => line['cursor']), [4, 3, 1]);
  assert.equal(lines[0]?.['text'], 'Your environment stopped: disk quota exceeded.');
  assert.equal(lines[1]?.['text'], 'Checking it works.');
  assert.deepEqual(rows(activityLines(undefined)), []);
});

/* The whole point of the table in operator.js is that the words a person reads are its own and never
 * the machinery's. assets.test.ts guards the vocabulary across every served file; this guards the one
 * place where the kernel's words and a person's sit next to each other, because that is where a new
 * step would most easily be captioned with the wrong one. */
await test('no step, headline or activity line shows a word from the machinery underneath', () => {
  const forbidden = /\b(generation|drain|draining|probe|probing|quiesce|quiescing|digest|baseline|envelope|socket|pin set|profile|kernel|target|transition)\b/iu;
  const said: string[] = [];
  for (const stage of stages) said.push(String(stage['name']), String(stage['note']));
  for (const entry of rows(visibleSections(['settings', 'accounts', 'models', 'modes', 'limits', 'spaces', 'updates', 'packages', 'environments', 'activity', 'restore-points', 'undo']))) {
    said.push(String(entry['label']), String(entry['note']));
  }
  let progress: unknown = notStarted;
  for (const stage of ['QUIESCING', 'FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'DRAINING', 'ROLLING_BACK', 'FAILED', 'LIVE']) {
    progress = advance(progress, stage);
    const view = object(changeView(progress));
    said.push(String(view['headline']), String(view['note']));
  }
  for (const kind of ['process.start', 'process.exit', 'process.shutdown', 'process.drain', 'work.change']) {
    for (const data of [{}, { outcome: 'killed' }, { outcome: 'live' }]) said.push(...rows(activityLines([{ cursor: 1, at: 1, kind, data }])).map(line => String(line['text'])));
  }
  for (const to of ['QUIESCING', 'FROZEN', 'APPLYING', 'PROBING', 'SWITCHING', 'LIVE', 'ROLLING_BACK', 'FAILED']) {
    said.push(...rows(activityLines([{ cursor: 1, at: 1, kind: 'generation.transition', data: { to } }])).map(line => String(line['text'])));
  }
  for (const line of said) assert.ok(!forbidden.test(line), `the panel shows "${line}", which names the machinery underneath.`);
});
