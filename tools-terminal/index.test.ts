/** Exercise real child processes through the real hooks, with a real spill sink; TE-018, TE-021, TE-024.
 *
 * Nothing here is stubbed: every case starts an actual `/bin/sh`, reads what it actually printed, and
 * ends with `shutdown` leaving no child behind, which is the conformance requirement for a handler
 * that owns processes. The one thing fabricated is `ctx`, because the loader that normally supplies
 * it lives in another process; what it supplies is four fields and an `emit`, and the emit is the
 * point of the pending test.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { stages } from './index.ts';
import { limits } from './commands.ts';
import { SpillSink } from '@/lib/spill/index.ts';
import type { CallRequest } from '@/contracts/turn-events/types.ts';

const notices: Record<string, unknown>[] = [];
const root = await mkdtemp('/tmp/terminal-');
await stages.init({}, { settings: {}, spaces: [{ path: root, mode: 'rw', space: 'work' }], emit: notice => { notices.push(notice); } });

async function call(name: string, args: Record<string, unknown>, readOnly = false) {
  const id = randomUUID(); const sink = new SpillSink(root, id);
  const request: CallRequest = { id, name, args, roots: [{ path: root, mode: 'rw', space: 'work' }], mode: { readOnly, deny: [] }, deadlineMs: 30000, budget: { resultBytes: 32768 } };
  const answer = await stages.call(request, sink);
  const output = await sink.finish(); assert.ok(output.ok);
  return { answer, text: output.value.text };
}

/** The panel's route, which is the same hook with a verb instead of a tool name. */
async function panel(verb: string, args: Record<string, unknown>) {
  const id = randomUUID(); const sink = new SpillSink(root, id);
  const request: CallRequest = { id, name: verb, args, roots: [], mode: { readOnly: false, deny: [] }, deadlineMs: 20000, budget: { resultBytes: 262144 } };
  const answer = await stages.call(request, sink); await sink.abort();
  const body = answer.content?.[0];
  return { answer, value: body?.type === 'text' ? JSON.parse(body.text) as Record<string, unknown> : undefined };
}

const settle = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms));

await test('a command that finishes inside the turn answers with what it printed', async () => {
  const run = await call('run_command', { command: 'echo hello; echo there >&2', name: 'greeting' });
  assert.equal(run.answer.ok, true);
  assert.equal(run.answer.pending, undefined);
  assert.match(run.text, /hello/u);
  assert.match(run.text, /there/u, 'a command speaks on both its outputs and both are one screen');
  assert.match(run.text, /greeting finished\./u);
  assert.equal(run.answer.data?.['running'], false);
  assert.equal(run.answer.data['code'], 0);
});

await test('a command that does not finish answers pending and owes exactly one notice', async () => {
  const run = await call('run_command', { command: `echo starting; sleep ${String(limits.graceMs / 1000 + 2)}`, name: 'slow' });
  assert.equal(run.answer.ok, true);
  const handle = run.answer.pending?.handle;
  assert.equal(typeof handle, 'string');
  assert.match(run.text, /starting/u);
  assert.match(run.text, /still running\. Read what it prints next with read_command id/u);
  const before = notices.length;
  await settle((limits.graceMs + 3000));
  const mine = notices.slice(before).filter(notice => notice['handle'] === handle);
  assert.equal(mine.length, 1, 'exactly one notice per handle');
  assert.equal(mine[0]?.['wake'], false);
  await settle(200);
  assert.equal(notices.filter(notice => notice['handle'] === handle).length, 1, 'and never a second one');
});

await test('reading twice returns what arrived between the reads, and nothing again', async () => {
  const run = await call('run_command', { command: 'echo first; sleep 4; echo second', name: 'two' });
  const id = run.answer.data?.['id'];
  assert.equal(typeof id, 'string');
  assert.match(run.text, /first/u);
  await settle(4500);
  const second = await call('read_command', { id });
  assert.match(second.text, /second/u);
  assert.doesNotMatch(second.text, /first/u);
  const third = await call('read_command', { id });
  assert.match(third.text, /Nothing new/u);
  const whole = await call('read_command', { id, from_start: true });
  assert.match(whole.text, /first/u);
});

