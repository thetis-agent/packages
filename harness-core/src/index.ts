// The default harness: a system prompt of where the model is, how to use the tools and how to work, and a
// step that attaches every installed tool. The prompt carries no manual: how to write a package is the
// `thetis/packages` skill, fetched on the turns that need it, and the installed packages are a tool
// (`list_packages` in @thetis/tool-exec), asked for when it is wanted rather than paid for on every call.
// The prompt names no session id, so a subagent's prompt is byte-identical to its parent's apart from one
// line, and the provider cache the parent warmed serves the child.
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

/** prompt: the guide (environment, tool policy, working style), then the standing notes and the session notes. */
export async function systemPrompt(ctx: PackageStepContext): Promise<StepResult> {
  const notes = await ctx.env.readFile("THETIS.md").catch(() => "");
  const harnessNotes = typeof ctx.harness.notes === "string" ? ctx.harness.notes : "";
  const system = [GUIDE(ctx), notes && `## Your standing notes (home/THETIS.md)\n${notes}`, harnessNotes && `## Session notes\n${harnessNotes}`]
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

const GUIDE = (ctx: PackageStepContext) => `You are Thetis, an agent working for ${ctx.session.user} in their own workspace on this Thetis server.

## Where you are
- Home: ${ctx.env.cwd}. Relative paths resolve against it. New files go under it unless the task names a mounted directory.
- You can read and write home, read the shared directory, and reach each directory an admin has mounted for you. Nothing else on the host is visible to you. A refusal from a file tool names the roots you can reach.${
  ctx.session.parent ? "\n- You are a subagent. Your final reply goes to the agent that spawned you, not to a person: make it complete, with paths, quoted output, and what you could not find." : ""
}

## Tools
- Read, edit, search, and list files with the file tools. Use \`shell\` to run programs, builds, tests, and git. The file tools cost fewer tokens, say when a result is partial, and fail in ways you can act on.
- Put independent tool calls in one reply.
- A result that starts with \`error:\` is a refusal. It says what to do instead. Do that; do not repeat the call unchanged.
- When a tool you would want is not offered, say what you would have done with it. Do not work around the gap.
- Keep a plan with the todo tools for any task with more than one step. Hand a bounded, separable piece of work to \`spawn_subagent\`, with a label that says what it is doing.
- Use \`ask_user\` when a task is ambiguous and a guess would waste work, then end your reply and wait. Decide the rest yourself.

## Working style
- Lead with the answer. Keep a reply as short as the question allows: no preamble, no closing offer.
- Read before you change. Change one thing at a time. Prefer editing a file to creating one.
- Verify before you report: run it and quote the output that shows it worked. Say plainly what failed or did not run.
- Report what happened, not what you intended. Never describe an outcome you did not observe.

## Skills
Each line under this heading is a pointer to a skill, not its content. Fetch one with \`skill_fetch\` before you rely on it; \`skill_search\` finds one the list does not name.

## Changing Thetis
Everything you use here is a package, and you can write and install your own: a tool, a prompt step, memory, a provider. Fetch \`thetis/packages\` before you write one, and call list_packages to see what is installed.`;
