// The two pipeline steps, thin on purpose: each finds the session's project through the assignments
// file and returns nothing when there is none, so a person without projects pays one small read per
// turn and no change to the call. `projectPrompt` runs in the `prompt` phase and appends the project's
// section to `call.system`: the name, each project directory with whether the fence has it mounted (from
// THETIS_MOUNTS, the same source the file tools use), and the standing instructions. `projectTools` runs
// in the `call` phase, after every `tools`-phase step whatever the install order, and drops the tools the
// project switched off from `call.tools`. Both read through `ctx.env.readFile` and tolerate missing files.
import { currentMounts, describeDirectory, isWithin, mountModeOf } from "./mounts.js";
import { projectOfSession, readInstructions } from "./store.js";

/**
 * The text appended for a project: heading, directories, instructions. Each directory says what the agent
 * can do with it now, and a directory the file tools cannot reach says so in the same line, because the
 * alternative is an agent that plans work in a directory it will find missing. The line is written from
 * THETIS_MOUNTS alone: reading the operator's mount list would cost a round trip on every turn, and the
 * project page is where a mount is repaired. Exported for the tests.
 */
export function projectSection(project, instructions, mounts, user, home = null) {
  const lines = [`## Project: ${project.name}`];
  if (project.directories.length) {
    lines.push("Project directories:");
    for (const d of project.directories) lines.push(`- ${describeDirectory(d, mounts, user, null, home)}`);
    if (project.directories.some((d) => !mountModeOf(d, mounts) && !isWithin(d, home))) {
      lines.push("", 'A directory marked NOT USABLE is outside this workspace: the file tools answer "no such file" there. Say so instead of working around it.');
    }
  } else {
    lines.push("This project has no project directories.");
  }
  const text = instructions.trim();
  if (text) lines.push("", "### Instructions", text);
  return lines.join("\n");
}

/** prompt: the project's section goes at the end of the system prompt. Nothing when the session has no project. */
export async function projectPrompt(ctx) {
  const project = await projectOfSession(ctx.env, ctx.session.id);
  if (!project) return;
  const instructions = await readInstructions(ctx.env, project.id);
  const section = projectSection(project, instructions, currentMounts(), ctx.session.user, ctx.env.cwd);
  return { call: { ...ctx.call, system: [ctx.call.system, section].filter(Boolean).join("\n\n") } };
}

/** call: remove the tools the project switched off. Nothing when there is no project or nothing is off. */
export async function projectTools(ctx) {
  const project = await projectOfSession(ctx.env, ctx.session.id);
  const disabled = new Set(project?.tools.disable ?? []);
  if (!disabled.size) return;
  return { call: { ...ctx.call, tools: (ctx.call.tools ?? []).filter((t) => !disabled.has(t.name)) } };
}
