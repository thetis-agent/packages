export function createProvider(config) {
  return {
    async models() {
      return [{ id: config.id ?? "stub" }];
    },
    async *call(call) {
      seen.push(call.model);
      yield { type: "usage", usage: { prompt_tokens: 100, completion_tokens: 10, cost: config.cost ?? 0.25 } };
      yield { type: "text", delta: `stub saw ${call.model}` };
    },
  };
}
export const seen = [];
