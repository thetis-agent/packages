// One shell session: a real pty, one ring buffer, many cursors, and a state word computed here.
//
// The pty is `script -qfc "<shell>" /dev/null` from util-linux, which is on the read-only /usr every fence
// gets. It is the whole reason this package exists rather than another wrapper around `exec`: a pty gives
// line editing, job control, colour, programs that behave as they do for a person, and — the part no pipe
// can give — an interrupt that is a keystroke, delivered by the line discipline to the foreground process
// group only, so the runaway dies and the shell that owns the session does not.
//
// Three rules the rest of the file exists to keep:
//
//   Nothing consumes. The ring holds the last `bufferBytes` of output and a counter that only goes up.
//   Every reader — the agent, each open browser — holds an offset into that counter. A reader whose offset
//   has fallen off the back is told how many characters it lost. Ring buffers lie by default; this one is
//   made to say so.
//
//   The buffer is never edited. The marks stay in the bytes the person's emulator sees. Only the text
//   handed to the agent is cleaned, and cleaning means removing what an emulator would have consumed: the
//   escapes, the prompt between the prompt-start and command-start marks, the echo of the command we
//   ourselves wrote, and the marker line of an unframed shell.
//
//   Nothing is inferred. An exit status is reported only when a mark carried it. A command is "running"
//   only because a submit was seen going in and no end mark has come back out. A shell that will not carry
//   the marks is `unframed` and says so, rather than being guessed at.
import { spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { initFile, MarkParser, legacyMarker } from "./marks.js";

/** The ring, per session. 256 KiB: the legacy display buffer was 96 KiB, under one screen of a verbose
 *  build. Plan section 2.4. Counted in characters of the decoded stream, not raw bytes, because the
 *  buffer is decoded once on arrival so a multi-byte character can never be split by a cursor. */
export const DEFAULT_BUFFER_BYTES = 262_144;
/** What `env.exec` waits before it gives up, and what this waits before it answers "still running".
 *  Plan section 2.4. Unlike `exec`, nothing is killed when it runs out. */
export const DEFAULT_WAIT_MS = 120_000;
/** A running command that has printed nothing for this long is `busy-quiet` rather than `busy`. Five
 *  seconds is long enough that a compile between files does not flicker and short enough that a wedged
 *  command is visible before a person goes looking. Plan section 4.2. */
export const BUSY_QUIET_MS = 5_000;
/** How long `shell_send` watches for an answer after writing. The legacy `send_settle_ms`, plan 3.1. */
export const SEND_SETTLE_MS = 400;
/** The same settle after an interrupt: long enough for the shell to print `^C` and its next prompt. */
export const INTERRUPT_SETTLE_MS = 400;
/** How long a new session is given to prove it carries the marks before the first command is sent. Bash
 *  emits its first prompt mark inside 100 ms; this is twenty times that, paid once, and only in full by a
 *  shell that never will. */
export const FRAMING_GRACE_MS = 2_000;
/** A `cd` sent on the caller's behalf before their command. It is a builtin; a second is already generous. */
export const CD_WAIT_MS = 5_000;
/** How long the `stty` of a resize is given before we stop hiding it from the agent's transcript. */
export const RESIZE_WAIT_MS = 1_000;
/** After a command ends the shell runs PROMPT_COMMAND and redraws its prompt. A command written into
 *  that gap is echoed once by the line discipline and then again by readline's redisplay, so the person
 *  sees it twice and the agent sees it before its own prompt region. This is how long the next command
 *  waits for the prompt to be up; the gap is normally under a millisecond. */
export const PROMPT_SETTLE_MS = 2_000;
/** A command's finish mark follows its last output, usually in the same chunk from the pty. When a busy
 *  machine splits the two, a read that woke on the output would answer "still running" about a command
 *  that had just ended. This is how long it waits for the mark before answering that, and it is paid only
 *  by a read that woke while a command was running. */
export const END_MARK_GRACE_MS = 50;
/** Between SIGTERM and SIGKILL when a session is closed. Measured: util-linux `script` waits a flat two
 *  seconds after SIGTERM before killing the shell itself. A session holds nothing worth two seconds, and
 *  killing `script` closes the pty master, which is a SIGHUP to the shell, so nothing is left behind. */
export const CLOSE_GRACE_MS = 300;
/** The pty's size until a browser resizes it. 120 columns keeps a compiler's diagnostics off the wrap. */
export const DEFAULT_ROWS = 24;
export const DEFAULT_COLS = 120;

const ESC = "\u001b";
const BEL = "\u0007";
const INTERRUPT_CHAR = "\u0003";

const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/** Remove what an emulator would have consumed. Everything here is display, not content. */
function stripEscapes(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (ch !== ESC) {
      out += ch;
      i++;
      continue;
    }
    const n = s[i + 1];
    if (n === undefined) break; // a half-arrived escape at the very end; it is not content either
    if (n === "]" || n === "P" || n === "X" || n === "^" || n === "_") {
      let j = i + 2;
      while (j < s.length && s[j] !== BEL && !(s[j] === ESC && s[j + 1] === "\\")) j++;
      i = j >= s.length ? s.length : s[j] === BEL ? j + 1 : j + 2;
      continue;
    }
    if (n === "[") {
      let j = i + 2;
      while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j++;
      i = j >= s.length ? s.length : j + 1;
      continue;
    }
    if (n === "(" || n === ")" || n === "*" || n === "+" || n === "%" || n === "#") {
      i += 3; // a charset or a screen-size select: ESC, the intermediate, and one more
      continue;
    }
    i += 2;
  }
  return out;
}

