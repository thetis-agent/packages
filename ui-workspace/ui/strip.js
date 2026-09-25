/* The 26 px status strip under the file view: path, root and mode, language, size, the saved state, and on
 * the right the cursor, encoding and line ends. `mountStrip(host)` appends the strip and answers `set(state)`,
 * which merges a partial state, so the editor's cursor callback can send `{ cursor }` alone.
 *
 * State: `{ path, root, mode, language, size, saved, dirty, readOnly, cursor: { line, col }, encoding, eol }`.
 * `saved` is when the file was last written (ISO, ms or Date) and shows as "Saved <ago>"; `dirty` shows
 * "Unsaved changes" in the warn colour over it; `readOnly` shows "Read-only" over both. */

import { ago } from "./editor.js";
import { languageLabel } from "./lang.js";
import { formatSize } from "./viewer.js";

const TICK_MS = 30_000;

function rootWord(root) {
  const word = String(root ?? "");
  if (word === "home") return "Home";
  if (word === "shared") return "Shared";
  return word;
}

/** The text of the saved field for a state, exported for the tests. */
export function savedText(state, now = Date.now()) {
  if (state.readOnly) return "Read-only";
  if (state.dirty) return "Unsaved changes";
  if (state.saved == null) return "";
  const when = ago(state.saved, now);
  return when ? `Saved ${when}` : "Saved";
}

export function mountStrip(host) {
  const doc = host.ownerDocument;
  const span = (cls) => {
    const node = doc.createElement("span");
    node.className = cls;
    return node;
  };
  const fields = {
    path: span("ws-strip-path"),
    root: span("ws-strip-root"),
    language: span("ws-strip-lang"),
    size: span("ws-strip-size"),
    saved: span("ws-strip-saved"),
    cursor: span("ws-strip-cursor"),
    encoding: span("ws-strip-enc"),
    eol: span("ws-strip-eol"),
  };
  const strip = doc.createElement("div");
  strip.className = "ws-strip";
  const spacer = span("ws-strip-r");
  strip.append(fields.path, fields.root, fields.language, fields.size, fields.saved, spacer, fields.cursor, fields.encoding, fields.eol);
  host.append(strip);

  let state = {};

  function draw() {
    fields.path.textContent = state.path ?? "";
    fields.path.title = state.path ?? "";
    const root = rootWord(state.root);
    fields.root.textContent = root ? (state.mode ? `${root} · ${state.mode}` : root) : "";
    fields.language.textContent = state.language ? languageLabel(state.language) : "";
    fields.size.textContent = state.size != null ? formatSize(state.size) : "";
    fields.saved.textContent = savedText(state);
    fields.saved.classList.toggle("is-warn", Boolean(state.dirty) && !state.readOnly);
    fields.cursor.textContent = state.cursor ? `Ln ${state.cursor.line}, Col ${state.cursor.col}` : "";
    fields.encoding.textContent = state.encoding ?? "";
    fields.eol.textContent = state.eol ?? "";
    for (const node of Object.values(fields)) node.hidden = !node.textContent;
  }

  const timer = setInterval(() => {
    if (!state.dirty && !state.readOnly && state.saved != null) fields.saved.textContent = savedText(state);
  }, TICK_MS);

  draw();
  return {
    element: strip,
    set(next) {
      state = { ...state, ...next };
      draw();
    },
    clear() {
      state = {};
      draw();
    },
    destroy() {
      clearInterval(timer);
      strip.remove();
    },
  };
}
