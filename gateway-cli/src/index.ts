// CLI gateway. When `thetis serve` runs, every command is a client of that one kernel over the control
// socket, so installs, passwords and moderation reach the running services. Without a daemon, a command
// boots a kernel in-process. Both paths speak to the same operator handler, so the commands are one code.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { createInterface as createPrompt } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { KernelRpc, ModelDescriptor, PackageInfo, SessionRecord, TurnEvent, UserRecord } from "@thetis/contracts";
import { createDoor } from "@thetis/door";
import { behind, readIndex, shortCommit, type Behind } from "@thetis/marketplace";
import { ControlServer, controlSocketPath, createKernel } from "@thetis/host";
import { configPath, createControlHandler, defaultConfig, loadConfig, saveConfig, type SessionRef } from "@thetis/kernel";
import { connectRpcSocket } from "@thetis/lib/ndjson-socket";
import type { MountState } from "@thetis/lib/mounts";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** How long `serve` gives the door, the control socket and the fences to close before it exits regardless. */
const SHUTDOWN_DEADLINE_MS = 5_000;

const HELP = `thetis - recursive language model service

usage: thetis <command> [options]

  init                                 create the data dir and default config
  serve                                run the kernel, its control socket, and every installed service until stopped
  chat --user <id> [--session <id>]    interactive conversation (streams output)
  send --user <id> [--session <id>] <text>   one-shot turn
  sessions list --user <id>
  sessions show --user <id> --session <id>
  users list | add <id> [--admin] | remove <id> | suspend <id> | unsuspend <id> | role <id> <admin|user>
  users passwd <id> [--password <text>]  set the sign-in password (reads one line from stdin without --password)
  install <source> [--user <id>]       install a package (system userspace without --user)
  uninstall <name> [--user <id>]
  packages list [--user <id>] | install <source> [--user <id>] | uninstall <name> [--user <id>] | promote <name> --user <id>
  packages outdated [--user <id>]      what is behind the registry it was installed from
  packages update [<name>] [--user <id>]  reinstall those packages at the registry's current commit
  mounts list [--user <id>]            host paths bound into each person's fence, and whether each is there
  mounts add <user> <path> [--ro]      bind a host directory into that person's fence at the same path (read-write unless --ro)
  mounts remove <user> <path>
  mounts browse [path]                 the directories under a host path, to pick one to bind
  models [--user <id>]                 models advertised by installed providers
  config                               print effective config
  bench run <suite> [--write] [--force] [--sandbox auto|bwrap|none] [--package <dir>]
                                       measure the harness against a suite; --write updates each package's BENCH.md
  bench verify [<package-dir>]         check a package's thetis.bench declaration without running anything

When \`thetis serve\` runs, the other commands talk to it through $THETIS_HOME/thetis.sock.
env: THETIS_HOME (data dir, default ~/.thetis; a relative path is resolved against the repository root),
     OPENROUTER_API_KEY. A .env in the cwd and in the repository root is loaded.
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

type Call = KernelRpc;

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
  if (cmd === "bench") {
    // The bench boots its own kernel in a temporary home, so it must not touch this one or a running daemon:
    // the arms, the phases and the installed set all have to be controlled for the numbers to mean anything.
    const { main } = await import("@thetis/bench");
    const code = await main(argv.slice(1));
    if (code !== 0) process.exitCode = code;
    return;
  }

  const socket = controlSocketPath(home);
  const remote = await connectRpcSocket(socket);
  if (cmd === "serve") {
    if (remote) {
      remote.close();
      throw new Error(`a thetis daemon is already running on ${socket}`);
    }
    return serve(config, socket);
  }
  if (remote) {
    try {
      await dispatch(remote.call, cmd, args, config.sharedDir);
    } finally {
      remote.close();
    }
    return;
  }
  const kernel = createKernel(config);
  try {
    await dispatch(createControlHandler(kernel), cmd, args, config.sharedDir);
  } finally {
    await kernel.shutdown();
  }
}

/** Runs the kernel until SIGINT or SIGTERM: control socket for the CLI, the door for browsers, services for everyone else. */
async function serve(config: ReturnType<typeof loadConfig>, socket: string): Promise<void> {
  const kernel = createKernel(config);
  const log = (line: string) => process.stderr.write(line + "\n");
  const control = new ControlServer(socket, createControlHandler(kernel), log);
  const door = createDoor({
    loginSocket: resolve(kernel.userspaces.pathFor("_system").run, "login.sock"),
    socketFor: (user) => (kernel.users.get(user)?.role !== "system" && kernel.users.get(user) && kernel.userspaces.exists(user) ? resolve(kernel.userspaces.pathFor(user).run, "web.sock") : undefined),
    log,
  });
  try {
    await control.listen();
    await kernel.services.boot();
    await new Promise<void>((done, fail) => door.once("error", fail).listen(config.door.port, config.door.host, done));
    print(`thetis is serving; control socket ${socket}; door on http://${config.door.host}:${config.door.port}; press Ctrl+C to stop`);
    await new Promise<void>((done) => {
      process.once("SIGINT", () => done());
      process.once("SIGTERM", () => done());
    });
    print("stopping");
  } finally {
    // The backstop. Each step closes what it owns and should be quick; if one is not, a daemon that needs
    // SIGKILL is worse than an unclean stop, so say what was still open and leave. The timer holds nothing
    // alive: it fires only if something else still does.
    let waitingOn = "the door";
    setTimeout(() => {
      log(`stopping: still waiting on ${waitingOn} after ${SHUTDOWN_DEADLINE_MS} ms; exiting anyway`);
      process.exit(0);
    }, SHUTDOWN_DEADLINE_MS).unref();
    await new Promise<void>((done) => door.close(() => done()));
    waitingOn = "the control socket";
    await control.close();
    waitingOn = "the fences";
    await kernel.shutdown();
    waitingOn = "an open handle after everything was closed";
  }
}

