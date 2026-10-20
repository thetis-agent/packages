// The inner runner: one run of a trial, inside its own user, mount and pid namespace (the outer starts it
// as `unshare --user --map-root-user --mount --propagation private --pid --fork --kill-child --mount-proc
// -- node lib/inner.js <run spec>`). Before anything else it isolates itself (isolate.js) and waits for the
// outer to confirm, from outside, that nothing it wrote is visible there. Then it builds the real Thetis
// from the real configuration, read through the overlay, with:
//   - the person's fence: bwrap, no network, no docker; the system fence (the provider) keeps the
//     configured network, since the model call is made from there;
//   - no ssh grants, no cgroups, no host packages, and no services but @thetis/terminal and @thetis/browser;
//   - no gateway and no control socket: `serve()` is never called.
// It applies the arm's change, runs the request, accounts its cost, and prints what the outer writes into
// the real trial directory. When it exits, the namespace and every write in it are gone.
import { mkdirSync, readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createAccount } from "./accounting.js";
import { applyChange, assignProject } from "./change.js";
import { isolate } from "./isolate.js";
import { line } from "./protocol.js";
import { safeList, safeRead } from "./safe-fs.js";

const SYSTEM_USER = "_system";
const SERVICES = new Set(["@thetis/terminal", "@thetis/browser"]);
const UNSET = ["SSH_AUTH_SOCK", "DOCKER_HOST", "XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"];
const SESSION = /^s_[a-f0-9]+$/;

