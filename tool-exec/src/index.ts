import { contentText } from "@thetis/runtime/lib/content";
// The tool package that lets the model install, fork, delete and replace its own packages, and spawn a
// subagent in the same space. Running commands is @thetis/terminal, which holds a shell session the
// person can see; reading, editing and searching files is @thetis/tools-files. Everything here acts
// inside the fence through the agent's env.
import { resolve } from "node:path";
import type { ConfigKeyState, ConfigReport, Message, PackageInfo, Tool, ToolEnv } from "@thetis/runtime/contracts";
import { forkPackage as copyFork, forkVersion } from "@thetis/runtime/lib/pkg-fs";

/** One path segment, as the kernel accepts in a package name. Keeps `as` from leaving packages/. */
const DIR_NAME = /^[a-z0-9._-]+$/;

/** When a change to what is installed reaches the running code: the space applies it once no reply is running. */
const TAKES_EFFECT = "It takes effect when this reply ends.";

/** A phase no production configuration lists. Its steps cannot run here, so naming them would mislead. */
const BENCH_PHASE = "bench";

/**
 * Every package installed in this userspace, one line each: name, version, type, description, then the
 * steps (`phase:export`), the tools and the bench suites it declares, and what it forked from. `type`
 * narrows the list. This is the list the system prompt used to carry on every call.
 */
export const listPackages: Tool = async (args, env) => {
  const wanted = typeof args.type === "string" && args.type ? args.type : null;
  const lines = (await env.kernel.packages.list())
    .filter((p) => !wanted || p.type === wanted)
    .map((p) => {
      const steps = (p.thetis.steps ?? []).filter((s) => s.phase !== BENCH_PHASE).map((s) => `${s.phase}:${s.export}`).join(", ");
      const tools = (p.thetis.tools ?? []).map((t) => t.name).join(", ");
      const bench = (p.thetis.bench?.suites ?? []).join(", ");
      // A fork is said against its origin as that origin stands now, because "fork of X@0.1.1" is as true
      // on the day it is made as it is a year and six fixes later, and the model is often the one asked
      // why a person is not seeing a change that shipped.
      const fork = forkLine(p.fork ?? p.forkedFrom);
      // The fence read its version when it opened; the files have moved on since. Said here because the
      // version on the line is the one on disk, which is not the one this turn is running. It is applied
      // when the turn ends, so the model has nothing to ask for.
      const loaded = p.loadedVersion && p.loadedVersion !== p.version ? ` (update ready: ${p.loadedVersion} runs until this reply ends)` : "";
      return `- ${p.name}@${p.version} (${p.type})${p.description ? `: ${p.description}` : ""}${steps ? ` steps[${steps}]` : ""}${tools ? ` tools[${tools}]` : ""}${bench ? ` bench[${bench}]` : ""}${p.thetis.service ? " service" : ""}${fork}${loaded}`;
    });
  if (!lines.length) return wanted ? `no ${wanted} packages are installed in your userspace` : "no packages are installed in your userspace";
  return `${lines.length} ${wanted ? `${wanted} ` : ""}package${lines.length === 1 ? "" : "s"} installed in your userspace:\n${lines.join("\n")}`;
};

/** What to say about a fork on its one line: nothing, or its origin, or its origin and how far that has gone without it. */
function forkLine(fork: PackageInfo["fork"] | undefined): string {
  if (!fork) return "";
  // The origin is everyone's default here. Worth saying to the model, because it is usually the reason a
  // person's setup differs from the one every other answer about this host describes.
  const everyone = "everyone" in fork && fork.everyone ? ", and everyone else gets it" : "";
  if (!("shipped" in fork) || !fork.shipped) return ` fork of ${fork.name}@${fork.version}${everyone}`;
  if (fork.identical) return ` fork of ${fork.name}@${fork.version}, identical to the shipped ${fork.shipped}${everyone}: it is carrying no change and will see no further fix (unfork_package)`;
  if (fork.shipped !== fork.version) return ` fork of ${fork.name}@${fork.version}, ${fork.shipped} is shipped now${everyone} (unfork_package)`;
  return ` fork of ${fork.name}@${fork.version}${everyone}`;
}

export const installPackage: Tool = async (args, env) => {
  const info = await env.kernel.packages.install(String(args.source));
  const replaced = info.replaced ? `; replaced ${info.replaced}` : "";
  return `installed ${info.name}@${info.version} (${info.type})${brings(info.thetis)}${replaced}. ${TAKES_EFFECT}`;
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
  return `forked ${name}@${origin.version} to packages/${as} as ${forkName}@${version}${brings(origin.thetis)}${linked}. Edit it, then install_package with source "packages/${as}": it replaces ${name} until the fork is uninstalled or deleted. The fork inherits ${name}'s configuration; package_config shows what it gets.`;
};

