/** A question the agent asked, as a value: what was asked, what is allowed as an answer, and what the
 *  person said. Kept apart from the stage so the shapes and the bounds can be read and tested without
 *  a request, a sink or a socket.
 *
 * Four shapes, which are the four the legacy transcript form supported: a question with no answers
 * offered, a question with one answer to pick, a question with any number to pick, and a yes/no. They
 * are one field rather than four tools because they are one act — the agent wants to know something —
 * and a model that has to choose between four tools to ask a question will pick the wrong one.
 */

export interface Limits { questions: number; answerMs: number }
export const limits: Limits = { questions: 32, answerMs: 900000 };
/** Bounds on one question, which are the package's and never a setting: a longer prompt or a longer
 *  list of answers is not a deployment's choice, it is a question nobody can read. */
export const bounds = { questionLength: 500, optionLength: 120, options: 12, answerLength: 4000 };

export type Shape = 'text' | 'choice' | 'multiple' | 'confirm';
export type State = 'waiting' | 'answered' | 'expired';

export interface Question {
  handle: string;
  conversation: string;
  question: string;
  shape: Shape;
  options: string[];
  asked: number;
  expires: number;
  state: State;
  answer: string;
}

function line(value: unknown, bound: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, bound) : '';
}

function shapeOf(value: unknown, options: string[]): Shape {
  if (value === 'confirm') return 'confirm';
  if (value === 'multiple') return options.length ? 'multiple' : 'text';
  if (value === 'choice') return options.length ? 'choice' : 'text';
  // A model that offered answers and forgot to say what kind of question it was meant one of them.
  return options.length ? 'choice' : 'text';
}

/** Yes and no are supplied rather than asked for: a confirmation whose two answers the model wrote
 *  is a confirmation that can be phrased so only one of them is sayable. */
export const confirmation = ['Yes', 'No'];

export function ask(handle: string, conversation: string, args: Record<string, unknown>, now: number, answerMs: number): Question | undefined {
  const question = line(args['question'], bounds.questionLength);
  if (!question) return undefined;
  const offered = (Array.isArray(args['options']) ? args['options'] : []).map(value => line(value, bounds.optionLength)).filter(Boolean).slice(0, bounds.options);
  const shape = shapeOf(args['shape'], offered);
  return { handle, conversation, question, shape, options: shape === 'confirm' ? [...confirmation] : shape === 'text' ? [] : offered,
    asked: now, expires: now + answerMs, state: 'waiting', answer: '' };
}

/** A question nobody answered stops being a question. Applied when the list is read rather than on a
 *  timer: nothing is waiting on it — the call that asked was answered the moment it was asked — so a
 *  timer would only exist to change a word on a screen nobody is necessarily looking at. */
export function expire(question: Question, now: number): Question {
  return question.state === 'waiting' && now >= question.expires ? { ...question, state: 'expired' } : question;
}

/** What the person said, in the words they chose, joined for a question that took more than one. */
export function answerOf(question: Question, value: unknown): string {
  if (question.shape === 'multiple') {
    const picked = (Array.isArray(value) ? value : []).map(item => line(item, bounds.optionLength)).filter(Boolean);
    return picked.slice(0, bounds.options).join(', ');
  }
  return line(value, bounds.answerLength);
}

/** The exchange as the model reads it. The question is restated with the answer because the model has
 *  no access to the form: an answer that does not name its question is one it has to guess at. */
export function transcript(question: Question): string {
  if (question.state === 'expired') return `You asked: ${question.question}\nNobody answered, and the question is no longer on screen.`;
  if (question.state === 'answered') return `You asked: ${question.question}\nThey answered: ${question.answer || 'nothing'}`;
  return `You asked: ${question.question}\nThey have not answered yet.`;
}

/** The words a person reads, in every place this package says what a question is doing. */
export const wording: Record<State, string> = {
  waiting: 'Waiting for your answer',
  answered: 'Answered',
  expired: 'No longer needed'
};
