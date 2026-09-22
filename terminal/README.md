# @thetis/terminal

Long-lived shell sessions inside one person's own fence: five tools for the model, and the shelf that shows the same sessions live in the browser, so the person and the agent stand at the same prompt. It is a `tool` package with a `service` and a `ui`, plain ECMAScript with no build step and no runtime dependency of its own. Everything it runs — the shells, the session table, the socket — lives inside the person's fence, and nothing is added to the kernel.

It replaces the one-shot `exec` with something that keeps its state: a `cd`, a virtualenv, an `ssh-agent` or a half-finished rebase carries over from one call to the next; a command that asks for a passphrase can be answered; a command that outlives its wait keeps running instead of being killed; and while it runs, the person watches it happen.

## The session model

A session is a real pty: `script -qfc "<shell>" /dev/null`, which is util-linux on the read-only `/usr` every fence has. A pty is the whole point — line editing, job control, colour, programs that behave as they do for a person, and an interrupt that is a keystroke, delivered by the line discipline to the foreground process group only, so the runaway dies and the shell that owns the session does not. Bash is started with an init file the package writes, which sources the person's own rc and then wraps the prompt so the shell announces four things with the escapes every modern terminal already uses (OSC 133 and OSC 7): the prompt has started, the command line has ended, the command finished with this status, and the working directory is now this. So **every** command is framed, whoever typed it; the framing is invisible, because the emulator consumes it; and busy, idle, `person` and `fullscreen` are observed rather than guessed. A shell that will not carry the marks degrades honestly: the host appends the legacy marker to the commands it sends, the session is flagged `unframed`, and every surface says so instead of claiming an exit status it does not have. Each session holds a ring buffer of its last output and a counter that only goes up; every reader — this conversation, each open browser — holds an offset into that counter, nothing consumes, and a reader whose offset has fallen off the back is told how many characters it lost.

Three parts in two processes, and one socket between them. The service holds the session table and listens on `<root>/run/term.sock`; the tools run in the userspace agent; the `ui` commands run in the person's gateway. Module state cannot be shared between two processes, and must not be relied on inside one of them either, so both sides ask the one process that holds the sessions. The socket is `0600` inside the person's own userspace, and the host takes no user argument: the isolation is structural, as it is for the operator channel.

The transcript lives in the agent process's memory and nowhere else. It is not written to disk and not sent to the journal, because a shell holds whatever was pasted into it and a passphrase typed into a session must not outlive it. The journal gets one line per session opened and closed, with no command text.

## What it provides

The manifest declares `service.export: "startTerminals"`, five `tools`, and a `ui` block with `dir: "ui"`, `entry: "index.js"`, `style: "index.css"`, one `shelf` entry, one chat-bar `chips` entry and eight commands.

| Tool | Arguments | Answer |
|---|---|---|
| `shell` | `cmd`, `session?`, `cwd?`, `timeoutMs?`, `background?` | The exit status (`exit 0`), then what the command printed, then the notes. A command that outlives its wait is not killed: the answer says it is still running and how to collect it. `background` starts it and answers at once. `cwd` runs one command elsewhere without moving the session; relative to the home unless absolute. |
| `shell_read` | `session?`, `waitMs?` | What has arrived since this conversation's last read, and whether anything is running now and with what status the last thing ended. |
| `shell_send` | `text`, `session?`, `submit?` | Writes raw input — a passphrase, a `y`, a line for a REPL — and answers with what the session printed in the moment after. `submit` defaults to true. |
| `shell_interrupt` | `session?` | The interrupt character. Says whether the session is idle again, or that something is still running. |
| `shell_sessions` | `close?` | This conversation's sessions, one line each: name and id, what it is doing and for how long, where it is, whether output was dropped, and whether the person has the terminal open in their browser. `close` ends one instead. |

Every tool means this conversation's own session unless `session` names another, and opens it on the first command that needs one. `session` takes an id or a name as `shell_sessions` prints them. The notes on an answer are the facts the model would otherwise miss: a working directory that moved, output that fell out of the buffer before it was read, a shell that reports no exit statuses, and — the point of a session two people share — **that the person typed in it**, which is reported rather than pushed into the prompt.

A refusal comes back as `error: <sentence>`, so the transcript shows a failed call. When the host is not running the client's own sentence goes through untouched, because it already says what a person can do about it.

| Slot | Id | Label |
|---|---|---|
| `shelf` | `terminal` | Terminals — the drawer in the bottom dock under the conversation, which shortens it rather than covering it. |
| `chips` | `terminal` | The chip in every chat bar: `2 terminals`, or `Terminal` when there are none, which toggles the drawer. |

