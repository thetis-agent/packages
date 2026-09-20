// Entry point: the service that holds the sessions, the five tools the model calls, and the eight
// commands the package's own page sends. Argument checks live here; the mechanism lives under `lib/`.
//
// Three facts shape this file.
//
// The sessions live in one process and the callers live in two. A tool runs in the userspace agent, a
// `ui` command runs in the person's gateway, and neither may hold a session in module state. Both reach
// `lib/host.js` over `<root>/run/term.sock`, so everything below is a wrapper around one request.
//
// Who is asking is said by the cursor key, and by nothing else. A tool's key is the conversation id, so
// each conversation has its own place in the output it has already seen; a browser's key is `ui:`-
// prefixed, which is what makes the host report `person` rather than `busy` when someone types. A tool
// must therefore never send a `ui:` key, and a ui command must never send anything else.
//
// A tool answers a person's colleague: a string, factual, bounded, and claiming nothing that was not
// observed. A ui command answers a program: `{ data }`, because the gateway keeps `text` and `data` and
// drops every other field (`packages/gateway-web/README.md` section 11.4), and a thrown error is a `400` with
// its sentence. The one streaming command yields values instead, batched on a frame tick, and closes its
// connection when the browser lets go.
import { randomBytes } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { connect } from "./lib/client.js";
import { startHost } from "./lib/host.js";

/** One frame per session per tick. The gateway applies no backpressure, so a `yes` loop is coalesced
 *  here rather than written through a socket a thousand times a second. */
export const FRAME_MS = 50;
/** How long a watching stream may hear nothing before it asks the host whether it is still there. A
 *  connection that died leaves no event behind, and a stream that hangs is worse than one that ends:
 *  the page retries a stream that ends, with a widening delay. */
export const HEARTBEAT_MS = 20_000;
/** A session id as the host makes them: `randomBytes(6).toString("hex")`. Anything else the model gives
 *  as `session` is read as a name, and looked up among this conversation's own. */
const SESSION_ID = /^[0-9a-f]{12}$/;

const fail = (message) => {
  throw new Error(message);
};

// ---- the service ----

/**
 * Start the session host for this fence. `env` is the `ServiceEnv`: the fence environment plus `config`
 * (`config.packages["@thetis/terminal"]`) and `log`. Every limit is read from `config` inside the host,
 * which is the only place that reads it, so there is nothing to decide here.
 *
 * There is deliberately no `enabled` key. A switch that records an intention while the five tools stay
 * declared is a trap: the model still sees them, still calls them, and gets a refusal where it expected
 * a capability. The way to take the terminal away from someone is to not install the package for them —
 * `thetis uninstall @thetis/terminal --user <id>` — which removes the tools, the shelf and this service
 * together, and shows in `thetis packages list`. That is a state, not a wish.
 */
export async function startTerminals(env) {
  const host = await startHost(env);
  return { stop: () => host.stop() };
}

// ---- the one connection ----
//
// One connection per process, made when it is first needed and remade after it drops, rather than one
// per call: a tool call is a socket handshake cheaper this way, and a subscribed connection is what the
// host counts as a watcher, so the count would be wrong if every call opened one.
//
// A dropped connection must never leave a caller hanging, and `lib/client.js` sees to that: closing the
// socket rejects everything pending with the sentence a person can act on. What is left to decide here
// is what to do with the rejection. A connection made in this very call that fails has failed for the
// reason the client says — the host is not running — and that sentence goes through untouched. A
// connection that was already in use and died may mean the agent process restarted under us, so it is
// dropped and, for the calls that can be repeated without repeating their effect, sent again. `run`,
// `write`, `read`, `interrupt` and `open` are not among them: re-sending a command that may already have
// reached the shell would be worse than saying plainly that what happened is not known.

let held = null;

const CONNECTION_GONE = /the terminal service is not running in this workspace|this connection to the terminal service was closed/;
const dropped = (error) => CONNECTION_GONE.test(error?.message ?? "");
const RESENDABLE = new Set(["list", "resize", "rename", "close"]);

