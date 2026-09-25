/* The text editor of the Workspace place: CodeMirror 6 from `./vendor/`, dressed by `editor.css` alone.
 *
 * `createEditor(host, opts)` answers synchronously with the API and mounts the view once the core bundle has
 * loaded (`api.ready`). Calls that need the view before then are queued, so a caller may `goTo` right after
 * `createEditor` without awaiting. The grammar loads after the first paint through a Compartment: a 200 KB
 * TypeScript file shows its text at once and colours a moment later.
 *
 * What the editor knows about the file is `opts.file`: the `stat` data plus `text` and `etag`. The loaded
 * text is the reference for dirtiness (doc !== loaded), for the changed-lines gutter and for the diff in the
 * conflict banner; it moves only when a save succeeds, a reload happens or Load theirs is chosen.
 *
 * The pure helpers (`changedLines`, `unifiedDiff`, `detectEol`, `ago`) are exported for the tests and import
 * nothing from the DOM. */

import { loadCore, loadLanguage } from "./lang.js";
import { isWithin, nameOf, rootOf } from "./model.js";

const POLL_MS = 5000;
const DIFF_DEBOUNCE_MS = 200;
const BUFFER_DEBOUNCE_MS = 400;

const ICON_WARN = ["M10 3l7.5 13h-15z", "M10 8v4M10 14v.5"];
const ICON_LOCK = ["M5 10.5a1.5 1.5 0 0 1 1.5-1.5h7a1.5 1.5 0 0 1 1.5 1.5v5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 5 15.5z", "M7 9V6.5a3 3 0 0 1 6 0V9"];
const ICON_ERR = ["M10 3.5a6.5 6.5 0 1 1 0 13a6.5 6.5 0 0 1 0-13z", "M10 6.5v4M10 13v.5"];

/* ---------- pure helpers ---------- */

function splitLines(text) {
  return String(text ?? "").split("\n");
}

/**
 * The common prefix and suffix, in lines, of two texts. Everything between is "the change". No LCS: one
 * edit anywhere is marked exactly, two edits far apart mark the span between them, which is what a gutter
 * bar is for and costs O(n) on every keystroke of a large file.
 */
