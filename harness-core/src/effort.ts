// How hard the model thinks, chosen per conversation from a pill beside the model picker. Once
// `@thetis/effort`; part of the harness since 0.6.0, because it is a parameter of the call this package
// makes and not a feature of its own. The files it keeps did not move: a choice made before the merge is
// still the choice.
//
// One step and three commands. The step runs in the `call` phase and writes `call.params.reasoning`
// from the person's choice: `{ effort }` for a level, `{ enabled: false }` for off. `call.params` is
// what the OpenRouter provider spreads over the request body after its own `defaults`, so a choice made
// here wins over the deployment's `"reasoning": { "effort": "medium" }` and nothing has to know about
// the provider by name. A conversation with no choice, and no remembered choice, changes nothing: the
// provider's defaults, or the model's own, decide.
//
// The step does not check the choice against the model. The page hides what a model rejects, and a
// person who names a level the model does not take gets OpenRouter's own sentence back (`Reasoning is
// mandatory for this endpoint`), which is the truth and better than a silent drop. The one thing the
// step does know is that a model with no `reasoning` descriptor at all does not think: for one of those
// it sends nothing, so switching from a thinking model to a plain one never puts a `reasoning` field on
// a request that would refuse it.
//
// Two files under `effort/` in the person's home, written only by the commands: `sessions.json` maps a
// session id to the effort chosen for it, and `prefs.json` holds the choice made last, which is what a
// conversation without a choice of its own gets. A missing file is an empty value, never an error.
import type { KernelClient, PackageStepContext, StepEnv, StepResult, UiCommandEnv, UiCommandResult } from "@thetis/runtime/contracts";

const DIR = "effort";
export const effortSessionsPath = (): string => `${DIR}/sessions.json`;
export const effortPrefsPath = (): string => `${DIR}/prefs.json`;

/** Every effort the gateway knows, highest first. `none` turns thinking off. */
export const EFFORTS = Object.freeze(["max", "xhigh", "high", "medium", "low", "minimal", "none"] as const);
export type Effort = (typeof EFFORTS)[number];

export const isEffort = (value: unknown): value is Effort => typeof value === "string" && (EFFORTS as readonly string[]).includes(value);

type Files = Pick<StepEnv, "readFile" | "writeFile">;

async function readJson(env: Files, path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await env.readFile(path);
  } catch (e) {
    if ((e as { code?: string })?.code === "ENOENT") return {};
    throw e;
  }
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const writeJson = (env: Files, path: string, value: unknown): Promise<void> => env.writeFile(path, JSON.stringify(value, null, 2) + "\n");

/** The session map, with anything that is not a known effort dropped. */
export async function readEffortSessions(env: Files): Promise<Record<string, Effort>> {
  const raw = await readJson(env, effortSessionsPath());
  return Object.fromEntries(Object.entries(raw).filter((e): e is [string, Effort] => isEffort(e[1])));
}

/** The remembered choice, or null. */
export async function readRememberedEffort(env: Files): Promise<Effort | null> {
  const raw = await readJson(env, effortPrefsPath());
  return isEffort(raw.default) ? raw.default : null;
}

/**
 * What the step sends for a session: its own choice, else the remembered one, else nothing.
 * `source` says which, so a page can tell a choice made here from one inherited.
 */
export async function effortOf(env: Files, session: string | undefined): Promise<{ effort: Effort | null; source: "session" | "remembered" | null }> {
  const sessions = await readEffortSessions(env);
  const own = session ? sessions[session] : undefined;
  if (own) return { effort: own, source: "session" };
  const remembered = await readRememberedEffort(env);
  if (remembered) return { effort: remembered, source: "remembered" };
  return { effort: null, source: null };
}

/**
 * Records a choice. An empty `effort` means the default again: the session's entry goes, and with
 * `remember` so does the remembered choice, exactly as the model picker treats "Default".
 */