function hold(root) {
  if (!held || held.root !== root) held = { root, used: false, ready: null };
  const entry = held;
  if (!entry.ready) {
    entry.ready = connect(root).catch((error) => {
      if (held === entry) held = null; // a failed connection is not kept; the next call tries again
      throw error;
    });
  }
  return entry;
}

function release(entry) {
  if (held === entry) held = null;
  entry.ready?.then((conn) => conn.close()).catch(() => {});
}

/** One request to the session host, on the connection this process holds. */
async function call(root, op, args = {}) {
  const entry = hold(root);
  const reused = entry.used;
  entry.used = true;
  try {
    return await (await entry.ready).request(op, args);
  } catch (error) {
    if (!dropped(error)) throw error; // the host refused, and its wording is the answer
    release(entry);
    if (!reused) throw error; // we opened this one just now: the service really is not there
    if (!RESENDABLE.has(op)) {
      fail(`the connection to the terminal service dropped while this call was in flight, so what it did is not known. Look with shell_sessions or shell_read before doing it again.`);
    }
    const again = hold(root);
    again.used = true;
    return (await again.ready).request(op, args);
  }
}

// ---- the tools ----

/** The conversation is the tool's cursor key: what this conversation has already been shown. */
const cursor = (env) => env?.session?.id ?? "agent";

/**
 * Every tool: a string always, and a refusal marked `error:` so the transcript shows a failed call
 * rather than an answer, as `@thetis/tools-files` does.
 */
function tool(fn) {
  return async (args, env) => {
    try {
      return await fn(args ?? {}, env);
    } catch (error) {
      return `error: ${error?.message ?? String(error)}`;
    }
  };
}

const wantString = (value, what) => (typeof value === "string" ? value : fail(what));
const wantNumber = (value, what) => (Number.isFinite(Number(value)) && Number(value) > 0 ? Number(value) : fail(what));

const list = (env, conversation) => call(env.root, "list", conversation === undefined ? {} : { conversation });

/** The sessions of this conversation, newest state first read from the host, open ones only. */
const openOf = (sessions) => sessions.filter((s) => s.state !== "closed");

/**
 * Which session the model means. Nothing given means this conversation's own, which the host opens on
 * the first command that needs one, so `null` is an answer and not a failure. An id is passed through;
 * anything else is read as a name and looked up among this conversation's sessions, because a name is
 * what `shell_sessions` puts in front of the model.
 */
async function sessionArg(args, env, what = "session") {
  if (args[what] === undefined || args[what] === null) return null;
  const want = wantString(args[what], `${what} must be the id or the name of a shell session, as shell_sessions lists them.`);
  if (SESSION_ID.test(want)) return want;
  const mine = await list(env, cursor(env));
  const hit = openOf(mine).find((s) => s.name === want) ?? mine.find((s) => s.name === want);
  if (!hit) fail(`this conversation has no shell session called ${JSON.stringify(want)}. List them with shell_sessions.`);
  return hit.id;
}

/** The same, for the tools that can only act on a session that exists: `read`, `write` and `interrupt`
 *  take an id, and this conversation's own has to be found rather than opened. */
async function needSession(args, env) {
  const given = await sessionArg(args, env);
  if (given) return given;
  const open = openOf(await list(env, cursor(env)));
  const mine = open.find((s) => s.name === "main") ?? open[0];
  if (!mine) fail("this conversation has no shell session open. Run something with shell and one opens.");
  return mine.id;
}

const seconds = (ms) => `${Math.max(0, Math.round(ms / 1000))}s`;

/** The output, or the fact that there was none. Trailing blank lines go; leading ones too, because the
 *  first thing after a status line should be the first thing the command printed. */
function printed(output, nothing) {
  const text = String(output ?? "").replace(/^\n+/, "").replace(/\s+$/, "");
  return text || nothing;
}

/**
 * What is true about the session after the call, in the order a reader needs it. The person typing is
 * last and is never left out: it is the whole point of a session the two share, and the model would
 * otherwise read their output as its own command's.
 */