const emit = (msg) => process.stdout.write(line(msg));
const log = (text) => process.stderr.write(`${text}\n`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** The lines from the outer runner on stdin, as a queue of waiters and a cancel hook. */
function control(onCancel) {
  let go;
  const ready = new Promise((r) => (go = r));
  createInterface({ input: process.stdin }).on("line", (text) => {
    let msg;
    try {
      msg = JSON.parse(text);
    } catch {
      return;
    }
    if (msg?.go) go(true);
    if (msg?.cancel) {
      go(false);
      onCancel(String(msg.cancel));
    }
  });
  process.stdin.on("end", () => {
    go(false);
    onCancel("cancelled");
  });
  return ready;
}

async function main(specPath) {
  const spec = JSON.parse(readFileSync(specPath, "utf8"));
  for (const k of UNSET) delete process.env[k];
  // Nothing but this process's protocol lines may reach stdout: a package that logs with console.log on the
  // host side would otherwise land in the middle of them.
  console.log = (...a) => console.error(...a);
  console.info = console.log;

  let stopped = null;
  let stopHook = () => {};
  const ready = control((why) => {
    if (stopped) return;
    stopped = why === "timeout" || why === "budget" ? why : "cancelled";
    stopHook();
  });

  let isolation;
  try {
    let dockerSocket;
    try {
      dockerSocket = JSON.parse(readFileSync(resolve(spec.home, "thetis.config.json"), "utf8"))?.fence?.dockerSocket;
    } catch {
      // no file, or none set
    }
    isolation = await isolate({ ...spec, dockerSockets: typeof dockerSocket === "string" ? [dockerSocket] : [] });
  } catch (e) {
    emit({ type: "fail", error: `the trial could not isolate itself: ${e?.message ?? e}`, isolation: true });
    return 1;
  }
  spec.overlays = isolation.overlays;
  emit({ type: "isolated", ...isolation });
  if (!(await ready)) {
    emit({ type: "end", state: stopped ?? "cancelled", costUsd: 0, tokens: 0 });
    return 0;
  }
  return run(spec, () => stopped, (fn) => (stopHook = fn), (why) => {
    if (!stopped) stopped = why;
  });
}

async function run(spec, stoppedWhy, onStop, stop) {
  // A home for whatever host-side code writes under $HOME, inside the overlay with everything else.
  process.env.HOME = resolve(spec.home, "trials", spec.trial, "home");
  mkdirSync(process.env.HOME, { recursive: true });

  const imp = (rel) => import(pathToFileURL(resolve(spec.root, "dist/src", rel)).href);
  let kernel;
  try {
    const rt = await imp("index.js");
    const km = await imp("kernel/index.js");
    const sandbox = await imp("sandbox/index.js");
    const config = rt.loadConfig(spec.home, spec.root, process.env);
    if (config.fence.sandbox === "none") throw new Error("trials need the bwrap sandbox, and fence.sandbox is none");
    const systemNetwork = config.fence.network;
    config.fence = { ...config.fence, sandbox: "bwrap", network: "none", docker: "off" };
    delete config.fence.dockerSocket;
    config.control = { ...config.control, allowRestart: false };
    kernel = await rt.createKernel(config, (c) => configure(c, rt.T, km, sandbox, config, systemNetwork));
  } catch (e) {
    emit({ type: "fail", error: `the trial kernel could not start: ${e?.message ?? e}`, isolation: false });
    return 1;
  }

  const user = spec.user;
  const account = createAccount();
  let firstError = null;
  let session = null;
  const watcher = new AbortController();
  try {
    const record = kernel.users.authorize(user);
    // The grants the overlays were made for must be the grants the fence will bind.
    for (const who of [user, SYSTEM_USER]) {
      for (const m of kernel.mounts.get(who)) {
        if (m.mode !== "rw") continue;
        const real = realOrNull(m.path);
        if (real && !isolationCovers(spec, real)) {
          emit({ type: "fail", error: `the read-write mount ${m.path} was granted after the trial was queued; start the trial again`, isolation: true });
          return 1;
        }
      }
    }
    const us = kernel.sessions.userspaceFor(record);
    log(`[trial] ${spec.arm}-${spec.n}: ${await applyChange(kernel, user, us.home, spec.change)}`);

    const ref = kernel.sessions.create(user);
    session = ref.id;
    emit({ type: "session", id: session });
    if (spec.project) assignProject(us.home, session, spec.project);

    let reported = 0;
    const progress = (force) => {
      if (!force && Date.now() - reported < 500) return;
      reported = Date.now();
      emit({ type: "progress", costUsd: account.costUsd, tokens: account.tokens });
    };
    const cut = () => kernel.sessions.cancelAll(user, stoppedWhy() === "cancelled" ? "stop" : "budget").catch(() => {});
    onStop(cut);
    void kernel.sessions.watch(user, (m) => {
      if (!account.add(m.session, m.event)) return;
      progress(false);
      if (account.costUsd >= spec.budgetUsd) {
        stop("budget");
        cut();
      }
    }, watcher.signal);
    const deadline = setTimeout(() => {
      stop("timeout");
      cut();
    }, spec.minutes * 60_000);

    if (!stoppedWhy()) {
      for await (const e of kernel.sessions.send(user, session, spec.request.text, { model: spec.model })) {
        if (e.type === "error" && !firstError && !stoppedWhy()) firstError = e.message || "the turn failed without saying why";
      }
      // A subagent may still be working after the turn that spawned it ended.
      while (kernel.sessions.inFlight().length && !stoppedWhy()) await sleep(250);
    }
    if (stoppedWhy()) await kernel.sessions.cancelAll(user, stoppedWhy() === "cancelled" ? "stop" : "budget");
    clearTimeout(deadline);
    progress(true);
  } catch (e) {
    firstError ??= e?.message ?? String(e);
  } finally {
    watcher.abort();
  }

  try {
    if (session) await copyOut(kernel, user, session);
  } catch (e) {
    log(`[trial] copying the run out failed: ${e?.message ?? e}`);
    firstError ??= `copying the run out failed: ${e?.message ?? e}`;
  }
  const state = stoppedWhy() ?? (firstError ? "failed" : "done");
  emit({ type: "end", state, ...(firstError && state === "failed" ? { error: firstError } : {}), costUsd: account.costUsd, tokens: account.tokens });
  await Promise.race([kernel.shutdown().catch(() => {}), sleep(10_000)]);
  return 0;
}

/** The rebinding that makes the real kernel a trial kernel. */
function configure(c, T, km, sandbox, config, systemNetwork) {
  c.bind(T.log, () => log);
  // No ssh grant reaches any fence: no agent, no repository key.
  c.bind(T.ssh, () => ({ get: () => [], all: () => ({}), set: () => {} }));
  // The cgroup tree is the daemon's: a trial creating groups in it could disturb the real fences.
  c.bind(T.cgroups, () => undefined);
  // A host package acts on the host itself (grants, updates, configuration) and has no business in a trial.
  c.bind(T.hosts, () => ({
    call: async (name, method) => {
      throw Object.assign(new Error(`host.${name}.${method} is not available inside a trial`), { code: "unauthorized" });
    },
    selfExports: () => [],
  }));
  const fence = (settings) =>
    new sandbox.ProcessFence({
      agentPath: config.agentPath,
      fence: settings,
      sharedDir: config.sharedDir,
      resolvConf: resolve(config.home, "fence-resolv.conf"),
      sshDir: resolve(config.home, "fence-ssh"),
      cgroups: () => undefined,
      requestTimeoutMs: () => config.requestTimeoutMs,
      log,
    });
  const person = fence(config.fence);
  const system = fence({ ...config.fence, network: systemNetwork === "none" ? "none" : systemNetwork });
  c.bind(T.fence, () => ({ open: (us, rpc) => (us.id === SYSTEM_USER ? system : person).open(us, rpc) }));
  class TrialServices extends km.ServiceSupervisor {
    constructor(...args) {
      super(...args);
      // Armed without `boot()`, which would open every person's fence: only this person's opens, when the run needs it.
      this.enabled = true;
    }
    async boot() {}
    async opened(us, handle) {
      for (const pkg of this.packages.installed(us)) if (SERVICES.has(pkg.name) && pkg.thetis.service) await this.start(us, pkg, handle);
    }
    async installed(us, pkg) {
      if (SERVICES.has(pkg.name)) await super.installed(us, pkg);
    }
    async restart(id, name) {
      if (SERVICES.has(name)) await super.restart(id, name);
    }
  }
  c.bind(T.services, (c) => new TrialServices(c.get(T.settings), c.get(T.users), c.get(T.userspaces), c.get(T.packages), c.get(T.fences), c.get(T.log), c.get(T.journal)));
}

function realOrNull(path) {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** Whether a real path lies under one of the overlays this run made. */
function isolationCovers(spec, real) {
  return (spec.overlays ?? []).some((o) => real === o || real.startsWith(o + "/"));
}

/** The session and every descendant, inspected, then the harness files each left, as file lines. */
async function copyOut(kernel, user, root) {
  const all = kernel.sessions.list(user);
  const ids = [root];
  for (let i = 0; i < ids.length; i++) for (const s of all) if (s.parent === ids[i] && !ids.includes(s.id)) ids.push(s.id);
  emit({ type: "file", path: "record.json", content: JSON.stringify(kernel.sessions.inspect(user, root), null, 2) + "\n" });
  for (const id of ids.slice(1)) emit({ type: "file", path: `children/${id}.json`, content: JSON.stringify(kernel.sessions.inspect(user, id), null, 2) + "\n" });
  // Every fence stops before its files are read, so nothing in one can change them meanwhile.
  await kernel.fences.close();
  const home = kernel.userspaces.pathFor(user).home;
  for (const id of ids.filter((s) => SESSION.test(s))) {
    const turns = safeRead(home, `harness-core/turns/${id}.jsonl`);
    if (turns !== null) emit({ type: "file", path: `harness/turns/${id}.jsonl`, content: turns });
    for (const f of safeList(home, `harness-core/snapshots/${id}`)) {
      if (f.dir) continue;
      try {
        const text = safeRead(home, `harness-core/snapshots/${id}/${f.name}`);
        if (text !== null) emit({ type: "file", path: `harness/snapshots/${id}/${f.name}`, content: text });
      } catch (e) {
        log(`[trial] skipped harness-core/snapshots/${id}/${f.name}: ${e?.message ?? e}`);
      }
    }
  }
}

const code = await main(process.argv[2]).catch((e) => {
  emit({ type: "fail", error: `the trial runner failed: ${e?.message ?? e}`, isolation: false });
  return 1;
});
// Let stdout drain before the namespace goes.
process.stdout.write("", () => process.exit(code));
