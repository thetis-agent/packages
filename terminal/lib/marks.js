// Framing a stream that never ends. A shell's output is one long stream, so the only way to know where
// one command's output stops is to have the shell say so. We say it the way every modern terminal already
// does: OSC 133 (semantic prompt) for prompt-start, command-start and command-finished-with-this-status,
// and OSC 7 for the working directory, plus one private OSC, 7770, by which the shell reports the path of
// its own tty once, so a resize can be an ioctl on that device instead of a command typed into the shell.
// `initFile` writes the bash that emits them; `MarkParser` reads them back out of the pty's output.
//
// Two rules shape the parser. It never modifies the stream: the marks stay in the bytes that reach the
// ring buffer, because the browser's emulator consumes them and the person must see a clean transcript
// either way (stripping for the agent happens in session.js, which is the only consumer that is not an
// emulator). And it is strict about what counts as a mark: an escape a program printed itself must not be
// read as one, so a candidate is accepted only when its whole body matches a shape we emit. An escape
// split across two chunks is held until the rest arrives, which is the common case at 64 KiB pipe reads.
//
// `legacyMarker` is the honest degradation for a shell with no such hook (the person's shell is not bash,
// or their rc fights the prompt). It is the mechanism the legacy host used for every command: a printf
// appended to the command line. It can only report the status of a command the host itself sent, which is
// exactly why it is the fallback and not the design.

/** An OSC body longer than this is not one of ours; stop holding the stream for it. Ours are under 4 KiB
 *  because the longest is a working directory path, and PATH_MAX is 4096. */
export const OSC_MAX_BODY = 4096;
/** A CSI longer than this is malformed; the longest real one is a handful of parameters. */
export const CSI_MAX = 64;

/** Single-quote a string for bash: end the quote, escape the quote, start it again. */
const sq = (s) => `'${String(s).replaceAll("'", "'\\''")}'`;

/**
 * The bash init file for one session, passed as `--rcfile`. It sources the person's own rc first, so
 * their aliases, prompt and functions are all there, and only then wraps the prompt.
 *
 * PROMPT_COMMAND is appended to, never replaced: ours goes on the front to capture `$?` before the
 * person's own hook can clobber it, and on the back to emit the mark, with the person's in between and
 * their `$?` preserved by the `return`. Bash 5.1 made PROMPT_COMMAND an array, so both shapes are handled.
 *
 * `rows`/`cols` are set here rather than sent as a command because a command would be echoed into the
 * person's transcript before they had done anything. The line after it reports the shell's tty path once,
 * so that a resize after this point can be an `stty -F <path>` from a sibling process and echo nothing
 * either (session.js).
 */
export function initFile({ rc, rows = 24, cols = 120 } = {}) {
  return [
    "# Written by @thetis/terminal for one session. Not a file to edit: it is rewritten on every open.",
    `[ -t 0 ] && stty rows ${Number(rows) | 0} cols ${Number(cols) | 0} 2>/dev/null`,
    "[ -t 0 ] && printf '\\033]7770;tty=%s\\007' \"$(tty)\" 2>/dev/null",
    rc ? `[ -r ${sq(rc)} ] && . ${sq(rc)}` : "# no rc file for this person",
    // History expansion off, and after the person's rc so it cannot turn it back on. With it on, a `!` in
    // an ordinary command line (`grep "Failed!"`) makes bash refuse the whole line, and a refused line
    // skips PROMPT_COMMAND, so no command-finished mark ever comes. A person who wants `!!` can `set -H`.
    "set +H",
    "__thetis_pre() { __thetis_st=$?; return $__thetis_st; }",
    "__thetis_post() {",
    "  local s=${__thetis_st:-0}",
    // The working directory is announced before the command-finished mark, not after it. The mark is what
    // a reader waits on, so anything sent after it arrives too late to be part of the answer: a `cd` would
    // report the directory it started in.
    "  printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"$PWD\"",
    // The first prompt is not the end of a command, so the boot flag swallows one D. Without it every
    // session would open by reporting a command that finished successfully and never ran.
    "  if [ -n \"$__thetis_boot\" ]; then unset __thetis_boot; else printf '\\033]133;D;%s\\033\\\\' \"$s\"; fi",
    "  return $s",
    "}",
    "__thetis_boot=1",
    "__thetis_pcdecl=$(declare -p PROMPT_COMMAND 2>/dev/null)",
    "case \"$__thetis_pcdecl\" in",
    "  \"declare -a\"*) PROMPT_COMMAND=(__thetis_pre \"${PROMPT_COMMAND[@]}\" __thetis_post) ;;",
    "  \"\") PROMPT_COMMAND=$'__thetis_pre\\n__thetis_post' ;;",
    "  *) PROMPT_COMMAND=$'__thetis_pre\\n'\"${PROMPT_COMMAND}\"$'\\n__thetis_post' ;;",
    "esac",
    "unset __thetis_pcdecl",
    // \[ \] tell readline the escapes take no width; without them the shell miscounts the prompt and
    // line editing corrupts itself as soon as a command is longer than the terminal is wide.
    "PS1='\\[\\033]133;A\\033\\\\\\]'\"${PS1:-\\$ }\"'\\[\\033]133;B\\033\\\\\\]'",
    "",
  ].join("\n");
}

