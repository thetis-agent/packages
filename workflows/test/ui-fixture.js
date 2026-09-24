/* A definition shaped like the README's example, shared by the ui-*.test.js files. */
export function sample() {
  return {
    id: "wf_1a2b3c4d",
    name: "Bug fix",
    version: 3,
    input: { kind: "lines", label: "Links" },
    start: "lookup",
    steps: {
      lookup: { type: "tool", package: "@x/notion", export: "tools", name: "page_get", args: { page: "{{input}}" }, next: "plan" },
      plan: { type: "prompt", model: "fable", conversation: "new", prompt: "Plan {{lookup.text}}", budget: { toolCalls: 60, tokens: 250000, minutes: 45 }, next: "impl" },
      impl: { type: "prompt", model: "opus", conversation: "plan", prompt: "Do it", next: "parse", onBreach: "needs" },
      parse: { type: "parse", from: ["impl", "plan"], fields: { status: "RESULT: (\\w+)", commit: "commit=(\\S+)" }, next: "branch" },
      branch: { type: "branch", on: "{{parse.status}}", cases: { FIXED: "verify", BLOCKED: "needs" }, default: "needs" },
      verify: { type: "prompt", model: "sonnet", conversation: "new", prompt: "Verify {{parse.commit}}", next: "loop" },
      loop: { type: "loop", target: "impl", max: 1, exhausted: "needs" },
      needs: { type: "needs", reason: "Stuck" },
      done: { type: "done", summary: "ok" },
    },
    layout: {},
  };
}
