/** Exercise the Tools inspector's drawing without a browser.
 *
 * surface/view.js takes its DOM helpers as an argument (see its own comment), so the recording
 * stand-in below stands in for `/lib/surface.js`'s `el`, `section` and `collapsibleSection`, and
 * every branch can be read back as a tree. The guard that nothing served reaches for a `style`
 * attribute or evaluates source lives in surface.test.ts.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { blocks, card, limits, subtitle, withheldCard } from './surface/view.js';
import type { Dom, SectionSpec } from './surface/view.js';
import type { Described, Tool } from './surface/fold.js';

interface Fake {
  readonly tag: string;
  readonly props: Readonly<Record<string, unknown>>;
  readonly children: Fake[];
  text: string;
}

function isFake(value: unknown): value is Fake {
  return typeof value === 'object' && value !== null && 'tag' in value;
}

function isToggle(value: unknown): value is (open: boolean) => void {
  return typeof value === 'function';
}

function el(tag: string, props: Readonly<Record<string, unknown>> = {}, ...children: readonly unknown[]): Fake {
  const node: Fake = { tag, props, children: [], text: '' };
  for (const child of children.flat(4)) {
    if (child === null || child === undefined || child === false) continue;
    if (isFake(child)) node.children.push(child);
    // Narrowed rather than stringified blind: a stray object would read as [object Object] and hide a bug.
    else if (typeof child === 'string' || typeof child === 'number' || typeof child === 'boolean') node.text += String(child);
  }
  return node;
}

function heading(spec: SectionSpec): Fake {
  return el('section', { ...spec }, spec.title, spec.count === undefined ? null : ` ${String(spec.count)} `, spec.note ?? null);
}

const dom: Dom<Fake> = { el, section: heading, collapsibleSection: (spec, rows) => el('details', { ...spec }, heading(spec), ...rows) };

function walk(node: Fake): Fake[] { return [node, ...node.children.flatMap(walk)]; }
function all(nodes: readonly Fake[]): Fake[] { return nodes.flatMap(walk); }
function textOf(node: Fake): string { return [node.text, ...node.children.map(textOf)].filter(Boolean).join(' '); }
function readAll(nodes: readonly Fake[]): string { return nodes.map(textOf).join(' '); }
function classesOf(node: Fake): string[] { const value = node.props['class']; return typeof value === 'string' ? value.split(' ') : []; }
function classed(nodes: readonly Fake[], name: string): Fake[] { return all(nodes).filter(node => classesOf(node).includes(name)); }
function titles(nodes: readonly Fake[]): string[] { return all(nodes).map(node => node.props['title']).filter((value): value is string => typeof value === 'string'); }

function tool(name: string, extra: Partial<Tool> = {}): Tool {
  return { name, description: `The ${name} tool.`, source: 'tools-files@1.0.0', schema: { type: 'object' }, readOnly: true, endsTurn: false, destructive: false, derived: false, data: [], ...extra };
}

const described: Described = {
  known: true,
  mode: { readOnly: false, deny: ['tools-files/delete_file'] },
  sources: [{ source: 'tools-files@1.0.0', tools: [tool('read_file'), tool('write_file', { readOnly: false, destructive: true, data: ['path'] })] }],
  withheld: [{ name: 'delete_file', entry: 'tools-files/delete_file', why: 'denied', tool: undefined }],
  counts: { offered: 2, sources: 1, withheld: 1 },
};

await test('a tool card names only the flags the tool actually declared', () => {
  const plain = card(dom, tool('read_file'));
  assert.deepEqual(classed([plain], 'ti-badge').map(textOf), ['read-only']);
  const loud = card(dom, tool('write_file', { readOnly: false, destructive: true, endsTurn: true, derived: true, data: ['path', 'bytes'] }));
  assert.deepEqual(classed([loud], 'ti-badge').map(textOf), ['ends turn', 'destructive', 'derived']);
  assert.match(textOf(loud), /Reports path, bytes/u);
  assert.equal(classed([loud], 'is-danger').length, 1, 'only the destructive flag is coloured');
});

await test('a tool card carries its description and its arguments, with a hint on every flag', () => {
  const node = card(dom, tool('read_file'));
  assert.match(textOf(node), /The read_file tool\./u);
  assert.match(textOf(node), /"type": "object"/u);
  assert.ok(titles([node]).some(title => title.includes('read-only mode')));
});

await test('a schema longer than its bound is cut rather than dumped', () => {
  const wide = card(dom, tool('read_file', { schema: { type: 'object', description: 'x'.repeat(limits.chars * 2) } }));
  const pre = classed([wide], 'ti-pre')[0];
  assert.ok(pre);
  assert.ok(textOf(pre).length <= limits.chars + 4);
});

await test('a schema that cannot be serialised is said to be, rather than throwing', () => {
  const cyclic: Record<string, unknown> = {};
  cyclic['self'] = cyclic;
  assert.match(textOf(card(dom, tool('read_file', { schema: cyclic }))), /unserialisable/u);
});

await test('a withheld tool is named, with a reading of why and whatever was known about it', () => {
  const denied = withheldCard(dom, { name: 'delete_file', entry: 'tools-files/delete_file', why: 'denied', tool: undefined });
  assert.match(textOf(denied), /delete_file/u);
  assert.match(textOf(denied), /Denied as tools-files\/delete_file/u);
  assert.deepEqual(classed([denied], 'ti-badge').map(textOf), ['denied']);
  const narrowed = withheldCard(dom, { name: 'write_file', entry: 'write_file', why: 'read-only', tool: tool('write_file', { readOnly: false }) });
  assert.deepEqual(classed([narrowed], 'ti-badge').map(textOf), ['not read-only']);
  assert.match(textOf(narrowed), /The write_file tool\./u);
  assert.doesNotMatch(textOf(narrowed), /Denied as/u);
});

await test('a reason this panel does not have a reading for is shown as itself, not swallowed', () => {
  assert.match(textOf(withheldCard(dom, { name: 'x', entry: 'x', why: 'unheard-of', tool: undefined })), /unheard-of/u);
});

await test('before any offer the panel says what it does not know', () => {
  const empty: Described = { known: false, mode: { readOnly: false, deny: [] }, sources: [], withheld: [], counts: { offered: 0, sources: 0, withheld: 0 } };
  assert.match(readAll(blocks(empty, dom, new Set())), /No offer seen yet/u);
  assert.equal(subtitle(empty), undefined);
});

await test('the panel says what the mode is doing before it lists anything', () => {
  const read = readAll(blocks(described, dom, new Set()));
  assert.match(read, /can call tools that change things/u);
  assert.match(read, /Denied by name: tools-files\/delete_file/u);
  assert.match(read, /withheld/u);
  assert.equal(subtitle(described), '2 offered from 1 package · 1 withheld · read-write');
});

await test('a long deny list is spelled out up to its bound and counted after it', () => {
  const names = Array.from({ length: limits.denied + 3 }, (_, index) => `t${String(index)}`);
  const loud: Described = { ...described, mode: { readOnly: false, deny: names } };
  const read = readAll(blocks(loud, dom, new Set()));
  assert.match(read, /and 3 more/u);
  assert.doesNotMatch(read, new RegExp(`t${String(limits.denied)}[^0-9]`, 'u'));
});

await test('a read-only conversation says so, and admits what it cannot name', () => {
  const strict: Described = { ...described, mode: { readOnly: true, deny: [] }, withheld: [], counts: { ...described.counts, withheld: 0 } };
  const read = readAll(blocks(strict, dom, new Set()));
  assert.match(read, /This conversation is read-only/u);
  assert.match(read, /leaves no trace on this wire/u);
  assert.equal(subtitle(strict), '2 offered from 1 package · read-only');
});

await test('an offer with no tools at all says so rather than showing an empty page', () => {
  const none: Described = { known: true, mode: { readOnly: true, deny: [] }, sources: [], withheld: [], counts: { offered: 0, sources: 0, withheld: 0 } };
  assert.match(readAll(blocks(none, dom, new Set())), /No tools are offered in this mode/u);
  assert.equal(subtitle(none), '0 offered from 0 packages · read-only');
});

await test('a source group remembers whether the person had it open', () => {
  const open = new Set<string>(['tools-files@1.0.0']);
  const group = blocks(described, dom, open).find(node => node.tag === 'details');
  assert.ok(group);
  assert.equal(group.props['open'], true);
  const onToggle = group.props['onToggle'];
  assert.ok(isToggle(onToggle));
  onToggle(false);
  assert.equal(open.size, 0);
  onToggle(true);
  assert.deepEqual([...open], ['tools-files@1.0.0']);
});
