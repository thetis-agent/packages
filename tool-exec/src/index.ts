// "Run code in my userspace": the tool package that lets the model write, build, test and
// install packages. Everything here executes inside the fence via the agent's env.
import type { Tool } from "@thetis/contracts";

export const exec: Tool = async (args, env) => {
  const r = await env.exec(String(args.cmd), { cwd: args.cwd ? String(args.cwd) : undefined, timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined });
  const parts = [`exit ${r.code}`];
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n");
};

export const readFile: Tool = async (args, env) => env.readFile(String(args.path));

export const writeFile: Tool = async (args, env) => {
  await env.writeFile(String(args.path), String(args.content ?? ""));
  return `wrote ${args.path}`;
};

export const installPackage: Tool = async (args, env) => {
  const info = await env.kernel.packages.install(String(args.source));
  const steps = (info.thetis.steps ?? []).map((s) => `${s.phase}:${s.id}`).join(", ");
  const tools = (info.thetis.tools ?? []).map((t) => t.name).join(", ");
  return `installed ${info.name}@${info.version} (${info.type})${steps ? `; steps: ${steps}` : ""}${tools ? `; tools: ${tools}` : ""}. Live on the next turn.`;
};

export const uninstallPackage: Tool = async (args, env) => {
  await env.kernel.packages.uninstall(String(args.name));
  return `uninstalled ${args.name}`;
};

export const spawnSubagent: Tool = async (args, env) => {
  const child = await env.kernel.sessions.create(env.session.id);
  const reply = await env.kernel.sessions.ask(child.id, String(args.task));
  return `[subagent ${child.id}]\n${reply}`;
};
