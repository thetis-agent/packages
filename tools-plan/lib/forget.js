// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. This package keeps two files per conversation
// under the home: the plan (`plans/<s>.json`) and the questions ask_user recorded (`questions/<s>.json`).
// Nothing here blocks a forget, and a file already gone is neither an error nor reported.
import { unlink } from "node:fs/promises";
import { planPath, questionsPath } from "./store.js";

async function removeFile(file) {
  try {
    await unlink(file);
    return true;
  } catch (e) {
    if (e?.code === "ENOENT") return false;
    throw e;
  }
}

const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

/** `thetis.sessions.forget({ phase, session, sessions, options }, env)`: nothing to preview; on forget, both files of every id. */
export async function forgetSession(args, env) {
  if (args?.phase !== "forget") return {};
  let plans = 0;
  let questions = 0;
  for (const s of Array.isArray(args.sessions) ? args.sessions : []) {
    if (typeof s !== "string" || !s) continue;
    if (await removeFile(planPath(env.cwd, s))) plans++;
    if (await removeFile(questionsPath(env.cwd, s))) questions++;
  }
  const removed = [];
  if (plans) removed.push(`The plan of ${count(plans, "conversation", "conversations")}.`);
  if (questions) removed.push(`The questions asked in ${count(questions, "conversation", "conversations")}.`);
  return { removed };
}
