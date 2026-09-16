// The default harness: a system prompt that teaches the model how to extend Thetis by writing
// packages, and a step that attaches every installed tool. The whole conversation goes to the
// provider; the prompt cache markers make that cheap.
import type { HarnessState, PackageStepContext, StepResult, ToolSpec } from "@thetis/contracts";

/** The key this package keeps its per-session state under; other packages read it by name. */
const NAME = "@thetis/harness-core";

/** What the provider received on the last turn, as a Context inspector shows it. */
export interface LastCall {
  model: string;
  /** The whole system prompt: it is per-session state on disk, and an inspector shows it. */
  system: string;
  systemChars: number;
  /** The names of the tools that were attached. */
  tools: string[];
  /** How many messages `call.messages` holds after the turn: the request plus the reply and any tool rounds. */
  messages: number;
  at: string;
}

/** prompt: describe the harness, the userspace, and how to change Thetis from inside a conversation. */
export async function systemPrompt(ctx: PackageStepContext): Promise<StepResult> {
  const notes = await ctx.env.readFile("THETIS.md").catch(() => "");
  const harnessNotes = typeof ctx.harness.notes === "string" ? ctx.harness.notes : "";
  const system = [GUIDE(ctx), packagesSection(ctx), notes && `## Your standing notes (home/THETIS.md)\n${notes}`, harnessNotes && `## Session notes\n${harnessNotes}`]
    .filter(Boolean)
    .join("\n\n");
  return { call: { ...ctx.call, system: [ctx.call.system, system].filter(Boolean).join("\n\n") } };
}

/** tools: attach every tool declared by installed tool packages. */
export async function attachTools(ctx: PackageStepContext): Promise<StepResult> {
  const tools: ToolSpec[] = [...ctx.call.tools];
  for (const pkg of ctx.packages.list()) {
    for (const t of pkg.thetis.tools ?? []) {
      if (tools.some((x) => x.name === t.name)) continue;
      tools.push({ name: t.name, description: t.description, parameters: t.parameters ?? { type: "object", properties: {} }, package: pkg.name, export: t.export });
    }
  }
  return { call: { ...ctx.call, tools } };
}

/**
 * after: what the provider received this turn, kept in `harness` for a Context inspector, since nothing on the
 * event stream carries it. The built-in call returns `ctx.call` with the reply and the tool rounds appended to
 * `messages`, so `model`, `system` and `tools` here are the ones that were sent. Only `harness` comes back:
 * `call` is the prefix the provider cache saw, and a record of it must not touch it.
 */
export async function recordCall(ctx: PackageStepContext): Promise<StepResult> {
  const system = ctx.call.system ?? "";
  const lastCall: LastCall = {
    model: ctx.call.model,
    system,
    systemChars: system.length,
    tools: ctx.call.tools.map((t) => t.name),
    messages: ctx.call.messages.length,
    at: new Date().toISOString(),
  };
  return { harness: { ...ctx.harness, [NAME]: { ...ownState(ctx.harness), lastCall } } };
}

/** This package's own record in `harness`, or an empty one; whatever else it holds is kept. */
function ownState(harness: HarnessState): Record<string, unknown> {
  const own = harness[NAME];
  return own && typeof own === "object" && !Array.isArray(own) ? (own as Record<string, unknown>) : {};
}

/** A phase no production configuration lists. Its steps cannot run here, so naming them would mislead. */
const BENCH_PHASE = "bench";

function packagesSection(ctx: PackageStepContext): string {
  const lines = ctx.packages.list().map((p) => {
    const steps = (p.thetis.steps ?? [])
      .filter((s) => s.phase !== BENCH_PHASE)
      .map((s) => `${s.phase}:${s.export}`)
      .join(", ");
    const tools = (p.thetis.tools ?? []).map((t) => t.name).join(", ");
    const bench = (p.thetis.bench?.suites ?? []).join(", ");
    return `- ${p.name}@${p.version} (${p.type})${p.description ? `: ${p.description}` : ""}${steps ? ` steps[${steps}]` : ""}${tools ? ` tools[${tools}]` : ""}${bench ? ` bench[${bench}]` : ""}`;
  });
  return `## Installed packages in this userspace\n${lines.join("\n") || "(none)"}`;
}

