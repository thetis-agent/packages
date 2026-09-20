/* The emulator, and the only file in this package that names it. Everything else here speaks of a screen:
 * a thing with an element, that takes bytes and gives back keystrokes. If the vendored xterm.js is ever
 * dropped for a small renderer, this file is replaced and nothing else in the package changes.
 *
 * Three shapes in here are deliberate. The module is imported lazily, by the first session that appears,
 * because it is 345 KiB and a person who never opens a shell must never fetch it. The element is made at
 * once but the terminal is opened into it only when it is in the document, because xterm measures a cell
 * to render and a detached element measures zero; writes that arrive before either happens are held and
 * flushed in order, so no output is lost between the first chunk and the first paint. And the palette
 * comes from theme.css, read back through the cascade: xterm wants colours as strings and cannot resolve
 * a custom property itself. Every --term-* token is a plain hex literal for exactly this reason — a
 * color-mix() would arrive here unresolved and be rejected. The probe element stays for one job only,
 * measuring a cell of the font the way the emulator measures it. */

const FALLBACK_FONT = 'ui-monospace, "SF Mono", Menlo, Consolas, monospace';
// Typography has to be set on the emulator: xterm measures a cell from these and positions every glyph
// absolutely, so a CSS font-size on the pane would shift the text out of the grid it drew. Looser than
// xterm's default line height: dense output is the drawer's normal state, and 1.25 packed it into a slab
// that was hard to scan a line of.
const FONT_SIZE = 12.5;
const LINE_HEIGHT = 1.45;
const SCROLLBACK = 5000;
const SCROLLBAR = 14; // xterm's viewport keeps a scrollbar; the columns must not sit under it
const MIN_COLS = 20;
const MIN_ROWS = 2;
const SAMPLE = 32; // W's per measurement, as the emulator itself uses: one character rounds badly

let loading = null;          // the one import of the vendored module, shared by every screen
const live = new Set();      // every screen now on the page, so a scheme change re-themes all of them
let probe = null;            // one hidden span: it resolves colours and measures a cell

/** Imports the vendored emulator once. The first session pays for it; every later one does not. */
function load() {
  if (!loading) loading = import("./vendor/xterm.js").then((mod) => mod.Terminal);
  return loading;
}

function probeNode() {
  if (!probe || !probe.isConnected) {
    probe = document.createElement("span");
    probe.className = "term-probe";
    probe.setAttribute("aria-hidden", "true");
    document.body.append(probe);
  }
  return probe;
}

/** The emulator's palette, from the --term-* tokens in theme.css: the terminal's own warm neutrals and
 *  desaturated hues, the same in both colour schemes, because a terminal is a dark device set into the page. */
function theme() {
  const css = getComputedStyle(document.documentElement);
  const tok = (name, fallback) => css.getPropertyValue(name).trim() || fallback;
  return {
    background: tok("--term-bg", "#141414"),
    foreground: tok("--term-fg", "#d4d4d4"),
    cursor: tok("--term-cursor", "#a3b8cc"),
    cursorAccent: tok("--term-bg", "#141414"),
    selectionBackground: tok("--term-selection", "#2f4a3a"),
    black: tok("--term-black", "#232323"),
    red: tok("--term-red", "#e387a7"),
    green: tok("--term-green", "#3a8e5b"),
    yellow: tok("--term-yellow", "#d9b48a"),
    blue: tok("--term-blue", "#81a1c1"),
    magenta: tok("--term-magenta", "#e394dc"),
    cyan: tok("--term-cyan", "#82d2ce"),
    white: tok("--term-white", "#d4d4d4"),
    brightBlack: tok("--term-bright-black", "#5a5a5a"),
    brightRed: tok("--term-bright-red", "#f0a3bd"),
    brightGreen: tok("--term-bright-green", "#70b489"),
    brightYellow: tok("--term-bright-yellow", "#e8cba6"),
    brightBlue: tok("--term-bright-blue", "#a3bcd6"),
    brightMagenta: tok("--term-bright-magenta", "#f0b3ea"),
    brightCyan: tok("--term-bright-cyan", "#a0e0dd"),
    brightWhite: tok("--term-bright-white", "#f0f0f0"),
  };
}

/** The font the terminal is drawn in: the page's monospace stack at the drawer's own size. */
function fontOf() {
  const css = getComputedStyle(document.documentElement);
  const family = css.getPropertyValue("--mono").trim() || FALLBACK_FONT;
  return { family, size: FONT_SIZE };
}

/**
 * One cell of the terminal's font, measured rather than guessed: there is no fit addon, so the pane is
 * divided by this. It is measured the way the emulator measures it — a run of W's at the natural line
 * height, divided by their number, and the height then multiplied by the line height the terminal is
 * given — so the rows and columns chosen here are the rows and columns it draws. A cell guessed from the
 * font size alone comes out short, and the last lines of the screen end up under the bottom edge.
 */
