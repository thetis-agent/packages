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
import { chmodSync, mkdirSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { openSession, DEFAULT_BUFFER_BYTES, DEFAULT_WAIT_MS } from "./session.js";

/** The socket name, under `<root>/run/`, beside the gateway's own. Plan section 1. */
export const SOCKET = "term.sock";
/** Sessions per person. The legacy limit was 4 per conversation; a person's fence is the unit now.
 *  Plan sections 2.4 and 6 (`sessions`). */
export const MAX_SESSIONS = 8;
/** Minutes with no attached viewer and no running command before a session is closed. The legacy
 *  `idle_timeout_secs`. Plan sections 2.4 and 6 (`idleMinutes`); 0 disables it. */
export const IDLE_MINUTES = 30;
/** What one tool answer may carry, head and tail kept. The cap `env.exec` already uses
 *  (`userspace-agent/src/agent.ts:18`). Plan section 2.4. */
export const ANSWER_CHARS = 30_000;
/** How often the idle reaper looks. It ticks sooner when `idleMinutes` is set shorter than this, so a
 *  short idle close is honoured rather than rounded up to half a minute. */
export const REAP_INTERVAL_MS = 30_000;
/** How many closed sessions stay on the list so the shelf can say "closed, exit 130" and offer a reopen.
 *  Beyond this the oldest are forgotten; they hold no process and no buffer worth keeping. */
export const CLOSED_KEPT = 4;

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

  function nameFor(conversation) {
    const mine = open().filter((s) => s.conversation === conversation);
    if (!mine.length) return "main";
    for (let n = 2; ; n++) if (!mine.some((s) => s.name === String(n))) return String(n);
  }

  function create({ name, cwd, conversation = null }) {
    prune();
    if (open().length >= maxSessions) {
      throw new Error(`there are already ${maxSessions} shell sessions open, which is the limit for this person. Close one with shell_sessions before opening another.`);
    }
    const id = randomBytes(6).toString("hex");
    const where = cwd ? (isAbsolute(cwd) ? cwd : resolve(home, cwd)) : home;
    const session = openSession({
      id,
      name: name ? String(name) : nameFor(conversation),
      shell,
      cwd: where,
      conversation,
      bufferBytes,
      runDir,
      rc: resolve(home, ".bashrc"),
      log,
    });
    sessions.set(id, session);
    session.onEvent((e) => {
      if (e.type === "output") broadcast({ ev: "output", id, seq: e.from, text: e.text });
      else if (e.type === "state") broadcast({ ev: "state", session: e.session });
      else if (e.type === "closed") {
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

  /** The conversation's `main` session, opened on the first command that needs one. */
  function mainOf(conversation) {
    const mine = open().filter((s) => s.conversation === conversation);
    return mine.find((s) => s.name === "main") ?? mine[0] ?? create({ conversation });
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
      return need(id).rename(name.trim());
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
    const conn = { socket, subscribed: false, consumer: null };
    conns.add(conn);
    let buffer = "";
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
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
        for (const s of open()) {
          if (s.running || s.state().watchers > 0 || s.idleMs < idleMs) continue;
          log(`terminal: closing ${s.name} after ${Math.round(s.idleMs / 1000)}s idle`);
          void s.close();
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
      await Promise.all([...sessions.values()].map((s) => s.close()));
      for (const c of conns) c.socket.destroy();
      conns.clear();
      await new Promise((done) => server.close(() => done()));
      rmSync(socketPath, { force: true });
    },
  };
}
