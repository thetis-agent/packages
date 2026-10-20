// What a run cost, summed from the events of every conversation in it -- the trial session and every
// subagent it spawned -- the way @thetis/workflows sums a step (engine.js): a `usage` event counts, and a
// `message` that carries usage counts only when no `usage` event came before it in that conversation, so
// a provider that reports both is not counted twice. `tokens` is prompt plus completion tokens over every call.

const isObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const round = (n) => Math.round(n * 1e6) / 1e6;

export function createAccount() {
  const usageSeen = new Map();
  let costUsd = 0;
  let tokens = 0;
  const count = (usage) => {
    if (!isObject(usage)) return false;
    const cost = Number(usage.cost);
    if (Number.isFinite(cost) && cost > 0) costUsd = round(costUsd + cost);
    const prompt = Number(usage.prompt_tokens ?? usage.input_tokens);
    const completion = Number(usage.completion_tokens ?? usage.output_tokens);
    if (Number.isFinite(prompt) && prompt > 0) tokens += prompt;
    if (Number.isFinite(completion) && completion > 0) tokens += completion;
    return true;
  };
  return {
    /** One event of conversation `session`. True when it counted something. */
    add(session, event) {
      if (!isObject(event)) return false;
      if (event.type === "usage") {
        usageSeen.set(session, true);
        return count(event.usage);
      }
      if (event.type === "message") {
        const counted = event.usage && !usageSeen.get(session) ? count(event.usage) : false;
        usageSeen.set(session, false);
        return counted;
      }
      return false;
    },
    get costUsd() {
      return costUsd;
    },
    get tokens() {
      return tokens;
    },
  };
}
