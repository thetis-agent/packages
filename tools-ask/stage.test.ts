/** The round trip: a call answered as unfinished, a person's reply, and the notice that completes it.
 *
 * What these check is this package's end of the contract — the handle the call promised, the
 * conversation the notice names, the words in it. The other end, that a queued notice becomes a `tool`
 * message in that conversation's history at the next turn boundary, is the core's and is covered by
 * packages/core/notices.test.ts and runtime/test/notices.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { Schemas } from '@/lib/schema/index.ts';
import type { CallAnswer, CallRequest, Content, Envelope, ToolDef } from '@/contracts/turn-events/types.ts';
import { definitions, settings, stages } from './index.ts';

const schemas = new Schemas(); await schemas.load();
const mode = { readOnly: false, deny: [] };
/** What `ctx.emit` was handed, which the loader validates against contract/turn-events before it goes
 *  anywhere; named here rather than reached for through `Notice`, whose index signature erases the
 *  fields this wants to read. */
interface Emitted { tool?: string; handle?: string; conversation?: string; content: Content[]; wake?: boolean }
const notices: Emitted[] = [];
await stages.init({}, { settings: {}, emit: (notice: Emitted) => { notices.push(notice); } });

const request = (name: string, args: Record<string, unknown>, id = 'call-1'): CallRequest =>
  ({ id, name, args, mode, roots: [], budget: { resultBytes: 32768, deadlineMs: 30000 } }) as unknown as CallRequest;
const envelope = (conversation: string, type: Envelope['type'] = 'input'): Envelope => ({ type, conversation, turn: 1, iteration: 0, seq: 0, payload: {} });
interface Reported { questions: { handle: string; state: string; answer: string }[] }
const asked = (answer: CallAnswer): Reported => JSON.parse((answer.content?.[0] as { text: string }).text) as Reported;

await test('the definition validates, says it ends the turn, and is offered in every mode', async () => {
  const valid = schemas.validator<ToolDef>('turn-events', 'toolDef');
  assert.ok(valid(definitions[0]));
  assert.equal(definitions[0].endsTurn, true);
  assert.equal((await stages.offer()).length, 1);
});

await test('a question answers its call as unfinished, names the handle, and stops the turn', async () => {
  stages.observe(envelope('c-ask'));
  const answer = await stages.call(request('ask_user', { question: 'How long?', shape: 'choice', options: ['a', 'b'] }, 'call-ask'));
  assert.ok(schemas.validator('turn-events', 'callAnswer')(answer));
  assert.equal(answer.ok, true);
  assert.equal(answer.endsTurn, true);
  // The handle is the call's own id, which is also what the browser has in the frame it draws.
  assert.equal(answer.pending?.handle, 'call-ask');
  assert.match((answer.content?.[0] as { text: string }).text, /Waiting for an answer to: How long\?/u);
});

await test('the answer settles the question and emits exactly one notice completing that call', async () => {
  stages.observe(envelope('c-reply'));
  const opened = await stages.call(request('ask_user', { question: 'Which way?', shape: 'confirm' }, 'call-reply'));
  assert.equal(asked(await stages.call(request('asked', { conversation: 'c-reply' }))).questions[0]?.state, 'waiting');
  notices.length = 0;
  const settled = await stages.call(request('reply', { conversation: 'c-reply', handle: opened.pending?.handle, answer: 'Yes' }));
  assert.equal(asked(settled).questions[0]?.answer, 'Yes');
  // "an emitter that returned `pending` emits exactly one notice per handle" — the contract's own
  // conformance line for a notice emitter.
  assert.equal(notices.length, 1);
  const [emitted] = notices; assert.ok(emitted);
  assert.equal(emitted.handle, 'call-reply');
  assert.equal(emitted.tool, 'ask_user');
  // Nothing but the emitting stage knows which conversation the work belonged to, so the notice says.
  assert.equal(emitted.conversation, 'c-reply');
  assert.ok(schemas.validator('turn-events', 'notice')({ ...emitted, source: 'tools-ask@1.0.0' }));
  assert.match((emitted.content[0] as { text: string }).text, /You asked: Which way\?\nThey answered: Yes/u);
});

await test('a question is answered once, and one nobody answered is no longer needed', async () => {
  stages.observe(envelope('c-twice'));
  const opened = await stages.call(request('ask_user', { question: 'Again?' }, 'call-twice'));
  const handle = opened.pending?.handle;
  await stages.call(request('reply', { conversation: 'c-twice', handle, answer: 'once' }));
  const second = await stages.call(request('reply', { conversation: 'c-twice', handle, answer: 'twice' }));
  assert.equal(second.ok, false);
  assert.match(second.error?.message ?? '', /already been answered/u);
  assert.equal((await stages.call(request('reply', { conversation: 'c-twice', handle: 'call-nothing', answer: 'x' }))).error?.message, 'That question is no longer needed.');
});

await test('a question that ran out of time is retired, and answering it is refused in plain words', async () => {
  const kept = settings.answerMs;
  settings.answerMs = 1;
  try {
    stages.observe(envelope('c-expire'));
    const opened = await stages.call(request('ask_user', { question: 'Still there?' }, 'call-expire'));
    await new Promise(resolve => setTimeout(resolve, 5));
    const refused = await stages.call(request('reply', { conversation: 'c-expire', handle: opened.pending?.handle, answer: 'late' }));
    assert.equal(refused.error?.message, 'That question is no longer needed.');
    assert.equal(asked(await stages.call(request('asked', { conversation: 'c-expire' }))).questions[0]?.state, 'expired');
  } finally { settings.answerMs = kept; }
});

/* The sentences a person or a model actually reads, checked against the house rule on vocabulary.
 * The panel's own answer is excluded on purpose: it is JSON with a `handle` field in it, read by the
 * package's own module and never rendered, which is data rather than a sentence. */
await test('nothing said in words names a handle, a notice or a pending call', async () => {
  stages.observe(envelope('c-words'));
  const opened = await stages.call(request('ask_user', { question: 'Readable?' }, 'call-words'));
  const said = [(opened.content?.[0] as { text: string }).text,
    (await stages.call(request('reply', { conversation: 'c-words', handle: 'call-nothing', answer: 'x' }))).error?.message ?? '',
    (await stages.call(request('nothing', {}))).error?.message ?? ''];
  notices.length = 0;
  await stages.call(request('reply', { conversation: 'c-words', handle: opened.pending?.handle, answer: 'yes' }));
  said.push((notices[0]?.content[0] as { text: string }).text);
  for (const sentence of said) assert.doesNotMatch(sentence, /handle|pending|notice|envelope|tool call/iu, sentence);
});
