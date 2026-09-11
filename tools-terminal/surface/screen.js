/* A small terminal screen: enough of the protocol for what a command actually emits here.
 *
 * No xterm.js. The library was measured first — 283 KB of emulator plus a stylesheet, which does fit
 * both the 4 MiB per-file bound and the CSP, since it is a same-origin classic script that evaluates
 * nothing — and the reason not to take it is fit rather than size. Commands here run on ordinary
 * pipes with no controlling terminal (../commands.ts), so programs see a non-tty and emit
 * line-oriented output: newlines, carriage returns rewriting a progress line, backspaces, and SGR
 * colour from the ones that colour anyway. Cursor addressing, the alternate screen, reflow and
 * wide-character measurement — most of what that 283 KB is — would never arrive. What is here is the
 * part that does, and it is small enough to be tested line by line.
 *
 * The model is a scrollback of lines rather than a fixed grid: there is no row count to address
 * against when the dock is resizable, so vertical moves clamp inside the buffer and `H` is read as
 * "go to this column". A line is two parallel arrays, characters and style keys, so a run of one
 * style is found by comparing keys rather than by comparing objects per character.
 */

export const limits = { lines: 2000, columns: 4000, render: 800, tab: 8 };

const BOLD = 1, DIM = 2, ITALIC = 4, UNDERLINE = 8, INVERSE = 16;
const PLAIN = "-1|-1|0";
/** The sixteen named colours come from theme.css through a class, so the surface's own palette
 *  governs them; anything beyond is resolved to a literal here and set through CSSOM, which the CSP
 *  allows and a `style=` attribute would not. */
const NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white"];
const STEPS = [0, 95, 135, 175, 215, 255];

export function blank() {
  return { lines: [line()], row: 0, col: 0, fg: -1, bg: -1, flags: 0, saved: null, pending: "" };
}

function line() { return { chars: [], keys: [] }; }
function keyOf(screen) { return `${String(screen.fg)}|${String(screen.bg)}|${String(screen.flags)}`; }

/** Advances to the next line, growing the buffer and dropping the oldest when it is full. */
function feed(screen) {
  screen.row++;
  while (screen.lines.length <= screen.row) screen.lines.push(line());
  if (screen.lines.length > limits.lines) {
    screen.lines.splice(0, screen.lines.length - limits.lines);
    screen.row = screen.lines.length - 1;
  }
}

function put(screen, character) {
  if (screen.col >= limits.columns) { feed(screen); screen.col = 0; }
  const row = screen.lines[screen.row];
  while (row.chars.length < screen.col) { row.chars.push(" "); row.keys.push(PLAIN); }
  row.chars[screen.col] = character;
  row.keys[screen.col] = keyOf(screen);
  screen.col++;
}

/** Selects graphic rendition. An unknown parameter is skipped rather than aborting the run: a colour
 *  nobody here reads is better ignored than turned into visible escape soup. */
function sgr(screen, parameters) {
  const values = parameters.length ? parameters : [0];
  for (let at = 0; at < values.length; at++) {
    const code = values[at];
    if (code === 0) { screen.fg = -1; screen.bg = -1; screen.flags = 0; }
    else if (code === 1) screen.flags |= BOLD;
    else if (code === 2) screen.flags |= DIM;
    else if (code === 3) screen.flags |= ITALIC;
    else if (code === 4) screen.flags |= UNDERLINE;
    else if (code === 7) screen.flags |= INVERSE;
    else if (code === 22) screen.flags &= ~(BOLD | DIM);
    else if (code === 23) screen.flags &= ~ITALIC;
    else if (code === 24) screen.flags &= ~UNDERLINE;
    else if (code === 27) screen.flags &= ~INVERSE;
    else if (code >= 30 && code <= 37) screen.fg = code - 30;
    else if (code === 39) screen.fg = -1;
    else if (code >= 40 && code <= 47) screen.bg = code - 40;
    else if (code === 49) screen.bg = -1;
    else if (code >= 90 && code <= 97) screen.fg = code - 90 + 8;
    else if (code >= 100 && code <= 107) screen.bg = code - 100 + 8;
    else if (code === 38 || code === 48) {
      const extended = values[at + 1];
      const value = extended === 5 ? values[at + 2]
        : extended === 2 ? ((values[at + 2] << 16) + (values[at + 3] << 8) + values[at + 4] + 256) : undefined;
      at += extended === 5 ? 2 : extended === 2 ? 4 : 0;
      if (value === undefined || !Number.isFinite(value)) continue;
      if (code === 38) screen.fg = value; else screen.bg = value;
    }
  }
}