await test('a command can be typed into and stopped, and says so afterwards', async () => {
  const run = await call('run_command', { command: 'cat', name: 'echoing' });
  const id = run.answer.data?.['id'];
  assert.equal(run.answer.pending?.handle, id);
  assert.equal((await call('write_command', { id, text: 'spoken' })).answer.ok, true);
  await settle(300);
  assert.match((await call('read_command', { id })).text, /spoken/u);
  assert.equal((await call('stop_command', { id })).answer.ok, true);
  await settle(500);
  assert.match((await call('list_commands', {})).text, /\techoing\techoing was stopped\.\tcat\n/u);
  const refused = await call('write_command', { id, text: 'too late' });
  assert.equal(refused.answer.ok, false);
  assert.equal(refused.answer.error?.code, 'tool');
});

await test('read-only mode offers only the reading tools and refuses the rest', async () => {
  const offered = await stages.offer({ mode: { readOnly: true, deny: [] } });
  assert.deepEqual(offered.map(tool => tool.name), ['read_command', 'list_commands']);
  const refused = await call('run_command', { command: 'echo nope' }, true);
  assert.equal(refused.answer.ok, false);
  assert.equal(refused.answer.error?.code, 'read-only-mode');
  assert.equal((await stages.offer({ mode: { readOnly: false, deny: [] } })).length, 5);
});

await test('a name that was never offered, and arguments that do not fit, never reach a command', async () => {
  const gone = await call('run_shell', { command: 'echo nope' });
  assert.equal(gone.answer.error?.code, 'gone');
  const invalid = await call('run_command', { name: 'no command at all' });
  assert.equal(invalid.answer.error?.code, 'invalid-args');
  const missing = await call('read_command', { id: 'not-a-command' });
  assert.equal(missing.answer.error?.code, 'not-found');
});

await test('the panel drives the same commands through its own declared verbs', async () => {
  const started = await panel('start', { command: 'echo from the panel', name: 'panelled' });
  const id = started.value?.['started'];
  assert.equal(typeof id, 'string');
  await settle(400);
  const read = await panel('output', { id, since: 0 });
  assert.match(String(read.value?.['text']), /from the panel/u);
  assert.equal(read.value?.['readOnly'], false);
  const listed = read.value['commands'];
  assert.ok(Array.isArray(listed) && listed.some(entry => (entry as Record<string, unknown>)['id'] === id));
  // A name that is neither a declared verb nor a tool is refused as a name that is not there. The
  // gateway never forwards an undeclared verb (ADR 0051), so this is the second line rather than the
  // first, and it is the same refusal the model would get for a tool that had been withdrawn.
  const unknown = await panel('rm', { id });
  assert.equal(unknown.answer.ok, false);
  assert.equal(unknown.answer.error?.code, 'gone');
});

await test('the conversation is read-only once an offer says so, and the panel is refused too', async () => {
  stages.observe({ type: 'offer', conversation: 'c', turn: 1, iteration: 1, seq: 1, payload: { tools: [], mode: { readOnly: true, deny: [] } } });
  const refused = await panel('start', { command: 'echo nope' });
  assert.equal(refused.answer.ok, false);
  assert.equal(refused.answer.error?.code, 'read-only-mode');
  assert.equal((await panel('output', { id: '' })).value?.['readOnly'], true, 'and the panel is told why');
  stages.observe({ type: 'offer', conversation: 'c', turn: 2, iteration: 1, seq: 1, payload: { tools: [], mode: { readOnly: false, deny: [] } } });
});

await test('only so many commands may run at once, and shutdown leaves none of them', async () => {
  const ids: string[] = [];
  for (let at = 0; at < limits.sessions; at++) {
    const run = await call('run_command', { command: 'sleep 30', name: `held-${String(at)}` });
    const id = run.answer.data?.['id']; assert.equal(typeof id, 'string'); ids.push(String(id));
  }
  const full = await call('run_command', { command: 'sleep 30', name: 'one too many' });
  assert.equal(full.answer.ok, false);
  assert.equal(full.answer.error?.code, 'budget');
  assert.match(full.answer.error.message, /Stop one first\./u);
  await stages.shutdown();
  assert.match((await call('list_commands', {})).text, /Nothing has been run here yet\./u);
  await rm(root, { recursive: true, force: true });
});
