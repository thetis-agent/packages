/** `ask_user`: the agent asks a question and stops until a person answers it; contract/turn-events §call.
 *
 * The mechanism is the contract's own. A tool that cannot finish inside its deadline answers `ok: true`
 * with `pending: { handle }`, and a later `notice` carrying that handle completes it. A question is the
 * clearest case there is of a call that cannot finish inside a deadline — the deadline is thirty
 * seconds and the person may be making coffee — so the call answers immediately with a handle and
 * `endsTurn`, which is what a person reads as the agent waiting: the turn stops on the question rather
 * than running on to guess the answer.
 *
 * The answer comes back the way ADR 0051 lets any contributed surface act: the form drawn in the
 * transcript sends the declared verb `reply`, the gateway checks it against this package's own
 * manifest, and the environment turns it into the `call` below. This package then emits the notice
 * that completes the call, naming the handle and the conversation, and the core writes it into that
 * conversation's history at the next turn boundary. That last segment did not exist when this package
 * was written — a notice reached the monitor and stopped there — and it is why `packages/core` gained
 * `notices.ts` in the same change.
 *
 * What still does not happen is a turn starting by itself. `Notice.wake` is set here, honestly, and
 * the core does not act on it: there is no `conversation.wake` setting for it to consult, and starting
 * a turn with no person input is a change to the shape of the loop rather than a change to this
 * package. So the agent picks the answer up the next time the person says anything, and everything a
 * person reads here says exactly that rather than implying the turn resumes on its own.
 */
import type { CallAnswer, CallRequest, Content, Envelope, ToolDef } from '@/contracts/turn-events/types.ts';
import { isObject } from '@/lib/schema/index.ts';
import type { Limits, Question } from './questions.ts';
import { answerOf, ask, bounds, expire, limits, transcript } from './questions.ts';

const source = 'tools-ask@1.0.0';
/** Questions one worker remembers at once, answered ones included: the panel lists what was asked
 *  here, so a settled question is still worth keeping long after the turn that asked it. */
export const defaults = { remembered: 256 };
export const settings: Limits & { remembered: number } = { ...limits, remembered: defaults.remembered };

/** Every question this worker has seen, newest last, keyed by handle. One pool rather than a map per
 *  conversation: the bound that matters is how much a long-lived worker keeps, and the conversation
 *  is a field. */
const asked = new Map<string, Question>();
let current = '';
let announce: (notice: { tool?: string; handle?: string; conversation?: string; content: Content[]; wake?: boolean }) => void = () => {};

const text = { type: 'string', maxLength: bounds.questionLength } as const;
export const definitions: ToolDef[] = [{
  name: 'ask_user',
  description: 'Ask the person a question and stop until they answer. Use it when the answer changes what you would do next, not to narrate.',
  readOnly: true,
  endsTurn: true,
  source,
  schema: {
    type: 'object',
    properties: {
      question: text,
      shape: { enum: ['text', 'choice', 'multiple', 'confirm'], description: 'text for an open question, choice to pick one of the options, multiple to pick any of them, confirm for yes or no.' },
      options: { type: 'array', maxItems: bounds.options, items: { type: 'string', maxLength: bounds.optionLength } }
    },
    required: ['question']
  }
}];

function now(): number { return Date.now(); }

/** Questions for one conversation, oldest first, with any that have run out of time retired first. */
function inConversation(conversation: string): Question[] {
  const at = now(); const held: Question[] = [];
  for (const [handle, question] of asked) {
    const fresh = expire(question, at);
    if (fresh !== question) asked.set(handle, fresh);
    if (fresh.conversation === conversation) held.push(fresh);
  }
  return held;
}

/** Keeps the pool inside its bound, oldest forgotten first — but never a question still waiting, which
 *  is the one row whose disappearance a person would notice. */
function room(): void {
  while (asked.size >= settings.remembered) {
    const stale = [...asked.entries()].find(([, question]) => question.state !== 'waiting');
    if (!stale) return;
    asked.delete(stale[0]);
  }
}

function answer(id: string, body: string): CallAnswer { return { id, ok: true, content: [{ type: 'text', text: body }] }; }
function refuse(id: string, code: NonNullable<CallAnswer['error']>['code'], message: string): CallAnswer {
  return { id, ok: false, error: { code, message } };
}