function eraseLine(screen, mode) {
  const row = screen.lines[screen.row];
  if (mode === 1) {
    for (let at = 0; at <= screen.col && at < row.chars.length; at++) { row.chars[at] = " "; row.keys[at] = PLAIN; }
    return;
  }
  if (mode === 2) { row.chars.length = 0; row.keys.length = 0; return; }
  row.chars.length = Math.min(row.chars.length, screen.col);
  row.keys.length = Math.min(row.keys.length, screen.col);
}

function erase(screen, mode) {
  if (mode === 2 || mode === 3) { screen.lines = [line()]; screen.row = 0; screen.col = 0; return; }
  if (mode === 1) { for (let at = 0; at < screen.row; at++) screen.lines[at] = line(); eraseLine(screen, 1); return; }
  screen.lines.length = screen.row + 1;
  eraseLine(screen, 0);
}

/** The control sequences a piped command still emits. Anything else is consumed and dropped. */
function control(screen, parameters, final) {
  const first = parameters[0] ?? 0;
  const count = Math.max(first, 1);
  const row = screen.lines[screen.row];
  if (final === "m") sgr(screen, parameters);
  else if (final === "K") eraseLine(screen, first);
  else if (final === "J") erase(screen, first);
  else if (final === "A") screen.row = Math.max(0, screen.row - count);
  else if (final === "B") screen.row = Math.min(screen.lines.length - 1, screen.row + count);
  else if (final === "C") screen.col += count;
  else if (final === "D") screen.col = Math.max(0, screen.col - count);
  else if (final === "G" || final === "`") screen.col = Math.max(0, count - 1);
  else if (final === "H" || final === "f") screen.col = Math.max(0, (parameters[1] ?? 1) - 1);
  else if (final === "P") { row.chars.splice(screen.col, count); row.keys.splice(screen.col, count); }
  else if (final === "@") for (let at = 0; at < count; at++) { row.chars.splice(screen.col, 0, " "); row.keys.splice(screen.col, 0, PLAIN); }
  else if (final === "s") screen.saved = { row: screen.row, col: screen.col };
  else if (final === "u" && screen.saved) { screen.row = Math.min(screen.saved.row, screen.lines.length - 1); screen.col = screen.saved.col; }
}

/** Consumes one escape sequence starting at `at`; returns where to carry on, or -1 when it is cut
 *  off at the end of this chunk and has to wait for the next read. */
function escape(screen, text, at) {
  const introducer = text[at + 1];
  if (introducer === undefined) return -1;
  if (introducer === "[") {
    let end = at + 2;
    while (end < text.length && !/[@-~]/.test(text[end])) end++;
    if (end >= text.length) return -1;
    const body = text.slice(at + 2, end);
    // A private sequence (`?25l`, `?1049h`) addresses a screen this renderer does not have.
    if (!body.startsWith("?") && !body.startsWith(">")) {
      control(screen, body.split(";").map((part) => (part === "" ? 0 : Number.parseInt(part, 10) || 0)), text[end]);
    }
    return end + 1;
  }
  if (introducer === "]") {
    const bell = text.indexOf("\x07", at);
    const terminator = text.indexOf("\x1b\\", at + 2);
    if (bell === -1 && terminator === -1) return -1;
    if (bell !== -1 && (terminator === -1 || bell < terminator)) return bell + 1;
    return terminator + 2;
  }
  // Two-byte escapes: charset selection, index, keypad mode. None of them mean anything here.
  if ("()#%".includes(introducer)) return text[at + 2] === undefined ? -1 : at + 3;
  return at + 2;
}