function bounds(a, b) {
  let prefix = 0;
  const max = Math.min(a.length, b.length);
  while (prefix < max && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  const room = max - prefix;
  while (suffix < room && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

/**
 * 1-based line numbers in `after` that differ from `before`: changed and inserted lines, and for a pure
 * deletion the line now standing where the deleted lines were (so a removal still leaves a mark).
 */
export function changedLines(before, after) {
  if (before === after) return [];
  const a = splitLines(before);
  const b = splitLines(after);
  const { prefix, suffix } = bounds(a, b);
  const lines = [];
  const end = b.length - suffix;
  for (let i = prefix; i < end; i++) lines.push(i + 1);
  if (!lines.length) lines.push(Math.min(prefix + 1, b.length));
  return lines;
}

/** A unified diff of the two texts around the changed span, with `context` lines either side. */
export function unifiedDiff(before, after, { context = 3, names = ["theirs", "mine"] } = {}) {
  if (before === after) return "";
  const a = splitLines(before);
  const b = splitLines(after);
  const { prefix, suffix } = bounds(a, b);
  const from = Math.max(0, prefix - context);
  const aEnd = a.length - suffix;
  const bEnd = b.length - suffix;
  const aTo = Math.min(a.length, aEnd + context);
  const bTo = Math.min(b.length, bEnd + context);
  const out = [`--- ${names[0]}`, `+++ ${names[1]}`, `@@ -${from + 1},${aTo - from} +${from + 1},${bTo - from} @@`];
  for (let i = from; i < prefix; i++) out.push(" " + a[i]);
  for (let i = prefix; i < aEnd; i++) out.push("-" + a[i]);
  for (let i = prefix; i < bEnd; i++) out.push("+" + b[i]);
  for (let i = aEnd; i < aTo; i++) out.push(" " + a[i]);
  return out.join("\n");
}

/** `"CRLF"` when the text carries Windows line ends, otherwise `"LF"`. */
export function detectEol(text) {
  return /\r\n/.test(String(text ?? "")) ? "CRLF" : "LF";
}

/** "just now", "40 seconds ago", "3 min ago", "2 h ago", or a short date. `when` is an ISO string, ms or Date. */
export function ago(when, now = Date.now()) {
  const t = when instanceof Date ? when.getTime() : typeof when === "number" ? when : Date.parse(when);
  if (!Number.isFinite(t)) return "";
  const ms = Math.max(0, now - t);
  if (ms < 5_000) return "just now";
  if (ms < 60_000) return `${Math.floor(ms / 1000)} seconds ago`;
  const m = Math.floor(ms / 60_000);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h ago`;
  return new Date(t).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/** The name of a conversation a conflict answer may carry, or null when the data says nothing. */
export function writerName(current) {
  const who = current?.conversation ?? current?.writer ?? current?.session ?? null;
  if (!who) return null;
  if (typeof who === "string") return who;
  return who.title ?? who.name ?? who.id ?? null;
}

const relativeTo = (path, base) => (isWithin(path, base) ? path.slice(base.replace(/\/+$/, "").length).replace(/^\/+/, "") : null);

/**
 * The Copy to Home target as a HOME-RELATIVE path (the server resolves a relative path against home; `~/` is
 * never sent, because the server has no tilde expansion and would make a directory called `~`):
 * `shared/<path under the shared root>` for a shared file, `<basename of the mount root>/<path under it>`
 * for a file on a mount (the mount root from the stat's `mount`, else the deepest of the roots' mounts or
 * project directories that holds the path), and `copies/<basename>` for anything else.
 */
export function homeCopyPath(file, roots = null) {
  const path = String(file?.path || "");
  const name = nameOf(path) || "copy";
  if (file?.root === "shared" && roots?.shared?.path) {
    const rel = relativeTo(path, roots.shared.path);
    if (rel) return `shared/${rel}`;
  }
  if (file?.root === "mount") {
    let mountRoot = typeof file.mount?.path === "string" ? file.mount.path : null;
    if (!mountRoot || !isWithin(path, mountRoot)) {
      let best = null;
      for (const m of roots?.mounts ?? []) if (m?.path && isWithin(path, m.path) && (!best || m.path.length > best.length)) best = m.path;
      mountRoot = best ?? rootOf(roots, path)?.path ?? null;
    }
    const rel = mountRoot ? relativeTo(path, mountRoot) : null;
    if (rel) return `${nameOf(mountRoot)}/${rel}`;
  }
  return `copies/${name}`;
}

/** Whether a failed request says the person is signed out or refused: polling must stop, not retry. */
export function isAuthError(err) {
  const status = Number(err?.status);
  return status === 401 || status === 403 || (err?.name === "ApiError" && status === 401);
}

/**
 * Whether a keydown is a plain printable character (one key, no Ctrl/Meta/Alt): typed into the editor, it
 * must never reach the shell's single-key shortcuts (`/` focuses the sidebar search). Escape and modified
 * keys propagate.
 */
export function isPlainTypingKey(event) {
  return typeof event?.key === "string" && event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
}

function readBuffer(model, path) {
  try {
    const saved = model?.tabs?.buffer?.(path);
    return typeof saved === "string" ? saved : null;
  } catch {
    return null;
  }
}

function writeBuffer(model, path, text) {
  try {
    model?.tabs?.setBuffer?.(path, text);
  } catch {
    /* storage may be full or blocked; the tab's dirty flag still says there is unsaved work */
  }
}

function rootLabel(file) {
  const root = String(file?.root ?? "");
  if (root === "shared") return "Shared";
  if (root === "home") return "Home";
  return root || "This directory";
}

/** Whether the root the file sits on refuses writes for this person (a size-only read-only is not this). */
export const isReadOnlyRoot = (file) => Boolean(file && (file.writable === false || file.mode === "ro"));

/** The sentence of the read-only notice, shared by the editor and the rendered markdown view. */
export const readOnlySentence = (file) => `${rootLabel(file)} is read-only for you. You can read and download this file. To change it, copy it to Home or ask an admin.`;

/**
 * Writes a copy of `text` under the home at the home-relative target `homeCopyPath` names, and answers the
 * absolute path the write landed on (from the answer, else home + target). Throws with a sentence when the
 * write is refused. Shared by the editor's banner and the rendered markdown view's.
 */
export async function copyToHome({ model, file, text, session }) {
  const roots = model.rootsCached?.(session) ?? (await model.roots?.({ session }).catch(() => null));
  const target = homeCopyPath(file, roots);
  const answer = await model.write(target, String(text ?? ""), {});
  if (answer && answer.ok === false) throw new Error(answer.message ?? `${target} was not written.`);
  // The write answer names the copy by its absolute path; the tab opens on that, never on the relative form.
  return typeof answer?.path === "string" ? answer.path : roots?.home?.path ? `${roots.home.path.replace(/\/+$/, "")}/${target}` : target;
}

/**
 * The read-only notice for a file on a read-only root: the info banner (`.ws-banner.is-info[data-banner=
 * readonly]`, with a Copy to Home button) and a second Copy to Home button for the tabs' right cluster.
 * `onCopy()` runs for either button.
 */
export function readOnlyNotice(ext, file, onCopy) {
  const { el } = ext.dom;
  const banner = el(
    "div",
    { class: "ws-banner is-info", "data-banner": "readonly", role: "note" },
    el("span", { class: "ws-banner-ic" }, ext.dom.icon(ICON_LOCK, { size: 15, width: 1.6 })),
    el("span", { class: "ws-banner-text" }, readOnlySentence(file)),
    el("span", { class: "ws-banner-acts" }, ext.ui.button("Copy to Home", { onClick: () => onCopy() }))
  );
  const control = ext.ui.button("Copy to Home", { title: "Write a copy under your home and open it", onClick: () => onCopy() });
  return { banner, control };
}

/* ---------- the editor ---------- */

/**
 * `host`: the element the view fills. `opts`:
 * - `ext`, `model`: the seam and the shared model.
 * - `file`: `stat` data plus `text` and `etag`; `path` is the key everywhere.
 * - `line`: 1-based line to reveal once mounted.
 * - `readOnly`: forces read-only; otherwise `file.writable === false` or `file.mode === "ro"` does.
 * - `readOnlyReason`: `"size"` when the file is read-only only because the editor opens a window of it: no
 *   read-only-root banner and no Copy to Home then (the large-file banner stands alone).
 * - `banner`: an element for banners; otherwise a `.ws-banners` is prepended to `host`.
 * - `active`: whether stat polling runs now (default true); `setActive` changes it.
 * - `session`: the conversation the roots are read for (Copy to Home needs the roots to name its target).
 * - `onDirty(dirty)`, `onSaved({ etag, size, mtime })`, `onCursor({ line, col })`, `onReloaded(text)`.
 */
export function createEditor(host, opts) {
  const { ext, model, file, onDirty, onSaved, onCursor, onReloaded } = opts;
  const { el } = ext.dom;
  const path = file.path;
  const readOnly = Boolean(opts.readOnly ?? isReadOnlyRoot(file));
  // The root's refusal is the person's to work around (Copy to Home); a size-only read-only is not.
  const roRoot = readOnly && opts.readOnlyReason !== "size";

  let loaded = String(file.text ?? "");
  let etag = file.etag ?? null;
  let dirty = false;
  let view = null;
  let core = null;
  let destroyed = false;
  let active = opts.active ?? true;
  let saving = false;
  let bannerEtag = null;
  let diffTimer = 0;
  let bufferTimer = 0;
  const pending = [];

  const bannerSlot = opts.banner ?? host.querySelector(":scope > .ws-banners") ?? el("div", { class: "ws-banners" });
  if (!bannerSlot.isConnected && !opts.banner) host.prepend(bannerSlot);
  const element = el("div", { class: `ws-view ws-view-editor${readOnly ? " is-readonly" : ""}`, "data-path": path });
  // A character typed here is the editor's alone: the shell's single-key shortcuts listen on the document.
  element.addEventListener("keydown", (event) => {
    if (isPlainTypingKey(event)) event.stopPropagation();
  });
  host.append(element);

  const saveButton = readOnly ? null : ext.ui.button("Save", { tone: "primary", title: "Save (Ctrl+S)", onClick: () => save() });
  const revertButton = readOnly ? null : ext.ui.button("Revert", { title: "Back to the saved text", onClick: () => revert() });
  const notice = roRoot ? readOnlyNotice(ext, file, () => copyHome()) : null;
  const controls = el("span", { class: "ws-controls" }, saveButton, revertButton, notice?.control ?? null);
  const syncControls = () => {
    if (saveButton) saveButton.disabled = !dirty || saving;
    if (revertButton) revertButton.disabled = !dirty;
  };
  syncControls();

  /* banners */
  const banners = new Map();
  function showBanner(id, kind, icon, text, buttons = []) {
    hideBanner(id);
    const node = el(
      "div",
      { class: `ws-banner is-${kind}`, "data-banner": id, role: kind === "info" ? "note" : "alert" },
      el("span", { class: "ws-banner-ic" }, ext.dom.icon(icon, { size: 15, width: 1.6 })),
      el("span", { class: "ws-banner-text" }, ...[].concat(text)),
      buttons.length ? el("span", { class: "ws-banner-acts" }, ...buttons) : null
    );
    banners.set(id, node);
    bannerSlot.append(node);
    return node;
  }
  function hideBanner(id) {
    const node = banners.get(id);
    if (node) node.remove();
    banners.delete(id);
  }
  function showError(message) {
    showBanner("error", "err", ICON_ERR, message, [ext.ui.button("Dismiss", { onClick: () => hideBanner("error") })]);
  }

  if (notice) {
    banners.set("readonly", notice.banner);
    bannerSlot.append(notice.banner);
  }

  /* state */
  function currentText() {
    return view ? view.state.doc.toString() : loaded;
  }
  function setDirty(next) {
    if (next === dirty) return;
    dirty = next;
    syncControls();
    if (typeof onDirty === "function") onDirty(dirty);
    model.tabs?.markDirty?.(path, dirty);
    if (!dirty) {
      clearTimeout(bufferTimer);
      writeBuffer(model, path, null);
    }
  }
  function scheduleBuffer() {
    clearTimeout(bufferTimer);
    bufferTimer = setTimeout(() => {
      if (!destroyed && dirty) writeBuffer(model, path, currentText());
    }, BUFFER_DEBOUNCE_MS);
  }
  function reportCursor() {
    if (!view || typeof onCursor !== "function") return;
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    onCursor({ line: line.number, col: head - line.from + 1 });
  }

  /* the changed-lines gutter */
  let setChanged = null;
  let changedField = null;
  let changedMarker = null;
  function refreshGutter() {
    if (!view || !core) return;
    const doc = view.state.doc;
    const text = doc.toString();
    const lines = dirty || text !== loaded ? changedLines(loaded, text) : [];
    const ranges = lines.filter((n) => n >= 1 && n <= doc.lines).map((n) => changedMarker.range(doc.line(n).from));
    view.dispatch({ effects: setChanged.of(core.RangeSet.of(ranges, true)) });
  }
  function scheduleGutter() {
    clearTimeout(diffTimer);
    diffTimer = setTimeout(refreshGutter, DIFF_DEBOUNCE_MS);
  }

  function onUpdate(update) {
    if (update.docChanged) {
      const doc = update.state.doc;
      const next = doc.length !== loaded.length || doc.toString() !== loaded;
      setDirty(next);
      if (next) scheduleBuffer();
      scheduleGutter();
    }
    if (update.docChanged || update.selectionSet) reportCursor();
  }

  /* the loaded reference moves: after a save, a reload, Load theirs */
  function adopt(text, nextEtag, { replaceDoc = true } = {}) {
    loaded = text;
    etag = nextEtag ?? etag;
    bannerEtag = null;
    hideBanner("conflict");
    if (replaceDoc && view && view.state.doc.toString() !== text) {
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
    }
    setDirty(false);
    refreshGutter();
  }

  /* saving */
  async function save({ force = false } = {}) {
    if (readOnly) return { ok: false, readOnly: true };
    if (!view || saving) return { ok: false, busy: true };
    const text = currentText();
    if (!force && !dirty && text === loaded) return { ok: true, etag, unchanged: true };
    saving = true;
    syncControls();
    try {
      const answer = await model.write(path, text, force ? { etag, force: true } : { etag });
      if (answer?.ok) {
        hideBanner("error");
        loaded = text;
        etag = answer.etag ?? etag;
        bannerEtag = null;
        hideBanner("conflict");
        setDirty(false);
        refreshGutter();
        if (typeof onSaved === "function") onSaved({ etag, size: answer.size, mtime: answer.mtime });
        return answer;
      }
      if (answer?.conflict) {
        showConflict(answer.current ?? {});
        return answer;
      }
      showError(answer?.message ?? `Saving ${file.display ?? path} did not answer ok; nothing was written.`);
      return answer ?? { ok: false };
    } catch (err) {
      showError(err?.message ?? String(err));
      return { ok: false, error: err };
    } finally {
      saving = false;
      syncControls();
    }
  }

  function revert() {
    if (!view) return;
    adopt(loaded, etag);
  }

  async function copyHome() {
    try {
      const written = await copyToHome({ model, file, text: currentText(), session: opts.session });
      model.tabs?.open?.(written);
    } catch (err) {
      showError(err?.message ?? String(err));
    }
  }

  /* the conflict banner: the file on disk moved while the buffer holds other text */
  async function theirText(current) {
    if (typeof current.text === "string") return current.text;
    const answer = await model.readText(path);
    return typeof answer === "string" ? answer : String(answer?.text ?? "");
  }
  function showConflict(current) {
    bannerEtag = current.etag ?? bannerEtag;
    const who = writerName(current);
    const text = [`This file changed on disk ${ago(current.mtime) || "just now"} while you were editing.`];
    if (who) text.push(" The conversation ", el("b", {}, who), " wrote it.");
    let diffNode = null;
    const buttons = [
      ext.ui.button("Show diff", {
        title: "Their text against yours",
        onClick: async () => {
          if (diffNode) {
            diffNode.remove();
            diffNode = null;
            return;
          }
          try {
            const theirs = await theirText(current);
            diffNode = el("pre", { class: "ws-diff" }, ...diffLines(unifiedDiff(theirs, currentText())));
            banner.after(diffNode);
          } catch (err) {
            showError(err?.message ?? String(err));
          }
        },
      }),
      ext.ui.button("Load theirs", {
        title: "Drop your edits and take the file as it is on disk",
        onClick: async () => {
          try {
            const theirs = await theirText(current);
            diffNode?.remove();
            adopt(theirs, current.etag);
          } catch (err) {
            showError(err?.message ?? String(err));
          }
        },
      }),
      ext.ui.button("Keep mine", { tone: "primary", title: "Write your text over theirs", onClick: () => (diffNode?.remove(), save({ force: true })) }),
    ];
    const banner = showBanner("conflict", "warn", ICON_WARN, text, buttons);
  }
  function diffLines(diff) {
    return diff.split("\n").map((line) => {
      const kind = line.startsWith("+") ? "is-add" : line.startsWith("-") ? "is-del" : line.startsWith("@@") ? "is-hunk" : "";
      return el("span", { class: `ws-diff-line ${kind}`.trim() }, line + "\n");
    });
  }

  /* stat polling while the tab is visible; it stops for good once a stat says the person is signed out */
  let polling = false;
  let pollStopped = false;
  function stopPolling() {
    pollStopped = true;
    clearInterval(timer);
  }
  async function poll() {
    if (destroyed || pollStopped || !active || polling || saving || typeof document === "undefined" || document.visibilityState !== "visible") return;
    polling = true;
    try {
      const stat = await model.stat(path);
      if (destroyed || !stat?.etag || stat.etag === etag) return;
      if (!dirty) {
        const answer = await model.readText(path);
        if (destroyed) return;
        const text = typeof answer === "string" ? answer : String(answer?.text ?? "");
        adopt(text, answer?.etag ?? stat.etag);
        if (typeof onReloaded === "function") onReloaded(text);
      } else if (bannerEtag !== stat.etag) {
        showConflict({ etag: stat.etag, size: stat.size, mtime: stat.mtime });
      }
    } catch (err) {
      // A failed stat is not news and the next tick tries again, unless the session is gone: then every
      // tick would be another 401, so the poll ends here and nothing restarts it.
      if (isAuthError(err)) stopPolling();
    } finally {
      polling = false;
    }
  }
  const timer = setInterval(poll, POLL_MS);
  const onVisible = () => {
    if (document.visibilityState === "visible") poll();
  };
  document.addEventListener("visibilitychange", onVisible);

  /* mounting */
  function mount(cm) {
    core = cm;
    const { EditorState, EditorView, Compartment, StateEffect, StateField, RangeSet, GutterMarker, gutter, keymap } = cm;
    class Changed extends GutterMarker {
      elementClass = "ws-gutter-changed";
    }
    changedMarker = new Changed();
    setChanged = StateEffect.define();
    changedField = StateField.define({
      create: () => RangeSet.empty,
      update(set, tr) {
        for (const effect of tr.effects) if (effect.is(setChanged)) return effect.value;
        return tr.docChanged ? set.map(tr.changes) : set;
      },
    });
    const language = new Compartment();
    const nonce = document.querySelector('meta[name="csp-nonce"]')?.content;
    const restored = readBuffer(model, path);
    const doc = typeof restored === "string" && restored !== loaded ? restored : loaded;
    const extensions = [
      keymap.of([{ key: "Mod-s", run: () => (save(), true) }]),
      cm.lineNumbers(),
      cm.highlightActiveLineGutter(),
      cm.highlightActiveLine(),
      cm.drawSelection(),
      cm.history(),
      cm.bracketMatching(),
      cm.highlightSelectionMatches(),
      cm.syntaxHighlighting(cm.classHighlighter),
      keymap.of([...cm.defaultKeymap, ...cm.historyKeymap, ...cm.searchKeymap, cm.indentWithTab]),
      language.of([]),
      changedField,
      gutter({ class: "ws-changes", markers: (v) => v.state.field(changedField) }),
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
      EditorView.updateListener.of(onUpdate),
    ];
    if (nonce) extensions.push(EditorView.cspNonce.of(nonce));
    view = new EditorView({ parent: element, state: EditorState.create({ doc, extensions }) });
    if (doc !== loaded) {
      setDirty(true);
      refreshGutter();
    }
    loadLanguage(file.language).then((support) => {
      if (!destroyed && support && view) view.dispatch({ effects: language.reconfigure(support) });
    });
    if (opts.line) goTo(opts.line);
    reportCursor();
    for (const fn of pending.splice(0)) fn();
  }

  const ready = loadCore()
    .then((cm) => {
      if (!destroyed) mount(cm);
    })
    .catch((err) => {
      showError(`The editor did not load: ${err?.message ?? err}. The file is unchanged; reload the page to try again.`);
      throw err;
    });

  function whenReady(fn) {
    if (view) fn();
    else pending.push(fn);
  }

  function goTo(line) {
    whenReady(() => {
      const n = Math.max(1, Math.min(Number(line) || 1, view.state.doc.lines));
      const pos = view.state.doc.line(n).from;
      view.dispatch({ selection: { anchor: pos }, effects: core.EditorView.scrollIntoView(pos, { y: "center" }) });
      view.focus();
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    clearInterval(timer);
    clearTimeout(diffTimer);
    clearTimeout(bufferTimer);
    document.removeEventListener("visibilitychange", onVisible);
    if (dirty) writeBuffer(model, path, currentText());
    view?.destroy();
    view = null;
    for (const node of banners.values()) node.remove();
    banners.clear();
    element.remove();
    if (!opts.banner && bannerSlot.childElementCount === 0) bannerSlot.remove();
  }

  return {
    ready,
    element,
    controls,
    destroy,
    focus: () => whenReady(() => view.focus()),
    value: currentText,
    setValue(text, { asLoaded = false, etag: nextEtag } = {}) {
      whenReady(() => {
        if (asLoaded) adopt(String(text ?? ""), nextEtag);
        else view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text ?? "") } });
      });
    },
    goTo,
    isDirty: () => dirty,
    isReadOnly: () => readOnly,
    etag: () => etag,
    save,
    revert,
    setActive(next) {
      active = Boolean(next);
      if (active && !pollStopped) poll();
    },
    isPolling: () => !pollStopped,
    get view() {
      return view;
    },
  };
}
