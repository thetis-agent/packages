// ask_user: records questions for the (not-yet-built) form UI, and hands back fixed text
// so the model asks them inline in this turn — the only mechanism that exists right now.
import { loadQuestions, saveQuestions } from "./store.js";

const MAX_QUESTIONS = 4;
const MAX_QUESTION_CHARS = 500;
const MAX_OPTIONS = 12;
const MAX_OPTION_CHARS = 120;

function normalizeQuestion(q, i) {
  const question = String(q?.question ?? "").slice(0, MAX_QUESTION_CHARS);
  if (!question) throw new Error(`questions[${i}].question is required and must not be empty.`);
  const id = q?.id ? String(q.id) : `q-${i + 1}`;
  const options = Array.isArray(q?.options) ? q.options.slice(0, MAX_OPTIONS).map((o) => String(o).slice(0, MAX_OPTION_CHARS)) : undefined;
  const allowMultiple = Boolean(q?.allow_multiple);
  return { id, question, options, allow_multiple: allowMultiple };
}

export async function askUser(args, env) {
  const raw = Array.isArray(args.questions) ? args.questions : [];
  if (raw.length < 1 || raw.length > MAX_QUESTIONS) {
    throw new Error(`questions must have 1 to ${MAX_QUESTIONS} entries; got ${raw.length}.`);
  }
  const questions = raw.map(normalizeQuestion);
  const intro = args.intro ? String(args.intro) : undefined;

  const home = env.cwd;
  const sessionId = env.session?.id ?? "default";
  const data = await loadQuestions(home, sessionId);
  data.entries.push({ at: new Date().toISOString(), intro, questions });
  await saveQuestions(home, sessionId, data);

  return (
    "Questions recorded. Now end your reply by asking the user these questions word for word, " +
    "numbered, with their options, and stop. The answer arrives in the user's next message."
  );
}