function notes(out) {
  const session = out.session ?? {};
  const lines = [];
  if (out.moved && out.cwd) lines.push(`The working directory is now ${out.cwd}.`);
  if (out.dropped > 0) lines.push(`${out.dropped} characters this session printed earlier fell out of its buffer before you read them.`);
  if (session.holder === "person") {
    lines.push(session.command
      ? `The person typed in this session: ${JSON.stringify(session.command)} is running in it now, and its output arrives here too.`
      : "The person typed in this session, and what they started is running in it now.");
  }
  if (session.framed === false) lines.push("This shell does not announce its prompts, so nothing the person runs in it carries an exit status.");
  if (session.state === "closed") lines.push("This session is closed. The next shell command opens a new one.");
  return lines;
}

const assemble = (status, body, out) => [status, body, ...(notes(out).length ? [notes(out).join("\n")] : [])].join("\n\n");

/** `shell`: the exit status, the output, then the notes. */
export const shell = tool(async (args, env) => {
  const cmd = wantString(args.cmd, "cmd is the command line to run, as a string.").trim();
  if (!cmd) fail("cmd is the command line to run, and it must not be empty.");
  const background = args.background === true;
  const id = await sessionArg(args, env);
  const where = args.cwd === undefined || args.cwd === null ? undefined : wantString(args.cwd, "cwd must be a path, as a string.");
  const out = await call(env.root, "run", {
    ...(id ? { id } : {}),
    conversation: cursor(env),
    cmd,
    // The manifest promises "relative to home unless absolute", so a relative path is resolved against
    // the home here rather than against wherever the session happens to stand.
    ...(where ? { cwd: isAbsolute(where) ? where : resolve(env.cwd, where) } : {}),
    ...(args.timeoutMs === undefined ? {} : { timeoutMs: wantNumber(args.timeoutMs, "timeoutMs is a number of milliseconds greater than zero.") }),
    background,
    consumer: cursor(env),
  });

  const status = out.running
    ? background
      ? "Started in the background, and it is still running. Collect what it prints with shell_read."
      : "Still running: the wait ran out and the command was not killed. Collect the rest with shell_read, answer it with shell_send, or stop it with shell_interrupt."
    : typeof out.exit === "number"
      ? `exit ${out.exit}`
      : "Finished, with no exit status: this shell does not report one.";
  return assemble(status, printed(out.output, "(it printed nothing)"), out);
});

/** `shell_read`: what arrived since this conversation last looked, and whether anything is still running. */
export const shellRead = tool(async (args, env) => {
  const id = await needSession(args, env);
  const waitMs = args.waitMs === undefined ? 0 : wantNumber(args.waitMs, "waitMs is a number of milliseconds greater than zero.");
  const out = await call(env.root, "read", { id, waitMs, consumer: cursor(env) });
  const status = out.running
    ? "Still running. Read again for more, or stop it with shell_interrupt."
    : typeof out.exit === "number"
      ? `Nothing is running now; the last command in this session ended with exit ${out.exit}.`
      : "Nothing is running now, and this shell reports no exit status.";
  return assemble(status, printed(out.output, "(nothing new since your last read)"), out);
});

/** `shell_send`: raw input, and what the session printed in the moment after. */
export const shellSend = tool(async (args, env) => {
  const text = wantString(args.text, "text is what to write to the session, as a string. Use an empty string with submit to send a bare newline.");
  // The manifest promises Enter unless the caller says otherwise; `ops.write` defaults the other way,
  // which is right for a browser, where Enter is already a `\r` in the keystrokes. This is the seam.
  const submit = args.submit === undefined ? true : Boolean(args.submit);
  const id = await needSession(args, env);
  const out = await call(env.root, "write", { id, text, submit, consumer: cursor(env) });
  const status = out.running
    ? "Sent. Something is running in the session; collect the rest with shell_read."
    : typeof out.exit === "number"
      ? `Sent. Nothing is running now; the last command ended with exit ${out.exit}.`
      : "Sent. Nothing is running now.";
  return assemble(status, printed(out.output, "(it printed nothing in the moment after)"), out);
});

