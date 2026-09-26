// @thetis/effort: how hard the model thinks, chosen per conversation from a pill beside the model picker.
//
// One step and three commands. The step runs in the `call` phase and writes `call.params.reasoning`
// from the person's choice: `{ effort }` for a level, `{ enabled: false }` for off. `call.params` is
// what the OpenRouter provider spreads over the request body after its own `defaults`, so a choice made
// here wins over the deployment's `"reasoning": { "effort": "medium" }` and nothing has to know about
// the provider by name. A conversation with no choice, and no remembered choice, changes nothing: the
// provider's defaults, or the model's own, decide as they did before this package existed.
//
// The step does not check the choice against the model. The page hides what a model rejects, and a
// person who names a level the model does not take gets OpenRouter's own sentence back (`Reasoning is
// mandatory for this endpoint`), which is the truth and better than a silent drop. The one thing the
// step does know is that a model with no `reasoning` descriptor at all does not think: for one of those
// it sends nothing, so switching from a thinking model to a plain one never puts a `reasoning` field on
// a request that would refuse it.
//
// A UI command runs in the person's own fence with `readFile` and `writeFile` over the home; that is all
// these three need. `effort-state` answers what the pill draws, `effort-set` records a choice, and
// `effort-models` answers the reasoning descriptors of the models the fence can call, so the page can
// filter the list to what the chosen model accepts without a second provider round trip per open.
import { EFFORTS, effortOf, readRemembered, readSessions, setEffort } from "./lib/store.js";

export { EFFORTS } from "./lib/store.js";

/** The `reasoning` object to send for one choice, or undefined for "say nothing". */
export function reasoningFor(effort) {
  if (!effort) return undefined;
  if (effort === "none") return { enabled: false };
  return { effort };
}

/**
 * The reasoning descriptor of `model` from the fence's model list, or null when the list does not have
 * the model or the model does not think. A failing list is treated as "unknown": the choice goes through,
 * because a page that let the person pick knew the model at the time.
 */
async function reasoningOf(kernel, model) {
  let choices;
  try {
    choices = await kernel.models();
  } catch {
    return undefined;
  }
  const found = choices?.models?.find((m) => m.id === model);
  if (!found) return undefined;
  return found.reasoning && typeof found.reasoning === "object" ? found.reasoning : null;
}

/** call: `call.params.reasoning` from the person's choice. Nothing when there is no choice, or the model does not think. */
export async function applyEffort(ctx) {
  const { effort } = await effortOf(ctx.env, ctx.session.id);
  const reasoning = reasoningFor(effort);
  if (!reasoning) return;
  const descriptor = await reasoningOf(ctx.env.kernel, ctx.call.model);
  if (descriptor === null) return;
  return { call: { ...ctx.call, params: { ...(ctx.call.params ?? {}), reasoning } } };
}

// ---- the commands ----

function sessionOf(args, env) {
  const named = typeof args?.session === "string" && args.session ? args.session : undefined;
  const session = named ?? env.session;
  if (!session) throw new Error("no conversation is open");
  return session;
}

/** effort-state: the session's own choice, the remembered one, and what the step would send. */
export async function uiState(args, env) {
  const session = typeof args?.session === "string" && args.session ? args.session : env.session;
  const [sessions, remembered] = await Promise.all([readSessions(env), readRemembered(env)]);
  const own = session ? sessions[session] ?? null : null;
  const effective = own ?? remembered ?? null;
  return { data: { session: session ?? null, effort: own, remembered, effective, source: own ? "session" : remembered ? "remembered" : null, efforts: EFFORTS } };
}

/** effort-set: record a choice for the conversation. `effort: ""` means the default again; `remember: false` leaves the remembered choice alone. */
export async function uiSet(args, env) {
  const session = sessionOf(args, env);
  const effort = typeof args?.effort === "string" ? args.effort : "";
  const remember = args?.remember !== false;
  const chosen = await setEffort(env, session, effort, remember);
  return { data: { session, effort: chosen, remembered: remember ? chosen : await readRemembered(env) } };
}

/** effort-models: the default model and, per model that thinks, its reasoning descriptor. Models that do not think are left out. */
export async function uiModels(args, env) {
  const choices = await env.kernel.models();
  const reasoning = {};
  for (const m of choices.models ?? []) if (m.reasoning && typeof m.reasoning === "object") reasoning[m.id] = m.reasoning;
  return { data: { model: choices.model ?? "", reasoning } };
}