/** Where an OSC body ends. BEL and ST terminate it; a newline or a stray ESC means it was never one. */
function findOscEnd(buf, from) {
  for (let j = from; j < buf.length; j++) {
    const c = buf[j];
    if (c === "\u0007") return { status: "found", bodyEnd: j, next: j + 1 };
    if (c === "\u001b") {
      if (j + 1 >= buf.length) return { status: "need-more" };
      if (buf[j + 1] === "\\") return { status: "found", bodyEnd: j, next: j + 2 };
      return { status: "abandon", next: j };
    }
    if (c === "\n" || c === "\r") return { status: "abandon", next: j };
  }
  return { status: "need-more" };
}

/** Where a CSI ends: the first byte in 0x40-0x7E. */
function findCsiEnd(buf, from) {
  for (let j = from; j < buf.length; j++) {
    const c = buf.charCodeAt(j);
    if (c >= 0x40 && c <= 0x7e) return j;
  }
  return -1;
}

/** The private OSC number the init file reports the shell's tty through. Private-use, and unknown to
 *  every emulator, which drops it. */
export const TTY_OSC = 7770;
/** The only paths a tty report is believed for: a pty slave or a console device. Anything else — a
 *  program printing our own escape with a path of its choosing — is ignored rather than handed to `stty -F`. */
const TTY_PATH = /^\/dev\/(pts\/\d+|tty[A-Za-z0-9]*)$/;

/** A mark, or null when the body is some other program's escape. Strict on purpose: see the head comment. */
function parseOsc(body) {
  if (body.startsWith("133;")) {
    const parts = body.split(";");
    const what = parts[1];
    if (what === "A") return { kind: "prompt-start" };
    if (what === "B") return { kind: "command-start" };
    if (what === "C") return { kind: "command-executed" };
    if (what === "D") {
      if (parts.length === 2) return { kind: "command-end", exit: null };
      if (parts.length === 3 && /^-?\d+$/.test(parts[2])) return { kind: "command-end", exit: Number(parts[2]) };
      return null;
    }
    return null;
  }
  if (body.startsWith("7;file://")) {
    const rest = body.slice("7;file://".length);
    const slash = rest.indexOf("/");
    if (slash === -1) return null;
    const host = rest.slice(0, slash);
    let path = rest.slice(slash);
    try {
      path = decodeURIComponent(path);
    } catch {
      // A path with a stray % is not URL-encoded; take it as it came rather than refusing the mark.
    }
    return { kind: "cwd", cwd: path, host };
  }
  if (body.startsWith(`${TTY_OSC};tty=`)) {
    const path = body.slice(`${TTY_OSC};tty=`.length);
    return TTY_PATH.test(path) ? { kind: "tty", path } : null;
  }
  return null;
}