/** What a panel reads: every question in one conversation, as JSON in a text part. `CallAnswer.data`
 *  admits only flat scalars (contract/turn-events), and a question has a list of options in it. */
function report(id: string, conversation: string): CallAnswer {
  return answer(id, JSON.stringify({ questions: inConversation(conversation).map(question => ({
    handle: question.handle, question: question.question, shape: question.shape, options: question.options,
    state: question.state, answer: question.answer
  })) }));
}

function named(args: Record<string, unknown>): string {
  return typeof args['conversation'] === 'string' ? args['conversation'] : current;
}

/** The person answered. The question is settled here and announced twice: as the notice the contract
 *  asks a pending call to be completed by, and — see this file's own header — as an append. */
function reply(request: CallRequest, args: Record<string, unknown>): CallAnswer {
  const handle = args['handle'];
  if (typeof handle !== 'string') return refuse(request.id, 'invalid-args', 'That question could not be found.');
  const held = asked.get(handle);
  if (!held) return refuse(request.id, 'gone', 'That question is no longer needed.');
  const question = expire(held, now());
  if (question.state === 'expired') { asked.set(handle, question); return refuse(request.id, 'gone', 'That question is no longer needed.'); }
  if (question.state === 'answered') return refuse(request.id, 'not-unique', 'That question has already been answered.');
  const said = answerOf(question, args['answer']);
  const settled: Question = { ...question, state: 'answered', answer: said };
  asked.set(handle, settled);
  // The notice the contract completes a `pending` call with. It names the handle the call returned,
  // the conversation it belongs to — nothing else knows which one — and asks to wake, which the core
  // will honour when a person's setting says it may.
  announce({ tool: 'ask_user', handle, conversation: settled.conversation, content: [{ type: 'text', text: transcript(settled) }], wake: true });
  return report(request.id, settled.conversation);
}

export const stages = {
  source,
  init(_profile: unknown, context: { settings?: Record<string, unknown>; emit?: typeof announce }): Promise<void> {
    for (const key of ['answerMs', 'questions', 'remembered'] as const) {
      const value = context.settings?.[key];
      if (typeof value === 'number' && Number.isSafeInteger(value) && value > 0) settings[key] = value;
    }
    // Captured once, because `emit` is handed over at initialization and never again; a notice sent
    // later is sent through this.
    if (context.emit) announce = context.emit;
    return Promise.resolve();
  },
  /** The conversation whose turn is in flight. A call request carries no conversation of its own
   *  (contract/turn-events), so the stage takes it from the log it already observes, as skills-l1
   *  does: every envelope of an iteration precedes that iteration's calls. */
  observe(event: Envelope): void { current = event.conversation; },
  offer(): Promise<ToolDef[]> {
    // Offered in every mode, read-only included: asking a person a question changes nothing.
    return Promise.resolve(definitions.map(item => structuredClone(item)));
  },
  call(request: CallRequest): Promise<CallAnswer> {
    const args = isObject(request.args) ? request.args : {};
    if (request.name === 'asked') return Promise.resolve(report(request.id, named(args)));
    if (request.name === 'reply') return Promise.resolve(reply(request, args));
    if (request.name !== 'ask_user') return Promise.resolve(refuse(request.id, 'gone', `${request.name} no longer exists.`));
    const waiting = inConversation(current).filter(question => question.state === 'waiting');
    if (waiting.length >= settings.questions) return Promise.resolve(refuse(request.id, 'budget', 'There are already more unanswered questions here than this conversation can hold.'));
    room();
    // The handle is the call's own id. A handle only has to name the call it completes, and the call
    // id already does — which also means the browser learns it from the `tool-call` frame it is
    // already drawing, instead of this package having to publish a second name for the same thing.
    const handle = request.id;
    const question = ask(handle, current, args, now(), settings.answerMs);
    if (!question) return Promise.resolve(refuse(request.id, 'invalid-args', 'A question needs something to ask.'));
    asked.set(handle, question);
    // `pending` is the contract's word for "this call is not finished", and `endsTurn` is what makes
    // the wait visible: the turn stops on the question instead of running on without its answer.
    return Promise.resolve({ id: request.id, ok: true, content: [{ type: 'text', text: `Waiting for an answer to: ${question.question}` }], pending: { handle }, endsTurn: true });
  }
};
