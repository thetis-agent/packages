// CLI gateway. When `thetis serve` runs, every command is a client of that one kernel over the control
// socket, so installs, passwords and moderation reach the running services. Without a daemon, a command
// boots a kernel in-process. Both paths speak to the same operator handler, so the commands are one code.
import { exec as cpExec, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface as createPrompt } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import type { ConfigReport, KernelRpc, ModelDescriptor, Mount, PackageInfo, SessionRecord, SshGrant, TurnEvent, UserRecord } from "@thetis/contracts";
import { createDoor } from "@thetis/door";
import { ahead, behind, readIndex, shortCommit, type Ahead, type Behind } from "@thetis/marketplace";
import { ControlServer, controlSocketPath, createKernel, migrateStore, readControlToken, writeControlToken, type KernelConfig } from "@thetis/host";
import { configPath, createControlHandler, defaultConfig, loadConfig, redact, saveConfig, type SessionRef } from "@thetis/kernel";
import { parseDotEnv } from "@thetis/lib/config";
import { errorMessage } from "@thetis/lib/error";
import { connectRpcSocket } from "@thetis/lib/ndjson-socket";
import { assertHomeFitsSockets, homeSocketWarning } from "@thetis/lib/socket-paths";
import { isSupervised, type Pending, type RestartState } from "@thetis/lib/restart";

const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../../..");
/** How long `serve` gives the door, the control socket and the fences to close before it exits regardless. */
const SHUTDOWN_DEADLINE_MS = 5_000;

const HELP = `thetis - recursive language model service

usage: thetis <command> [options]

  init                                 create the data dir and default config
  serve                                run the kernel, its control socket, and every installed service until stopped
  status [--json]                      what is running, and whether it is the code that is on disk now; --json the raw report
  reload --user <id> | --all           put the code on disk into service: that workspace's fence closes and opens again
                                       their gateway, terminal and every service start over, and open shell sessions die;
                                       --all does everyone, _system last, so the sign-in page blips once at the end
  restart [--reason <text>] [--yes]    ask the running daemon to restart itself: it waits for every turn
                                       everywhere to finish, then exits so that systemd starts it again;
                                       this ends every turn in progress and every open terminal session
  restart status                       whether one is armed, and whether one would be accepted at all
  restart cancel                       call off an armed restart
  chat --user <id> [--session <id>]    interactive conversation (streams output)
  send --user <id> [--session <id>] <text>   one-shot turn
  sessions list --user <id>
  sessions show --user <id> --session <id>
  users list | add <id> [--admin] | remove <id> | suspend <id> | unsuspend <id> | role <id> <admin|user>
  users passwd <id> [--password <text>]  set the sign-in password (reads one line from stdin without --password)
  install <source> [--user <id>]       install a package (system userspace without --user)
  uninstall <name> [--user <id>]
  packages list [--user <id>] | install <source> [--user <id>] | uninstall <name> [--user <id>] | promote <name> --user <id>
  packages outdated [--user <id>]      what is behind the registry it was installed from, the code on disk, or the
                                       package it was forked from, and what is ahead: newer here than the registry
                                       holds, or never published at all
  packages update [<name>] [--user <id>]  reinstall those packages at the registry's current commit
  packages unfork <name> [--user <id>] [--delete-files]  go back to the package this fork was copied from
  mounts list [--user <id>]            host paths bound into each person's fence, and whether each is there
  mounts add <user> <path> [--ro]      bind a host directory into that person's fence at the same path (read-write unless --ro)
  mounts remove <user> <path>
  mounts browse [path]                 the directories under a host path, to pick one to bind
  ssh list [--user <id>]               the ssh keys granted to each person's fence, and whether each is on this host
  ssh grant <user> <key> [--host <name>]... [--scan <name>]...
                                       load one host key file into that person's fence agent; --host adds a
                                       known_hosts line, --scan fetches them with ssh-keyscan. The key is never
                                       bound into the fence: the agent holds it and the fence asks it to sign
  ssh keygen <user> [--host <name>]... [--scan <name>]...
                                       make that person's fence a key of its own and grant it, for when
                                       there is no host credential to share; prints the public half to
                                       register. The private half never leaves the kernel
  ssh import <user> <name> [--host <name>]... [--scan <name>]...
                                       read a private key from stdin (a key already registered at GitHub, say),
                                       keep it with the kernel under that name and grant it to the person's fence;
                                       prints the public half and its fingerprint. A key with a passphrase is refused
  ssh revoke <user> <key>
  publish <package> --to <target> [--version <v> | --bump patch|minor|major] [--with <name>]... [--dry-run]
                                       put a package in a registry at a new version: check the manifest, refuse a
                                       version the target already holds, commit only that package's directory and
                                       push. <package> is an installed name or a path; --dry-run says what would go.
                                       A push sends the branch, so commits to other packages on it would go too:
                                       --with names one you meant to publish as well, and is repeatable. One that
                                       could not be published on its own is refused whatever you say
  models [--user <id>]                 models advertised by installed providers
  config                               print the configuration file over its defaults, secrets hidden
  config show [<package>] [--user <id>]  every key of one package and where its value comes from, or one line per package;
                                       --user shows that person's own layer over the system's
  config set <package> <key> [<value>] [--user <id>] [--json] [--stdin]
                                       set one key at the system layer, or at that person's; --json parses the value,
                                       --stdin reads it from stdin (a secret stays out of the shell history)
  config unset <package> <key> [--user <id>]
  config reload                        re-read the packages of thetis.config.json and the .env file; services whose
                                       configuration changed start again
  migrate                              move the users, auth, registry and mounts files of an older data dir into the store
  bench run <suite> [--write] [--force] [--sandbox auto|bwrap|none] [--package <dir>]
                                       measure the harness against a suite; --write updates each package's BENCH.md
  bench verify [<package-dir>]         check a package's thetis.bench declaration without running anything

When \`thetis serve\` runs, the other commands talk to it through $THETIS_HOME/thetis.sock.
env: THETIS_HOME (data dir, default ~/.thetis; a relative path is resolved against the repository root;
     at most 73 bytes, because every unix socket hangs off it and a socket path cannot exceed 107; a
     home over 49 bytes serves, but shortens how long a user id may be, and init says by how much),
     OPENROUTER_API_KEY. A .env in the cwd and in the repository root is loaded.
`;

interface Args {
  _: string[];
  [k: string]: string | boolean | string[];
}