async function dispatch(call: Call, cmd: string, args: Args, shared: string): Promise<void> {
  const user = typeof args.user === "string" ? args.user : undefined;
  const need = (): string => {
    if (!user) throw new Error("--user <id> is required");
    return user;
  };
  switch (cmd) {
    case "users":
      return usersCmd(call, args);
    case "packages":
      return packagesCmd(call, args, user, shared);
    case "mounts":
      return mountsCmd(call, args, user);
    case "install":
    case "uninstall":
      return packagesCmd(call, { ...args, _: ["packages", ...args._] }, user, shared);
    case "models": {
      for (const m of (await call("models", { user })) as ModelDescriptor[]) print(`${m.id}\t${m.provider}`);
      return;
    }
    case "sessions": {
      const u = need();
      if (args._[1] === "show") return print(JSON.stringify(await call("sessions.inspect", { user: u, session: String(args.session) }), null, 2));
      for (const s of (await call("sessions.list", { user: u })) as SessionRef[]) print(`${s.id}\tturns=${s.turns}\t${s.updatedAt}${s.parent ? `\tparent=${s.parent}` : ""}`);
      return;
    }
    case "send": {
      const u = need();
      const text = args._.slice(1).join(" ");
      if (!text) throw new Error("send needs a message");
      const session = typeof args.session === "string" ? args.session : ((await call("sessions.create", { user: u })) as SessionRef).id;
      await render(call, u, session, text, !!args.verbose);
      return;
    }
    case "chat":
      return chat(call, need(), typeof args.session === "string" ? args.session : undefined, !!args.verbose);
    default:
      throw new Error(`unknown command: ${cmd}\n${HELP}`);
  }
}

async function usersCmd(call: Call, args: Args): Promise<void> {
  const [, sub, id, extra] = args._;
  switch (sub) {
    case "list":
    case undefined:
      for (const u of (await call("users.list", {})) as UserRecord[]) print(`${u.id}\t${u.role}\t${u.status}\t${u.createdAt}`);
      return;
    case "add":
      return print(`created ${((await call("users.create", { id, role: args.admin ? "admin" : "user" })) as UserRecord).id}`);
    case "remove":
      await call("users.remove", { id });
      return print(`removed ${id} and its userspace`);
    case "suspend":
      return print(`suspended ${((await call("users.setStatus", { id, status: "suspended" })) as UserRecord).id}`);
    case "unsuspend":
      return print(`reactivated ${((await call("users.setStatus", { id, status: "active" })) as UserRecord).id}`);
    case "role":
      return print(`${id} is now ${((await call("users.setRole", { id, role: extra })) as UserRecord).role}`);
    case "passwd": {
      const password = typeof args.password === "string" ? args.password : (await readLine()).trim();
      await call("users.passwd", { id, password });
      return print(`password set for ${id}`);
    }
    default:
      throw new Error(`unknown users subcommand: ${sub}`);
  }
}

