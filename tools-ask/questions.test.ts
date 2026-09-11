/** The four shapes a question can take, and what happens to one nobody answers. */
import test from 'node:test';
import assert from 'node:assert/strict';
import { answerOf, ask, confirmation, expire, transcript, wording } from './questions.ts';

const made = (args: Record<string, unknown>, now = 1000, ms = 5000) => {
  const question = ask('q-1', 'c-1', args, now, ms);
  assert.ok(question);
  return question;
};

await test('a question with no answers offered is an open one', () => {
  const question = made({ question: 'What should it be called?' });
  assert.equal(question.shape, 'text');
  assert.deepEqual(question.options, []);
});

await test('answers offered make it a choice even when the shape was left out', () => {
  assert.equal(made({ question: 'Which one?', options: ['a', 'b'] }).shape, 'choice');
  assert.equal(made({ question: 'Which ones?', shape: 'multiple', options: ['a', 'b'] }).shape, 'multiple');
  // A shape that needs answers and was given none is an open question, not a list of nothing.
  assert.equal(made({ question: 'Which one?', shape: 'choice' }).shape, 'text');
});

await test('a confirmation supplies its own two answers', () => {
  const question = made({ question: 'Shall I go ahead?', shape: 'confirm', options: ['Absolutely', 'Absolutely'] });
  assert.deepEqual(question.options, confirmation);
});

await test('a question with nothing to ask is not a question', () => {
  assert.equal(ask('q-1', 'c-1', { question: '   ' }, 0, 1), undefined);
});

await test('what the person picked is joined in their own words, and one pick is one answer', () => {
  assert.equal(answerOf(made({ question: 'Which ones?', shape: 'multiple', options: ['a', 'b'] }), ['a', 'b']), 'a, b');
  assert.equal(answerOf(made({ question: 'Which one?', options: ['a'] }), 'a'), 'a');
  assert.equal(answerOf(made({ question: 'What?' }), '  spaced  out  '), 'spaced out');
});

await test('a question nobody answered stops being one, and says so in plain words', () => {
  const question = made({ question: 'Still there?' });
  assert.equal(expire(question, 5000).state, 'waiting');
  const gone = expire(question, 6000);
  assert.equal(gone.state, 'expired');
  assert.equal(wording[gone.state], 'No longer needed');
  assert.match(transcript(gone), /Nobody answered/u);
  // An answered question is never retired out from under its answer.
  assert.equal(expire({ ...question, state: 'answered' }, 60000).state, 'answered');
});

await test('the model is told the question again with the answer, because it cannot see the form', () => {
  const question = { ...made({ question: 'How long?' }), state: 'answered' as const, answer: 'Thirty days' };
  assert.equal(transcript(question), 'You asked: How long?\nThey answered: Thirty days');
});