/** A carriage return means the line was overwritten. Keep what was written last, which is what the person
 *  saw: a progress bar collapses to its final state instead of a hundred copies of itself. */
function normaliseReturns(s) {
  return s
    .replaceAll("\r\n", "\n")
    .split("\n")
    .map((line) => {
      const k = line.lastIndexOf("\r");
      return k === -1 ? line : line.slice(k + 1);
    })
    .join("\n");
}

const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;

function clean(s) {
  return normaliseReturns(stripEscapes(s)).replace(CONTROL, "");
}

/**
 * The pty echoes what we wrote. Drop that first line when it is exactly what we sent, and only then.
 * `prompted` loosens "exactly" to "ends with": an unframed shell carries no prompt-start mark, so the
 * prompt it printed cannot be cut by offset and is still sitting in front of the echo.
 */
function stripEcho(text, sent, prompted = false) {
  if (!sent) return text;
  const want = sent.trim();
  if (!want) return text;
  const nl = text.indexOf("\n");
  const first = (nl === -1 ? text : text.slice(0, nl)).trim();
  if (first !== want && !(prompted && first.endsWith(want))) return text;
  return nl === -1 ? "" : text.slice(nl + 1);
}

/**
 * Open one session. `runDir` is where the per-session bash init file is written (the package uses
 * `<root>/run`); `rc` is the person's own rc to source, when they have one. `env` is extra environment
 * for the shell, merged over this process's.
 *
 * @returns the session object described in the head comment; `state()` is the whole of what it claims.
 */
