import { contentText } from "@thetis/runtime/lib/content";
// A scripted reply. The script reacts to what the harness assembled, never to a marker in the query: the
// query text must stay exactly as the suite authored it, because a retriever matches on it.

/** Does this step's guard hold for the assembled call? A step with no `when` always fires. */
export function holds(when, call) {
  if (!when) return true;
  if (when.toolsInclude && !(call.tools ?? []).some((t) => t.name === when.toolsInclude)) return false;
  if (when.systemIncludes && !(call.system ?? "").includes(when.systemIncludes)) return false;
  if (when.systemExcludes && (call.system ?? "").includes(when.systemExcludes)) return false;
  return true;
}

/**
 * Pick the reply for this round. `else` is what to say when the guard fails, which is how one script covers
 * an arm that offers a search tool and an arm that does not without branching per arm.
 */
export function replyFor(script, task, round, call) {
  const steps = (script?.tasks?.[task] ?? script?.default ?? {}).turns ?? [];
  const step = steps[round];
  if (!step) return { text: "done" };
  const chosen = holds(step.when, call) ? step : (step.else ?? { text: "done" });
  return chosen.toolCall ? { ...chosen, toolCall: fill(chosen.toolCall, call) } : chosen;
}

/**
 * `argsFromRequest` puts the task's own words into a tool argument. This is how a ranking mechanism is
 * exercised without a model and without the bench knowing the answer: it is handed the question, not a hint.
 */
function fill(toolCall, call) {
  if (!toolCall.argsFromRequest) return toolCall;
  const request = contentText([...(call.messages ?? [])].reverse().find((m) => m.role === "user")?.content);
  return { ...toolCall, args: { ...(toolCall.args ?? {}), [toolCall.argsFromRequest]: request } };
}