/**
 * The inverse of `fork_package`: the userspace goes back to the package the fork was copied from, with the
 * fork's files left where they are. A fork is the only install that replaces something, so it is the only
 * one whose removal needs to name what takes its place; the kernel checks that package is on disk before
 * it removes anything, which is what makes this safe to run on the gateway a person is reading through.
 */
export const unforkPackage: Tool = async (args, env) => {
  const name = String(args.name);
  const back = await env.kernel.packages.unfork(name, args.deleteFiles === true);
  const files = args.deleteFiles === true ? " and its files were deleted" : "; its files were kept";
  return `${name} is no longer installed${files}. ${back.name}@${back.version} is back in its place. ${TAKES_EFFECT}`;
};

export const deletePackage: Tool = async (args, env) => {
  const r = await env.kernel.packages.delete(String(args.name));
  return `deleted ${r.name} and its files at ${r.path}${r.restored ? `; ${r.restored} is back in place` : ""}. ${TAKES_EFFECT}`;
};

/**
 * The first line of the result is `[subagent <id>]` or `[subagent <id> <label>]`; every reader parses it with
 * `/^\[subagent (s_[a-f0-9]+)(?: ([^\]]*))?\]/`. The rest is the child's reply, or `stopped: …` with what it had
 * said when it was stopped, or `error: <message>` when its turn failed or paused for a restart or an update. The turn is driven with `send` rather
 * than `ask` so a stop still yields the partial text, and so no error of the child's becomes a thrown error
 * here: a throw from a tool carries its stack back to the model, and the child's failure is a result, not a bug.
 * A stop of the parent turn aborts `env.signal`, and the child is cancelled with it, so a stop cascades down
 * however deep the subagents go.
 */
export const spawnSubagent: Tool = async (args, env) => {
  const child = await env.kernel.sessions.create(env.session.id);
  const head = headOf(child.id, args.label);
  if (env.signal?.aborted) return `${head}\nstopped: the parent was stopped before the subagent started.`;
  return drive(env, child.id, head, String(args.task));
};

/**
 * Continues a subagent of this conversation from where its last turn stopped: a turn with no input, which
 * runs over the saved conversation and adds no message, so nothing it finished is done again. The result has
 * the same shape as `spawn_subagent`'s. A child whose last turn finished is not run again: its last reply is
 * the answer, because a turn with no input after a finished reply would ask the model to go on from its own
 * last word.
 */
export const resumeSubagent: Tool = async (args, env) => {
  const id = /s_[a-f0-9]+/.exec(String(args.id ?? ""))?.[0];
  if (!id) throw new Error("id must be a subagent session id, such as s_1a2b3c4d5e6f");
  const record = await env.kernel.sessions.inspect(id);
  if (record.parent !== env.session.id) throw new Error(`${id} is not a subagent of this conversation`);
  const head = headOf(id, args.label);
  if (record.status === "running") return `${head}\nbusy: the subagent is running a turn already. Wait, then call resume_subagent again if it stops.`;
  const finished = record.interrupted ? null : finishedReply(record.conversation);
  if (finished !== null) return `${head}\n${finished}`;
  if (env.signal?.aborted) return `${head}\nstopped: the parent was stopped before the subagent resumed.`;
  return drive(env, id, head, []);
};

/** `[subagent <id> <label>]`, the label cleaned to one short line, or `[subagent <id>]` without one. */
function headOf(id: string, label: unknown): string {
  const clean = typeof label === "string" ? label.replace(/[\]\r\n]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return `[subagent ${id}${clean ? ` ${clean}` : ""}]`;
}

/** The text of a conversation's last message when it is a finished assistant reply: no tool calls, not marked cut off. */
function finishedReply(conversation: Message[] | undefined): string | null {
  const last = conversation?.at(-1);
  if (!last || last.role !== "assistant" || last.toolCalls?.length) return null;
  const mark = (last.extensions as Record<string, { partial?: boolean } | undefined> | undefined)?.[HARNESS];
  if (mark?.partial) return null;
  const text = contentText(last.content);
  return text.trim() ? text : null;
}

/** harness-core's key on a message, where it marks a reply cut off part-way as `partial`. */
const HARNESS = "@thetis/harness-core";
/** harness-core's retry event: `waiting` means the half-finished round was dropped and will be asked again. */
const RETRY_EVENT = "harness-core.retry";

