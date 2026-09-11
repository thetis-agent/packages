/** One conversation's plan, as a value: every change is a pure function of the list and the arguments.
 *
 * The list is the only thing this package is about, so it is kept apart from the stage that offers the
 * tools and answers the panel — the interesting decisions are here (what an id is, what a bound
 * refuses, what the model is shown) and none of them need a request, a sink or a clock to be tested.
 *
 * Ids are minted, never taken from the model. A tool that let the caller choose an id would have to
 * decide what happens when it chose one twice, and the model has no reason to care what an item is
 * called: it names an item to mark or to move, and the list it was just shown carries the names.
 */

/** Bounds the plan itself; the stage resolves them from its settings and hands them in. */
export interface Limits { items: number; textLength: number }
export const limits: Limits = { items: 64, textLength: 200 };

export type Stage = 'pending' | 'active' | 'done';
export interface Item { id: string; text: string; stage: Stage; note?: string }
export interface Plan { items: Item[]; next: number }

export function empty(): Plan { return { items: [], next: 1 }; }

/** Trims a person- or model-supplied line to one bounded line: a plan is a list of things to do, and a
 *  paragraph with newlines in it draws as one long row nobody can read. */
function line(value: unknown, bound: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, bound) : '';
}

function stageOf(value: unknown): Stage {
  return value === 'active' || value === 'done' ? value : 'pending';
}

/** An item as the tools accept it: text, an optional stage, and an optional note for the one in hand. */
function item(plan: Plan, value: unknown, bounds: Limits): Item | undefined {
  const source = typeof value === 'string' ? { text: value } : value;
  if (typeof source !== 'object' || source === null) return undefined;
  const record = source as Record<string, unknown>;
  const text = line(record['text'], bounds.textLength);
  if (!text) return undefined;
  const note = line(record['note'], bounds.textLength);
  return { id: `t-${String(plan.next++)}`, text, stage: stageOf(record['stage']), ...(note ? { note } : {}) };
}

/** Replaces the list wholesale. The ids start again from where the conversation had reached rather
 *  than from one: a person looking at the panel should never see an id they already ticked reappear
 *  on a different line. */
export function write(plan: Plan, values: unknown, bounds: Limits): Plan {
  const list = Array.isArray(values) ? values : [];
  const items: Item[] = [];
  for (const value of list) {
    if (items.length >= bounds.items) break;
    const made = item(plan, value, bounds); if (made) items.push(made);
  }
  return { items, next: plan.next };
}

/** Adds to the end. Past the bound the extra items are dropped rather than the oldest forgotten: the
 *  top of a plan is the part already agreed, and losing it silently is worse than refusing a new line. */
export function add(plan: Plan, values: unknown, bounds: Limits): Plan {
  const list = Array.isArray(values) ? values : [];
  const items = [...plan.items];
  for (const value of list) {
    if (items.length >= bounds.items) break;
    const made = item(plan, value, bounds); if (made) items.push(made);
  }
  return { items, next: plan.next };
}

/** Moves the named items to a stage, leaving every other item where it is. Only one item is ever in
 *  hand, so marking one active puts back any other that was. */
export function mark(plan: Plan, ids: unknown, stage: Stage): Plan {
  const named = new Set((Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string'));
  const items = plan.items.map(existing => {
    if (named.has(existing.id)) return { ...existing, stage };
    return stage === 'active' && existing.stage === 'active' ? { ...existing, stage: 'pending' as Stage } : existing;
  });
  return { ...plan, items };
}

/** Reorders to the given ids. An id the plan does not hold is ignored and an item the order does not
 *  name keeps its place at the end, so a partial order is a partial move rather than a lost plan. */
export function order(plan: Plan, ids: unknown): Plan {
  const named = (Array.isArray(ids) ? ids : []).filter((id): id is string => typeof id === 'string');
  const remaining = new Map(plan.items.map(existing => [existing.id, existing]));
  const items: Item[] = [];
  for (const id of named) { const found = remaining.get(id); if (found) { items.push(found); remaining.delete(id); } }
  return { ...plan, items: [...items, ...remaining.values()] };
}

/** How far through the plan is, in the words the panel and the model both use. */
export function progress(plan: Plan): { done: number; total: number } {
  return { done: plan.items.filter(existing => existing.stage === 'done').length, total: plan.items.length };
}

/** The plan as the model reads it. A checkbox line per item, because that is the shape every model
 *  has already seen a plan written in, and the id in front so the next call can name a line. */
export function render(plan: Plan): string {
  if (!plan.items.length) return 'The plan is empty.';
  const { done, total } = progress(plan);
  const rows = plan.items.map(existing => {
    const box = existing.stage === 'done' ? '[x]' : existing.stage === 'active' ? '[~]' : '[ ]';
    return `${box} ${existing.id} ${existing.text}${existing.note ? ` — ${existing.note}` : ''}`;
  });
  return `The plan (${String(done)} of ${String(total)} done):\n${rows.join('\n')}`;
}