type Call = KernelRpc;

/** A mount as `host.grants.mountsList` answers it: with what the host holds at the path now. A daemon without the host package says nothing about it. */
type MountState = Mount & { present?: boolean; kind?: "dir" | "file" | "none" };
/** A grant as `host.grants.sshList` answers it: whether the key is on the host, and its public half when it is. */
type SshGrantState = SshGrant & { present?: boolean; publicKey?: string | null; fingerprint?: string | null };
/** What making or importing a key answers: where it is, and the half to register wherever it is going. */
type MadeKey = { key: string; publicKey: string; fingerprint: string | null };

export async function run(argv: string[]): Promise<void> {
  loadDotEnv(resolve(process.cwd(), ".env"));
  loadDotEnv(resolve(PROJECT_ROOT, ".env"));
  const args = parse(argv);
  const cmd = args._[0];
  if (!cmd || cmd === "help" || args.help) return void process.stdout.write(HELP);
  const home = resolve(PROJECT_ROOT, String(process.env.THETIS_HOME ?? resolve(process.env.HOME ?? ".", ".thetis")));
  const config = loadConfig(home, PROJECT_ROOT);
  if (cmd === "init") {
    // Checked here rather than at the first `serve`, because this is the one moment the person is choosing
    // the path: every unix socket this installation will ever open hangs off it, and a home that is too
    // long cannot be fixed by anything but a different home. Saying `initialized <path>` and exiting 0
    // over a path that can never serve is the whole bug this closes.
    assertHomeFitsSockets(home);
    if (!existsSync(configPath(home))) saveConfig(defaultConfig(home, PROJECT_ROOT));
    process.stdout.write(`initialized ${home}\n`);
    // A home can be perfectly good and still not have room for every user id the kernel would allow. That
    // is a fact about this directory, not a fault in it, so it is said once, here, where another path is
    // still free to choose -- and enforced later, at `users.create`, where an id actually exists.
    const note = homeSocketWarning(home);
    if (note) process.stdout.write(`${note}\n`);
    return;
  }
  if (cmd === "config" && args._[1] === undefined) return print(JSON.stringify(redact(config), null, 2));
  if (cmd === "bench") {
    // The bench boots its own kernel in a temporary home, so it must not touch this one or a running daemon:
    // the arms, the phases and the installed set all have to be controlled for the numbers to mean anything.
    const { main } = await import("@thetis/bench");
    const code = await main(argv.slice(1));
    if (code !== 0) process.exitCode = code;
    return;
  }

  const socket = controlSocketPath(home);
  // The running daemon's token, from the host's run directory. Undefined when there is none, and then the
  // daemon has none either and admits anyone who can open the socket, as it always did.
  const remote = await connectRpcSocket(socket, readControlToken(home));
  if (cmd === "serve") {
    if (remote) {
      remote.close();
      throw new Error(`a thetis daemon is already running on ${socket}`);
    }
    return serve(config, socket);
  }
  if (cmd === "migrate") {
    // The records move while nothing holds them: a daemon has them in memory and would write the old files back.
    if (remote) {
      remote.close();
      throw new Error(`a thetis daemon is running on ${socket}; stop it, then migrate`);
    }
    return migrateCmd(config);
  }
  if (remote) {
    try {
      await dispatch(remote.call, cmd, args, config.sharedDir);
    } finally {
      remote.close();
    }
    return;
  }
  const kernel = await createKernel(config);
  try {
    await dispatch(createControlHandler(kernel), cmd, args, config.sharedDir);
  } finally {
    await kernel.shutdown();
  }
}