/** `shell_interrupt`: the interrupt character, and whether it worked. */
export const shellInterrupt = tool(async (args, env) => {
  const id = await needSession(args, env);
  const out = await call(env.root, "interrupt", { id, consumer: cursor(env) });
  const status = out.running
    ? "The interrupt was sent, and something is still running in this session. Send it again, or close the session with shell_sessions."
    : typeof out.exit === "number"
      ? `Interrupted; the session is idle again, and the command ended with exit ${out.exit}.`
      : "Interrupted; the session is idle again.";
  return assemble(status, printed(out.output, "(it printed nothing)"), out);
});

/** One session, as one line: what it is called, what it is doing, where, and who is watching. */
function row(session) {
  const what = {
    idle: "idle",
    unframed: "idle; this shell does not report exit statuses",
    busy: session.command ? `busy: you are running ${JSON.stringify(session.command)} (${seconds(Date.now() - (session.since ?? Date.now()))})` : "busy",
    "busy-quiet": session.command
      ? `busy: ${JSON.stringify(session.command)} has printed nothing for ${seconds(session.quietMs ?? 0)} (running ${seconds(Date.now() - (session.since ?? Date.now()))})`
      : "busy, and printing nothing",
    person: session.command ? `the person is running ${JSON.stringify(session.command)} (${seconds(Date.now() - (session.since ?? Date.now()))})` : "the person is typing in it",
    fullscreen: "a full-screen program has the terminal",
    closed: typeof session.lastExit === "number" ? `closed, exit ${session.lastExit}` : "closed",
  }[session.state] ?? session.state;
  const parts = [`${session.name} (${session.id})`, what, session.cwd];
  if (session.state !== "closed" && typeof session.lastExit === "number" && !session.command) parts.push(`last exit ${session.lastExit}`);
  if (session.dropped > 0) parts.push(`${session.dropped} characters dropped from its buffer`);
  // The host counts open browsers, not viewers of this row, so one open page marks every session. Say
  // what the number knows and no more.
  parts.push(session.watchers > 0 ? "the person has the terminal open in their browser" : "the terminal is not open in a browser");
  return parts.join(" · ");
}

/** `shell_sessions`: this conversation's sessions, or one of them closed. */
export const shellSessions = tool(async (args, env) => {
  if (args.close !== undefined && args.close !== null) {
    const id = await sessionArg(args, env, "close");
    const state = await call(env.root, "close", { id });
    return `Closed the shell session ${state.name}${typeof state.lastExit === "number" ? ` (its last command ended with exit ${state.lastExit})` : ""}.`;
  }
  const sessions = await list(env, cursor(env));
  if (!sessions.length) return "This conversation has no shell session. The first shell command opens one.";
  const open = openOf(sessions).length;
  const head = `${open} shell session${open === 1 ? "" : "s"} open in this conversation${sessions.length > open ? `, and ${sessions.length - open} closed` : ""}.`;
  return [head, sessions.map(row).join("\n")].join("\n\n");
});

// ---- the ui commands ----
//
// Each answers `{ data }`, because the gateway keeps `text` and `data` and drops the rest. Each acts as
// a browser: a `ui:`-prefixed cursor key, which is what makes the host say `person` rather than `busy`
// when the keys are someone's own. A refusal is thrown, and the gateway answers `400` with the sentence,
// so every sentence here is one the page can put in front of a person.

const viewer = (env) => `ui:${env?.user ?? "person"}`;

const idArg = (args) => {
  const id = args?.id;
  if (typeof id !== "string" || !id) fail("id is the session to act on, as the session list gives it.");
  return id;
};

const optional = (args, what) => {
  const value = args?.[what];
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") fail(`${what} must be a string.`);
  return value;
};

/** sessions: every session of this fence, not just one conversation's — the shelf shows them all. */
export async function uiSessions(_args, env) {
  return { data: { sessions: await call(env.root, "list", {}) } };
}

/** open: a new session, named and placed where the caller asks, in the conversation they name. */
export async function uiOpen(args, env) {
  const name = optional(args, "name");
  const cwd = optional(args, "cwd");
  const session = await call(env.root, "open", {
    ...(name ? { name } : {}),
    ...(cwd ? { cwd } : {}),
    conversation: optional(args, "conversation") ?? null,
  });
  return { data: { session } };
}

