/** Pin paired orchestration against the real loop and outcome sandbox; EV-001, EV-003, EV-004. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Evaluator } from './run.ts';
import type { Configuration } from './run.ts';
import { seedIdentity } from '../../lib/evaluation/index.ts';
import { EvaluationDriver } from '../../test/evaluator-driver.ts';

async function fixture(coreChanged = false) {
  const directory = await mkdtemp('/tmp/evaluation-'); const checks = join(directory, 'run.sh');
  await writeFile(checks, 'test -s /space/conversation.jsonl && ! touch /space/forbidden-write 2>/dev/null\n');
  const configuration: Configuration = { secret: 'fixture-seed', coreChanged, previousDefaultScorer: 'previous-default', stoplist: new Set(), plan: {
    identities: { baseline: '1', candidate: 'sha256:candidate', suite: 'sha256:suite', scorer: 'reviewed', provider: 'fixed', model: 'scripted', seed: seedIdentity('fixture-seed') },
    tasks: ['task-1'], regressions: [], runs: coreChanged ? 5 : 3, scorers: coreChanged ? ['reviewed', 'previous-default'] : ['reviewed'], margin: -2
  }, cases: [{ kind: 'task', task: { id: 'task-1', family: 'tool', request: 'Tell Alice about 12 files in {path}.', mutable: { names: ['Alice'], numbers: ['12'], path: 'path' }, requires: [], required: ['files/read@1'], gold: { tools: ['files/read@1'], skills: [] }, budget: { cost: 0.4, iterations: 20 }, checks, fixture: directory } }] };
  return { configuration, close: () => rm(directory, { recursive: true, force: true }) };
}

await test('EV-001 identical candidates produce identical seeds, variants and outcome rows', async () => {
  const f = await fixture();
  try {
    const first = new EvaluationDriver(); const second = new EvaluationDriver();
    const a = await new Evaluator().run(f.configuration, first); const b = await new Evaluator().run(f.configuration, second);
    assert.ok(a.ok); assert.ok(b.ok); assert.deepEqual(a.value, b.value);
    assert.ok(a.value.rows.every(row => row.pass)); assert.equal(a.value.rows.length, 6);
    assert.deepEqual(first.jobs.map(job => job.input), second.jobs.map(job => job.input));
    for (let index = 0; index < first.jobs.length; index += 2) assert.deepEqual(first.jobs[index]?.input, first.jobs[index + 1]?.input);
    assert.ok(first.jobs.every(job => !job.input.text.includes('Alice') && !job.input.text.includes('task-1')));
  } finally { await f.close(); }
});

await test('EV-003 required tool ablation retains the tool and reports required_by', async () => {
  const f = await fixture();
  try {
    const driver = new EvaluationDriver(); const result = await new Evaluator().run({ ...f.configuration, ablations: true }, driver);
    assert.ok(result.ok); const ablated = result.value.rows.filter(row => row.ablation);
    assert.equal(ablated.length, 6); assert.ok(ablated.every(row => row.required_by?.includes('task-1')));
    assert.ok(driver.jobs.every(job => job.withheld.tools.length === 0));
  } finally { await f.close(); }
});

await test('EV-004 a changed loop schedules five paired runs under both reviewed scorers', async () => {
  const f = await fixture(true);
  try {
    const driver = new EvaluationDriver(); const result = await new Evaluator().run(f.configuration, driver);
    assert.ok(result.ok); assert.equal(result.value.rows.length, 20);
    for (const arm of ['default', 'candidate']) for (const scorer of ['reviewed', 'previous-default']) assert.equal(result.value.rows.filter(row => row.arm === arm && row.scorer === scorer).length, 5);
    const rejected = await new Evaluator().run({ ...f.configuration, plan: { ...f.configuration.plan, scorers: ['reviewed'] } }, driver);
    assert.ok(!rejected.ok); assert.equal(rejected.error.code, 'invalid-args');
  } finally { await f.close(); }
});

await test('ADR-0004 provider changes require five paired runs before execution', async () => {
  const f = await fixture();
  try {
    const driver = new EvaluationDriver(); const result = await new Evaluator().run({ ...f.configuration, providerChanged: true }, driver);
    assert.ok(!result.ok); assert.equal(result.error.code, 'invalid-args'); assert.equal(driver.jobs.length, 0);
  } finally { await f.close(); }
});