/** Runs the kernel until SIGINT, SIGTERM or an armed restart: control socket for the CLI, the door for browsers, services for everyone else. */
async function serve(config: ReturnType<typeof loadConfig>, socket: string): Promise<void> {
  // Said again here, and before anything is built, because `init` is not the only way a home arrives: it can
  // be moved, `THETIS_HOME` can be edited, and a person can be handed a data directory somebody else made.
  // Without this the first thing that happens is `control.listen()` throwing a bare `listen EINVAL` naming a
  // path and no length, which reads as a fault in the daemon. Only the unconditional failure is refused; a
  // home with room for some ids and not others is the business of `users.create`, not of starting up.
  assertHomeFitsSockets(config.home);
  const kernel = await createKernel(config);
  const log = (line: string) => process.stderr.write(line + "\n");
  // Written fresh on every start, so a token from a dead daemon is never accepted by a live one.
  const control = new ControlServer(socket, createControlHandler(kernel), log, writeControlToken(config.home, log));
  const door = createDoor({
    loginSocket: resolve(kernel.userspaces.pathFor("_system").run, "login.sock"),
    socketFor: (user) => (kernel.users.get(user)?.role !== "system" && kernel.users.get(user) && kernel.userspaces.exists(user) ? resolve(kernel.userspaces.pathFor(user).run, "web.sock") : undefined),
    // The door is the only thing that sees a workspace whose fence is not there, so it is the only thing
    // that can reopen one; `socketFor` has already decided that this is a person the kernel knows.
    ensure: (user) => kernel.services.ensure(user),
    loginUser: "_system",
    log,
  });
  // One promise for every way this daemon ends, resolved before anything can arm a restart: the signals an
  // operator sends, and the latch firing. `serve()` is the only place that ever handles the latch, and the
  // latch refuses to arm without a handler, so in `thetis send`, `thetis chat` and the bench a restart cannot
  // mean "kill the command". Firing resolves the same promise SIGINT does, so the shutdown path below is the
  // only shutdown path there is, and the clean exit is what `Restart=always` turns into a restart.
  let why = "a signal";
  const stopped = new Promise<void>((done) => {
    process.once("SIGINT", () => done());
    process.once("SIGTERM", () => done());
    kernel.restart.onFire((r) => {
      why = `a restart asked for by ${r.by}: ${r.reason}`;
      // `cut` names the turns that were still running: on the deadline branch somebody else's turn ended here,
      // and this row is the only place that says whose.
      kernel.journal.append({ kind: "restart.fire", actor: r.by, target: "daemon", data: { reason: r.reason, quiet: r.quiet, waitedMs: r.waitedMs, cut: r.cut } });
      print(r.quiet ? `restarting: ${r.reason}` : `restarting: ${r.reason}; ${r.cut.length} turn(s) were still running and end here: ${r.cut.join(" ")}`);
      done();
    });
  });
  try {
    await control.listen();
    await kernel.services.boot();
    await new Promise<void>((done, fail) => door.once("error", fail).listen(config.door.port, config.door.host, done));
    print(`thetis is serving; control socket ${socket}; door on http://${config.door.host}:${config.door.port}; press Ctrl+C to stop`);
    // Which secrets this daemon is running on, said out loud. The default env file belongs to the checkout,
    // not to the data directory, so a second data directory under the same checkout silently inherits the
    // real provider key -- which is how a throwaway daemon for a test came to spend money on a live account.
    // Naming the file and whether it carried a key costs one line and ends that surprise; set `envFile` in
    // the data directory's configuration to point somewhere else.
    print(`environment: ${config.envFile}${existsSync(config.envFile) ? "" : " (not there)"}`);
    // Said at startup rather than when something first needs it: whether a stopped daemon comes back is the
    // operator's fact to know, and it is decided by the deployed unit, not by anything thetis does.
    print(supervision(kernel.restartPolicy()));
    kernel.journal.append({ kind: "daemon.start", actor: "daemon", target: "daemon", data: { pid: process.pid, supervised: isSupervised(), restartPolicy: kernel.restartPolicy() } });
    await stopped;
    print("stopping");
  } finally {
    // Paired with `daemon.start`, so the record of a restart is three rows an operator can read in order:
    // the fire, this stop, and the start of the process systemd put in its place.
    kernel.journal.append({ kind: "daemon.stop", actor: "daemon", target: "daemon", data: { why } });
    // The process is going, so a restart still pending is moot; leaving it armed would outlive its own latch.
    kernel.restart.close();
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

/**
 * Whether a stopped daemon comes back, in one line at startup. The deployed unit decides it and the file in
 * this checkout does not: an installation whose `/etc/systemd/system` copy still says `on-failure` would exit
 * cleanly on a restart and stay down, so an operator is told which one they have while everything still works.
 */
function supervision(policy: string | null): string {
  if (!isSupervised()) return "not supervised: nothing will start thetis again if it stops, and `thetis restart` refuses";
  if (policy === "always") return "supervised by systemd, deployed unit says Restart=always: an exit is a restart";
  if (policy === null) return "supervised by systemd, but the deployed unit's Restart= could not be read: `thetis restart` refuses rather than risk an exit that stays down";
  return `supervised by systemd, but the deployed unit says Restart=${policy}, not always: a clean exit would stay down, so \`thetis restart\` refuses. Put Restart=always in the unit (deploy/thetis-runtime.service), then systemctl daemon-reload.`;
}

async function dispatch(call: Call, cmd: string, args: Args, shared: string): Promise<void> {
  const user = typeof args.user === "string" ? args.user : undefined;
  const need = (): string => {
    if (!user) throw new Error("--user <id> is required");
    return user;
  };
  switch (cmd) {
    case "status":
      return statusCmd(call, args);
    case "reload":
      return reloadCmd(call, args, user);
    case "restart":
      return restartCmd(call, args);
    case "users":
      return usersCmd(call, args);
    case "packages":
      return packagesCmd(call, args, user, shared);
    case "mounts":
      return mountsCmd(call, args, user);
    case "ssh":
      return sshCmd(call, args, user);
    case "config":
      return configCmd(call, args, user);
    case "publish":
      return publishCmd(call, args, user);
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

interface StatusReport {
  daemon: { startedAt: string | null; uptimeSecs: number; supervised: boolean; restartPolicy: string | null; codeAt: string | null; stale: boolean };
  restart: Pending | null;
  workspaces: { user: string; openedAt: string | null; codeAt: string | null; stale: boolean; services: string[]; changed?: { name: string; loaded: string; onDisk: string }[] }[];
}

/**
 * What is running, and whether it is the code on disk. The last column is the whole point: someone who
 * deployed and saw nothing change is told which process is still holding the code it replaced, and the
 * remedy for it — a workspace reloads, the daemon needs a new process.
 */
async function statusCmd(call: Call, args: Args): Promise<void> {
  const report = await call("status", {});
  // `--json` is for a script (the installer reads it): the answer as the kernel gave it, and nothing else.
  if (args.json === true || args.json === "true") return print(JSON.stringify(report));
  const { daemon, restart, workspaces } = report as StatusReport;
  const supervised = `${daemon.supervised ? "supervised by systemd" : "not supervised"}; ${policyOf(daemon.restartPolicy)}`;
  print(`daemon	up ${duration(daemon.uptimeSecs)} since ${daemon.startedAt ?? "unknown"}	${supervised}	${freshness(daemon.codeAt, daemon.stale)}`);
  for (const w of workspaces) {
    const fence = w.openedAt ? `open since ${w.openedAt}` : "no fence open";
    // Which packages, and from which version to which: "older than the code on disk" names neither, and a
    // package shipped with the service is installed the moment its files land, so nothing else would say it.
    const changed = w.changed?.length ? `	${w.changed.length} package${w.changed.length === 1 ? "" : "s"} changed: ${w.changed.map((c) => `${c.name} ${c.loaded} -> ${c.onDisk}`).join(", ")}` : "";
    print(`${w.user}	${fence}	${w.services.join(" ") || "no services"}	${freshness(w.codeAt, w.stale)}${changed}`);
  }
  // Said in the same words here, in `thetis restart status` and on the page: one armed restart, one sentence.
  if (restart) print(`\n${pendingLine(restart)}`);
  for (const w of workspaces) if (w.stale) print(`
${w.user} is running older code than what is on disk. Put it into service: thetis reload --user ${w.user}`);
  if (daemon.stale) print(`
the daemon is running older code than what is on disk, and only a new process picks that up: thetis restart --reason "new daemon code", or sudo systemctl restart thetis-runtime.service`);
}

/** What the deployed unit says a clean exit means: the same words wherever it is shown, and honest when unread. */
const policyOf = (policy: string | null): string => (policy ? `deployed unit says Restart=${policy}` : "the deployed unit's Restart= could not be read");

/** Whether what is running is the code on disk, in words rather than two timestamps to compare by eye. */
function freshness(codeAt: string | null, stale: boolean): string {
  if (!codeAt) return "no code on disk";
  return stale ? `older than the code on disk (newest ${codeAt})` : "the code on disk";
}

function duration(secs: number): string {
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h ${Math.floor((secs % 3600) / 60)}m`;
}

/**
 * Puts the code on disk into service. One reload replaces a whole fence, so it is that person's gateway,
 * terminal and every other service that starts again, and their open shell sessions die with the old
 * process. Sequentially, never at once: each reload spawns a sandbox and waits on its launch gate.
 */
async function reloadCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const all = args.all === true || args.all === "true";
  if (all && user) throw new Error("reload takes --user <id> or --all, not both");
  if (!all && !user) throw new Error("reload needs --user <id>, or --all for everyone");
  const targets = all ? await reloadOrder(call) : [user!];
  let failed = false;
  for (const id of targets) {
    try {
      const done = (await call("fence.reload", { user: id })) as { services: string[] };
      print(`reloaded ${id}	${done.services.join(" ") || "no services; the fence reopens on the next request"}`);
    } catch (err) {
      failed = true;
      print(`${id} did not reload: ${errorMessage(err)}
Try it again: thetis reload --user ${id}`);
    }
  }
  if (failed) process.exitCode = 1;
}

type RestartReport = RestartState & { policy: string | null };

/** What a restart ends. Said before anything is armed, because the cost falls on people who did not ask. */
const RESTART_ENDS = `A restart of the daemon ends every turn in progress, for everyone, not only yours, and every shell
session open in a terminal anywhere. It waits for turns to finish first and counts down where everyone can see it,
so nobody is cut off without warning, and it can be called off until the moment it fires.`;

/**
 * Asks the running daemon to restart itself. Nothing restarts here and nothing restarts at once: the kernel
 * arms a latch which waits for every turn to finish and then exits so that systemd starts a new process. The
 * answer is the latch's own sentence, printed as it came, so the host, the page and the model read the same
 * words about the same latch — including a refusal, which means nothing happened.
 */
async function restartCmd(call: Call, args: Args): Promise<void> {
  const sub = args._[1];
  if (sub === "status") {
    const s = (await call("restart.status", {})) as RestartReport;
    if (s.pending) print(pendingLine(s.pending));
    else print(s.armable ? "nothing is armed, and a restart would be accepted" : `nothing is armed, and a restart would be refused (${s.why})`);
    print(`daemon	up ${duration(s.uptimeSecs)}	${s.supervised ? "supervised by systemd" : "not supervised"}	${policyOf(s.policy)}`);
    return;
  }
  if (sub === "cancel") {
    const { was } = (await call("restart.cancel", {})) as { was: Pending | null };
    return print(was ? `called off the restart ${was.by} asked for: ${was.reason}` : "nothing was armed, so nothing was called off and nothing changed");
  }
  if (sub !== undefined) throw new Error(`unknown restart subcommand: ${sub}`);
  const reason = typeof args.reason === "string" && args.reason.trim() ? args.reason.trim() : "asked for at the host";
  print(RESTART_ENDS);
  if (args.yes !== true) {
    // No terminal means nobody is there to be asked, and a script that meant it can say so: `--yes`.
    if (!process.stdin.isTTY) throw new Error("thetis restart needs --yes when there is no terminal to confirm at");
    const rl = createPrompt({ input: process.stdin, output: process.stdout });
    const answer = (await rl.question(`restart thetis (${reason})? [y/N] `)).trim().toLowerCase();
    rl.close();
    if (answer !== "y" && answer !== "yes") return print("nothing was armed and nothing is going to happen");
  }
  const armed = (await call("restart.request", { reason })) as { state: string; message: string };
  print(armed.message);
  if (armed.state === "refused") process.exitCode = 1;
}

/** An armed restart in one line: what it is for, who asked, and how long there is to think better of it. */
function pendingLine(p: Pending): string {
  const when = p.firesAt === undefined ? `waiting for every turn to finish, and going anyway by ${new Date(p.deadlineAt).toISOString()}` : `counting down, fires at ${new Date(p.firesAt).toISOString()}`;
  return `a restart is armed: ${p.reason} (asked by ${p.by} at ${new Date(p.at).toISOString()}), ${when}. Call it off: thetis restart cancel`;
}

/** Everyone active, with `_system` last: it serves the sign-in page, so it blips once, at the end. */
async function reloadOrder(call: Call): Promise<string[]> {
  const ids = ((await call("users.list", {})) as UserRecord[]).filter((u) => u.status === "active").map((u) => u.id);
  return [...ids.filter((id) => id !== "_system"), ...ids.filter((id) => id === "_system")];
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
 * The grant list is replaced whole by `host.grants.sshSet`, the same way mounts are; grant and revoke read the
 * current list first and send the edited one. A grant names one key file, never a directory: a host
 * `~/.ssh` holds unrelated credentials, and granting the directory would give a fence all of them. The
 * key is read by the kernel into that fence's own agent and is never bound where the fence can reach it.
 */
async function sshCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const [, sub, id, key] = args._;
  const listOf = async (u: string) => ((await call("host.grants.sshList", { user: u })) as Record<string, SshGrantState[]>)[u] ?? [];
  if (sub === "keygen" && !id) throw new Error("ssh keygen needs <user>");
  if (sub === "import" && !(id && key)) throw new Error("ssh import needs <user> <name>, and the key on stdin");
  if (sub !== "list" && sub !== "keygen" && sub !== undefined && !(id && key)) throw new Error(`ssh ${sub} needs <user> <key-path>`);
  switch (sub) {
    case "list":
    case undefined: {
      if (user) {
        for (const g of await listOf(user)) print([user, g.key, g.fingerprint ?? "", g.present ? "" : "missing", (g.hosts ?? []).length ? `${(g.hosts ?? []).length} known host(s)` : "no known hosts"].filter(Boolean).join("\t"));
        return;
      }
      const all = (await call("host.grants.sshList", {})) as Record<string, SshGrantState[]>;
      for (const [u, list] of Object.entries(all)) for (const g of list) print([u, g.key, g.fingerprint ?? "", g.present ? "" : "missing"].filter(Boolean).join("\t"));
      return;
    }
    case "grant": {
      // Known hosts are part of the grant because a key with no vouched-for host cannot connect to
      // anything: StrictHostKeyChecking is on inside the fence, and there is nobody there to answer a
      // prompt. `--host` may be given more than once, and `--scan` fetches the lines with ssh-keyscan.
      const hosts = await knownHostLines(args);
      const ssh = [...(await listOf(id)).filter((g) => g.key !== key), { key, ...(hosts.length ? { hosts } : {}) }];
      const after = (await call("host.grants.sshSet", { user: id, ssh })) as SshGrantState[];
      const granted = after.find((g) => g.key === key);
      if (granted && granted.present === false) throw new Error(`${key} is written down for ${id}, but there is no such file on the host: the fence opens without an agent. Fix the path.`);
      if (!hosts.length) print(`warning: no known hosts for ${key}; add --host <name> or --scan <name>, or ssh will refuse every connection`);
      return print(`granted ${key} to ${id}; the fence reopens with an agent holding it`);
    }
    case "keygen": {
      // No host credential to lend, and none needed: this fence gets a key of its own, already granted.
      // The private half stays with the kernel, so it is agent-held like any other grant.
      const hosts = await knownHostLines(args);
      const made = (await call("host.grants.sshKeygen", { user: id, ssh: [{ key: "/generated", hosts }] })) as MadeKey;
      print(made.publicKey);
      print(`granted ${made.key} to ${id}${made.fingerprint ? ` (${made.fingerprint})` : ""}; register the line above wherever it is going`);
      if (!hosts.length) print(`warning: no known hosts; add --host <name> or --scan <name>, or ssh will refuse every connection`);
      return;
    }
    case "import": {
      // A key the person already has: the material goes over the control socket once and the kernel keeps
      // it beside the generated ones; it never touches this shell's history or the journal.
      if (process.stdin.isTTY) throw new Error("ssh import reads the private key from stdin: thetis ssh import <user> <name> < key");
      const hosts = await knownHostLines(args);
      const privateKey = await readStdin();
      const made = (await call("host.grants.sshImport", { user: id, name: key, privateKey, hosts })) as MadeKey;
      print(made.publicKey);
      print(`granted ${made.key} to ${id}${made.fingerprint ? ` (${made.fingerprint})` : ""}; the fence reopens with an agent holding it`);
      if (!hosts.length) print(`warning: no known hosts; add --host <name> or --scan <name>, or ssh will refuse every connection`);
      return;
    }
    case "revoke": {
      const before = await listOf(id);
      const ssh = before.filter((g) => g.key !== key);
      if (ssh.length === before.length) throw new Error(`${key} is not granted to ${id}`);
      await call("host.grants.sshSet", { user: id, ssh });
      return print(`revoked ${key} for ${id}; the fence reopens without it`);
    }
    default:
      throw new Error(`unknown ssh subcommand: ${sub}`);
  }
}

/** The known_hosts lines for a grant: those given with --host, plus those ssh-keyscan finds for --scan. */
async function knownHostLines(args: Args): Promise<string[]> {
  const named = [args.host].flat().filter((h): h is string => typeof h === "string" && h.length > 0);
  const scan = [args.scan].flat().filter((h): h is string => typeof h === "string" && h.length > 0);
  const lines = [...named];
  for (const host of scan) {
    const run = spawnSync("ssh-keyscan", [host], { encoding: "utf8" });
    if (run.status !== 0) throw new Error(`ssh-keyscan ${host} failed: ${(run.stderr ?? "").trim()}`);
    for (const line of run.stdout.split("\n").map((l) => l.trim())) if (line && !line.startsWith("#")) lines.push(line);
  }
  return [...new Set(lines)];
}

/**
 * The mount list is replaced whole by `host.grants.mountsSet`; add and remove read the current list first and send
 * the edited one. Every line says whether the host still holds the directory, because a mount whose path
 * is gone is skipped when the fence opens, and a silent skip is how a person finds out too late.
 */
async function mountsCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const [, sub, id, path] = args._;
  const listOf = async (u: string) => ((await call("host.grants.mountsList", { user: u })) as Record<string, MountState[]>)[u] ?? [];
  if (sub !== "list" && sub !== "browse" && sub !== undefined && !(id && path)) throw new Error(`mounts ${sub} needs <user> <path>`);
  switch (sub) {
    case "list":
    case undefined: {
      const all = (await call("host.grants.mountsList", { user })) as Record<string, MountState[]>;
      for (const [u, list] of Object.entries(all)) for (const m of list) print([u, m.path, m.mode, stateOf(m)].filter(Boolean).join("\t"));
      return;
    }
    case "browse": {
      const listing = (await call("host.grants.mountsBrowse", { path: id ?? "/" })) as { path: string; kind: string; readable: boolean; entries: { path: string }[] };
      if (!listing.readable) throw new Error(`${listing.path} is ${listing.kind === "none" ? "not there" : listing.kind === "file" ? "not a directory" : "not readable"}`);
      for (const e of listing.entries) print(e.path);
      return;
    }
    case "add": {
      const mode = args.ro ? "ro" : "rw";
      const mounts = [...(await listOf(id)).map((m) => ({ path: m.path, mode: m.mode })).filter((m) => m.path !== path), { path, mode }];
      const after = (await call("host.grants.mountsSet", { user: id, mounts })) as MountState[];
      const bound = after.find((m) => m.path === path);
      if (bound && bound.present === false) throw new Error(`${path} is written down for ${id}, but the host has ${bound.kind === "file" ? "a file" : "nothing"} there: the fence opens without it. Fix the path, or make the directory.`);
      return print(`mounted ${path} (${mode}) for ${id}; the fence reopens with it`);
    }
    case "remove": {
      const before = await listOf(id);
      const mounts = before.filter((m) => m.path !== path);
      if (mounts.length === before.length) throw new Error(`${path} is not mounted for ${id}`);
      await call("host.grants.mountsSet", { user: id, mounts });
      return print(`unmounted ${path} for ${id}`);
    }
    default:
      throw new Error(`unknown mounts subcommand: ${sub}`);
  }
}

/**
 * One package's configuration, key by key. A secret shows as `•••`: the kernel never sends the value, and
 * the command never asks. The summary sentence comes first, because it is the one line that says whether
 * the package can work.
 */
function showReport(r: ConfigReport): void {
  print(`${r.package}${r.user ? ` (${r.user})` : ""}${r.inherits.length ? `, inherits ${r.inherits.join(" < ")}` : ""}: ${r.summary}`);
  for (const k of r.keys) {
    const value = k.value !== undefined ? JSON.stringify(k.value) : k.state === "set" ? "•••" : "";
    const cells = [k.key, k.state, value, k.source ?? "", k.inheritedFrom ?? "", (k.missing ?? []).join(" ")];
    print(`  ${cells.join("\t")}`);
  }
}

/**
 * The configuration commands: what is set, and setting it. A value is one argument, `--json` for anything
 * that is not a string, and `--stdin` for a secret, so that it never lands in the shell's history.
 */
async function configCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const [, sub, name, key, ...rest] = args._;
  switch (sub) {
    case "show": {
      if (name) return showReport((await call("config.show", { name, user })) as ConfigReport);
      const reports = (await call("config.list", { user })) as ConfigReport[];
      // The packages that cannot work come first: they are what the listing is for.
      for (const r of [...reports].sort((a, b) => Number(b.broken) - Number(a.broken))) print(`${r.broken ? "!" : " "} ${r.package}\t${r.summary}`);
      return;
    }
    case "set": {
      if (!name || !key) throw new Error("config set needs <package> <key>");
      // `--json` right before the value swallows it as its argument; that is still the value.
      const text = args.stdin === true ? await readStdin() : rest.length ? rest.join(" ") : typeof args.json === "string" ? args.json : undefined;
      if (text === undefined) throw new Error("config set needs a <value>, or --stdin to read it from stdin");
      const value: unknown = args.json ? JSON.parse(text) : text;
      const r = (await call("config.set", { name, key, value, user })) as ConfigReport;
      const state = r.keys.find((k) => k.key === key);
      return print(`${name}${user ? ` (${user})` : ""}: ${key} is ${state?.state ?? "unset"}; ${r.summary}`);
    }
    case "unset": {
      if (!name || !key) throw new Error("config unset needs <package> <key>");
      const r = (await call("config.unset", { name, key, user })) as ConfigReport;
      return print(`${name}${user ? ` (${user})` : ""}: ${key} cleared; ${r.summary}`);
    }
    case "reload": {
      const r = (await call("config.reload", {})) as { changed: string[]; restarted: { user: string; package: string }[]; dispatch: string[]; fence: string[]; boot: string[] };
      print(r.changed.length ? `changed: ${r.changed.join(", ")}` : "nothing changed in the file");
      for (const s of r.restarted) print(`restarted ${s.package} for ${s.user}`);
      if (r.dispatch.length) print(`live now: ${r.dispatch.join(", ")}`);
      if (r.fence.length) print(`applied by reopening every fence: ${r.fence.join(", ")}`);
      // Said last and said plainly. A reload that looked like it worked while quietly doing nothing for
      // these keys is the thing this line exists to prevent.
      if (r.boot.length) print(`NOT applied -- these are read once at startup and need a daemon restart: ${r.boot.join(", ")}`);
      return;
    }
    default:
      throw new Error(`unknown config subcommand: ${sub}`);
  }
}

/** What `@thetis/package-publish` answers. Kept here as a shape and not as a dependency: see `publishCmd`. */
interface PublishAnswer {
  ok: boolean;
  dryRun: boolean;
  package: string;
  from: string;
  mode: string;
  target: string;
  url: string;
  branch: string;
  directory: string;
  repo: string;
  was: string | null;
  now: string;
  first: boolean;
  files: string[];
  /** The packages that rode along on the branch, each a publish of its own. */
  with?: { package: string; was: string | null; now: string; files: string[] }[];
  /** The publishable passengers a dry run could still be told to take. */
  nameable?: string[];
  author: string;
  commit: string | null;
  committed: boolean;
  pushed: boolean;
  summary: string;
  /** Only on a dry run: the gates about the state of the tree, reported instead of thrown. */
  blockers?: { code: string; message: string }[];
}

const PUBLISH_PACKAGE = "@thetis/package-publish";

/**
 * `thetis publish`: the same act the `publish_package` tool performs, run from a terminal so that the
 * person who maintains the packages does not need a chat window to ship one. It goes through the package's
 * own code and decides nothing of its own; what it supplies is the environment, because the command line
 * is not a fence. The operator's home, shell and ssh agent stand in for the fence's, which is the right
 * identity: the maintainer publishing from their checkout is the operator, and theirs is the key the
 * registry knows.
 */
async function publishCmd(call: Call, args: Args, user: string | undefined): Promise<void> {
  const name = opt(args._[1]);
  if (!name) throw new Error("publish needs a package: thetis publish <package> --to <target> [--version <v> | --bump patch|minor|major] [--dry-run]");
  // The specifier is held in a variable on purpose. The package is plain ECMAScript with no build and no
  // declarations, so a literal import would ask the compiler for types that do not exist, and the command
  // line is not going to grow a copy of them. A package that is not there is one sentence, not a stack.
  const specifier = PUBLISH_PACKAGE;
  let mod: { publish: (a: Record<string, unknown>, e: unknown) => Promise<PublishAnswer> };
  try {
    mod = await import(specifier);
  } catch {
    throw new Error(`thetis publish needs ${PUBLISH_PACKAGE}, which is not in this installation's packages directory.`);
  }
  // The configuration comes from the kernel, so the command line and the fence read one set of targets.
  const report = (await call("config.show", { name: PUBLISH_PACKAGE, user })) as ConfigReport;
  const config = Object.fromEntries(report.keys.filter((k) => k.state === "set").map((k) => [k.key, k.value]));
  const answer = await mod.publish(
    { package: name, to: opt(args.to), version: opt(args.version), bump: opt(args.bump), message: opt(args.message), with: list(args.with), dryRun: args["dry-run"] === true || args.dryRun === true },
    publishEnv(call, user, config),
  );
  print(answer.summary);
  // A dry run reports the two gates about the surrounding tree rather than throwing, so they are printed
  // here and the exit code says the publish would not go: a script asking "would this publish?" is asking
  // a yes or no question and should not have to parse the sentence to learn the answer.
  for (const blocker of answer.blockers ?? []) print(`refused\t${blocker.code}\t${blocker.message}`);
  if (answer.ok === false) process.exitCode = 1;
  print(`package\t${answer.package}\t${answer.was ?? "(not held)"} -> ${answer.now}${answer.first ? "\tfirst publish" : ""}`);
  print(`target\t${answer.target}\t${answer.url}\t${answer.branch}`);
  print(`tree\t${answer.repo}\t${answer.directory}/\t${answer.mode}`);
  if (answer.commit) print(`commit\t${answer.commit}\t${answer.author}`);
  for (const file of answer.files) print(`${answer.dryRun ? "would send" : "sent"}\t${file}`);
  // Each package that rode along on the branch, as its own publish, because that is what it was.
  for (const also of answer.with ?? []) print(`${answer.dryRun ? "would send" : "sent"}\t${also.package}\t${also.was ?? "(not held)"} -> ${also.now}\t${also.files.length} file(s)`);
  for (const name of answer.dryRun ? (answer.nameable ?? []) : []) if (!(answer.with ?? []).some((w) => w.package === name)) print(`could add\t${name}\t--with ${name}`);
}

/** A flag's value when it is a string worth having, and undefined when it is a bare `--flag` or missing. */
const opt = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);

/** A flag given none, once or many times, as a list. */
const list = (v: unknown): string[] => [v].flat().filter((x): x is string => typeof x === "string" && x.trim().length > 0);

/**
 * The environment `@thetis/package-publish` expects, built out of what a host process has. It is the
 * fence's `ToolEnv` minus one field: there is no store on this side of the control socket, so a publish
 * made from the command line keeps no record of itself. Everything that record would have held is in the
 * answer, which is printed.
 */
function publishEnv(call: Call, user: string | undefined, config: Record<string, unknown>) {
  const home = process.env.HOME ?? process.cwd();
  return {
    cwd: home,
    root: home,
    shared: home,
    config,
    exec: (cmd: string, opts: { cwd?: string; timeoutMs?: number; env?: Record<string, string> } = {}) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((res) => {
        cpExec(cmd, { cwd: opts.cwd ? resolve(home, opts.cwd) : home, env: { ...process.env, ...(opts.env ?? {}) }, timeout: opts.timeoutMs ?? 120_000, maxBuffer: 16 * 1024 * 1024, shell: "/bin/bash" }, (err, stdout, stderr) => {
          const code = err && typeof (err as { code?: unknown }).code === "number" ? (err as { code: number }).code : err ? 1 : 0;
          res({ code, stdout: String(stdout), stderr: String(stderr) + (err && !stderr ? `\n${(err as Error).message}` : "") });
        });
      }),
    readFile: (p: string) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p: string, content: string) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    kernel: { packages: { list: () => call("packages.list", { user }) } },
  };
}

/** Moves the legacy record files into the store. Runs against the files directly, so the daemon must be stopped first. */
async function migrateCmd(config: KernelConfig): Promise<void> {
  const { imported, skipped } = await migrateStore(config, (line) => process.stderr.write(line + "\n"));
  for (const [file, n] of Object.entries(imported)) print(`imported ${n} record(s) from ${file}; it is now ${file}.migrated`);
  if (skipped.length) print(`not there, so nothing to import: ${skipped.join(", ")}`);
  if (!Object.keys(imported).length) print("nothing to migrate");
}

/**
 * What an installation is behind on. Nothing updates on its own: the index says what is latest, the record
 * says what is installed, and this compares them so a person can decide.
 */
async function outdatedIn(call: Call, target: string, shared: string): Promise<Behind[]> {
  return (await standingIn(call, target, shared)).behind;
}

/**
 * The marketplace index. It is a file the marketplace service writes into the shared directory. The command
 * line is a host process and reads it there; asking the kernel would mean teaching the kernel where the
 * marketplace keeps its things, which is exactly the sort of opinion it does not hold.
 */
const marketplaceIndex = (shared: string) => readIndex({ shared, readFile: async (at: string) => readFileSync(at, "utf8"), writeFile: async () => {} });

/**
 * Where a userspace stands, both ways round, off one read of the list and one of the index. `behind` is
 * what it is missing. `ahead` is the other direction: what is newer here than anywhere else, which nothing
 * in this tool has ever said. Whoever maintains these packages runs them from the same checkout that every
 * fence loads, so a version bump is live here the moment it lands while the registry other installations
 * read still holds the old one.
 */
async function standingIn(call: Call, target: string, shared: string): Promise<{ installed: PackageInfo[]; behind: Behind[]; ahead: Ahead[] }> {
  const installed = (await call("packages.list", { user: target })) as PackageInfo[];
  const index = await marketplaceIndex(shared);
  return { installed, behind: behind(installed, index), ahead: ahead(installed, index) };
}

/** Unpublished work, in one clause, wherever a package is named. Empty for a package the registries have caught up with. */
const aheadNote = (a: Ahead | undefined): string => {
  if (!a) return "";
  return a.state === "unpublished" ? "\tnever published" : `\t${a.version} here, ${a.published} published in ${a.registry}`;
};

/**
 * What a fork is, in one clause, wherever a package is named. Said plainly and in the stronger form when it
 * holds, because "identical to what is shipped" is the sentence that makes a person act and "forked from"
 * on its own is the sentence they have been reading for months while the fixes went past them.
 */
function forkLine(b: Behind): string {
  return b.identical ? `identical to ${b.origin}@${b.available}, which is shipped` : `forked from ${b.origin}@${b.installed}; ${b.available} is shipped now`;
}

const forkNote = (fork: PackageInfo["fork"]): string => {
  if (!fork) return "";
  // The origin is what everyone on this host gets. An operator looking down a list of people is the one
  // most likely to be wondering why this person is not among them, and this is the answer.
  const everyone = fork.everyone ? "; everyone else gets it" : "";
  if (fork.identical && fork.shipped) return `\tidentical to ${fork.name}@${fork.shipped}, which is shipped${everyone}`;
  if (fork.shipped && fork.shipped !== fork.version) return `\tforked from ${fork.name}@${fork.version}; ${fork.shipped} is shipped now${everyone}`;
  return `\tforked from ${fork.name}@${fork.version}${everyone}`;
};

async function packagesCmd(call: Call, args: Args, user: string | undefined, shared: string): Promise<void> {
  const [, sub, source] = args._;
  const target = user ?? "_system";
  switch (sub) {
    case "list":
    case undefined: {
      // A fork prints what it was copied from and how that package stands now. A listing that says only
      // `@someone/gateway-web@0.1.1-fork.1` is the whole problem: nothing in it says the shipped gateway
      // has moved on, or that this copy changed nothing and is costing its owner every fix for free.
      // Unpublished work prints the same way and for the same reason: a version on disk that no registry
      // has is invisible in every listing there has ever been, and the person holding it is the one person
      // who could publish it.
      const standing = await standingIn(call, target, shared);
      const unshared = new Map(standing.ahead.map((a) => [a.name, a]));
      for (const p of standing.installed) print(`${p.name}@${p.version}\t${p.type}\t${p.root}${forkNote(p.fork)}${aheadNote(unshared.get(p.name))}`);
      return;
    }
    case "install": {
      const info = (await call("packages.install", { user: target, source, actor: "_system" })) as PackageInfo;
      return print(`installed ${info.name}@${info.version} (${info.type}) in ${target}`);
    }
    case "uninstall":
      await call("packages.uninstall", { user: target, name: source });
      return print(`uninstalled ${source} from ${target}`);
    case "unfork": {
      if (!source) throw new Error("packages unfork needs <name>");
      const info = (await call("packages.unfork", { user: target, name: source, deleteFiles: args["delete-files"] === true })) as PackageInfo;
      print(`${source} is no longer installed in ${target}; ${info.name}@${info.version} is back in its place`);
      return print(args["delete-files"] === true ? `the fork's files were deleted` : `the fork's files were kept; delete them with: thetis packages unfork ... --delete-files, or by hand`);
    }
    case "promote": {
      const r = (await call("packages.promote", { user: target, name: source })) as { name: string; userspaces: string[]; forks?: { user: string; fork: string }[] };
      print(`promoted ${source} to ${r.name}; installed in ${r.userspaces.join(", ")}`);
      // Anyone holding a fork of it keeps their fork: see PackageManager.displace. Said here because the
      // line above is otherwise read as "everyone", and the whole point of promoting is that it is everyone.
      if (r.forks?.length) print(`not installed for ${r.forks.map((f) => `${f.user} (holding ${f.fork})`).join(", ")}: their fork of it stays in place`);
      return;
    }
    case "outdated": {
      const { behind: out, ahead: unshared } = await standingIn(call, target, shared);
      if (!out.length && !unshared.length) return print(`nothing in ${target} is behind its registry or the code on disk, and nothing here is newer than the registries hold`);
      if (!out.length) print(`nothing in ${target} is behind its registry or the code on disk`);
      for (const b of out) {
        if (b.apply === "reload") print(`${b.name}\tloaded ${b.installed}, ${b.available} on disk\tthetis reload --user ${target}`);
        else if (b.apply === "unfork") print(`${b.name}\t${forkLine(b)}\tthetis packages unfork ${b.name}${user ? ` --user ${user}` : ""}`);
        else print(`${b.name}\t${b.version}\t${shortCommit(b.installed)} -> ${shortCommit(b.available)}\t${b.registry}`);
      }
      if (out.some((b) => b.apply === "install")) print(`\nrun: thetis packages update${user ? ` --user ${user}` : ""} [<name>]`);
      // Ahead rows carry no command of their own on the row, because unlike an update there is nothing to
      // apply here -- the change is already in service; what is missing is that anyone else can have it.
      // The line under them names the one command that closes the gap.
      if (unshared.length) {
        print(`\n${unshared.length} package${unshared.length === 1 ? " is" : "s are"} newer in ${target} than the registries hold, or not published at all:`);
        for (const a of unshared) print(`${a.name}${aheadNote(a)}`);
        print(`\nrun: thetis publish <package> [--to <target>] [--bump patch|minor|major], or use Publish on the package's page in the Marketplace`);
      }
      return;
    }
    case "update": {
      const all = await outdatedIn(call, target, shared);
      // A reload row has nothing to install: the code on disk is already the installed copy, and only a
      // reload of the workspace puts it into service.
      const out = all.filter((b) => b.apply === "install");
      const wanted = source ? out.filter((b) => b.name === source) : out;
      if (source && !wanted.length) {
        if (all.some((b) => b.name === source)) throw new Error(`${source} is not behind its registry in ${target}: it is behind the code on disk, so run thetis reload --user ${target}`);
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
  // A reasoning model can spend most of a turn thinking, and a terminal has no fold to put that in. So the
  // default says it is happening and no more, and `-v` streams it dimmed, the way `-v` streams the steps.
  // Either way it is closed off the moment anything else arrives, so thinking never reads as the answer.
  let thinking = false;
  const settle = () => {
    if (!thinking) return;
    thinking = false;
    process.stdout.write("\n");
  };
  await call("sessions.send", { user, session, input }, (raw) => {
    const e = raw as TurnEvent;
    switch (e.type) {
      case "reasoning":
        if (verbose) process.stdout.write(dim(e.delta));
        else if (!thinking) process.stdout.write(dim("[thinking…]"));
        thinking = true;
        break;
      case "text":
        settle();
        process.stdout.write(e.delta);
        break;
      case "tool.call":
        settle();
        process.stdout.write(`\n${dim(`[tool ${e.call.name}] ${JSON.stringify(e.call.args).slice(0, 400)}`)}\n`);
        break;
      case "tool.result":
        process.stdout.write(dim(`[${e.name} -> ${e.result.replace(/\s+/g, " ").slice(0, 300)}]`) + "\n");
        break;
      case "message":
        settle();
        if (e.usage) process.stdout.write(`\n${dim(usageLine(e.usage))}\n`);
        break;
      case "error":
        settle();
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
  return readStdin().then((data) => data.split("\n")[0] ?? "");
}

/** All of stdin, without the one newline an editor or `echo` leaves at the end. */
function readStdin(): Promise<string> {
  return new Promise((done) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => done(data.replace(/\n$/, "")));
  });
}

function parse(argv: string[]): Args {
  const out: Args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      const value: string | boolean = next !== undefined && !next.startsWith("--") ? (i++, next) : true;
      // A flag given twice is both values, not the second one. `--host`, `--scan` and `--with` are all
      // meant to repeat, and `knownHostLines` has always read `[args.host].flat()` as though this were
      // already true; it was not, and the first `--host` of a pair was being dropped without a word.
      const had = out[key];
      out[key] = had === undefined ? value : ([] as string[]).concat(had as string[], value as string);
    } else out._.push(a);
  }
  return out;
}

/** The file's variables into the process, for the daemon's own use. A name the shell already set keeps the shell's value. */
function loadDotEnv(file: string): void {
  if (!existsSync(file)) return;
  for (const [name, value] of Object.entries(parseDotEnv(readFileSync(file, "utf8")))) {
    if (process.env[name] === undefined) process.env[name] = value;
  }
}

function print(s: string): void {
  process.stdout.write(s + "\n");
}

/**
 * `thetis packages list | head` is what anybody does with a long listing, and `head` closing the pipe
 * used to kill the process with an unhandled EPIPE and a stack trace, as though the command had failed.
 * It had not: the reader stopped reading, which is the reader's business. Exit quietly instead. Every
 * other write error is left alone, because those are real.
 */
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") process.exit(0);
  throw err;
});
