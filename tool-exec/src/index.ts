// "Run code in my userspace": the tool package that lets the model build, test, fork and install
// packages. Reading, editing and searching files is @thetis/tools-files. Everything here executes inside the fence via the agent's env.
import { resolve } from "node:path";
import type { Tool, ToolEnv } from "@thetis/contracts";
import { forkPackage as copyFork, forkVersion } from "@thetis/lib/pkg-fs";

/** One path segment, as the kernel accepts in a package name. Keeps `as` from leaving packages/. */
const DIR_NAME = /^[a-z0-9._-]+$/;

export const exec: Tool = async (args, env) => {
  const r = await env.exec(String(args.cmd), { cwd: args.cwd ? String(args.cwd) : undefined, timeoutMs: args.timeoutMs ? Number(args.timeoutMs) : undefined });
  const parts = [`exit ${r.code}`];
  if (r.stdout) parts.push(`stdout:\n${r.stdout}`);
  if (r.stderr) parts.push(`stderr:\n${r.stderr}`);
  return parts.join("\n");
};

export const installPackage: Tool = async (args, env) => {
  const info = await env.kernel.packages.install(String(args.source));
  const replaced = info.replaced ? `; replaced ${info.replaced}` : "";
  return `installed ${info.name}@${info.version} (${info.type})${brings(info.thetis)}${replaced}. Live on the next turn.`;
};

export const uninstallPackage: Tool = async (args, env) => {
  await env.kernel.packages.uninstall(String(args.name));
  return `uninstalled ${args.name}`;
};

/** Copies an installed package into the home as the caller's own, ready to edit. The kernel does the replacing at install. */
export const forkPackage: Tool = async (args, env: ToolEnv) => {
  const name = String(args.name);
  const installed = await env.kernel.packages.list();
  const origin = installed.find((p) => p.name === name);
  if (!origin) throw new Error(`${name} is not installed in your userspace`);
  const as = args.as ? String(args.as) : name.slice(name.indexOf("/") + 1);
  if (!DIR_NAME.test(as)) throw new Error(`as must be a plain directory name: ${as}`);
  const forkName = `@${env.session.user}/${as}`;
  const version = forkVersion(origin.version, installed.find((p) => p.name === forkName)?.version);
  const to = resolve(env.cwd, "packages", as);
  const r = copyFork({ from: origin.root, to, name: forkName, version, origin: { name, version: origin.version }, root: env.root });
  const linked = r.linked.length ? `; dependencies linked: ${r.linked.join(", ")}` : "";
  return `forked ${name}@${origin.version} to packages/${as} as ${forkName}@${version}${brings(origin.thetis)}${linked}. Edit it, then install_package with source "packages/${as}": it replaces ${name} until the fork is uninstalled or deleted.`;
};

export const deletePackage: Tool = async (args, env) => {
  const r = await env.kernel.packages.delete(String(args.name));
  return `deleted ${r.name} and its files at ${r.path}${r.restored ? `; ${r.restored} is back in place` : ""}. Live on the next turn.`;
};

export const spawnSubagent: Tool = async (args, env) => {
  const child = await env.kernel.sessions.create(env.session.id);
  const reply = await env.kernel.sessions.ask(child.id, String(args.task));
  return `[subagent ${child.id}]\n${reply}`;
};

function brings(t: { steps?: { id: string; phase: string }[]; tools?: { name: string }[]; service?: { export: string } }): string {
  const steps = (t.steps ?? []).map((s) => `${s.phase}:${s.id}`).join(", ");
  const tools = (t.tools ?? []).map((x) => x.name).join(", ");
  return `${steps ? `; steps: ${steps}` : ""}${tools ? `; tools: ${tools}` : ""}${t.service ? "; a service" : ""}`;
}
