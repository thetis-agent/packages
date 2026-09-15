// The two verbs the package's own page sends (see ui/index.js): `plan` reads the conversation's plan and
// `mark` sets one item's stage. Both answer the plan as data, because the answer is what the page draws
// next: a row stays disabled until it lands. Thin over lib/plan.js and lib/store.js, the same code the
// todo_* tools run, so the page and the model never see two different plans. `env.session` is the
// conversation on screen, already checked by the gateway as the person's own; the gateway also passes
// no session when no conversation is open, and then there is nothing to read.
import { loadPlan, savePlan } from "./store.js";
import { markStage, planData } from "./plan.js";

function where(env) {
  if (typeof env?.session !== "string" || !env.session) throw new Error("no conversation is open");
  return { home: env.cwd, sessionId: env.session };
}

/** `plan`: the items and the done/total tally of the conversation on screen. */
export async function uiPlan(_args, env) {
  const { home, sessionId } = where(env);
  return { data: planData(await loadPlan(home, sessionId)) };
}

/** `mark`: `{ id, stage }`, validated like todo_mark. Answers the whole plan; `text` carries the single-active note when one applies. */
export async function uiMark(args, env) {
  const { home, sessionId } = where(env);
  const id = String(args?.id ?? "");
  if (!id) throw new Error("id is required");
  const plan = await loadPlan(home, sessionId);
  const notes = markStage(plan, [id], String(args?.stage ?? ""));
  await savePlan(home, sessionId, plan);
  return notes.length ? { text: notes.join("\n"), data: planData(plan) } : { data: planData(plan) };
}