/**
 * write: keystrokes, as the emulator produced them. A burst that ends in a carriage return is the person
 * pressing Enter, so it is submitted as a command and the session learns whose it is; anything else goes
 * through raw. Nothing waits for output: the stream is already carrying it, and a settle here would put
 * the round trip of every keystroke in front of the next one.
 */
export async function uiWrite(args, env) {
  const id = idArg(args);
  if (typeof args.text !== "string") fail("text is what was typed, as a string.");
  const enter = /[\r\n]$/.test(args.text);
  await call(env.root, "write", {
    id,
    text: enter ? args.text.replace(/[\r\n]+$/, "") : args.text,
    submit: enter,
    settleMs: 0,
    consumer: viewer(env),
  });
  return { data: {} };
}

/** interrupt: the deliberate Ctrl-C, from the row's own button. */
export async function uiInterrupt(args, env) {
  await call(env.root, "interrupt", { id: idArg(args), consumer: viewer(env) });
  return { data: {} };
}

/**
 * resize: the pane's size, in rows and columns. The ordinary answer is `applied: true`: the size was set
 * on the session's tty from outside the shell, whether or not something is running. `applied: false,
 * deferred: true` is the fallback for a shell that never reported its tty, stated rather than hidden —
 * a command is running, so the size is written down and typed at the next prompt, and the program
 * running now keeps the old one.
 */
export async function uiResize(args, env) {
  const id = idArg(args);
  const rows = Math.trunc(wantNumber(args.rows, "rows must be a number of rows greater than zero."));
  const cols = Math.trunc(wantNumber(args.cols, "cols must be a number of columns greater than zero."));
  const out = await call(env.root, "resize", { id, rows, cols });
  return { data: { applied: out.applied === true, deferred: out.deferred === true } };
}

/** close: this session ends, and the shell in it with it. */
export async function uiClose(args, env) {
  await call(env.root, "close", { id: idArg(args) });
  return { data: {} };
}

/** rename: what the row calls it. A person names a session; the model cannot. */
export async function uiRename(args, env) {
  const id = idArg(args);
  const name = typeof args.name === "string" ? args.name.trim() : "";
  if (!name) fail("name is what to call this session, and it must not be empty.");
  if (name.length > 40) fail("a session name is at most 40 characters.");
  return { data: { session: await call(env.root, "rename", { id, name }) } };
}

// ---- the stream ----

/**
 * watch: every session of this fence, live, for as long as the browser holds the subscription.
 *
 * It yields four values and nothing else: `sessions` when it opens and whenever one is added or gone,
 * `output` with the session's counter *after* the chunk, `state` when a session's word changes, and
 * `closed`. The first `output` of each session carries the whole ring buffer with `replace`, so a page
 * that opens in the middle of a build sees the last screenful and a reconnect is a redraw that costs
 * nothing: every value is written to be replayed.
 *
 * Output is batched on a `FRAME_MS` tick, one frame per session, because the gateway applies no
 * backpressure and a `yes` loop would otherwise become a request per write. Everything else is yielded
 * as it happens, and a frame held for a session is flushed before it, so what the page receives is in
 * the order it happened.
 *
 * This is the one export with a connection of its own: a subscribed connection is what the host counts
 * as a watcher, and a `finally` closes it, so a browser that walks away leaves nothing behind.
 */
