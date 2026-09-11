/** The hooks: what the model is offered, what a panel may ask for, and what the next prompt carries. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schemas } from '@/lib/schema/index.ts';
import type { CallAnswer, CallRequest, Envelope, Message, ToolDef } from '@/contracts/turn-events/types.ts';
import { definitions, stages } from './index.ts';

const schemas = new Schemas(); await schemas.load();
const mode = { readOnly: false, deny: [] };
const request = (name: string, args: Record<string, unknown>, id = 'call-1'): CallRequest =>
  ({ id, name, args, mode, roots: [], budget: { resultBytes: 32768, deadlineMs: 30000 } }) as unknown as CallRequest;
const envelope = (conversation: string): Envelope => ({ type: 'input', conversation, turn: 1, iteration: 0, seq: 0, payload: { text: 'hello', attachments: [] } });
interface Reported { items: { id: string; stage: string }[]; done: number; total: number }
const plan = (answer: CallAnswer): Reported => JSON.parse((answer.content?.[0] as { text: string }).text) as Reported;

await test('every offered definition satisfies contract/turn-events, and none is offered read-only', async () => {
  const valid = schemas.validator<ToolDef>('turn-events', 'toolDef');
  for (const definition of definitions) assert.ok(valid(definition), `${definition.name} does not validate.`);
  assert.deepEqual(await stages.offer({ mode: { readOnly: true, deny: [] } }), []);
  assert.deepEqual((await stages.offer({ mode })).map(tool => tool.name), definitions.map(tool => tool.name));
});

await test('a plan change answers with the whole plan, so the next call can name a line', async () => {
  stages.observe(envelope('c-write'));
  const answer = await stages.call(request('todo_write', { items: ['read it', 'change it'] }));
  assert.equal(answer.ok, true);
  assert.match((answer.content?.[0] as { text: string }).text, /\[ \] t-1 read it/u);
  const validate = schemas.validator('turn-events', 'callAnswer');
  assert.ok(validate(answer));
});

await test('a name this package does not answer is gone rather than guessed at', async () => {
  stages.observe(envelope('c-gone'));
  const answer = await stages.call(request('todo_burn', {}));
  assert.equal(answer.error?.code, 'gone');
});

await test('the panel reads the plan and ticks a line, and the model sees the tick next iteration', async () => {
  stages.observe(envelope('c-tick'));
  await stages.call(request('todo_write', { items: ['one', 'two'] }));
  const read = plan(await stages.call(request('plan', { conversation: 'c-tick' })));
  assert.deepEqual(read, { items: read.items, done: 0, total: 2 });
  const ticked = plan(await stages.call(request('tick', { conversation: 'c-tick', id: 't-2' })));
  assert.equal(ticked.done, 1);
  assert.equal(ticked.items[1]?.stage, 'done');
  const appended: Message[] = [];
  stages.context(message => appended.push(message));
  assert.equal(appended.length, 1);
  assert.match((appended[0]?.content[0] as { text: string }).text, /\[x\] t-2 two/u);
});

await test('a tick of a line that is not on the plan is refused, and an empty plan appends nothing', async () => {
  stages.observe(envelope('c-empty'));
  assert.equal((await stages.call(request('tick', { conversation: 'c-empty', id: 't-9' }))).error?.code, 'not-found');
  assert.equal((await stages.call(request('tick', { conversation: 'c-empty' }))).error?.code, 'invalid-args');
  const appended: Message[] = [];
  stages.context(message => appended.push(message));
  assert.deepEqual(appended, []);
});

await test('a panel naming another conversation reads that one, and never this one by accident', async () => {
  stages.observe(envelope('c-one'));
  await stages.call(request('todo_write', { items: ['only here'] }));
  stages.observe(envelope('c-two'));
  assert.equal(plan(await stages.call(request('plan', { conversation: 'c-one' }))).total, 1);
  assert.equal(plan(await stages.call(request('plan', { conversation: 'c-two' }))).total, 0);
});