The drawer is the legacy terminal drawer's look and structure on a real pty: the emulator on the left, a compact list of shells on the right (a dot for the state, the name, the last segment of the directory, `exited` on a closed row), a footer with the chosen shell's full directory and one sentence about it, an interrupt on a busy row, a details card, a two-step close, and a rename by double-click. The input is always enabled — including while the agent holds the prompt, because that is how a person answers the question the agent's command asked. A shell appearing in the open conversation opens the drawer by itself; switching conversations closes it and reopens it when the new one has shells; nothing takes the focus from the composer. The shelf's chrome — the grip, the head with **+** and the eraser before collapse and hide, the animated height kept across reloads — is the gateway's.

Eight commands, each any signed-in person's, each acting on their own fence alone. Seven answer `{ data }`; the eighth streams.

| Verb | Export | Arguments | Answer |
|---|---|---|---|
| `sessions` | `uiSessions` | none | `{ sessions }` — every session of the fence, not one conversation's. |
| `open` | `uiOpen` | `conversation?`, `name?`, `cwd?` | `{ session }` |
| `write` | `uiWrite` | `id`, `text` | `{}`. Keystrokes as the emulator made them; a burst ending in a carriage return is submitted as a command, so the session learns whose it is. |
| `interrupt` | `uiInterrupt` | `id` | `{}` |
| `resize` | `uiResize` | `id`, `rows`, `cols` | `{ applied, deferred }`. Normally `applied: true`: the size is set on the session's tty from outside the shell, at once, whether or not something is running. `applied: false, deferred: true` is the fallback for a shell that reported no tty: a command is running and the size is typed at the next prompt. |
| `close` | `uiClose` | `id` | `{}` |
| `rename` | `uiRename` | `id`, `name` | `{ session }` |
| `watch` | `uiWatch` | `screens?` | Streams. See below. |

`watch` is declared `stream: true` and is an async generator over `GET /api/ext/@thetis/terminal/watch/stream`. It yields four kinds of value and nothing else: `{ ev: "sessions", sessions }` when it opens and whenever a session is added or gone; `{ ev: "output", id, seq, text, replace? }`, where `seq` is that session's output counter **after** the chunk, so a value the page has already written can be recognised and dropped; `{ ev: "state", session }` when one session's word changes; and `{ ev: "closed", id, exit }`. The first three are the rows, a few hundred bytes a session, and every subscription carries them. `output` is the screens, and only a subscription opened with `args.screens: true` carries it: with the flag, each session's whole ring buffer arrives at subscription time as one chunk with `replace: true`, so a drawer that opens in the middle of a build sees the last screenful and a reconnect is a redraw that costs nothing; without it, nothing is replayed and the host's output events are dropped before they cost a frame. The page holds one subscription for its lifetime and asks for the screens only while the drawer is on screen — the flag is read once, when the stream opens, so the drawer opening or closing swaps the subscription for one with the other flag — which keeps a page with the drawer closed, and every reconnect of one, to the rows. Output is batched on a 50 ms tick, one frame per session, because the gateway applies no backpressure and a `yes` loop must not become a value per write; everything else is yielded as it happens, and what is held for a session goes out in front of it. The subscription has a connection of its own, closed in a `finally` when `env.signal` fires, so a browser that walks away leaves nothing behind.

Every ui command and the stream act as a browser: their cursor key is `ui:`-prefixed, which is what makes the host report `person` rather than `busy` when someone types, and what keeps a browser's answer out of the cap that bounds a tool's. A tool never sends one.

The state word is computed where the truth is, and every surface says the same one:

| State | The row says | The repair in the row |
|---|---|---|
| `idle` | the working directory | Close |
| `busy` | `you are running cargo test · 14s` | Interrupt |
| `busy-quiet` | `cargo test · no output for 20s` | Interrupt |
| `person` | `you are running vim` | Interrupt |
| `fullscreen` | `a full-screen program has the terminal` | Interrupt |
| `unframed` | `this shell does not report exit codes` | — |
| `closed` | `closed · exit 130` | Reopen |

## Configuration

`config.packages["@thetis/terminal"]`, read per fence and read in `lib/host.js` alone. All optional:

| Key | Default | Meaning |
|---|---|---|
| `shell` | `/bin/bash` | The program. A shell that carries no prompt marks is allowed, and flagged `unframed`. |
| `sessions` | `8` | Sessions open at once, per person. |
| `bufferBytes` | `262144` | The ring buffer, per session. |
| `idleMinutes` | `30` | Close a session after this long with no attached viewer and no running command. `0` disables it. |
| `waitMs` | `120000` | What `shell` waits before it answers that a command is still running, when the call names no `timeoutMs`. |

