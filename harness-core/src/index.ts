// The default harness: a bounded history window, a system prompt that teaches the model how
// to extend Thetis by writing packages, and a step that attaches every installed tool.
import type { Message, PackageStepContext, StepResult, ToolSpec } from "@thetis/kernel";

const DEFAULT_WINDOW = 80;
const DEFAULT_KEEP = 0.5;
const HARNESS_KEY = "@thetis/harness-core";

/**
 * history: a bounded window over the conversation whose start moves rarely.
 *
 * A prompt cache is a prefix match, so a window that slides by one message every turn re-writes
 * the whole conversation every turn. Instead the cut point is kept in the harness and only moves
 * when the window overflows `historyWindow`; it then jumps so that `historyWindow * historyKeep`
 * messages remain. The cut always lands on a user message so a tool call stays with its results.
 */
export async function trimHistory(ctx: PackageStepContext): Promise<StepResult> {
  const limit = Math.max(1, Number(ctx.config.historyWindow ?? DEFAULT_WINDOW));
  const keep = Math.max(1, Math.min(limit, Math.floor(limit * Number(ctx.config.historyKeep ?? DEFAULT_KEEP))));
  const conv = ctx.conversation;
  const state = (ctx.harness[HARNESS_KEY] ?? {}) as { cut?: number };
  const saved = typeof state.cut === "number" && state.cut >= 0 && state.cut <= conv.length ? state.cut : 0;
  let cut = saved;
  if (conv.length - cut > limit) cut = Math.max(cut, alignToUser(conv, conv.length - keep));
  const call = { ...ctx.call, messages: conv.slice(cut) };
  if (cut === saved) return { call };
  return { call, harness: { ...ctx.harness, [HARNESS_KEY]: { ...state, cut } } };
}

/** The next user message at or after `index`; the last user message before it when none follows. */
function alignToUser(conv: Message[], index: number): number {
  for (let i = index; i < conv.length; i++) if (conv[i].role === "user") return i;
  for (let i = Math.min(index, conv.length) - 1; i >= 0; i--) if (conv[i].role === "user") return i;
  return index;
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

function packagesSection(ctx: PackageStepContext): string {
  const lines = ctx.packages.list().map((p) => {
    const steps = (p.thetis.steps ?? []).map((s) => `${s.phase}:${s.export}`).join(", ");
    const tools = (p.thetis.tools ?? []).map((t) => t.name).join(", ");
    return `- ${p.name}@${p.version} (${p.type})${steps ? ` steps[${steps}]` : ""}${tools ? ` tools[${tools}]` : ""}`;
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

Test packages before installing: run \`node -e\` or a small script via exec. After install_package succeeds the step or tool is active from the next turn on; you can also call the new tool immediately in a later turn.

## Working style
Be direct and concrete. When asked to change your behavior, write the package, install it, verify with exec, and report what is now live. If a command fails, read the error and fix it. Keep packages small and single-purpose.`;
