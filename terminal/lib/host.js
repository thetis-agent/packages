// The session table and the socket that is the seam between the two processes in a person's fence.
//
// A tool runs in the userspace agent process; a `ui` command runs in the gateway process. Two processes,
// one fence, one filesystem, and no shared module state to hold sessions in — `loadExport` imports with a
// modification-time query, so even inside one process a reinstall hands a tool a different module instance
// from the service. A unix socket under the userspace root is the only place they can meet, and
// `@thetis/gateway-web` already proved the pattern with `run/web.sock`.
//
// The protocol is newline-delimited JSON, because that is what the rest of this repository speaks between
// processes. A request is `{ i, op, ... }`; the answer is `{ i, ok: true, result }` or
// `{ i, ok: false, error }`. A connection that has subscribed also receives unsolicited events, which are
// the lines with `ev` and no `i`.
//
// The host takes no user argument, as the operator channel does not: the socket lives inside one person's
// userspace, so the only processes that can reach it are that person's own. Isolation here is structural,
// not a check.
import { createServer } from "node:net";
import { chmodSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, isAbsolute, resolve } from "node:path";
import { openSession, DEFAULT_BUFFER_BYTES, DEFAULT_WAIT_MS } from "./session.js";

/** How recent a browser's `seen` must be for a shell to count as one a person is watching. */
const WATCHED_MS = 10 * 60_000;

/** The socket name, under `<root>/run/`, beside the gateway's own. Plan section 1. */
export const SOCKET = "term.sock";
/** Sessions per person. The legacy limit was 4 per conversation; a person's fence is the unit now.
 *  Plan sections 2.4 and 6 (`sessions`). */
export const MAX_SESSIONS = 8;
/** Minutes with nothing happening — no output, no input, no browser with it on screen — and no running
 *  command before a session is closed (`idleMinutes`); 0 disables it. Two hours: long enough for a
 *  person to come back from lunch to the shell they left, short enough that a week of conversations
 *  does not leave thirty shells behind, which is what 30 minutes plus "any open browser tab keeps
 *  every shell alive" did. */
export const IDLE_MINUTES = 120;
/** What one tool answer may carry, head and tail kept. The cap `env.exec` already uses
 *  (`userspace-agent/src/agent.ts:18`). Plan section 2.4. */
export const ANSWER_CHARS = 30_000;
/** How often the idle reaper looks. It ticks sooner when `idleMinutes` is set shorter than this, so a
 *  short idle close is honoured rather than rounded up to half a minute. */
export const REAP_INTERVAL_MS = 30_000;
/** How many closed sessions stay on the list so the shelf can say "closed, exit 130" and offer a reopen.
 *  Beyond this the oldest are forgotten; they hold no process and no buffer worth keeping. */
export const CLOSED_KEPT = 4;

/** The init files the sessions write, `run/term-<id>.rc`. A session removes its own when it closes; one
 *  left by a process that was killed is removed when the next host starts. */
const RC_FILE = /^term-[0-9a-f]{12}\.rc$/;

/** Programs whose first argument is the task: `npm test` says more than `npm`. */
const RUNNERS = new Set(["npm", "npx", "pnpm", "yarn", "bun", "deno", "node", "python", "python3", "cargo", "make", "go", "git", "docker", "kubectl", "dotnet", "mvn", "gradle", "just", "uv", "pip", "ssh"]);
/** Words that only say how the command runs, never what it is. */
const PREFIXES = new Set(["sudo", "env", "time", "nohup", "exec", "command", "nice", "stdbuf", "timeout"]);
const NAME_CHARS = 24;

