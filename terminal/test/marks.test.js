// The escape parser, with no shell involved: the four marks, an escape split across two chunks, and the
// escapes a program prints itself, which must never be read as a mark.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initFile, legacyMarker, MarkParser } from "../lib/marks.js";

const ESC = "\u001b";
const BEL = "\u0007";
const osc = (body) => `${ESC}]${body}${ESC}\\`;

test("a prompt start and a command start are found, with their offsets", () => {
  const p = new MarkParser();
  const marks = p.feed(`${osc("133;A")}me@host:/tmp$ ${osc("133;B")}`);
  assert.deepEqual(marks.map((m) => m.kind), ["prompt-start", "command-start"]);
  assert.equal(marks[0].at, 0);
  assert.equal(marks[1].end, p.offset);
});

test("a command that finished carries the status the shell reported", () => {
  const p = new MarkParser();
  const [mark] = p.feed(`out${osc("133;D;130")}`);
  assert.equal(mark.kind, "command-end");
  assert.equal(mark.exit, 130);
  assert.equal(mark.at, 3);
});

test("a finish with no status says so rather than guessing zero", () => {
  const [mark] = new MarkParser().feed(osc("133;D"));
  assert.equal(mark.kind, "command-end");
  assert.equal(mark.exit, null);
});

test("the working directory comes out of OSC 7, host and path apart", () => {
  const [mark] = new MarkParser().feed(osc("7;file://dev/tank/data/Dev"));
  assert.equal(mark.kind, "cwd");
  assert.equal(mark.host, "dev");
  assert.equal(mark.cwd, "/tank/data/Dev");
});

test("a percent-encoded path is decoded, and a stray percent is taken as it came", () => {
  assert.equal(new MarkParser().feed(osc("7;file://dev/tmp/a%20b"))[0].cwd, "/tmp/a b");
  assert.equal(new MarkParser().feed(osc("7;file://dev/tmp/100%done"))[0].cwd, "/tmp/100%done");
});

test("the shell's tty report is a mark, with its path", () => {
  const bel = new MarkParser().feed(`${ESC}]7770;tty=/dev/pts/3${BEL}`);
  assert.deepEqual(bel.map((m) => [m.kind, m.path]), [["tty", "/dev/pts/3"]]);
  const st = new MarkParser().feed(osc("7770;tty=/dev/pts/12"));
  assert.deepEqual(st.map((m) => [m.kind, m.path]), [["tty", "/dev/pts/12"]]);
  assert.equal(new MarkParser().feed(osc("7770;tty=/dev/ttyS0"))[0].path, "/dev/ttyS0");
});

test("a tty report with a path outside /dev is ignored rather than handed to stty", () => {
  const p = new MarkParser();
  const bad = [osc("7770;tty=/tmp/not-a-tty"), osc("7770;tty=/dev/pts/../sda"), osc("7770;tty=not a tty"), osc("7770;tty="), osc("7770;/dev/pts/1")];
  assert.deepEqual(p.feed(bad.join("")), []);
});

test("a BEL-terminated mark is read as well as an ST-terminated one", () => {
  const [mark] = new MarkParser().feed(`${ESC}]133;D;3${BEL}`);
  assert.equal(mark.exit, 3);
});

test("an escape split across two chunks is held until the rest arrives", () => {
  const p = new MarkParser();
  assert.deepEqual(p.feed(`hello${ESC}]133;D;`), []);
  const marks = p.feed(`7${ESC}\\world`);
  assert.deepEqual(marks.map((m) => m.kind), ["command-end"]);
  assert.equal(marks[0].exit, 7);
  // The offsets are absolute across the whole stream, not relative to the chunk they arrived in.
  assert.equal(marks[0].at, 5);
  assert.equal(p.offset, `hello${osc("133;D;7")}world`.length);
});

test("an escape split one character at a time still yields exactly one mark", () => {
  const p = new MarkParser();
  const stream = `x${osc("133;A")}y`;
  const found = [];
  for (const ch of stream) found.push(...p.feed(ch));
  assert.deepEqual(found.map((m) => m.kind), ["prompt-start"]);
  assert.equal(p.offset, stream.length);
});