export async function setEffort(env: Files, session: string, effort: string | null, remember = true): Promise<Effort | null> {
  if (effort !== "" && effort !== null && !isEffort(effort)) throw new Error(`"${effort}" is not an effort; one of ${EFFORTS.join(", ")}, or empty for the default`);
  const chosen = effort || null;
  const sessions = await readEffortSessions(env);
  if (chosen) sessions[session] = chosen as Effort;
  else delete sessions[session];
  await writeJson(env, effortSessionsPath(), sessions);
  if (remember) await writeJson(env, effortPrefsPath(), chosen ? { default: chosen } : {});
  return chosen as Effort | null;
}

/** The `reasoning` object to send for one choice, or undefined for "say nothing". */
export function reasoningFor(effort: string | null | undefined): { effort: string } | { enabled: false } | undefined {
  if (!effort) return undefined;
  if (effort === "none") return { enabled: false };
  return { effort };
}

/**
 * The reasoning descriptor of `model` from the fence's model list, or null when the model is listed and
 * does not think. Undefined when the list fails or does not have the model: the choice goes through,
 * because a page that let the person pick knew the model at the time.
 */
async function reasoningOf(kernel: KernelClient, model: string): Promise<object | null | undefined> {
  let choices;
  try {
    choices = await kernel.models();
  } catch {
    return undefined;
  }
  const found = choices?.models?.find((m) => m.id === model);
  if (!found) return undefined;
  const reasoning = (found as { reasoning?: unknown }).reasoning;
  return reasoning && typeof reasoning === "object" ? reasoning : null;
}

/** call: `call.params.reasoning` from the person's choice. Nothing when there is no choice, or the model does not think. */
export async function applyEffort(ctx: PackageStepContext): Promise<StepResult | void> {
  const { effort } = await effortOf(ctx.env, ctx.session.id);
  const reasoning = reasoningFor(effort);
  if (!reasoning) return;
  const descriptor = await reasoningOf(ctx.env.kernel, ctx.call.model);
  if (descriptor === null) return;
  return { call: { ...ctx.call, params: { ...(ctx.call.params ?? {}), reasoning } } };
}

// ---- the commands ----

const namedSession = (args: Record<string, unknown>): string | undefined => (typeof args?.session === "string" && args.session ? args.session : undefined);

/** effort-state: the session's own choice, the remembered one, and what the step would send. */
export async function uiEffortState(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = namedSession(args) ?? env.session;
  const [sessions, remembered] = await Promise.all([readEffortSessions(env), readRememberedEffort(env)]);
  const own = session ? (sessions[session] ?? null) : null;
  const effective = own ?? remembered ?? null;
  return { data: { session: session ?? null, effort: own, remembered, effective, source: own ? "session" : remembered ? "remembered" : null, efforts: EFFORTS } };
}

/** effort-set: record a choice for the conversation. `effort: ""` means the default again; `remember: false` leaves the remembered choice alone. */
export async function uiEffortSet(args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const session = namedSession(args) ?? env.session;
  if (!session) throw new Error("no conversation is open");
  const effort = typeof args?.effort === "string" ? args.effort : "";
  const remember = args?.remember !== false;
  const chosen = await setEffort(env, session, effort, remember);
  return { data: { session, effort: chosen, remembered: remember ? chosen : await readRememberedEffort(env) } };
}

/** effort-models: the default model and, per model that thinks, its reasoning descriptor. Models that do not think are left out. */
export async function uiEffortModels(_args: Record<string, unknown>, env: UiCommandEnv): Promise<UiCommandResult> {
  const choices = await env.kernel.models();
  const reasoning: Record<string, unknown> = {};
  for (const m of choices.models ?? []) {
    const r = (m as { reasoning?: unknown }).reasoning;
    if (r && typeof r === "object") reasoning[m.id] = r;
  }
  return { data: { model: choices.model ?? "", reasoning } };
}