/**
 * One word for what the host holds at a mount's path: what the fence will do with it. A daemon older than
 * this field says nothing about the path, and the line says nothing rather than guessing.
 */
function stateOf(m: MountState): string {
  if (m.present === undefined) return "";
  return m.present ? "bound" : m.kind === "file" ? "skipped (a file, not a directory)" : "skipped (not on the host)";
}

/**
 * The mount list is replaced whole by `mounts.set`; add and remove read the current list first and send
 * the edited one. Every line says whether the host still holds the directory, because a mount whose path
 * is gone is skipped when the fence opens, and a silent skip is how a person finds out too late.
 */
async function mountsCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const [, sub, id, path] = args._;
  const listOf = async (u: string) => ((await call("mounts.list", { user: u })) as Record<string, MountState[]>)[u] ?? [];
  if (sub !== "list" && sub !== "browse" && sub !== undefined && !(id && path)) throw new Error(`mounts ${sub} needs <user> <path>`);
  switch (sub) {
    case "list":
    case undefined: {
      const all = (await call("mounts.list", { user })) as Record<string, MountState[]>;
      for (const [u, list] of Object.entries(all)) for (const m of list) print([u, m.path, m.mode, stateOf(m)].filter(Boolean).join("\t"));
      return;
    }
    case "browse": {
      const listing = (await call("mounts.browse", { path: id ?? "/" })) as { path: string; kind: string; readable: boolean; entries: { path: string }[] };
      if (!listing.readable) throw new Error(`${listing.path} is ${listing.kind === "none" ? "not there" : listing.kind === "file" ? "not a directory" : "not readable"}`);
      for (const e of listing.entries) print(e.path);
      return;
    }
    case "add": {
      const mode = args.ro ? "ro" : "rw";
      const mounts = [...(await listOf(id)).map((m) => ({ path: m.path, mode: m.mode })).filter((m) => m.path !== path), { path, mode }];
      const after = (await call("mounts.set", { user: id, mounts })) as MountState[];
      const bound = after.find((m) => m.path === path);
      if (bound && bound.present === false) throw new Error(`${path} is written down for ${id}, but the host has ${bound.kind === "file" ? "a file" : "nothing"} there: the fence opens without it. Fix the path, or make the directory.`);
      return print(`mounted ${path} (${mode}) for ${id}; the fence reopens with it`);
    }
    case "remove": {
      const before = await listOf(id);
      const mounts = before.filter((m) => m.path !== path);
      if (mounts.length === before.length) throw new Error(`${path} is not mounted for ${id}`);
      await call("mounts.set", { user: id, mounts });
      return print(`unmounted ${path} for ${id}`);
    }
    default:
      throw new Error(`unknown mounts subcommand: ${sub}`);
  }
}

/**
 * What an installation is behind on. Nothing updates on its own: the index says what is latest, the record
 * says what is installed, and this compares them so a person can decide.
 */
async function outdatedIn(call: Call, target: string, shared: string): Promise<Behind[]> {
  const installed = (await call("packages.list", { user: target })) as PackageInfo[];
  // The index is a file the marketplace service writes into the shared directory. The command line is a host
  // process and reads it there; asking the kernel would mean teaching the kernel where the marketplace keeps
  // its things, which is exactly the sort of opinion it does not hold.
  const index = await readIndex({ shared, readFile: async (at: string) => readFileSync(at, "utf8"), writeFile: async () => {} });
  return behind(installed, index);
}