/** Folds one chunk of a command's output into the screen. Anything cut off at the end is held for
 *  the next chunk, because a read stops on a byte count and an escape sequence does not. */
export function write(screen, chunk) {
  const text = screen.pending + chunk;
  screen.pending = "";
  let at = 0;
  while (at < text.length) {
    const character = text[at];
    if (character === "\x1b") {
      const next = escape(screen, text, at);
      if (next === -1) { screen.pending = text.slice(at, at + 64); return screen; }
      at = next; continue;
    }
    at++;
    if (character === "\n") { feed(screen); screen.col = 0; }
    else if (character === "\r") screen.col = 0;
    else if (character === "\b") screen.col = Math.max(0, screen.col - 1);
    else if (character === "\t") { const stop = screen.col + limits.tab - (screen.col % limits.tab); while (screen.col < stop) put(screen, " "); }
    else if (character === "\f" || character === "\v") { feed(screen); screen.col = 0; }
    else if (character >= " " && character !== "\x7f") put(screen, character);
  }
  return screen;
}

/** Resolves a style key to the class list and the literal colours a span needs. */
export function styleOf(key) {
  const [rawFg, rawBg, flags] = key.split("|").map(Number);
  const classes = [];
  if (flags & BOLD) classes.push("bold");
  if (flags & DIM) classes.push("dim");
  if (flags & ITALIC) classes.push("italic");
  if (flags & UNDERLINE) classes.push("under");
  const inverse = Boolean(flags & INVERSE);
  const pairs = inverse ? [["color", rawBg], ["background-color", rawFg]] : [["color", rawFg], ["background-color", rawBg]];
  const literal = {};
  for (const [slot, value] of pairs) {
    if (value < 0) { if (inverse) literal[slot] = slot === "color" ? "var(--term-bg)" : "var(--term-fg)"; continue; }
    if (value < 16) { classes.push(`${slot === "color" ? "f" : "b"}-${value >= 8 ? "bright-" : ""}${NAMES[value % 8]}`); continue; }
    literal[slot] = hex(value);
  }
  return { classes, literal };
}

/** The xterm 256-colour cube and grey ramp, and the truecolor values `38;2` carries, as literals. */
export function hex(value) {
  if (value >= 256) {
    const rgb = value - 256;
    return `#${[(rgb >> 16) & 255, (rgb >> 8) & 255, rgb & 255].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
  }
  if (value >= 232) { const grey = (8 + (value - 232) * 10).toString(16).padStart(2, "0"); return `#${grey}${grey}${grey}`; }
  const index = value - 16;
  return `#${[STEPS[Math.floor(index / 36) % 6], STEPS[Math.floor(index / 6) % 6], STEPS[index % 6]].map((part) => part.toString(16).padStart(2, "0")).join("")}`;
}

/** Draws the tail of the screen into a fragment: one span per run of one style, plain text
 *  otherwise. Only the last `limits.render` lines are built — the rest is scrollback nobody is
 *  looking at, and rebuilding it on every poll is how a busy command makes the page stutter. */
export function draw(screen) {
  const fragment = document.createDocumentFragment();
  const from = Math.max(0, screen.lines.length - limits.render);
  for (let index = from; index < screen.lines.length; index++) {
    const row = screen.lines[index];
    let at = 0;
    while (at < row.chars.length) {
      let end = at;
      while (end < row.chars.length && row.keys[end] === row.keys[at]) end++;
      const text = row.chars.slice(at, end).join("");
      if (row.keys[at] === PLAIN) fragment.append(document.createTextNode(text));
      else {
        const { classes, literal } = styleOf(row.keys[at]);
        const span = document.createElement("span");
        if (classes.length) span.className = classes.join(" ");
        for (const [slot, value] of Object.entries(literal)) span.style.setProperty(slot, value);
        span.append(document.createTextNode(text));
        fragment.append(span);
      }
      at = end;
    }
    if (index < screen.lines.length - 1) fragment.append(document.createTextNode("\n"));
  }
  return fragment;
}

/** The plain text of the screen, which is what a test can assert against without a DOM. */
export function textOf(screen) {
  return screen.lines.map((row) => row.chars.join("")).join("\n");
}
