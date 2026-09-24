// A real shell, on a real pty, in every test here: the mechanism is a pty and util-linux `script`, and a
// fake of either would be a test of the fake. Each test opens its own session and closes it, and none of
// them runs for longer than a few seconds.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { openSession } from "../lib/session.js";

async function withSession(t, options = {}) {
  const dir = await mkdtemp(resolve(tmpdir(), "thetis-term-"));
  const session = openSession({ id: "t" + Math.random().toString(16).slice(2, 8), cwd: dir, runDir: dir, ...options });
  t.after(async () => {
    await session.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { session, dir };
}

test("a command's exit status is the one the shell reported, not one we guessed", async (t) => {
  const { session } = await withSession(t);
  const ok = await session.run("echo hello", { consumer: "conv" });
  assert.equal(ok.exit, 0);
  assert.equal(ok.running, false);
  assert.equal(ok.output, "hello\n");

  const bad = await session.run("(exit 17)", { consumer: "conv" });
  assert.equal(bad.exit, 17);

  const missing = await session.run("ls /no/such/path/here", { consumer: "conv" });
  assert.ok(missing.exit > 0);
  assert.match(missing.output, /No such file or directory/);
});

test("a multiline submission waits for its final line and reports its complete output and status", async (t) => {
  const { session } = await withSession(t);
  const result = await session.run('printf "first\\n"\nsleep 0.2\nprintf "last\\n"; false', { consumer: "conv" });
  assert.equal(result.exit, 1);
  assert.equal(result.running, false);
  assert.equal(result.output, "first\nlast\n");
});

test("multiline heredocs and quoted text preserve the session's directory, variables and functions", async (t) => {
  const { session } = await withSession(t);
  const script = [
    "cd /usr",
    "export THETIS_TERMINAL_TEST='a b'",
    "greet() { printf '%s\\n' \"$THETIS_TERMINAL_TEST\"; }",
    "cat <<'DOC'",
    "quoted 'single' and \"double\", $literal and \\backslash",
    "DOC",
    "greet",
  ].join("\n");
  const result = await session.run(script, { consumer: "conv" });
  assert.equal(result.exit, 0);
  assert.equal(result.output, "quoted 'single' and \"double\", $literal and \\backslash\na b\n");
  const next = await session.run("pwd; greet; printenv THETIS_TERMINAL_TEST", { consumer: "conv" });
  assert.equal(next.output, "/usr\na b\na b\n");
});

test("a multiline submission that outlives its wait stays busy until its final line", async (t) => {
  const { session } = await withSession(t);
  const early = await session.run('printf "early\\n"\nsleep 0.5\nprintf "late\\n"; false', { consumer: "conv", timeoutMs: 100 });
  assert.equal(early.running, true);
  assert.equal(early.exit, null);
  await assert.rejects(session.run("echo overlapping", { consumer: "conv" }), /session is busy/);
  let rest;
  let output = early.output;
  do {
    rest = await session.read("conv", { waitMs: 2000 });
    output += rest.output;
  } while (rest.running);
  assert.equal(rest.exit, 1);
  assert.equal(output, "early\nlate\n");
});

test("a multiline fallback command keeps its marker out when Bash's finish mark appears later", async (t) => {
  // A narrow dumb terminal scrolls the initial prompt marks out of the display. The first call uses
  // the legacy marker, then sees Bash's command-end mark: completion must still use its own marker.
  const { session } = await withSession(t, { cols: 20, env: { TERM: "dumb" } });
  const output = "x".repeat(150);
  const result = await session.run(`printf '%s\\n' '${output}'\nfalse`, { consumer: "conv" });
  assert.equal(result.exit, 1);
  assert.equal(result.output, output + "\n");
});

test("multiline functions return normally, syntax errors finish, and the next command can run", async (t) => {
  const { session } = await withSession(t, { env: { TERM: "xterm-256color" } });
  const returned = await session.run("f() { printf 'before\\n'; return 7; printf 'after\\n'; }\nf", { consumer: "conv" });
  assert.equal(returned.exit, 7);
  assert.equal(returned.output, "before\n");
  const bad = await session.run("printf 'started\\n'\nif then", { consumer: "conv" });
  assert.equal(bad.exit, 2);
  assert.equal(bad.running, false);
  assert.match(bad.output, /syntax error/);
  const next = await session.run("printf 'still here\\n'", { consumer: "conv" });
  assert.equal(next.exit, 0);
  assert.equal(next.output, "still here\n");
});

test("a `!` in a command line is literal, not a history expansion", async (t) => {
  const { session } = await withSession(t);
  const result = await session.run('printf "%s\\n" "Failed!" | grep -E "Failed!|Passed!"', { consumer: "conv", timeoutMs: 5000 });
  assert.equal(result.running, false);
  assert.equal(result.exit, 0);
  assert.equal(result.rejected, false);
  assert.equal(result.output, "Failed!\n");
});

test("a line the shell refuses to run ends at once as not run, and the session stays usable", async (t) => {
  const { session } = await withSession(t);
  // History expansion is the known way to make bash refuse a line and skip PROMPT_COMMAND; a person
  // may turn it back on, so the refusal itself must still end the command.
  assert.equal((await session.run("set -H", { consumer: "conv" })).exit, 0);
  const started = Date.now();
  const refused = await session.run('echo "a!zzqq"', { consumer: "conv", timeoutMs: 20_000 });
  assert.ok(Date.now() - started < 10_000, "the refusal is the answer; it does not wait out the timeout");
  assert.equal(refused.running, false);
  assert.equal(refused.rejected, true);
  assert.equal(refused.exit, null, "a line that never ran has no status to report");
  assert.match(refused.output, /event not found/);
  const read = await session.read("conv");
  assert.equal(read.running, false);
  assert.equal(read.rejected, true);
  const next = await session.run("printf 'still here\\n'", { consumer: "conv" });
  assert.equal(next.exit, 0);
  assert.equal(next.rejected, false);
  assert.equal(next.output, "still here\n");
});

test("a shell with echo disabled keeps a literal less-than line in its output", async (t) => {
  const { session } = await withSession(t);
  await session.run("stty -echo", { consumer: "conv" });
  const result = await session.run("printf '<\\n'", { consumer: "conv" });
  assert.equal(result.exit, 0);
  assert.equal(result.output, "<\n");
});

test("a cd carries to the next command, and the move is reported", async (t) => {
  const { session } = await withSession(t);
  const moved = await session.run("cd /etc && pwd", { consumer: "conv" });
  assert.equal(moved.output, "/etc\n");
  assert.equal(moved.cwd, "/etc");
  assert.equal(moved.moved, true);

  const after = await session.run("pwd", { consumer: "conv" });
  assert.equal(after.output, "/etc\n");
  assert.equal(after.moved, false);
});

test("a cwd argument moves the session first, and a cwd that does not exist is the answer", async (t) => {
  const { session } = await withSession(t);
  const there = await session.run("pwd", { cwd: "/usr", consumer: "conv" });
  assert.equal(there.output, "/usr\n");
  assert.equal(there.moved, true);

  const nowhere = await session.run("pwd", { cwd: "/no/such/directory", consumer: "conv" });
  assert.notEqual(nowhere.exit, 0);
  assert.equal(nowhere.cwd, "/usr"); // the command never ran, and the session did not move
});

test("a command that outruns its wait keeps running and is collected later", async (t) => {
  const { session } = await withSession(t);
  const first = await session.run("echo early; sleep 2; echo late", { timeoutMs: 400, consumer: "conv" });
  assert.equal(first.running, true);
  assert.equal(first.exit, null, "no status is reported for a command that has not finished");
  assert.equal(first.output, "early\n");
  assert.equal(session.state().state, "busy");

  // A read answers as soon as something arrives, which may be one chunk before the finish mark, so the
  // collection is a loop: the point of the test is that the work was not thrown away.
  let rest = await session.read("conv", { waitMs: 4000 });
  let collected = rest.output;
  while (rest.running) {
    rest = await session.read("conv", { waitMs: 4000 });
    collected += rest.output;
  }
  assert.equal(rest.exit, 0);
  assert.match(collected, /late/);
  assert.doesNotMatch(collected, /early/, "what was already handed over is not handed over twice");
});

test("a second command while one is still running is refused, and says how to collect the first", async (t) => {
  const { session } = await withSession(t);
  await session.run("sleep 2", { timeoutMs: 300, consumer: "conv" });
  await assert.rejects(() => session.run("echo no", { consumer: "conv" }), /busy.*shell_read/s);
  await session.interrupt();
});

test("an interrupt ends the command and leaves the session alive", async (t) => {
  const { session } = await withSession(t);
  await session.run("sleep 30", { timeoutMs: 400, consumer: "conv" });
  assert.equal(session.running, true);

  const stopped = await session.interrupt({ consumer: "conv" });
  assert.equal(stopped.running, false);
  assert.equal(stopped.exit, 130, "the shell reported the status of a command killed by SIGINT");

  const alive = await session.run("echo still-here", { consumer: "conv" });
  assert.equal(alive.exit, 0);
  assert.equal(alive.output, "still-here\n");
  assert.equal(session.closed, false);
});

test("a ring buffer that drops says how much it dropped", async (t) => {
  const { session } = await withSession(t, { bufferBytes: 4096 });
  await session.run("echo warm", { consumer: "conv" });
  const big = await session.run("seq 1 4000", { consumer: "conv" });
  assert.ok(big.dropped > 0, "the command outran the ring, and the answer says by how much");
  assert.ok(big.output.length <= 4096 + 200);
  assert.match(big.output, /4000\n$/, "what survived is the end, which is the part that was not dropped");
  assert.equal(session.state().dropped, session.dropped);
  assert.ok(session.state().dropped > 0);
});

test("an unframed shell reports the host's own commands and claims nothing else", async (t) => {
  // /bin/sh is dash here: no bash init file, so no marks, so the legacy printf marker instead.
  const { session } = await withSession(t, { shell: "/bin/sh" });
  assert.equal(session.state().state, "unframed");

  const ok = await session.run("echo one", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(ok.exit, 0);
  assert.equal(ok.output, "one\n", "the marker line is cut out of what the agent is handed");

  const bad = await session.run("false", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(bad.exit, 1);

  const moved = await session.run("cd /etc && pwd", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(moved.cwd, "/etc");
  assert.equal(moved.moved, true);

  assert.equal(session.state().framed, false);
  assert.equal(session.state().state, "unframed", "an idle shell with no marks says so rather than saying idle");
});

test("the state word is computed from what was observed, and follows the command", async (t) => {
  const { session } = await withSession(t);
  await session.run("true", { consumer: "conv" });
  assert.equal(session.state().state, "idle");
  assert.equal(session.state().framed, true);

  await session.run("sleep 2", { timeoutMs: 300, consumer: "conv" });
  const busy = session.state();
  assert.equal(busy.state, "busy");
  assert.equal(busy.holder, "agent");
  assert.equal(busy.command, "sleep 2");
  assert.ok(busy.since <= Date.now());

  await session.interrupt();
  assert.equal(session.state().state, "idle");
  assert.equal(session.state().holder, null);
});

test("a command the person typed makes the session theirs, not the agent's", async (t) => {
  const { session } = await withSession(t);
  await session.run("true", { consumer: "conv" });
  await session.write("sleep 2", { submit: true, holder: "person", settleMs: 200 });
  const s = session.state();
  assert.equal(s.state, "person");
  assert.equal(s.holder, "person");
  assert.equal(s.command, "sleep 2");
  await session.interrupt();
});

test("a full-screen program is seen taking the terminal, and giving it back", async (t) => {
  const { session } = await withSession(t);
  await session.run("true", { consumer: "conv" });
  await session.write("printf '\\033[?1049h'", { submit: true, holder: "person", settleMs: 400 });
  assert.equal(session.state().state, "fullscreen");
  await session.write("printf '\\033[?1049l'", { submit: true, holder: "person", settleMs: 400 });
  assert.notEqual(session.state().state, "fullscreen");
});

test("a session knows its own tty, and it is the one the shell is on", async (t) => {
  const { session } = await withSession(t);
  const tty = await session.run("tty", { consumer: "conv" });
  const known = session.state().tty;
  assert.match(known, /^\/dev\/pts\/\d+$/, "the init file reported a pty slave");
  assert.equal(tty.output, `${known}\n`);
});

test("a resize while a command is running is applied at once, and the program running gets the size", async (t) => {
  const { session } = await withSession(t, { cols: 120 });
  await session.run("sleep 1; tput cols", { timeoutMs: 200, consumer: "conv" });
  assert.equal(session.running, true);
  const answer = await session.resize(33, 111);
  assert.deepEqual(answer, { applied: true, deferred: false, rows: 33, cols: 111 });

  let rest = await session.read("conv", { waitMs: 4000 });
  let collected = rest.output;
  while (rest.running) {
    rest = await session.read("conv", { waitMs: 4000 });
    collected += rest.output;
  }
  assert.equal(rest.exit, 0);
  assert.equal(collected.trim(), "111", "the tput after the sleep saw the size set during the sleep");
  assert.deepEqual(session.size, { rows: 33, cols: 111 }, "a reopen keeps the size");
});

test("a resize at idle is an ioctl on the device: nothing is printed, for the agent or the person", async (t) => {
  const { session } = await withSession(t);
  await session.run("true", { consumer: "conv" });
  await new Promise((r) => setTimeout(r, 300)); // the prompt after `true` is still being drawn when run answers
  const before = session.bytes;
  const applied = await session.resize(30, 90);
  assert.deepEqual({ applied: applied.applied, deferred: applied.deferred }, { applied: true, deferred: false });
  await new Promise((r) => setTimeout(r, 300));
  // What the pty printed is readline redrawing its prompt in place on SIGWINCH, as it does in any
  // terminal that was resized: carriage returns, an erase (ESC[K or spaces), and the prompt's marks.
  const raw = session.buffer(before).text;
  assert.doesNotMatch(raw, /stty/, "the raw buffer, which is what the person's emulator gets, has no stty in it");
  assert.match(raw, /^(\r(?:\u001b\[K| *)\r\u001b\]133;A.*\u001b\]133;B\u001b\\)?$/s, "a prompt redraw, or nothing");
  assert.equal((await session.read("conv", {})).output, "", "and the agent is handed nothing");

  const next = await session.run("tput lines; tput cols", { consumer: "conv" });
  assert.equal(next.output, "30\n90\n");
  assert.doesNotMatch(next.output, /stty/);
});

test("a shell without the rc reports no tty, and a resize during its command is deferred to the next idle", async (t) => {
  // /bin/sh is dash here: no init file, so no tty report, so the fallback — an stty typed at the prompt.
  const { session } = await withSession(t, { shell: "/bin/sh", cols: 120 });
  await session.run("true", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(session.state().tty, null);
  await session.run("sleep 1", { timeoutMs: 200, consumer: "conv" });
  const deferred = await session.resize(40, 100);
  assert.equal(deferred.applied, false);
  assert.equal(deferred.deferred, true);

  let rest = await session.read("conv", { waitMs: 4000 });
  while (rest.running) rest = await session.read("conv", { waitMs: 4000 });
  const cols = await session.run("tput cols", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(cols.output.trim(), "100");
});

test("a shell without the rc resized at idle types the stty, and the agent is not shown it", async (t) => {
  const { session } = await withSession(t, { shell: "/bin/sh" });
  await session.run("true", { timeoutMs: 5000, consumer: "conv" });
  const applied = await session.resize(30, 90);
  assert.deepEqual({ applied: applied.applied, deferred: applied.deferred }, { applied: true, deferred: false });
  assert.match(session.buffer(0).text, /stty rows 30 cols 90/, "the fallback is a real command in a real shell, and the person sees it");

  const next = await session.run("tput lines; tput cols", { timeoutMs: 5000, consumer: "conv" });
  assert.equal(next.output, "30\n90\n");
  assert.doesNotMatch(next.output, /stty/, "the stty this package sent for its own reasons is not the agent's business");
});

test("every consumer holds its own cursor, and nothing consumes", async (t) => {
  const { session } = await withSession(t);
  await session.run("echo alpha", { consumer: "agent" });
  const browser = await session.read("ui:1", {});
  assert.match(browser.output, /alpha/, "a reader that has never looked is given what the ring still holds");

  await session.run("echo beta", { consumer: "agent" });
  const again = await session.read("ui:1", {});
  assert.match(again.output, /beta/);
  assert.doesNotMatch(again.output, /alpha/);
});

test("the raw buffer keeps the marks the agent's text has had cut out of it", async (t) => {
  const { session } = await withSession(t);
  const answer = await session.run("echo clean", { consumer: "conv" });
  assert.equal(answer.output, "clean\n");
  const raw = session.buffer(0).text;
  assert.ok(raw.includes("]133;A"), "the browser's emulator still gets the prompt marks");
  assert.ok(raw.includes("]133;D;0"));
  assert.ok(raw.includes("echo clean"), "and the echo of the command, which is what the person saw");
});

test("a closed session says it is closed and refuses to be written to", async (t) => {
  const { session } = await withSession(t);
  await session.run("true", { consumer: "conv" });
  const closing = [];
  session.onEvent((e) => e.type === "closed" && closing.push(e));
  const state = await session.close();
  assert.equal(state.state, "closed");
  assert.ok(state.closedAt);
  assert.equal(closing.length, 1);
  await assert.rejects(() => session.run("echo no"), /closed/);
});

test("a subscriber sees the output as it arrives, with the offset it arrived at", async (t) => {
  const { session } = await withSession(t);
  const seen = [];
  session.onEvent((e) => e.type === "output" && seen.push(e));
  await session.run("echo streamed", { consumer: "conv" });
  assert.ok(seen.length > 0);
  assert.ok(seen.some((e) => e.text.includes("streamed")));
  assert.equal(seen[0].from, 0);
  for (const e of seen) assert.equal(typeof e.bytes, "number");
});