## Limits

| Limit | Value | Why |
|---|---|---|
| Sessions per person | 8 | A person's fence is the unit, not a conversation. |
| Ring buffer | 256 KiB per session | Under one screenful of a verbose build was the legacy mistake; this is a few. |
| One tool answer | 30,000 characters, head and tail kept, the middle counted | The cap `env.exec` already uses. A browser's answer is not capped: it is streaming anyway. |
| Default wait for `shell` | 120,000 ms | What `env.exec` waits. Unlike `exec`, nothing is killed when it runs out. |
| Idle close | 30 minutes | Nothing watching and nothing running. |
| Transcript on disk | none | Memory only, and gone with the fence. |

Two limitations stated rather than hidden. **A resize is an `stty -F <tty>` from a sibling process**, because Node cannot set a pty's window size without a native module and this repository has no runtime dependency: the init file reports the shell's tty once through a private OSC, and the size is set on that device from outside the shell — nothing typed, nothing echoed, `SIGWINCH` to whatever is running, so a full-screen program redraws at once. A shell that reported no tty (not bash, so no init file) gets the fallback: an `stty` typed at the next prompt, deferred while a command runs, and the row says so; a program already running in such a shell keeps its old size until it next starts. **A session does not survive its fence closing**: a mount change (`host.grants.mountsSet`), a workspace reload or a daemon restart closes the fence and everything in it, and the shelf says the session closed rather than pretending to reattach.

Left out on purpose: remote sessions over ssh (that crosses the fence's egress and authority model, and a person can `ssh` inside a session), a session shared between two people (a session lives in one fence), and the transcript kept across reloads. The file tools remain the cheaper and safer way to read and change a file, and the tool descriptions say so.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the service, the five tools, the shelf, the chip, the eight commands, the bench declaration. |
| `index.js` | The service export, the five tools, the eight ui commands, and the one connection this process holds. Argument checks only. |
| `lib/session.js` | One session: the pty, the marks, the ring buffer, the cursors, write, resize (an `stty -F` on the reported tty, or the typed fallback), interrupt, close, and the state word. |
| `lib/host.js` | The session table, the socket server, the line protocol, subscribe and broadcast, the limits, the idle reaper. |
| `lib/client.js` | Connect, request, subscribe — used by both processes. |
| `lib/marks.js` | The init file written for a session, and the parser for its escapes, the tty report among them. |
| `ui/index.js` | `install(ext)`: the shelf registration, the chip in the chat bar, the one `watch` subscription the whole page shares (the rows always, the screens while the drawer is open), and the two rules that open and close the drawer. |
| `ui/shelf.js`, `ui/screen.js`, `ui/index.css` | The drawer's body (the list, the pane, the footer, the card, the popover), the emulator wrapper, the styles on the `--term-*` tokens. |
| `ui/vendor/` | The emulator. See below. |
| `test/session.test.js`, `test/host.test.js`, `test/marks.test.js`, `test/watch.test.js` | The tests. |

`ui/vendor/` holds a vendored copy of `@xterm/xterm` (MIT), unmodified, with its `LICENSE` beside it: about 280 KiB of JS and 5 KiB of CSS, loaded on the first session, so a person who never opens a shell never fetches it. It is the first third-party runtime file in this repository, and it is here because a writable terminal will really be asked to run `less`, `git rebase -i` and `vim`, and because every hand-rolled emulator turns a build log into escape soup. `ui/screen.js` is the only file that names it. See `ui/vendor/README.md` for the version and how to update it.

## Tests

`npm test` from the runtime root, or `node --test "test/*.test.js"` here: `test/session.test.js` (spawn, exit status, a working directory carried over, a command that outruns its wait and is collected later, an interrupt that leaves the session alive, a ring buffer that drops and says so, an unframed shell, the session's own tty, a resize during a command that the running program sees and one at idle that prints nothing, and the typed fallback in a shell without the rc), `test/host.test.js` (the socket, the session limit, two consumers with independent cursors, the idle reaper, close on fence close, who typed read from the cursor key, a resize over the socket and the deferred fallback), `test/marks.test.js` (the escape parser, including one split across two chunks and one inside command output, and the tty report) and `test/watch.test.js` (the `watch` stream over a real host: the rows alone without `screens`, on connect and on a reconnect, and the replay marked `replace` with it). The gateway's stream route has its own tests in `@thetis/gateway-web`, and the browser checklist is `packages/gateway-web/test/BROWSER.md`.
