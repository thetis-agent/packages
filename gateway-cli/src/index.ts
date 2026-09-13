// CLI gateway: boots the kernel in-process, maps the operator to a --user, sends turns
// and renders events. Also exposes user moderation and package administration.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { createKernel, defaultConfig, loadConfig, saveConfig, configPath, type Kernel, type TurnEvent, type UserRole } from "@thetis/kernel";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");

const HELP = `thetis - recursive language model service

usage: thetis <command> [options]

  init                                 create the data dir and default config
  chat --user <id> [--session <id>]    interactive conversation (streams output)
  send --user <id> [--session <id>] <text>   one-shot turn
  sessions list --user <id>
  sessions show --user <id> --session <id>
  users list | add <id> [--admin] | remove <id> | suspend <id> | unsuspend <id> | role <id> <admin|user>
  packages list [--user <id>] | install <source> --user <id> | uninstall <name> --user <id>
  models [--user <id>]                 models advertised by installed providers
  config                               print effective config

env: THETIS_HOME (data dir, default ~/.thetis; a relative path is resolved against the repository root),
     OPENROUTER_API_KEY. A .env in the cwd and in the repository root is loaded.
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

export async function run(argv: string[]): Promise<void> {
  loadDotEnv(resolve(process.cwd(), ".env"));
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parse(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.help) return void process.stdout.write(HELP);
  const home = resolve(PROJECT_ROOT, String(process.env.THETIS_HOME ?? resolve(process.env.HOME ?? ".", ".thetis")));
  const config = loadConfig(home, PROJECT_ROOT);
  if (cmd === "init") {
    if (!existsSync(configPath(home))) saveConfig(defaultConfig(home, PROJECT_ROOT));
    process.stdout.write(`initialized ${home}\n`);
    return;
  }
  if (cmd === "config") return void process.stdout.write(JSON.stringify(config, null, 2) + "\n");
  const kernel = createKernel(config);
  try {
    await dispatch(kernel, cmd, args);
  } finally {
    await kernel.shutdown();
  }
}

async function dispatch(k: Kernel, cmd: string, args: Args): Promise<void> {
  const user = typeof args.user === "string" ? args.user : undefined;
  const need = (): string => {
    if (!user) throw new Error("--user <id> is required");
    return user;
  };
  switch (cmd) {
    case "users":
      return usersCmd(k, args);
    case "packages":
      return packagesCmd(k, args, user);
    case "models": {
      const us = k.sessions.userspaceFor(k.users.authorize(user ?? "_system"));
      for (const m of await k.providers.listModels(us)) print(`${m.id}\t${m.provider}`);
      return;
    }
    case "sessions": {
      const u = need();
      if (args._[1] === "show") return print(JSON.stringify(k.sessions.inspect(u, String(args.session)), null, 2));
      for (const s of k.sessions.list(u)) print(`${s.id}\tturns=${s.turns}\t${s.updatedAt}${s.parent ? `\tparent=${s.parent}` : ""}`);
      return;
    }
    case "send": {
      const u = need();
      const text = args._.slice(1).join(" ");
      if (!text) throw new Error("send needs a message");
      const session = typeof args.session === "string" ? args.session : k.sessions.create(u).id;
      await render(k.sessions.send(u, session, text), !!args.verbose);
      return;
    }
    case "chat":
      return chat(k, need(), typeof args.session === "string" ? args.session : undefined, !!args.verbose);
    default:
      throw new Error(`unknown command: ${cmd}\n${HELP}`);
  }
}

function usersCmd(k: Kernel, args: Args): void {
  const [, sub, id, extra] = args._;
  switch (sub) {
    case "list":
    case undefined:
      for (const u of k.users.list()) print(`${u.id}\t${u.role}\t${u.status}\t${u.createdAt}`);
      return;
    case "add":
      return print(`created ${k.users.create(String(id), args.admin ? "admin" : "user").id}`);
    case "remove":
      return void k.removeUser(String(id)).then(() => print(`removed ${id} and its userspace`));
    case "suspend":
      return print(`suspended ${k.users.setStatus(String(id), "suspended").id}`);
    case "unsuspend":
      return print(`reactivated ${k.users.setStatus(String(id), "active").id}`);
    case "role":
      return print(`${id} is now ${k.users.setRole(String(id), extra as UserRole).role}`);
    default:
      throw new Error(`unknown users subcommand: ${sub}`);
  }
}

async function packagesCmd(k: Kernel, args: Args, user?: string): Promise<void> {
  const [, sub, source] = args._;
  const actor = k.users.authorize(user ?? "_system");
  const us = k.sessions.userspaceFor(actor);
  switch (sub) {
    case "list":
    case undefined:
      for (const p of k.packages.installed(us)) print(`${p.name}@${p.version}\t${p.type}\t${p.root}`);
      return;
    case "install": {
      const info = await k.packages.install(us, actor, String(source));
      return print(`installed ${info.name}@${info.version} (${info.type}) in ${us.id}`);
    }
    case "uninstall":
      k.packages.uninstall(us, String(source));
      return print(`uninstalled ${source} from ${us.id}`);
    default:
      throw new Error(`unknown packages subcommand: ${sub}`);
  }
}

async function chat(k: Kernel, user: string, sessionId: string | undefined, verbose: boolean): Promise<void> {
  let session = sessionId ?? k.sessions.create(user).id;
  print(`thetis chat as ${user} in session ${session}. /new starts a session, /inspect shows state, /quit exits.`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  for (;;) {
    let line: string;
    try {
      line = (await rl.question("\nyou> ")).trim();
    } catch {
      break;
    }
    if (!line) continue;
    if (line === "/quit" || line === "/exit") break;
    if (line === "/new") {
      session = k.sessions.create(user).id;
      print(`new session ${session}`);
      continue;
    }
    if (line === "/inspect") {
      const s = k.sessions.inspect(user, session);
      print(JSON.stringify({ id: s.id, turns: s.turns, messages: s.conversation.length, harness: s.harness, status: s.status }, null, 2));
      continue;
    }
    process.stdout.write("\nthetis> ");
    await render(k.sessions.send(user, session, line), verbose);
  }
  rl.close();
}

async function render(events: AsyncIterable<TurnEvent>, verbose: boolean): Promise<void> {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  for await (const e of events) {
    switch (e.type) {
      case "text":
        process.stdout.write(e.delta);
        break;
      case "tool.call":
        process.stdout.write(`\n${dim(`[tool ${e.call.name}] ${JSON.stringify(e.call.args).slice(0, 400)}`)}\n`);
        break;
      case "tool.result":
        process.stdout.write(dim(`[${e.name} -> ${e.result.replace(/\s+/g, " ").slice(0, 300)}]`) + "\n");
        break;
      case "error":
        process.stdout.write(`\n\x1b[31merror: ${e.message}\x1b[0m\n`);
        break;
      case "step.start":
      case "step.end":
      case "usage":
        if (verbose) process.stdout.write(dim(`[${e.type} ${JSON.stringify("step" in e ? e.step.id : e.usage)}]`) + "\n");
        break;
      default:
        break;
    }
  }
  process.stdout.write("\n");
}

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) (out[key] = next), i++;
      else out[key] = true;
    } else out._.push(a);
  }
  return out;
}

function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  }
}

function print(s: string): void {
  process.stdout.write(s + "\n");
}