/** Runs one turn of the child and says how it ended, in the result shape both tools share. */
async function drive(env: ToolEnv, id: string, head: string, input: string | []): Promise<string> {
  let reply = "";
  let partial = "";
  let failure: { message: string; code?: string; retryable?: boolean } | undefined;
  // Set when the child's turn stopped at a round boundary because Thetis asked it to (a drained restart or an
  // update of this space): the turn ends without an error, but it did not finish, and nothing resumes a
  // subagent by itself. Reported as a reply it would have been taken for the child's answer, and the rest of
  // its task would have been dropped.
  let yielded: string | undefined;
  try {
    await env.kernel.sessions.send(id, input, (e) => {
      if (e.type === "text") partial += e.delta;
      else if (e.type === "message" && e.message.role === "assistant") {
        if (contentText(e.message.content).trim()) reply = contentText(e.message.content);
        partial = "";
      } else if (e.type === "extension" && e.name === RETRY_EVENT && (e.data as { phase?: string } | undefined)?.phase === "waiting") {
        // The round is asked again from its start, so what it had said is not said any more.
        partial = "";
      } else if (e.type === "error") failure = { message: e.message, code: e.code, retryable: (e as { retryable?: boolean }).retryable === true };
      else if (e.type === "yield") yielded = String((e as { why?: unknown }).why ?? "") || "restart";
    }, undefined, env.signal);
  } catch (err) {
    const code = (err as { code?: string })?.code;
    if (code === "busy") return `${head}\nbusy: the subagent is running a turn already. Wait, then call resume_subagent again if it stops.`;
    if (!env.signal?.aborted && code !== "cancelled") throw err;
    failure = { message: "the subagent was stopped", code: "cancelled" };
  }
  const said = partial.trim() || reply.trim();
  const sofar = said ? `\nWhat it had said so far:\n${said}` : "";
  if (failure?.code === "cancelled") return `${head}\nstopped: the subagent was stopped before it finished.${sofar}`;
  if (failure) {
    const next = (await resumable(env, id, failure))
      ? `\nIts work so far is kept. To continue it instead of starting again, call resume_subagent with id ${id}.`
      : "\nFiles it wrote before failing are still there; look before starting the work again.";
    return `${head}\nerror: ${failure.message}${sofar}${next}`;
  }
  if (yielded) {
    const what = yielded === "reload" ? "an update of this space" : "a restart of Thetis";
    return `${head}\nerror: the subagent paused at a safe point for ${what} before it finished.${sofar}\nIts work so far is kept. To continue it instead of starting again, call resume_subagent with id ${id}.`;
  }
  return `${head}\n${reply}`;
}

/** Whether a failed child can be continued: its error said so, or its record kept the turn as interrupted. */
async function resumable(env: ToolEnv, id: string, failure: { retryable?: boolean }): Promise<boolean> {
  if (failure.retryable) return true;
  try {
    return Boolean((await env.kernel.sessions.inspect(id)).interrupted);
  } catch {
    return false;
  }
}

/** The report as text: the summary, then one line per key, then its help. A secret is `•••`, never its value. */
export const packageConfig: Tool = async (args, env) => {
  const report = await env.kernel.config.show(String(args.name));
  const lines = [`${report.package}: ${report.summary}`];
  if (report.inherits.length) lines.push(`inherits ${report.inherits.join(" -> ")}`);
  for (const k of report.keys) {
    lines.push(keyLine(k));
    if (k.help) lines.push(`  ${k.help}`);
  }
  return lines.join("\n");
};

/** Sets or unsets one key of the caller's own layer. The reply names the key and its state; the value stays out of the transcript. */
export const configurePackage: Tool = async (args, env) => {
  const name = String(args.name);
  const key = String(args.key);
  let report: ConfigReport;
  if (args.unset === true) report = await env.kernel.config.unset(name, key);
  else {
    if (args.value === undefined) throw new Error("value is required unless unset is true");
    report = await env.kernel.config.set(name, key, args.json === true ? parseJson(String(args.value)) : args.value);
  }
  const state = report.keys.find((k) => k.key === key);
  const now = state ? `now ${state.state}${where(state)}` : "now unset";
  const restarted = (await env.kernel.packages.list()).some((p) => p.name === name && p.thetis.service) ? " The service was restarted." : "";
  return `${args.unset === true ? "unset" : "set"} ${key} on ${name}: ${now}. ${name}: ${report.summary}.${restarted}`;
};

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("value is not valid JSON; pass json: false to store it as a string");
  }
}

function keyLine(k: ConfigKeyState): string {
  let line = `${k.key}: ${k.state}${where(k)}`;
  if (k.redacted) line += " = •••";
  else if (k.value !== undefined) line += ` = ${JSON.stringify(k.value)}`;
  if (k.missing?.length) line += ` (${k.missing.join(", ")} not in the environment)`;
  if (!k.declared) line += " (undeclared)";
  return line;
}

/** ` [user]`, ` [default, inherited from @thetis/notion]`, or nothing when no layer supplied a value. */
function where(k: ConfigKeyState): string {
  if (!k.source) return "";
  return ` [${k.source}${k.inheritedFrom ? `, inherited from ${k.inheritedFrom}` : ""}]`;
}

function brings(t: { steps?: { id: string; phase: string }[]; tools?: { name: string }[]; service?: { export: string } }): string {
  const steps = (t.steps ?? []).map((s) => `${s.phase}:${s.id}`).join(", ");
  const tools = (t.tools ?? []).map((x) => x.name).join(", ");
  return `${steps ? `; steps: ${steps}` : ""}${tools ? `; tools: ${tools}` : ""}${t.service ? "; a service" : ""}`;
}