export async function* uiWatch(_args, env) {
  const key = `ui:${randomBytes(6).toString("hex")}`; // stable for this subscription, and only this one
  const conn = await connect(env.root);

  const queue = [];
  const frames = new Map(); // id -> { text, seq, replace }: at most one frame per session per tick
  const known = new Set(); // sessions the page has been told about; output for any other one waits
  let wake = null;
  let tick = null;
  let live = false; // until the subscribe answer, everything arriving is the replay of the ring buffers
  let stopped = false;
  let syncing = false;

  const nudge = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  function flushFrames() {
    clearTimeout(tick);
    tick = null;
    for (const [id, frame] of [...frames]) {
      if (!known.has(id)) continue; // a session the page has no row for yet: hold it, do not lose it
      frames.delete(id);
      queue.push({ ev: "output", id, seq: frame.seq, text: frame.text, ...(frame.replace ? { replace: true } : {}) });
    }
  }

  function arm() {
    if (tick || !live) return;
    tick = setTimeout(() => {
      flushFrames();
      nudge();
    }, FRAME_MS);
    tick.unref?.();
  }

  /** Everything but output: what is held for a session goes out in front of it, so the order holds. */
  function emit(value) {
    flushFrames();
    queue.push(value);
    nudge();
  }

  /** The list as the host has it now. It is also what `known` means, so a session the host has forgotten
   *  stops being one this stream is holding output for. */
  function announce(sessions) {
    emit({ ev: "sessions", sessions });
    known.clear();
    for (const session of sessions) known.add(session.id);
    for (const id of [...frames.keys()]) if (!known.has(id)) frames.delete(id);
  }

  /** A session was added or is gone; the host is the one that knows what the list is now. */
  function resync() {
    if (syncing || stopped) return;
    syncing = true;
    conn.request("list", {}).then(
      (sessions) => {
        syncing = false;
        if (!stopped) announce(sessions);
      },
      () => {
        syncing = false;
      },
    );
  }

  function onEvent(event) {
    if (stopped) return;
    if (event.ev === "output") {
      if (typeof event.id !== "string" || typeof event.text !== "string") return;
      // The host sends the offset the chunk starts at; the page counts from the end of it, so that a
      // chunk it has already written can be recognised and dropped.
      const after = (typeof event.seq === "number" ? event.seq : 0) + event.text.length;
      const frame = frames.get(event.id);
      if (frame) {
        frame.text += event.text;
        frame.seq = after;
      } else {
        frames.set(event.id, { text: event.text, seq: after, replace: false });
      }
      arm();
      return;
    }
    // Subscribing is itself a change — the host counts a watcher more — so a state event can arrive
    // before the answer does. Until the answer, the snapshot in it is the fresher word on every
    // session, so nothing else is yielded from this window and the rows go out in one value.
    if (!live) return;
    if (event.ev === "state" && event.session?.id) {
      const first = !known.has(event.session.id);
      emit({ ev: "state", session: event.session });
      known.add(event.session.id); // after the value, so the row exists before its output does
      if (first) resync();
      return;
    }
    if (event.ev === "closed" && typeof event.id === "string") {
      emit({ ev: "closed", id: event.id, exit: event.exit ?? null });
      resync();
    }
  }

  const abort = () => {
    stopped = true;
    nudge();
  };
  env.signal?.addEventListener("abort", abort, { once: true });

  try {
    if (env.signal?.aborted) return;
    // `from: 0` asks for everything each ring still holds. The host writes those chunks before it
    // answers, so what is held when the answer arrives is the replay and nothing else.
    const snapshot = await conn.subscribe(0, onEvent, { consumer: key });
    announce(snapshot?.sessions ?? []); // the rows first: the page has nowhere to put output yet
    for (const frame of frames.values()) frame.replace = true;
    live = true;
    arm();

    for (;;) {
      if (stopped) return;
      if (!queue.length) {
        await new Promise((done) => {
          const timer = setTimeout(() => {
            wake = null;
            done();
          }, HEARTBEAT_MS);
          timer.unref?.();
          wake = () => {
            clearTimeout(timer);
            done();
          };
        });
        if (stopped) return;
        if (!queue.length) {
          // Nothing for a while. A connection that died leaves no event behind, so it is asked: if it
          // has gone, this stream ends and the page retries it, rather than staying open and silent.
          let now;
          try {
            now = await conn.request("list", {});
          } catch {
            return;
          }
          const ids = now.map((s) => s.id);
          if (ids.length !== known.size || ids.some((id) => !known.has(id))) announce(now);
          continue;
        }
      }
      yield queue.shift();
    }
  } finally {
    env.signal?.removeEventListener("abort", abort);
    clearTimeout(tick);
    stopped = true;
    conn.close();
  }
}
