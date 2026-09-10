/** Exercise the Context inspector's drawing without a browser.
 *
 * surface/view.js takes its DOM helpers as an argument (see its own comment), so the recording
 * stand-in below stands in for `/lib/surface.js`'s `el` and `section` and every branch can be read
 * back as a tree. The CSP guard that no branch reaches for a `style` attribute lives in
 * surface.test.ts; what is checked here is that the one per-element value goes through CSSOM.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, requestBlocks, promptBlocks, segmented, usageBlocks, SEGMENTS } from './surface/view.js';
import type { Dom, SectionSpec } from './surface/view.js';
import type { Described, PromptModel, RequestModel, UsageModel } from './surface/fold.js';

interface Fake {
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: Fake[];
  readonly styles: Record<string, string>;
  readonly style: { setProperty: (name: string, value: string) => void };
  text: string;
}

function isFake(value: unknown): value is Fake {
  return typeof value === 'object' && value !== null && 'tag' in value;
}

function isHandler(value: unknown): value is () => void {
  return typeof value === 'function';
}

function el(tag: string, props: Readonly<Record<string, unknown>> = {}, ...children: readonly unknown[]): Fake {
  const styles: Record<string, string> = {};
  const node: Fake = { tag, props, children: [], styles, style: { setProperty: (name, value) => { styles[name] = value; } }, text: '' };
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    if (isFake(child)) node.children.push(child);
    // Narrowed rather than stringified blind: a stray object would read as [object Object] and hide a bug.
    else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') node.text += String(child);
  }
  return node;
}

const dom: Dom<Fake> = { el, section: (spec: SectionSpec) => el('section', { ...spec }, spec.title, spec.count === undefined ? null : ` ${String(spec.count)} `, spec.note ?? null) };

function walk(node: Fake): Fake[] { return [node, ...node.children.flatMap(walk)]; }
function all(nodes: readonly Fake[]): Fake[] { return nodes.flatMap(walk); }
function textOf(node: Fake): string { return [node.text, ...node.children.map(textOf)].filter(Boolean).join(' '); }
function readAll(nodes: readonly Fake[]): string { return nodes.map(textOf).join(' '); }
function classesOf(node: Fake): string[] { const value = node.props['class']; return typeof value === 'string' ? value.split(' ') : []; }
function classed(nodes: readonly Fake[], name: string): Fake[] { return all(nodes).filter(node => classesOf(node).includes(name)); }

const request: RequestModel = {
  provider: 'provider-mock', model: 'mock-1', options: { maxTokens: 1024 }, cachedThrough: 0,
  messages: [{ index: 0, role: 'system', text: 'You are Thetis.', chars: 15, cut: false, cached: true },
    { index: 1, role: 'user', text: 'hello', chars: 5, cut: true, cached: false }],
  tools: [{ name: 'read_file', description: 'Read a file.', schema: { type: 'object' } }],
  counts: { messages: 2, tools: 1 }, hidden: 0, truncated: false,
};

const prompt: PromptModel = {
  groups: [{ name: 'system', count: 1, chars: 15, text: 'You are Thetis.' },
    { name: 'skills', count: 0, chars: 0, text: '' },
    { name: 'harness', count: 2, chars: 40, text: '' },
    { name: 'history', count: 1, chars: 5, text: 'hello' }],
  budget: { total: 128000, reserve: 8000, used: 30000, available: 120000, share: 0.25 },
  truncated: false,
};

const usage: UsageModel = {
  counters: [{ name: 'cost', total: 0.0125 }, { name: 'in', total: 1200 }],
  calls: [{ n: 2, stop: 'length', usage: { cost: 0.01 } }, { n: 1, stop: 'end', usage: { cost: 0.0025, in: 1200 } }],
  forgotten: 0, count: 2,
};

await test('the segment switcher marks the active reading and reports what was pressed', () => {
  const pressed: string[] = [];
  const node = segmented('usage', id => { pressed.push(id); }, dom);
  const buttons = all([node]).filter(child => child.tag === 'button');
  assert.equal(buttons.length, SEGMENTS.length);
  assert.deepEqual(buttons.map(button => button.props['aria-pressed']), ['false', 'false', 'true']);
  const first = buttons[0];
  assert.ok(first);
  const onClick = first.props['onClick'];
  assert.ok(isHandler(onClick));
  onClick();
  assert.deepEqual(pressed, ['request']);
});

await test('with no model call yet the request reading says so rather than drawing an empty body', () => {
  const nodes = requestBlocks(undefined, dom);
  assert.equal(nodes.length, 1);
  assert.match(readAll(nodes), /No model call yet/u);
});

await test('the request reading draws the scalars, the messages and the tool definitions', () => {
  const nodes = requestBlocks(request, dom);
  const read = readAll(nodes);
  assert.match(read, /provider-mock · mock-1/u);
  assert.match(read, /maxTokens/u);
  assert.match(read, /The first 1 are the stored prefix/u);
  assert.equal(classed(nodes, 'ci-pill').length, 1, 'only the cached message is pilled');
  assert.match(read, /read_file/u);
  assert.match(read, /Cut for display/u, 'a cut message says it was cut');
});

await test('a request with no cache breakpoint says so, and one over its bound says what it left out', () => {
  const nodes = requestBlocks({ ...request, cachedThrough: -1, hidden: 7 }, dom);
  const read = readAll(nodes);
  assert.match(read, /asked for no cache breakpoint/u);
  assert.match(read, /7 further rows are not listed/u);
});

await test('a shortened frame is admitted to in the reading it belongs to', () => {
  assert.match(readAll(requestBlocks({ ...request, truncated: true }, dom)), /shortened this request to fit its event budget/u);
  assert.match(readAll(promptBlocks({ ...prompt, truncated: true }, dom)), /shortened this context to fit its event budget/u);
  assert.doesNotMatch(readAll(requestBlocks(request, dom)), /shortened/u);
});

await test('with no context assembled the prompt reading says so', () => {
  assert.match(readAll(promptBlocks(undefined, dom)), /No context assembled yet/u);
});

await test('the prompt reading meters the budget through CSSOM and labels every section', () => {
  const nodes = promptBlocks(prompt, dom);
  const fill = classed(nodes, 'ci-fill')[0];
  assert.ok(fill);
  assert.deepEqual(fill.styles, { width: '25%' });
  const read = readAll(nodes);
  assert.match(read, /30,000 used of 120,000 available/u);
  for (const name of ['system', 'skills', 'harness', 'history']) assert.match(read, new RegExp(name, 'u'));
  assert.match(read, /Empty this turn/u, 'an empty section is named, not hidden');
  assert.match(read, /40 chars across 2 messages, none of it text/u);
});

await test('with nothing spent the usage reading says so', () => {
  assert.match(readAll(usageBlocks({ counters: [], calls: [], forgotten: 0, count: 0 }, dom)), /Nothing spent/u);
});

await test('the usage reading tiles the totals, prices cost as money, and flags an unusual stop', () => {
  const nodes = usageBlocks(usage, dom);
  const read = readAll(nodes);
  assert.match(read, /\$0\.0125/u);
  assert.match(read, /1,200/u);
  assert.equal(classed(nodes, 'ci-stat').length, 3, 'one tile per counter, plus the call count');
  assert.equal(classed(nodes, 'ci-stop').length, 1, 'only the call that stopped on length is flagged');
});

await test('calls dropped from the ledger are still admitted to', () => {
  assert.match(readAll(usageBlocks({ ...usage, forgotten: 5, count: 7 }, dom)), /5 earlier calls are counted in the totals/u);
});

await test('the segment chooses the reading, and an unknown segment falls back to the request', () => {
  const described: Described = { request, prompt, usage };
  assert.match(readAll(blocks('prompt', described, dom)), /used of/u);
  assert.match(readAll(blocks('usage', described, dom)), /per call, newest first/u);
  assert.match(readAll(blocks('request', described, dom)), /provider-mock/u);
  assert.match(readAll(blocks('nonsense', described, dom)), /provider-mock/u);
});