/**
 * Fed the session's output in whatever chunks arrive, yields the marks it recognises. Every mark carries
 * `at` and `end`, absolute offsets into the stream fed so far, so the session can cut the prompt and the
 * mark itself out of what it hands the agent without touching the buffer the person sees.
 *
 * It also tracks the alternate screen buffer, because a full-screen program holding the terminal is a
 * fact the host must show and cannot otherwise know: prompt marks stop arriving and nothing says why.
 */
export class MarkParser {
  #pending = "";
  #base = 0;
  #alt = false;

  /** True while a full-screen program has the terminal. */
  get altScreen() {
    return this.#alt;
  }

  /** How many characters have been fed, including the ones still held as a partial escape. */
  get offset() {
    return this.#base + this.#pending.length;
  }

  /** @returns {Array<object>} the marks found in this chunk, in order. */
  feed(chunk) {
    const marks = [];
    const buf = this.#pending + chunk;
    const base = this.#base;
    let i = 0;
    while (i < buf.length) {
      const esc = buf.indexOf("\u001b", i);
      if (esc === -1) {
        i = buf.length;
        break;
      }
      if (esc + 1 >= buf.length) {
        i = esc; // the byte that says what kind of escape this is has not arrived
        break;
      }
      const kind = buf[esc + 1];
      if (kind === "]") {
        const end = findOscEnd(buf, esc + 2);
        if (end.status === "need-more") {
          if (buf.length - esc > OSC_MAX_BODY) {
            i = esc + 2;
            continue;
          }
          i = esc;
          break;
        }
        if (end.status === "abandon") {
          i = end.next;
          continue;
        }
        const mark = parseOsc(buf.slice(esc + 2, end.bodyEnd));
        if (mark) marks.push({ ...mark, at: base + esc, end: base + end.next });
        i = end.next;
        continue;
      }
      if (kind === "[") {
        const fin = findCsiEnd(buf, esc + 2);
        if (fin === -1) {
          if (buf.length - esc > CSI_MAX) {
            i = esc + 2;
            continue;
          }
          i = esc;
          break;
        }
        const body = buf.slice(esc + 2, fin);
        const final = buf[fin];
        if (body === "?1049" && (final === "h" || final === "l")) {
          this.#alt = final === "h";
          marks.push({ kind: "alt", on: this.#alt, at: base + esc, end: base + fin + 1 });
        }
        i = fin + 1;
        continue;
      }
      i = esc + 1; // any other escape: step past the ESC and keep looking
    }
    this.#pending = buf.slice(i);
    this.#base = base + i;
    return marks;
  }
}

/**
 * The fallback for a shell that will not carry the marks. `suffix` is appended to the command line the
 * host sends; `parse` finds the line it prints. It is deliberately a printed line and not an escape: an
 * unframed shell may be anything, and a printf is the one thing every shell has.
 *
 * It reports the status of the host's own commands and nothing else. A command the person typed carries
 * no suffix, so nothing is claimed about it.
 */
export function legacyMarker(id) {
  const safe = String(id).replace(/[^A-Za-z0-9_]/g, "");
  const marker = `__thetis_mark_${safe}__`;
  return {
    marker,
    suffix: `; printf '%s\\t%s\\t%s\\n' '${marker}' "$?" "$PWD"`,
    /**
     * The first marker line in `text`, or null. `at` is where the line starts and `end` where it ends,
     * so the caller can cut it out of what it shows. The marker must start a line, which the echo of the
     * command that carries it never does.
     */
    parse(text) {
      const re = new RegExp(`(?:^|[\\r\\n])(${marker}\\t(-?\\d+)\\t([^\\r\\n]*))(?:\\r?\\n|$)`);
      const m = re.exec(text);
      if (!m) return null;
      const at = m.index + m[0].indexOf(m[1]);
      return { exit: Number(m[2]), cwd: m[3], at, end: m.index + m[0].length, line: m[1] };
    },
  };
}