function cellOf(font) {
  const node = probeNode();
  node.style.setProperty("font-family", font.family);
  node.style.setProperty("font-size", `${font.size}px`);
  node.style.setProperty("line-height", "normal");
  node.textContent = "W".repeat(SAMPLE);
  const box = node.getBoundingClientRect();
  node.textContent = "";
  return { width: box.width / SAMPLE, height: box.height * LINE_HEIGHT };
}

/**
 * One screen for one session. `onData` gets every keystroke and paste; `onReady(error)` is called once the
 * module has resolved, so the view can redraw and size itself, or say why there is no picture.
 */
export function createScreen(id, { onData, onReady } = {}) {
  const element = document.createElement("div");
  element.className = "term-pane";
  const font = fontOf();
  let term = null;
  let held = [];             // what the session printed before the module arrived
  let opened = false;
  let failure = null;
  let size = { rows: 0, cols: 0 };
  let gone = false;
  let frozen = false;   // the session closed: the picture stays, the keyboard does not

  load().then((Terminal) => {
    if (gone) return;
    build(Terminal);
  }, (err) => fell(err));

  /** Everything that can go wrong with the emulator ends in `fell`, so the pane says why instead of staying blank. */
  function fell(err) {
    if (gone) return;
    failure = err?.message || "the emulator did not load";
    held = [];
    term = null;
    if (onReady) onReady(err);
  }

  function build(Terminal) {
    try {
      term = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: !frozen,
        disableStdin: frozen,
        fontFamily: font.family,
        fontSize: font.size,
        lineHeight: LINE_HEIGHT,
        scrollback: SCROLLBACK,
        theme: theme(),
      });
      term.onData((text) => onData && onData(text));
      for (const piece of held) {
        if (piece === null) term.reset();
        else term.write(piece);
      }
      held = [];
      if (element.isConnected) show();
    } catch (err) {
      return fell(err);
    }
    if (onReady) onReady(null);
  }

  function show() {
    if (!term || opened) return;
    term.open(element);
    opened = true;
  }

  const screen = {
    id,
    element,

    /** Why there is no picture, or null. A screen that failed still holds its place in the pane. */
    failure: () => failure,

    write(text) {
      if (gone || failure) return;
      if (term) term.write(text);
      else held.push(text);
    },

    /** The eraser: the view is wiped, the shell keeps running, and what arrives next starts at the top. */
    clear() {
      if (gone || failure) return;
      if (term) term.clear();
      else held = [];
    },

    /** The whole ring buffer is arriving: what is on the screen is not the session's output any more. */
    reset() {
      if (gone || failure) return;
      if (term) term.reset();
      else held = [null];
    },

    attach(parent) {
      parent.append(element);
      show();
      if (opened) term.refresh(0, term.rows - 1); // re-attached from another pane: repaint what is there
    },

    /** Takes the element out of the page and leaves the terminal alone: the scrollback is the session's. */
    detach() {
      element.remove();
    },

    /**
     * Divides the pane by a cell and resizes the terminal. Answers the new size when it changed, so the
     * caller sends one `resize` to the shell and no more; null when nothing changed or the pane has no
     * size yet (the shelf is closed, or this session is not the one on screen).
     */
    fit() {
      if (!term || gone || !element.isConnected) return null;
      const box = element.getBoundingClientRect();
      const cell = cellOf(font);
      if (!cell.width || !cell.height || box.width < 40 || box.height < 20) return null;
      const cols = Math.max(MIN_COLS, Math.floor((box.width - SCROLLBAR) / cell.width));
      const rows = Math.max(MIN_ROWS, Math.floor(box.height / cell.height));
      if (cols === size.cols && rows === size.rows) return null;
      size = { rows, cols };
      term.resize(cols, rows);
      return { rows, cols };
    },

    focus() {
      if (opened) term.focus();
    },

    /**
     * The session closed. The picture and its scrollback stay — the last screenful is usually why it
     * closed — and the terminal stops taking keys, so a dead prompt cannot appear to accept them: the
     * cursor stops blinking, which is the visible half of what the pane's note says in words.
     */
    freeze() {
      if (frozen) return;
      frozen = true;
      if (!term) return; // the module has not arrived yet; `build` reads the flag when it does
      term.options.disableStdin = true;
      term.options.cursorBlink = false;
    },

    /** The page changed colour scheme. The palette is baked into the emulator, so it is handed a new one. */
    retheme(next) {
      if (term) term.options.theme = next;
    },

    dispose() {
      gone = true;
      live.delete(screen);
      element.remove();
      try {
        term?.dispose();
      } catch (err) {
        console.error("@thetis/terminal: an emulator threw while closing:", err);
      }
      term = null;
    },
  };

  live.add(screen);
  return screen;
}

// The page follows the browser's colour scheme with no reload. The --term-* tokens are the same in both
// schemes today, but the palette is baked into the emulator, not inherited from the CSS, so a scheme that
// does override them is still followed by every open terminal.
try {
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    const next = theme();
    for (const screen of live) screen.retheme(next);
  });
} catch {
  /* an older browser: the terminals keep the palette they opened with */
}