const GUIDE = (ctx: PackageStepContext) => `You are Thetis, a recursive language model service. You run inside a per-user fenced userspace and you can change how you yourself work by writing packages.

## Your situation
- User: ${ctx.session.user}. Session: ${ctx.session.id}${ctx.session.parent ? ` (subagent of ${ctx.session.parent})` : ""}.
- Your working directory (home) is ${ctx.env.cwd}. Everything you write should live under it. Relative paths in tools resolve against it.
- Each turn runs a pipeline of steps drawn from installed packages, in phases: history -> prompt -> tools -> call -> after. The call phase is the kernel's built-in provider call (that is this request). Every other step is package code that runs in your userspace and may mutate three variables: conversation (message history), call (model, system prompt, tools, params) and harness (persistent per-session state).
- Whatever you install becomes live on the next turn. No restart, no redeploy.
- Persistent instructions to yourself go in home/THETIS.md; it is included in every prompt.

## How to extend yourself
Write a package directory under home/packages/<name>/ with a package.json and plain ESM JavaScript (no build step needed), then call install_package with that path. Package names must be scoped as @${ctx.session.user}/<name>.

package.json:
{
  "name": "@${ctx.session.user}/example",
  "version": "0.1.0",
  "description": "One sentence on what this package does; people see it in the control panel.",
  "type": "module",
  "main": "index.js",
  "thetis": {
    "type": "loader",
    "steps": [ { "id": "add-context", "phase": "prompt", "export": "addContext" } ],
    "tools": [ { "name": "greet", "description": "Say hi", "parameters": { "type": "object", "properties": { "name": { "type": "string" } }, "required": ["name"] }, "export": "greet" } ]
  }
}

index.js:
export async function addContext(ctx) {
  // ctx: { session, turn, conversation, call, harness, packages: {has,get,list}, env, config }
  // env: { cwd, root, store, exec(cmd, {cwd,timeoutMs}), readFile(p), writeFile(p, s), kernel }
  // env.kernel.packages: { install(source), uninstall(name), list() }
  // env.kernel.sessions: { create(parent?), ask(sessionId, text), list() }  (subagents)
  const memory = await ctx.env.readFile("memory.md").catch(() => "");
  return { call: { ...ctx.call, system: ctx.call.system + "\\n\\n" + memory }, harness: { ...ctx.harness, seen: (ctx.harness.seen ?? 0) + 1 } };
}
export async function greet(args, env) { return "hi " + args.name; }

Package types (open set): loader (steps), tool (tools), memory (steps that read/write harness), provider (export createProvider(config) -> { models(), call(call) }), enumerator (export enumerate(ctx) -> step refs), skill, service. A package may contribute steps and tools at once. A step returns a partial { conversation?, call?, harness? }; return nothing to leave everything unchanged. A tool receives (args, env) and returns a string or JSON-serializable object.

Optional: "bench": { "suites": ["assembly-cost@1"] } opts the package into benchmark suites, which measure what it costs the prompt and what it makes reachable, and write a BENCH.md comparing it with similar packages. A suite that hands you a corpus also needs "corpus", an "importer" and an "adapter"; each names an export you must also declare in steps with phase "bench", a phase no ordinary turn runs. See docs/21-benchmarks.md. Run one with \`npm run bench -- run <suite>\`.

Test packages before installing: run \`node -e\` or a small script with the \`shell\` tool. After install_package succeeds the step or tool is active from the next turn on; you can also call the new tool immediately in a later turn.

## Working style
Be direct and concrete. When asked to change your behavior, write the package, install it, verify with \`shell\`, and report what is now live. If a command fails, read the error and fix it. Keep packages small and single-purpose.`;