async function packagesCmd(call: Call, args: Args, user: string | undefined, shared: string): Promise<void> {
  const [, sub, source] = args._;
  const target = user ?? "_system";
  switch (sub) {
    case "list":
    case undefined:
      for (const p of (await call("packages.list", { user: target })) as PackageInfo[]) print(`${p.name}@${p.version}\t${p.type}\t${p.root}`);
      return;
    case "install": {
      const info = (await call("packages.install", { user: target, source, actor: "_system" })) as PackageInfo;
      return print(`installed ${info.name}@${info.version} (${info.type}) in ${target}`);
    }
    case "uninstall":
      await call("packages.uninstall", { user: target, name: source });
      return print(`uninstalled ${source} from ${target}`);
    case "promote": {
      const r = (await call("packages.promote", { user: target, name: source })) as { name: string; userspaces: string[] };
      return print(`promoted ${source} to ${r.name}; installed in ${r.userspaces.join(", ")}`);
    }
    case "outdated": {
      const out = await outdatedIn(call, target, shared);
      if (!out.length) return print(`nothing in ${target} is behind its registry`);
      for (const b of out) print(`${b.name}\t${b.version}\t${shortCommit(b.installed)} -> ${shortCommit(b.available)}\t${b.registry}`);
      return print(`\nrun: thetis packages update${user ? ` --user ${user}` : ""} [<name>]`);
    }
    case "update": {
      const out = await outdatedIn(call, target, shared);
      const wanted = source ? out.filter((b) => b.name === source) : out;
      if (source && !wanted.length) {
        const known = out.length ? `; behind: ${out.map((b) => b.name).join(", ")}` : "; nothing is behind";
        throw new Error(`${source} is not behind its registry in ${target}${known}`);
      }
      if (!wanted.length) return print(`nothing in ${target} is behind its registry`);
      for (const b of wanted) {
        const info = (await call("packages.install", { user: target, source: b.source, actor: "_system" })) as PackageInfo;
        print(`updated ${info.name} to ${info.version} (${shortCommit(b.installed)} -> ${shortCommit(b.available)})`);
      }
      return;
    }
    default:
      throw new Error(`unknown packages subcommand: ${sub}`);
  }
}

async function chat(call: Call, user: string, sessionId: string | undefined, verbose: boolean): Promise<void> {
  let session = sessionId ?? ((await call("sessions.create", { user })) as SessionRef).id;
  print(`thetis chat as ${user} in session ${session}. /new starts a session, /inspect shows state, /quit exits.`);
  const rl = createPrompt({ input: process.stdin, output: process.stdout });
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
      session = ((await call("sessions.create", { user })) as SessionRef).id;
      print(`new session ${session}`);
      continue;
    }
    if (line === "/inspect") {
      const s = (await call("sessions.inspect", { user, session })) as SessionRecord & { status: string };
      print(JSON.stringify({ id: s.id, turns: s.turns, messages: s.conversation.length, harness: s.harness, status: s.status }, null, 2));
      continue;
    }
    process.stdout.write("\nthetis> ");
    await render(call, user, session, line, verbose);
  }
  rl.close();
}

async function render(call: Call, user: string, session: string, input: string, verbose: boolean): Promise<void> {
  const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
  await call("sessions.send", { user, session, input }, (raw) => {
    const e = raw as TurnEvent;
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
      case "message":
        if (e.usage) process.stdout.write(`\n${dim(usageLine(e.usage))}\n`);
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
  });
  process.stdout.write("\n");
}

/** One line of accounting for a reply. Reads the usage by field name; a provider that reports nothing prints nothing. */
function usageLine(u: Record<string, number>): string {
  const parts: string[] = [];
  if (u.prompt_tokens !== undefined) parts.push(`in ${u.prompt_tokens}`);
  if (u.cache_read_tokens !== undefined && u.prompt_tokens) parts.push(`cached ${Math.round((u.cache_read_tokens / u.prompt_tokens) * 100)}%`);
  if (u.cache_write_tokens) parts.push(`wrote ${u.cache_write_tokens}`);
  if (u.completion_tokens !== undefined) parts.push(`out ${u.completion_tokens}`);
  if (u.cost !== undefined) parts.push(`$${u.cost.toFixed(4)}`);
  return `[${parts.join(" · ")}]`;
}

function readLine(): Promise<string> {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data.split("\n")[0] ?? ""));
  });
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
