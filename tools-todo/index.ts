/** The plan the agent keeps visible while it works, and the panel a person ticks it off in; ADR 0051.
 *
 * Four tools, because a plan has four verbs: put one up, add to it, move a line's state, and change
 * the order. Everything else a model wants to do to a list is one of those four applied again.
 *
 * The half that makes this worth contributing rather than printing is the panel. A plan the agent
 * wrote is a claim about what it is going to do, and the person reading it is the one who knows
 * whether a line is already done — so the panel's tick is a declared command (`tick`), answered here
 * by the same `call` hook the tools use, and the next iteration's `context` append puts the changed
 * plan back in front of the model. That append is deliberately every iteration: the plan is small,
 * and a model that is shown a stale plan will confidently redo work the person has already crossed
 * off.
 *
 * `plan` and `tick` are answered by `call` and offered by nothing, so the model is never told they
 * exist: `Dispatcher.call` refuses a name that was not offered, and the only route to them is a
 * person clicking in the panel this package contributed.
 */
import type { CallAnswer, CallRequest, Envelope, Message, OfferRequest, ToolDef } from '@/contracts/turn-events/types.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Limits, Plan, Stage } from './plan.ts';
import { add, empty, limits, mark, order, progress, render, write } from './plan.ts';

const source = 'tools-todo@1.0.0';
/** Conversations remembered at once, oldest forgotten first; the plan itself is bounded in plan.ts. */
export const defaults = { conversations: 64 };
export const settings: Limits & { conversations: number } = { ...limits, conversations: defaults.conversations };

const plans = new Map<string, Plan>();
/** The conversation whose turn is in flight. `contract/turn-events` gives a call request no
 *  conversation of its own, so the stage takes it from the log it already observes, exactly as
 *  skills-l1 does: every envelope of an iteration precedes that iteration's calls. A panel command
 *  cannot use it — the panel may be read between turns — so the panel names its conversation instead. */
let current = '';

const text = { type: 'string', maxLength: 2000 } as const;
const ids = { type: 'array', items: { type: 'string' }, maxItems: 256 } as const;
const lines = { type: 'array', maxItems: 256, items: { oneOf: [text, { type: 'object', properties: { text, stage: { enum: ['pending', 'active', 'done'] }, note: text }, required: ['text'] }] } } as const;

function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): ToolDef {
  return { name, description, readOnly: false, endsTurn: false, source, schema: { type: 'object', properties, required } };
}
export const definitions: ToolDef[] = [
  tool('todo_write', 'Put up the plan for this conversation, replacing whatever was there.', { items: lines }, ['items']),
  tool('todo_add', 'Add items to the end of the plan.', { items: lines }, ['items']),
  tool('todo_mark', 'Mark plan items as not started, in hand, or done.', { items: ids, stage: { enum: ['pending', 'active', 'done'] } }, ['items', 'stage']),
  tool('todo_order', 'Reorder the plan, naming its items in the order they should read.', { items: ids }, ['items'])
];

function plan(conversation: string): Plan {
  const found = plans.get(conversation);
  if (found) return found;
  // Oldest first, because a Map iterates in insertion order: the conversation nobody has touched for
  // longest is the one whose plan is least likely to be read again.
  if (plans.size >= settings.conversations) { const oldest = plans.keys().next().value; if (oldest !== undefined) plans.delete(oldest); }
  const made = empty(); plans.set(conversation, made); return made;
}

function keep(conversation: string, next: Plan): Plan {
  plans.delete(conversation); plans.set(conversation, next); return next;
}

function answer(id: string, body: string): CallAnswer { return { id, ok: true, content: [{ type: 'text', text: body }] }; }
function refuse(id: string, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
  return { id, ok: false, error: { code, message } };
}

/** A plan change the model asked for. The answer is the whole plan rather than "done": the model's
 *  next call names ids, and the ids it can name are the ones it has just been shown. */
function change(request: CallRequest, args: Record<string, unknown>): CallAnswer {
  const before = plan(current);
  const stage = args['stage'];
  const after = request.name === 'todo_write' ? write(before, args['items'], settings)
    : request.name === 'todo_add' ? add(before, args['items'], settings)
    : request.name === 'todo_mark' ? mark(before, args['items'], stage === 'active' || stage === 'done' ? stage : 'pending')
    : order(before, args['items']);
  return answer(request.id, render(keep(current, after)));
}

/** What the panel reads. JSON in a text part rather than `data`, because `CallAnswer.data` admits only
 *  flat scalars (contract/turn-events) and a plan is a list of rows. */
function report(id: string, conversation: string): CallAnswer {
  const held = plans.get(conversation) ?? empty();
  return answer(id, JSON.stringify({ items: held.items, ...progress(held) }));
}

/** The conversation a panel command is about. The gateway has already checked that the connection has
 *  this conversation open (gateway-web/surface-request.ts) and the environment that the stream is
 *  reading it (packages/core/surface-command.ts), but neither forwards which one it was, so the panel
 *  says. A panel that named a different one would reach another of this same person's conversations
 *  and nothing else: the stage is this person's, and so is everything in it. */
function named(args: Record<string, unknown>): string {
  return typeof args['conversation'] === 'string' ? args['conversation'] : current;
}

export const stages = {
  source,
  section: 'harness' as const,
  init(_profile: unknown, context: { settings?: Record<string, unknown> }): Promise<void> {
    for (const key of ['items', 'textLength', 'conversations'] as const) {
      const value = context.settings?.[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) settings[key] = value;
    }
    return Promise.resolve();
  },
  observe(event: Envelope): void { current = event.conversation; },
  offer(request: OfferRequest): Promise<ToolDef[]> {
    return Promise.resolve(request.mode.readOnly ? [] : definitions.map(item => structuredClone(item)));
  },
  /** The plan in front of the model on every iteration, so a line the person ticked in the panel is
   *  read before the next call rather than after it. Nothing is appended when the plan is empty: a
   *  conversation that never asked for one should not carry a sentence about not having one. */
  context(append: (message: Message) => void): void {
    const held = plans.get(current);
    if (!held?.items.length) return;
    append({ role: 'system', source, content: [{ type: 'text', text: `${render(held)}\nItems marked with an x were finished; some may have been ticked off by the person rather than by you.` }] });
  },
  call(request: CallRequest): Promise<CallAnswer> {
    const args = isObject(request.args) ? request.args : {};
    if (request.name === 'plan') return Promise.resolve(report(request.id, named(args)));
    if (request.name === 'tick') {
      const conversation = named(args);
      const id = args['id'];
      if (typeof id !== 'string') return Promise.resolve(refuse(request.id, 'invalid-args', 'That item could not be found.'));
      const held = plans.get(conversation);
      if (!held?.items.some(existing => existing.id === id)) return Promise.resolve(refuse(request.id, 'not-found', 'That item is no longer on the plan.'));
      const stage: Stage = args['done'] === false ? 'pending' : 'done';
      keep(conversation, mark(held, [id], stage));
      return Promise.resolve(report(request.id, conversation));
    }
    if (!definitions.some(item => item.name === request.name)) return Promise.resolve(refuse(request.id, 'gone', `${request.name} no longer exists.`));
    return Promise.resolve(change(request, args));
  }
};