/** The last segment of a directory, `~` spelled out, quotes gone. */
function leafOf(dir) {
  const plain = String(dir ?? "").trim().replace(/^['"]|['"]$/g, "").replace(/\/+$/, "");
  if (!plain || plain === "~") return null;
  return basename(plain) || null;
}

/**
 * What a shell is doing, as a name: the directory a leading `cd` goes to, else the program and, for a
 * runner, its task (`npm test`, `cargo build`). Null when the line says nothing a name could use.
 * Exported for the tests.
 */
export function nameFromCommand(cmd) {
  const line = String(cmd ?? "").split(/\r?\n/)[0].trim();
  if (!line) return null;
  const cd = /^cd\s+(?:--\s+)?("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(line);
  if (cd) return leafOf(cd[1]);
  // Only the first command of a pipeline or a list, without its redirections, is what the shell is doing.
  const words = line.split(/&&|\|\||[;|<>&]/)[0].trim().split(/\s+/).filter((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  while (words.length && PREFIXES.has(words[0])) words.shift();
  if (!words.length) return null;
  const program = basename(words[0]);
  if (!/^[\w.+-]+$/.test(program)) return null;
  const task = RUNNERS.has(program) ? words.slice(1).find((w) => /^[\w.:/@+-]+$/.test(w) && !w.startsWith("-")) : null;
  return (task ? `${program} ${task}` : program).slice(0, NAME_CHARS);
}

/**
 * Keep the head and the tail and say how much of the middle is missing. A truncation that does not say so
 * is the same failure as a ring buffer that hands over a hole.
 */
export function capAnswer(text, limit = ANSWER_CHARS) {
  if (typeof text !== "string" || text.length <= limit) return text;
  const note = (n) => `\n...[${n} characters not shown; the middle of the output]...\n`;
  const room = Math.max(0, limit - note(text.length).length);
  const head = Math.floor(room * 0.68);
  const tail = room - head;
  const hidden = text.length - head - tail;
  return text.slice(0, head) + note(hidden) + text.slice(text.length - tail);
}

const positive = (v, fallback) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : fallback);
/** A browser's cursor key; anything else is an agent's, and only an agent's answers are capped. */
const isViewer = (consumer) => typeof consumer === "string" && consumer.startsWith("ui:");

/**
 * Start the session table and its socket. `env` is the `ServiceEnv` the userspace agent hands a service:
 * `root` (the userspace), `cwd` (the person's home), `config` (`config.packages["@thetis/terminal"]`) and
 * `log`. Every limit above is read from `config` here, and nowhere else.
 */
export async function startHost(env = {}) {
  const config = env.config ?? {};
  const root = env.root ?? process.cwd();
  const home = env.cwd ?? root;
  const log = env.log ?? (() => {});
  const shell = typeof config.shell === "string" && config.shell ? config.shell : "/bin/bash";
  const maxSessions = positive(config.sessions, MAX_SESSIONS);
  const bufferBytes = positive(config.bufferBytes, DEFAULT_BUFFER_BYTES);
  // 0 is a real setting here (it stops the reaper), so this cannot go through `positive`. Anything that is
  // not a number at all falls back, rather than becoming a NaN that would disable the reaper in silence.
  const idleMinutes = Number.isFinite(Number(config.idleMinutes)) && Number(config.idleMinutes) >= 0 ? Number(config.idleMinutes) : IDLE_MINUTES;
  const defaultWaitMs = positive(config.waitMs, DEFAULT_WAIT_MS);

  const runDir = resolve(root, "run");
  // The directory is shared with `run/web.sock`, which the door reaches at mode 0660. Tightening it to
  // 0700 here would take that access away from whichever of the two services happened to start second, so
  // the confinement this socket relies on is the one the plan's section 7 actually names — it lives inside
  // the userspace — plus 0600 on the socket itself.
  mkdirSync(runDir, { recursive: true });
  const socketPath = resolve(runDir, SOCKET);
  rmSync(socketPath, { force: true });
  // No session is open yet, so every init file here belongs to a process that did not close its shells.
  let stale = 0;
  for (const file of readdirSync(runDir)) {
    if (!RC_FILE.test(file)) continue;
    rmSync(resolve(runDir, file), { force: true });
    stale++;
  }
  if (stale) log(`terminal: removed ${stale} init file${stale === 1 ? "" : "s"} left by shells that were not closed`);

  const sessions = new Map(); // id -> session, insertion-ordered, closed ones kept for a while
  const conns = new Set();

  const open = () => [...sessions.values()].filter((s) => !s.closed);

  function prune() {
    const dead = [...sessions.values()].filter((s) => s.closed);
    for (const s of dead.slice(0, Math.max(0, dead.length - CLOSED_KEPT))) sessions.delete(s.id);
  }

  function countWatchers() {
    const n = [...conns].filter((c) => c.subscribed && isViewer(c.consumer)).length;
    for (const s of sessions.values()) s.setWatchers(n);
  }

  function broadcast(line) {
    const text = `${JSON.stringify(line)}\n`;
    for (const c of conns) if (c.subscribed && c.socket.writable) c.socket.write(text);
  }

  // A shell is named for what it is about, not numbered: the directory it opened in, or — for one that
  // opened in the home, which says nothing — the first command it runs (`provisional` holds those until
  // then). A name a person gives is never replaced. Within one conversation a name is unique, because
  // the model addresses a session by its name.
  const provisional = new Set();

  function unique(base, conversation, except = null) {
    const taken = new Set(open().filter((s) => s.conversation === conversation && s.id !== except).map((s) => s.name));
    if (!taken.has(base)) return base;
    for (let n = 2; ; n++) if (!taken.has(`${base} ${n}`)) return `${base} ${n}`;
  }

  /** The first command of a shell named for nothing yet names it. */
  function claimName(s, cmd, cwd) {
    if (!provisional.has(s.id)) return;
    provisional.delete(s.id);
    const base = (cwd && leafOf(cwd)) || nameFromCommand(cmd);
    if (base && base !== s.name) s.rename(unique(base, s.conversation, s.id));
  }

  function create({ name, cwd, conversation = null, own = false }) {
    prune();
    if (open().length >= maxSessions) {
      throw new Error(`there are already ${maxSessions} shell sessions open, which is the limit for this person. Close one with shell_sessions before opening another.`);
    }
    const id = randomBytes(6).toString("hex");
    const where = cwd ? (isAbsolute(cwd) ? cwd : resolve(home, cwd)) : home;
    const named = name ? String(name) : where === home ? null : leafOf(where);
    const session = openSession({
      id,
      name: unique(named ?? "shell", conversation),
      shell,
      cwd: where,
      conversation,
      own,
      bufferBytes,
      runDir,
      rc: resolve(home, ".bashrc"),
      log,
    });
    sessions.set(id, session);
    if (!named) provisional.add(id);
    session.onEvent((e) => {
      if (e.type === "output") broadcast({ ev: "output", id, seq: e.from, text: e.text });
      else if (e.type === "state") broadcast({ ev: "state", session: e.session });
      else if (e.type === "closed") {
        provisional.delete(id);
        broadcast({ ev: "closed", id, exit: e.exit });
        log(`terminal: session ${session.name} closed`);
      }
    });
    countWatchers();
    log(`terminal: session ${session.name} opened in ${where}`);
    return session;
  }

  function need(id) {
    const s = sessions.get(id);
    if (!s) throw new Error(`there is no session ${JSON.stringify(id)}. List the open ones with shell_sessions.`);
    return s;
  }

  /** The conversation's own session (`own`), opened on the first command that needs one. */
  function mainOf(conversation) {
    const mine = open().filter((s) => s.conversation === conversation);
    return mine.find((s) => s.state().own) ?? mine[0] ?? create({ conversation, own: true });
  }

  /** An agent's answer is capped; a browser's is not, because the browser is streaming it anyway. */
  const answer = (result, consumer) => (isViewer(consumer) ? result : { ...result, output: capAnswer(result.output) });

  const ops = {
    async list({ conversation } = {}) {
      prune();
      const all = [...sessions.values()].map((s) => s.state());
      return conversation === undefined || conversation === null ? all : all.filter((s) => s.conversation === conversation);
    },

    async open({ name, cwd, conversation = null } = {}) {
      return create({ name, cwd, conversation }).state();
    },

    async run({ id, conversation = null, cmd, cwd, timeoutMs, background = false, consumer } = {}) {
      if (typeof cmd !== "string" || !cmd.trim()) throw new Error("cmd is required and must not be empty.");
      const s = id ? need(id) : mainOf(conversation);
      claimName(s, cmd, cwd);
      const out = await s.run(cmd, { cwd, timeoutMs: timeoutMs ?? (background ? undefined : defaultWaitMs), background, consumer });
      return { ...answer(out, consumer), id: s.id, name: s.name, session: s.state() };
    },

    async read({ id, consumer, waitMs = 0 } = {}) {
      const s = need(id);
      const out = await s.read(consumer, { waitMs });
      return { ...answer(out, consumer), id: s.id, name: s.name, session: s.state() };
    },

    async write({ id, text, submit = false, settleMs, consumer } = {}) {
      if (typeof text !== "string") throw new Error("text is required.");
      const s = need(id);
      if (submit && text.trim()) claimName(s, text, null);
      // Who is typing is read from the cursor key, not claimed by the caller: a `ui:` cursor is a browser,
      // and everything else is the agent. It is the only thing that tells `person` from `busy`.
      const out = await s.write(text, { submit, settleMs, consumer, holder: isViewer(consumer) ? "person" : "agent" });
      return { ...answer(out, consumer), id: s.id, name: s.name, session: s.state() };
    },

    async interrupt({ id, consumer } = {}) {
      const s = need(id);
      const out = await s.interrupt({ consumer });
      return { ...answer(out, consumer), id: s.id, name: s.name, session: s.state() };
    },

    async resize({ id, rows, cols } = {}) {
      return { ...(await need(id).resize(rows, cols)), id };
    },

    async close({ id } = {}) {
      const state = await need(id).close();
      prune();
      return state;
    },

    async rename({ id, name } = {}) {
      if (typeof name !== "string" || !name.trim()) throw new Error("name is required and must not be empty.");
      provisional.delete(id);
      return need(id).rename(name.trim());
    },

    /** A browser has this session on screen; the reaper leaves it alone for another `idleMinutes`. */
    async seen({ id } = {}) {
      need(id).touch();
      return {};
    },

    /**
     * How many shells are open, across every conversation: what closes when this space is updated. `watched`
     * is how many of them a browser has had on screen in the last ten minutes -- the ones a person would miss.
     * A shell only the agent uses is reopened by the agent, so it does not hold an automatic apply back.
     */
    async count() {
      const since = Date.now() - WATCHED_MS;
      const all = open();
      return { open: all.length, watched: all.filter((s) => s.seenAt?.() > since).length };
    },

    async subscribe({ from, consumer } = {}, conn) {
      if (!conn) throw new Error("subscribe needs a connection; it is not a one-shot call.");
      conn.subscribed = true;
      conn.consumer = consumer ?? null;
      countWatchers();
      const snapshot = [...sessions.values()].map((s) => s.state());
      // `from` replays what the ring still holds: a number is one offset for every session, an object is
      // an offset per session id. The replay is sent as ordinary output events after this answer, so a
      // reconnecting browser has one code path and not two.
      if (from !== undefined && from !== null) {
        queueMicrotask(() => {
          for (const s of sessions.values()) {
            const at = typeof from === "object" ? from[s.id] : from;
            if (at === undefined || at === null) continue;
            const held = s.buffer(Number(at) || 0);
            if (held.text) conn.socket.write(`${JSON.stringify({ ev: "output", id: s.id, seq: held.from, text: held.text, dropped: held.dropped })}\n`);
          }
        });
      }
      return { sessions: snapshot };
    },
  };

  const server = createServer((socket) => {
    socket.setEncoding("utf8");
    const conn = { socket, subscribed: false, consumer: null };
    conns.add(conn);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.trim()) void handle(line, conn);
      }
    });
    const gone = () => {
      conns.delete(conn);
      countWatchers();
    };
    socket.on("close", gone);
    socket.on("error", gone);
  });

  async function handle(line, conn) {
    let request;
    try {
      request = JSON.parse(line);
    } catch {
      return void conn.socket.write(`${JSON.stringify({ ok: false, error: "that was not a JSON line." })}\n`);
    }
    const { i, op, ...args } = request ?? {};
    const fn = ops[op];
    if (!fn) return void conn.socket.write(`${JSON.stringify({ i, ok: false, error: `there is no op named ${JSON.stringify(op)}.` })}\n`);
    try {
      const result = await fn(args, conn);
      if (conn.socket.writable) conn.socket.write(`${JSON.stringify({ i, ok: true, result })}\n`);
    } catch (e) {
      if (conn.socket.writable) conn.socket.write(`${JSON.stringify({ i, ok: false, error: e?.message ?? String(e) })}\n`);
    }
  }

  await new Promise((done, fail) => server.once("error", fail).listen(socketPath, done));
  chmodSync(socketPath, 0o600);
  log(`terminal: listening on ${socketPath}`);

  const idleMs = idleMinutes > 0 ? idleMinutes * 60_000 : 0;
  const reaper = idleMs
    ? setInterval(() => {
        // An open browser tab is not a reason to keep a shell: every page holds a subscription for its
        // whole life, so "no watcher" was never true for a person who leaves a tab open, and their
        // shells piled up. What keeps a shell is something happening in it, including a browser that
        // has it on screen and says so (`seen`), or a command still running.
        for (const s of open()) {
          if (s.running || s.idleMs < idleMs) continue;
          log(`terminal: closing ${s.name} after ${Math.round(s.idleMs / 60_000)} min idle`);
          void s.close({ why: "idle" }).then(prune);
        }
      }, Math.max(250, Math.min(REAP_INTERVAL_MS, idleMs)))
    : null;
  reaper?.unref?.();

  return {
    socket: socketPath,
    /** The open sessions, for a caller inside this process; everyone else goes through the socket. */
    sessions: () => open(),
    /** Closing the fence closes the host, and closing the host closes every session in it. */
    async stop() {
      clearInterval(reaper);
      // The socket file goes first: the fence gives its services about a second to stop, and closing every
      // shell can take longer than that. A socket left behind is a dead address other processes still find.
      rmSync(socketPath, { force: true });
      await Promise.all([...sessions.values()].map((s) => s.close()));
      for (const c of conns) c.socket.destroy();
      conns.clear();
      await new Promise((done) => server.close(() => done()));
    },
  };
}