test("the escapes a program prints itself are not marks", () => {
  const p = new MarkParser();
  const noise = [
    `${ESC}]0;a window title${BEL}`, // an OSC, but not one of ours
    `${ESC}[31mred${ESC}[0m`, // colour
    osc("133;Z"), // OSC 133 with a verb we do not emit
    osc("133;D;oops"), // a status that is not a number
    osc("7;https://example.invalid/x"), // OSC 7 with the wrong scheme
    "133;D;0 printed as plain text",
    `${ESC}]133;D;0 and then a newline with no terminator\nreal output`,
  ].join("");
  assert.deepEqual(p.feed(noise), []);
});

test("the alternate screen buffer is tracked both ways", () => {
  const p = new MarkParser();
  assert.equal(p.altScreen, false);
  assert.deepEqual(p.feed(`${ESC}[?1049h`).map((m) => m.on), [true]);
  assert.equal(p.altScreen, true);
  assert.deepEqual(p.feed(`${ESC}[?1049l`).map((m) => m.on), [false]);
  assert.equal(p.altScreen, false);
});

test("a CSI that is not the alternate screen changes nothing", () => {
  const p = new MarkParser();
  assert.deepEqual(p.feed(`${ESC}[?2004h${ESC}[2J${ESC}[1;31m`), []);
  assert.equal(p.altScreen, false);
});

test("the init file sources the person's rc and emits all four marks", () => {
  const text = initFile({ rc: "/home/someone/.bashrc", rows: 30, cols: 100 });
  assert.match(text, /\[ -r '\/home\/someone\/\.bashrc' \] && \. '\/home\/someone\/\.bashrc'/);
  assert.match(text, /stty rows 30 cols 100/);
  assert.match(text, /printf '\\033\]7770;tty=%s\\007' "\$\(tty\)"/, "the shell reports its tty once, so a resize can be an ioctl on it");
  assert.match(text, /133;A/);
  assert.match(text, /133;B/);
  assert.match(text, /133;D;%s/);
  assert.match(text, /\]7;file:\/\/%s%s/);
});

test("the init file appends to PROMPT_COMMAND instead of clobbering it, in both of bash's shapes", () => {
  const text = initFile({ rc: null });
  assert.match(text, /PROMPT_COMMAND=\(__thetis_pre "\$\{PROMPT_COMMAND\[@\]\}" __thetis_post\)/);
  assert.match(text, /\$'__thetis_pre\\n'"\$\{PROMPT_COMMAND\}"\$'\\n__thetis_post'/);
  // The person's own PS1 survives: it is wrapped, not replaced.
  assert.match(text, /\$\{PS1:-/);
});

test("the init file turns history expansion off after the person's rc, so their rc cannot undo it", () => {
  const text = initFile({ rc: "/home/someone/.bashrc" });
  const rc = text.indexOf(". '/home/someone/.bashrc'");
  const off = text.indexOf("\nset +H\n");
  assert.ok(rc > 0 && off > rc);
});

test("a rc path with a quote in it is still quoted safely", () => {
  assert.match(initFile({ rc: "/home/o'brien/.bashrc" }), /'\/home\/o'\\''brien\/\.bashrc'/);
});

test("the legacy marker reports the status and directory of the command it was appended to", () => {
  const m = legacyMarker("a1");
  assert.match(m.suffix, /printf/);
  assert.ok(m.suffix.includes('"$?"') && m.suffix.includes('"$PWD"'));
  const hit = m.parse(`some output\n${m.marker}\t7\t/tank/data\nthe next prompt$ `);
  assert.equal(hit.exit, 7);
  assert.equal(hit.cwd, "/tank/data");
  assert.equal(hit.line, `${m.marker}\t7\t/tank/data`);
});

test("the legacy marker is not found in the echo of the command that carries it", () => {
  const m = legacyMarker("a1");
  assert.equal(m.parse(`ls -l${m.suffix}\r\n`), null);
});

test("the legacy marker id is made safe for a regular expression", () => {
  const m = legacyMarker("a.*b/c");
  assert.equal(m.marker.includes("."), false);
  assert.equal(m.parse(`${m.marker}\t0\t/tmp\n`).exit, 0);
});