export function openSession({
  id,
  name = id,
  shell = "/bin/bash",
  cwd = process.cwd(),
  env = {},
  conversation = null,
  bufferBytes = DEFAULT_BUFFER_BYTES,
  runDir = tmpdir(),
  rc = null,
  rows = DEFAULT_ROWS,
  cols = DEFAULT_COLS,
  log = () => {},
} = {}) {
  // ---- the ring: chunks in order, an offset that only goes up, and an honest floor ----
  const chunks = [];
  let bytes = 0; // every character ever written out, the counter every cursor is an offset into
  let ringStart = 0; // the offset of the oldest character still held
  let ringLen = 0;

  function append(text) {
    chunks.push({ at: bytes, text });
    bytes += text.length;
    ringLen += text.length;
    while (ringLen > bufferBytes && chunks.length) {
      const head = chunks[0];
      const over = ringLen - bufferBytes;
      if (head.text.length <= over) {
        chunks.shift();
        ringLen -= head.text.length;
      } else {
        head.text = head.text.slice(over);
        head.at += over;
        ringLen -= over;
      }
      ringStart = chunks.length ? chunks[0].at : bytes;
    }
  }

  function slice(from, to) {
    const a = Math.max(from, ringStart);
    const b = Math.min(to, bytes);
    if (b <= a) return "";
    let out = "";
    for (const c of chunks) {
      if (c.at >= b) break;
      const s = Math.max(a, c.at);
      const e = Math.min(b, c.at + c.text.length);
      if (e > s) out += c.text.slice(s - c.at, e - c.at);
    }
    return out;
  }

  // ---- what the agent is not shown: the prompt, and commands this package sent for its own reasons ----
  const skips = [];
  function addSkip(from, to) {
    if (to > from) skips.push({ from, to });
    while (skips.length && skips[0].to < ringStart) skips.shift();
  }

  function forAgent(from, to) {
    let p = Math.max(from, ringStart);
    const parts = [];
    for (const r of skips.filter((s) => s.to > p && s.from < to).sort((a, b) => a.from - b.from)) {
      if (r.from > p) parts.push(slice(p, Math.min(r.from, to)));
      p = Math.max(p, r.to);
    }
    if (p < to) parts.push(slice(p, to));
    return clean(parts.join(""));
  }

  // ---- cursors: one per consumer, nothing consumes ----
  const cursors = new Map();
  /** A consumer we have never seen starts at the oldest character we still hold, so its first read is
   *  everything that survives rather than nothing. */
  const cursorOf = (consumer) => (consumer && cursors.has(consumer) ? cursors.get(consumer) : ringStart);
  const setCursor = (consumer, at) => {
    if (consumer) cursors.set(consumer, at);
  };

  // ---- the facts the state word is made of ----
  let framed = false;
  let running = false;
  let holder = null;
  let command = null;
  let since = null;
  let lastExit = null;
  let cwdNow = cwd;
  let lastOutputAt = Date.now();
  let lastActivityAt = Date.now();
  let watchers = 0;
  let closed = false;
  let closedAt = null;
  let exitCode = null;
  let sessionName = name;

  let endAt = null; // where the last finished command's output stopped, excluding its mark
  let endCursor = null; // where a reader should resume, after that mark
  let cmdToken = 0;
  let endToken = -1;

  let atPrompt = false; // a command-start mark has been seen and nothing has been submitted since
  let internalBusy = false; // a command this package sent (a resize); never reported as anyone's command
  let internalFrom = 0;
  let pendingResize = null;
  let wantRows = rows;
  let wantCols = cols;

  let legacyActive = null; // { marker, parse, carry, hit } while an unframed command is out
  let legacySeq = 0;

  // ---- waiting ----
  const waiters = new Set();
  function waitUntil(test, ms) {
    if (test()) return Promise.resolve(true);
    if (!(ms > 0)) return Promise.resolve(false);
    return new Promise((done) => {
      const w = { test };
      w.settle = (v) => {
        waiters.delete(w);
        clearTimeout(w.timer);
        done(v);
      };
      w.timer = setTimeout(() => w.settle(false), ms);
      w.timer.unref?.();
      waiters.add(w);
    });
  }
  function notify() {
    for (const w of [...waiters]) if (w.test()) w.settle(true);
  }
  const settle = (ms) => waitUntil(() => closed, ms);

  // ---- events ----
  const handlers = new Set();
  function emit(event) {
    for (const h of [...handlers]) {
      try {
        h(event);
      } catch (e) {
        log(`terminal: a subscriber of session ${id} threw: ${e?.message ?? e}`);
      }
    }
  }

  // The words, in the priority the plan fixes. `waiting` and `dropped` from plan 4.2 are deliberately not
  // here: `waiting` cannot be told from `busy-quiet` without guessing what a program meant by printing
  // nothing, and `dropped` is a fact on the row (`dropped > 0`), true of an idle session as much as a
  // busy one, so it is not a state.
  function word() {
    if (closed) return "closed";
    if (parser.altScreen) return "fullscreen";
    if (running && holder === "person") return "person";
    if (running) return Date.now() - lastOutputAt < BUSY_QUIET_MS ? "busy" : "busy-quiet";
    if (!framed) return "unframed";
    return "idle";
  }

  function state() {
    return {
      id,
      name: sessionName,
      cwd: cwdNow,
      state: word(),
      command,
      holder,
      since,
      quietMs: Date.now() - lastOutputAt,
      lastExit,
      framed,
      dropped: ringStart,
      watchers,
      conversation,
      bytes,
      closedAt,
    };
  }

  // A state event is worth sending when the word changes or a fact on the row does. `quietMs` and `bytes`
  // move constantly and are left out of the comparison, or every chunk would be a state event as well as
  // an output one. The word itself can change with time alone (busy -> busy-quiet), so a session with
  // something running is re-checked once a second.
  let lastSignature = null;
  const signature = (s) =>
    [s.state, s.name, s.cwd, s.command, s.holder, s.since, s.lastExit, s.framed, s.dropped, s.watchers, s.closedAt].join("\u0000");
  function maybeEmitState() {
    const s = state();
    const sig = signature(s);
    if (sig === lastSignature) return;
    lastSignature = sig;
    emit({ type: "state", id, session: s });
  }
  const ticker = setInterval(() => {
    if (running || internalBusy) maybeEmitState();
  }, 1_000);
  ticker.unref?.();

  // ---- the child ----
  const parser = new MarkParser();
  const decoder = new StringDecoder("utf8");
  const bash = /(^|\/)bash$/.test(shell);
  const rcPath = resolve(runDir, `term-${id}.rc`);
  if (bash) {
    mkdirSync(runDir, { recursive: true });
    writeFileSync(rcPath, initFile({ rc, rows, cols }), { mode: 0o600 });
  }
  // A non-bash shell gets no init file: `--rcfile` is bash's spelling, and guessing another shell's would
  // be a way to break a person's login shell rather than to frame it. Such a session runs unframed.
  const invocation = bash ? `${shell} --rcfile ${sq(rcPath)} -i` : shell;
  const child = spawn("script", ["-qfc", invocation, "/dev/null"], {
    cwd,
    env: { TERM: "xterm-256color", ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let promptFrom = null;

  function onMark(mark) {
    // Only the semantic-prompt marks prove the shell is framed. OSC 7 is emitted by plenty of things that
    // say nothing about the prompt, and taking it as proof let the first command be written before the
    // shell had a prompt up at all.
    if (mark.kind !== "alt" && mark.kind !== "cwd") framed = true;
    switch (mark.kind) {
      case "prompt-start":
        promptFrom = mark.at;
        break;
      case "command-start":
        if (promptFrom !== null) addSkip(promptFrom, mark.end);
        promptFrom = null;
        atPrompt = true;
        break;
      case "command-end":
        if (internalBusy) {
          addSkip(internalFrom, mark.end);
          internalBusy = false;
        } else {
          running = false;
          holder = null;
          lastExit = mark.exit;
          endAt = mark.at;
          endCursor = mark.end;
          endToken = cmdToken;
        }
        break;
      case "cwd":
        cwdNow = mark.cwd;
        break;
      default:
        break;
    }
    if (pendingResize && !running && !internalBusy) {
      const want = pendingResize;
      pendingResize = null;
      queueMicrotask(() => void applyResize(want.rows, want.cols));
    }
  }

  /** The unframed path: the marker is a printed line, so it is looked for in the text rather than parsed
   *  out of an escape. Only the tail of what came before is carried, so a long build is not re-scanned. */
  function scanLegacy(from, text) {
    const a = legacyActive;
    const buf = a.carry + text;
    const base = from - a.carry.length;
    const hit = a.parse(buf);
    if (hit) {
      a.hit = { at: base + hit.at, end: base + hit.end, exit: hit.exit, cwd: hit.cwd };
      running = false;
      holder = null;
      lastExit = hit.exit;
      if (hit.cwd) cwdNow = hit.cwd;
      endToken = cmdToken;
      return;
    }
    const keep = a.marker.length + 300;
    a.carry = buf.length > keep ? buf.slice(buf.length - keep) : buf;
  }

  function onData(text) {
    if (!text) return;
    const from = bytes;
    append(text);
    lastOutputAt = Date.now();
    lastActivityAt = lastOutputAt;
    for (const mark of parser.feed(text)) onMark(mark);
    if (legacyActive && legacyActive.hit === null) scanLegacy(from, text);
    emit({ type: "output", id, from, text, bytes });
    notify();
    maybeEmitState();
  }

  let closeTimer = null;
  function finish(code) {
    if (closed) return;
    closed = true;
    closedAt = Date.now();
    exitCode = code;
    running = false;
    holder = null;
    clearInterval(ticker);
    clearTimeout(closeTimer);
    if (bash) rmSync(rcPath, { force: true });
    notify();
    maybeEmitState();
    emit({ type: "closed", id, exit: code });
  }

  child.stdout.on("data", (b) => onData(decoder.write(b)));
  child.stderr.on("data", (b) => log(`terminal: session ${id}: ${String(b).trim()}`));
  child.on("error", (e) => {
    log(`terminal: session ${id} failed to start: ${e?.message ?? e}`);
    finish(null);
  });
  child.on("exit", (code, signal) => finish(code ?? (signal ? 128 : null)));

  const assertOpen = () => {
    if (closed) throw new Error(`session ${sessionName} is closed${exitCode === null ? "" : ` (exit ${exitCode})`}; open another one.`);
  };

  function writeRaw(text) {
    assertOpen();
    lastActivityAt = Date.now();
    child.stdin.write(text);
  }

  function busyMessage() {
    const who = holder === "person" ? "the person is" : "you are";
    return `the session is busy: ${who} running ${JSON.stringify(command)}. Collect its output with shell_read, answer it with shell_send, or stop it with shell_interrupt.`;
  }

  /** Resolves once the shell has a framed prompt up, or the grace has passed and it has not. */
  const framingSettled = waitUntil(() => atPrompt || closed, FRAMING_GRACE_MS);

  /** Nothing is written into the gap between a command ending and the next prompt appearing. */
  const atPromptOrNotFramed = () => (framed ? waitUntil(() => atPrompt || closed, PROMPT_SETTLE_MS) : Promise.resolve(true));

  // ---- one command, written and waited for ----
  async function submitAndWait(line, { holder: who = "agent", waitMs, consumer } = {}) {
    const beforeCwd = cwdNow;
    // The cursor is remembered, not clamped: the drop is counted after the wait, because the command
    // itself is the most likely thing to have pushed the reader off the back of the ring.
    const requested = cursorOf(consumer);

    let sent = line;
    if (framed) {
      legacyActive = null;
    } else {
      const marker = legacyMarker(`${id}_${++legacySeq}`);
      sent = line + marker.suffix;
      legacyActive = { marker: marker.marker, parse: marker.parse, carry: "", hit: null };
    }

    const token = ++cmdToken;
    atPrompt = false;
    running = true;
    holder = who;
    command = line;
    since = Date.now();
    lastOutputAt = Date.now();
    writeRaw(`${sent}\n`);
    maybeEmitState();

    const finished = await waitUntil(() => closed || (!running && endToken === token), waitMs);
    const done = finished && !closed;

    const hit = legacyActive?.hit ?? null;
    const stop = !done ? bytes : framed ? endAt ?? bytes : hit ? hit.at : bytes;
    const resume = !done ? bytes : framed ? endCursor ?? bytes : hit ? hit.end : bytes;
    const output = stripEcho(forAgent(Math.max(requested, ringStart), stop), sent, !framed);
    setCursor(consumer, resume);
    maybeEmitState();
    return {
      exit: done ? lastExit : null,
      running: !done && !closed,
      output,
      cwd: cwdNow,
      moved: cwdNow !== beforeCwd,
      dropped: Math.max(0, ringStart - requested),
    };
  }

  async function applyResize(r, c) {
    wantRows = r;
    wantCols = c;
    // The flag goes up before the wait, so a command cannot slip in while this one is waiting for the
    // prompt that a deferred resize was woken by the end of.
    internalBusy = true;
    await atPromptOrNotFramed();
    if (closed) {
      internalBusy = false;
      return;
    }
    internalFrom = bytes;
    atPrompt = false;
    writeRaw(`stty rows ${r} cols ${c}\n`);
    // A framed shell ends the command with a mark, which also closes the hidden region. An unframed one
    // has no mark, so the region is closed on a settle instead.
    if (framed) await waitUntil(() => !internalBusy || closed, RESIZE_WAIT_MS);
    else await settle(SEND_SETTLE_MS);
    if (internalBusy) {
      addSkip(internalFrom, bytes);
      internalBusy = false;
    }
    maybeEmitState();
  }

  return {
    id,
    conversation,
    get name() {
      return sessionName;
    },
    get closed() {
      return closed;
    },
    get bytes() {
      return bytes;
    },
    get dropped() {
      return ringStart;
    },
    get running() {
      return running;
    },
    get framed() {
      return framed;
    },
    /** Milliseconds since anything happened here: output, a write, or a read. The idle reaper's input. */
    get idleMs() {
      return Date.now() - lastActivityAt;
    },
    get size() {
      return { rows: wantRows, cols: wantCols };
    },

    state,

    /** Subscribe to `output`, `state` and `closed`. Returns the unsubscribe. */
    onEvent(handler) {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },

    /** The host owns the count of attached browsers; the session only reports it. */
    setWatchers(n) {
      if (n === watchers) return;
      watchers = n;
      lastActivityAt = Date.now();
      maybeEmitState();
    },

    rename(next) {
      sessionName = String(next);
      maybeEmitState();
      return state();
    },

    /** Everything still held, for a browser that has just attached. */
    buffer(from = ringStart) {
      return { from: Math.max(from, ringStart), text: slice(from, bytes), bytes, dropped: Math.max(0, ringStart - from) };
    },

    /**
     * Run one command and wait for the mark that says it finished. The command is **not** killed when the
     * wait runs out: it keeps running, `running: true` says so, and `read` collects the rest.
     */
    async run(cmd, { cwd: where, timeoutMs, background = false, consumer } = {}) {
      assertOpen();
      await framingSettled;
      // Checked before the waits as well as after them: a session that is already busy must be refused
      // now, not after two seconds of waiting for a prompt that the running command is holding.
      if (running) throw new Error(busyMessage());
      await waitUntil(() => !internalBusy || closed, RESIZE_WAIT_MS);
      await atPromptOrNotFramed();
      assertOpen();
      if (running) throw new Error(busyMessage());
      const waitMs = timeoutMs ?? (background ? SEND_SETTLE_MS : DEFAULT_WAIT_MS);
      // `moved` is measured across the whole call, so a `cwd` argument that changed the directory is
      // reported as a move even though the command that ran after it did not change anything.
      const beforeCwd = cwdNow;
      if (where && where !== cwdNow) {
        const cd = await submitAndWait(`cd -- ${sq(where)}`, { holder: "agent", waitMs: CD_WAIT_MS, consumer });
        // A `cd` that failed is the answer: the command was never run, and saying otherwise would be a lie
        // about where it ran.
        if (cd.running || cd.exit !== 0) return cd;
        await atPromptOrNotFramed(); // the command goes in at the prompt the `cd` came back to, not before it
      }
      const out = await submitAndWait(cmd, { holder: "agent", waitMs, consumer });
      return { ...out, moved: cwdNow !== beforeCwd };
    },

    /** What has arrived since this consumer last looked. Waits for something new, or for a running
     *  command to finish, whichever comes first. */
    async read(consumer, { waitMs = 0 } = {}) {
      const requested = cursorOf(consumer);
      const wasRunning = running;
      await waitUntil(() => closed || bytes > requested || (wasRunning && !running), waitMs);
      if (wasRunning && running && !closed) await waitUntil(() => closed || !running, END_MARK_GRACE_MS);
      const output = forAgent(Math.max(requested, ringStart), bytes);
      setCursor(consumer, bytes);
      lastActivityAt = Date.now();
      return { output, running, exit: running ? null : lastExit, dropped: Math.max(0, ringStart - requested) };
    },

    /** Raw input: a passphrase, a `y`, a line for a REPL, or a person's keystrokes from the browser. */
    async write(text, { submit = false, settleMs = SEND_SETTLE_MS, holder: who = "person", consumer } = {}) {
      assertOpen();
      const requested = consumer ? cursorOf(consumer) : bytes;
      // A submit on a framed shell starts a command, and we know whose it is because it came through here.
      // On an unframed shell nothing is claimed: there is no mark to say when it ended.
      if (submit && framed && !running && !internalBusy) {
        running = true;
        holder = who;
        command = text;
        since = Date.now();
        cmdToken++;
      }
      if (submit) atPrompt = false;
      writeRaw(submit ? `${text}\n` : text);
      maybeEmitState();
      await settle(settleMs);
      const output = forAgent(Math.max(requested, ringStart), bytes);
      setCursor(consumer, bytes);
      maybeEmitState();
      return { output, running, exit: running ? null : lastExit, dropped: Math.max(0, ringStart - requested) };
    },

    /** The interrupt character on the pty. The line discipline delivers SIGINT to the foreground process
     *  group, so the runaway dies and the shell lives. */
    async interrupt({ settleMs = INTERRUPT_SETTLE_MS, consumer } = {}) {
      assertOpen();
      const requested = consumer ? cursorOf(consumer) : bytes;
      writeRaw(INTERRUPT_CHAR);
      await settle(settleMs);
      const output = forAgent(Math.max(requested, ringStart), bytes);
      setCursor(consumer, bytes);
      maybeEmitState();
      return { output, running, exit: running ? null : lastExit, dropped: Math.max(0, ringStart - requested) };
    },

    /**
     * Node cannot set a pty's window size without a native module and this repository has no runtime
     * dependency, so a resize is an `stty` written to the session's own tty. It can only be written when
     * nothing is running, so a resize during a command is deferred to the next idle and the answer says
     * which happened. A full-screen program already running does not learn the new size; it learns it when
     * it next starts.
     */
    async resize(r, c) {
      assertOpen();
      const rr = Math.trunc(Number(r));
      const cc = Math.trunc(Number(c));
      if (!(rr > 0) || !(cc > 0)) throw new Error("resize needs a positive number of rows and columns.");
      if (running || internalBusy) {
        pendingResize = { rows: rr, cols: cc };
        return { applied: false, deferred: true, rows: rr, cols: cc, reason: "a command is running; the size is set when it ends" };
      }
      await applyResize(rr, cc);
      return { applied: true, deferred: false, rows: rr, cols: cc };
    },

    async close() {
      if (closed) return state();
      child.kill("SIGTERM");
      closeTimer = setTimeout(() => child.kill("SIGKILL"), CLOSE_GRACE_MS);
      closeTimer.unref?.();
      await waitUntil(() => closed, CLOSE_GRACE_MS + 1_000);
      if (!closed) finish(null); // the child outlived SIGKILL's delivery; the session is gone either way
      return state();
    },
  };
}
