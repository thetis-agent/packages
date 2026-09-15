import { normaliseAll } from "./lib/claims.js";
import { observe } from "./lib/observe.js";

export const KEY = "@thetis/bench";

/**
 * bench: fold every package's claim into one record the host can read back with sessions.inspect.
 * The kernel replaces `harness` rather than merging it, so everything already there is spread forward.
 */
export async function collect(ctx) {
  const prev = ctx.harness[KEY] && typeof ctx.harness[KEY] === "object" ? ctx.harness[KEY] : {};
  const turns = Array.isArray(prev.turns) ? prev.turns : [];
  return {
    harness: {
      ...ctx.harness,
      [KEY]: {
        ...prev,
        claims: normaliseAll(prev.claims),
        turns: [...turns, { turn: ctx.turn.id, ...observe(ctx) }],
      },
    },
  };
}
