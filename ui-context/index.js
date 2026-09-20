// The command export of @thetis/ui-context. The dock asks `context` for the open conversation and gets
// the session's turn count with the record `@thetis/harness-core` keeps under its own key in `harness`
// after every call (packages/kernel/src/pipeline/runner.ts). Nothing is computed here: the page draws what the
// harness wrote, and an empty state when it has written nothing yet.

/** The key `@thetis/harness-core` keeps its per-session state under. */
const HARNESS = "@thetis/harness-core";

/** `context`: `{ data: { turns, lastCall } }` for `env.session`; `lastCall` is null until a call has been made. */
export async function uiContext(_args, env) {
  if (!env.session) throw new Error("no conversation is open");
  const record = await env.kernel.sessions.inspect(env.session);
  return { data: { turns: record.turns, lastCall: lastCallOf(record.harness) } };
}

function lastCallOf(harness) {
  const own = isRecord(harness) ? harness[HARNESS] : null;
  const lastCall = isRecord(own) ? own.lastCall : null;
  return isRecord(lastCall) ? lastCall : null;
}

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
