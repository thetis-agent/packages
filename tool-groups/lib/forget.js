// The forget hook: when a person forgets a conversation, the gateway asks every package that declares
// `thetis.sessions.forget` to remove what it kept about it. This package keeps one document per
// conversation, in its own storage under `sessions` keyed by the session id (see store.js): the groups the
// router pinned and the ones tool_search loaded. The pin in the session's harness goes with the session.
// The hook must run under this package's own env: storage is namespaced by package, so another package's
// env would look in the wrong place and find nothing.
import { NAMESPACE } from "./store.js";

const STORE_KEY = /^[a-z0-9@_][a-z0-9._@-]{0,127}$/i;

/** `thetis.sessions.forget({ phase, session, sessions, options }, env)`: nothing to preview; on forget, each id's document. Idempotent. */
export async function forgetSession(args, env) {
  if (args?.phase !== "forget") return {};
  if (typeof env?.storage !== "function") throw new Error("this environment has no storage, so the routing documents could not be reached");
  const store = env.storage(NAMESPACE);
  let gone = 0;
  for (const s of Array.isArray(args.sessions) ? args.sessions : []) {
    if (typeof s !== "string" || !STORE_KEY.test(s)) continue;
    if ((await store.get(s)) === undefined) continue;
    await store.delete(s);
    gone++;
  }
  return { removed: gone ? [`The tool groups chosen for ${gone} conversation${gone === 1 ? "" : "s"}.`] : [] };
}
