// ask_user: records questions for the page's ask form and ends the turn (`endsTurn` in the manifest: the
// harness stops the loop once this returns). The answers are the next user message. Where nobody can answer,
// a subagent or a conversation marked unattended by harness-core, it refuses so the model decides itself.
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadQuestions, saveQuestions } from "./store.js";

export const NOBODY_ANSWERS =
  "Nobody reads this conversation while it runs, so no one can answer. Decide, and say what you assumed in your reply.";
export const ASKED = "Shown to the person as a form. The turn ends here; their answers come as the next message.";

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

/** True when harness-core's marker `harness-core/unattended/<session>.json` exists in the home: nobody reads it. */
async function unattended(home, sessionId) {
  try {
    await readFile(resolve(home, "harness-core/unattended", `${sessionId}.json`));
    return true;
  } catch {
    return false;
  }
}

export async function askUser(args, env) {
  const home = env.cwd;
  const sessionId = env.session?.id ?? "default";
  if (env.session?.parent || (await unattended(home, sessionId))) throw new Error(NOBODY_ANSWERS);
  const raw = Array.isArray(args.questions) ? args.questions : [];
  if (raw.length < 1 || raw.length > MAX_QUESTIONS) {
    throw new Error(`questions must have 1 to ${MAX_QUESTIONS} entries; got ${raw.length}.`);
  }
  const questions = raw.map(normalizeQuestion);
  const intro = args.intro ? String(args.intro) : undefined;

  const data = await loadQuestions(home, sessionId);
  data.entries.push({ at: new Date().toISOString(), intro, questions });
  await saveQuestions(home, sessionId, data);

  return ASKED;
}
