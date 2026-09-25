/* The viewer of the Workspace place: everything a tab shows that is not a plain text editor, and the plain
 * editor too, so the place can route every opened file through `createViewer` and let it decide.
 *
 * Preview words come from the server's `stat` (`preview`: text | markdown | image | svg | pdf | audio | none):
 * - markdown: Rendered (`ext.markdown` with images and fences resolved) or Source (an editor);
 * - image / svg / pdf / audio: the raw route in `img` / `object` / `audio`, images with Fit or 1:1;
 * - text: the editor; a `tooLarge` text is a read-only editor of its head with "Show last 4 MB";
 * - binary or none: the facts card with Download.
 * The mode toggle (`.ws-seg`) lives in `controls`, a node for the tabs' right cluster, and the last choice
 * per language is kept in localStorage `thetis.workspace.<user>.mode:<language>` (guarded like the model's;
 * nothing is stored before the roots have named the person). */

import { createEditor } from "./editor.js";
import { hasGrammar, loadCore, loadLanguage } from "./lang.js";
import { storageKey } from "./model.js";

const UNAVAILABLE = "not available in this gateway version";
const IMAGES_NEED_RAW = "Images need the raw file route, which this gateway does not have yet.";

const MODES = Object.freeze({
  markdown: ["rendered", "source"],
  image: ["fit", "actual"],
  svg: ["fit", "actual"],
});
const MODE_LABELS = Object.freeze({ rendered: "Rendered", source: "Source", fit: "Fit", actual: "1:1" });

/* ---------- pure helpers ---------- */

/** The key the mode memory uses: the language when it says something, else the preview word. */
export function modeKey(file) {
  const language = String(file?.language ?? "");
  if (language && language !== "plain") return language;
  return String(file?.preview ?? "plain");
}

/** The remembered mode for this person and language, or null (also before the person is known). */
export function rememberedMode(file, user, storage = globalThis.localStorage) {
  const key = storageKey(user, `mode:${modeKey(file)}`);
  if (!key) return null;
  try {
    const value = storage?.getItem(key);
    const allowed = MODES[file?.preview] ?? [];
    return allowed.includes(value) ? value : null;
  } catch {
    return null;
  }
}

export function rememberMode(file, mode, user, storage = globalThis.localStorage) {
  const key = storageKey(user, `mode:${modeKey(file)}`);
  if (!key) return;
  try {
    storage?.setItem(key, mode);
  } catch {
    /* a blocked store forgets the choice, nothing worse */
  }
}

/** `resolveRelative("/home/me/docs/README.md", "img/a.png")` → `/home/me/docs/img/a.png`; `..` never climbs. */
export function resolveRelative(filePath, src) {
  const dir = String(filePath ?? "").slice(0, String(filePath ?? "").lastIndexOf("/") + 1);
  const parts = [];
  for (const part of String(src ?? "").split("/")) {
    if (part === "" || part === ".") continue;
    if (part === "..") return null;
    parts.push(part);
  }
  return dir + parts.join("/");
}

/** "612 B", "2.8 KB", "11.3 MB". */
export function formatSize(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value < 100 ? value.toFixed(1).replace(/\.0$/, "") : Math.round(value)} ${units[unit]}`;
}

function baseName(path) {
  const s = String(path ?? "");
  return s.slice(s.lastIndexOf("/") + 1) || s;
}

/* ---------- the viewer ---------- */

/**
 * `host`: the element the view fills. `opts`:
 * - `ext`, `model`, `file` (the `stat` data; `text` and `etag` may be on it or given as `opts.text`/`opts.etag`);
 * - `actions.download(file)`: the host's download action; without it the raw route is used when there is one;
 * - `banner`, `line`, `readOnly`, `session`, `onDirty`, `onSaved`, `onCursor`, `onMode(mode)`: handed to the editor.
 */
export function createViewer(host, opts) {
  const { ext, model, file, actions = {} } = opts;
  const { el } = ext.dom;
  const path = file.path;
  const preview = file.binary ? "binary" : String(file.preview ?? "none");
  let text = opts.text ?? file.text ?? null;
  const etag = opts.etag ?? file.etag ?? null;
  let destroyed = false;
  let editor = null;
  let mode = null;
  let blobUrl = null;

  const bannerSlot = opts.banner ?? host.querySelector(":scope > .ws-banners") ?? el("div", { class: "ws-banners" });
  if (!bannerSlot.isConnected && !opts.banner) host.prepend(bannerSlot);
  const element = el("div", { class: `ws-view ws-view-${preview}`, "data-path": path });
  host.append(element);
  const controls = el("span", { class: "ws-controls" });
  const editorControls = el("span", { class: "ws-controls-editor" });

  const rawUrl = (extra = {}) => (typeof ext.raw?.url === "function" ? ext.raw.url("raw", { path, ...extra }) : null);

  /* the segment toggle in the tabs' right cluster */
  const choices = MODES[preview] ?? [];
  let seg = null;
  if (choices.length) {
    seg = el(
      "span",
      { class: "ws-seg", role: "group", "aria-label": "View" },
      ...choices.map((m) => el("button", { type: "button", class: "ws-seg-btn", "data-mode": m, "aria-pressed": "false", onClick: () => setMode(m) }, MODE_LABELS[m]))
    );
    controls.append(seg);
  }
  controls.append(editorControls);

  function syncSeg() {
    if (!seg) return;
    for (const button of seg.querySelectorAll(".ws-seg-btn")) button.setAttribute("aria-pressed", button.dataset.mode === mode ? "true" : "false");
  }

  /* pieces */
  function dropEditor() {
    if (!editor) return;
    text = editor.value();
    editor.destroy();
    editor = null;
    editorControls.replaceChildren();
  }

  function mountEditor(initialText, { readOnly, banner = bannerSlot, onLoaded } = {}) {
    editor = createEditor(element, {
      ext,
      model,
      file: { ...file, text: initialText, etag },
      line: opts.line,
      readOnly: opts.readOnly ?? readOnly,
      banner,
      active: opts.active,
      session: opts.session,
      onDirty: opts.onDirty,
      onSaved: opts.onSaved,
      onCursor: opts.onCursor,
      onReloaded: onLoaded,
    });
    editorControls.replaceChildren(editor.controls);
    return editor;
  }

  function facts(...extra) {
    return el("div", { class: "ws-facts" }, el("span", { class: "ws-facts-name" }, baseName(file.display ?? path)), file.size != null ? el("span", {}, formatSize(file.size)) : null, ...extra);
  }

  function downloadButton() {
    if (typeof actions.download === "function") return ext.ui.button("Download", { tone: "primary", onClick: () => actions.download(file) });
    const url = rawUrl({ download: true });
    if (url) return ext.ui.button("Download", { tone: "primary", onClick: () => location.assign(url) });
    return ext.ui.button("Download", { disabled: true, title: `Downloading is ${UNAVAILABLE}.` });
  }

  function unavailable(what) {
    return el("p", { class: "ws-unavailable" }, `${what} is ${UNAVAILABLE}.`);
  }

  function factsCard(sentence, ...children) {
    const pairs = [
      ["Name", baseName(file.display ?? path)],
      ["Path", file.display ?? path],
      ["Size", formatSize(file.size) || "—"],
      ["Modified", file.mtime ? new Date(file.mtime).toLocaleString() : "—"],
    ];
    return el("div", { class: "ws-facts-card" }, ext.ui.card(baseName(file.display ?? path), ext.ui.kv(pairs), el("p", {}, sentence), ...children, el("div", { class: "card-actions" }, downloadButton())));
  }

  /* markdown */
  async function renderMarkdown() {
    const body = el("div", { class: "ws-rendered md" });
    element.append(body);
    if (text == null) {
      const answer = await model.readText(path);
      if (destroyed) return;
      text = typeof answer === "string" ? answer : String(answer?.text ?? "");
    }
    const hasRaw = typeof ext.raw?.url === "function";
    // Without the raw route there is nothing an `img` could fetch: the page origin does not serve files,
    // so the resolver answers null and the shell draws the alt text, which becomes the placeholder below.
    const image = (src) => {
      const resolved = resolveRelative(path, src);
      if (!resolved || !hasRaw) return null;
      return ext.raw.url("raw", { path: resolved });
    };
    const blocks = ext.markdown(text, { image });
    body.append(...[].concat(blocks ?? []));
    if (!hasRaw) {
      for (const missing of body.querySelectorAll(".md-img-missing")) {
        const alt = missing.textContent || missing.getAttribute("title") || "image";
        missing.replaceWith(el("span", { class: "ws-img-missing", role: "img", "aria-label": alt, title: missing.getAttribute("title") }, el("span", { class: "ws-img-missing-alt" }, alt), el("span", { class: "ws-img-missing-note" }, IMAGES_NEED_RAW)));
      }
    }
    highlightFences(body);
  }

  async function highlightFences(root) {
    const jobs = [];
    for (const block of root.querySelectorAll(".md-code")) {
      const lang = block.querySelector(".md-code-lang")?.textContent ?? "";
      const code = block.querySelector("pre > code");
      if (code && hasGrammar(lang)) jobs.push({ lang, code });
    }
    if (!jobs.length) return;
    const cm = await loadCore();
    for (const job of jobs) {
      const support = await loadLanguage(job.lang);
      if (destroyed) return;
      if (support) job.code.replaceChildren(cm.highlightToDom(job.code.textContent, support));
    }
  }

  /* media */
  function mediaFrame(node) {
    return el("div", { class: `ws-media is-${mode ?? "fit"}` }, node);
  }

  function renderImage() {
    const url = rawUrl();
    if (!url) return element.append(factsCard("A preview needs the raw file route.", unavailable("Previewing")));
    const line = facts();
    const img = el("img", {
      class: "ws-img",
      alt: baseName(path),
      onLoad: () => line.append(el("span", {}, `${img.naturalWidth} × ${img.naturalHeight}`)),
      onError: () => line.append(el("span", { class: "is-err" }, "The image did not load.")),
    });
    element.append(mediaFrame(img), line);
    if (preview === "svg") {
      // The raw route serves SVG as text/plain (a script inside an SVG must never run on this origin), so
      // the bytes are fetched and shown from a typed blob URL, which is an image and nothing more.
      fetch(url)
        .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} ${r.statusText}`))))
        .then((svg) => {
          if (destroyed) return;
          blobUrl = URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" }));
          img.src = blobUrl;
        })
        .catch((err) => line.append(el("span", { class: "is-err" }, `The image did not load: ${err.message}.`)));
    } else img.src = url;
  }

  function renderPdf() {
    const url = rawUrl();
    if (!url) return element.append(factsCard("A preview needs the raw file route.", unavailable("Previewing")));
    element.append(
      el("div", { class: "ws-media is-fill" }, el("object", { class: "ws-pdf", type: "application/pdf", data: url }, el("p", { class: "ws-unavailable" }, "This browser does not show PDFs inline. Download it instead."), el("div", { class: "card-actions" }, downloadButton()))),
      facts()
    );
  }

  function renderAudio() {
    const url = rawUrl();
    if (!url) return element.append(factsCard("A preview needs the raw file route.", unavailable("Previewing")));
    element.append(el("div", { class: "ws-media is-center" }, el("audio", { class: "ws-audio", controls: true, src: url, preload: "metadata" })), facts());
  }

  /* text */
  async function renderText() {
    if (file.tooLarge) return renderLarge();
    if (text == null) {
      const answer = await model.readText(path);
      if (destroyed) return;
      text = typeof answer === "string" ? answer : String(answer?.text ?? "");
    }
    mountEditor(text);
  }

  async function renderLarge() {
    let part = "head";
    const load = async (which) => {
      const answer = await model.readText(path, { part: which });
      return typeof answer === "string" ? answer : String(answer?.text ?? "");
    };
    if (text == null) {
      text = await load("head");
      if (destroyed) return;
    }
    const button = ext.ui.button("Show last 4 MB", {
      onClick: async () => {
        button.disabled = true;
        try {
          part = part === "head" ? "tail" : "head";
          const next = await load(part);
          if (destroyed) return;
          editor?.setValue(next, { asLoaded: true });
          button.textContent = part === "head" ? "Show last 4 MB" : "Show first 4 MB";
          note.textContent = sentence();
        } finally {
          button.disabled = false;
        }
      },
    });
    const sentence = () => `This file is ${formatSize(file.size)}, more than the editor opens; this is its ${part === "head" ? "first" : "last"} 4 MB, read-only.`;
    const note = el("span", { class: "ws-banner-text" }, sentence());
    bannerSlot.append(el("div", { class: "ws-banner is-info", "data-banner": "large" }, note, el("span", { class: "ws-banner-acts" }, button)));
    mountEditor(text, { readOnly: true });
  }

  /* modes */
  function render() {
    dropEditor();
    element.replaceChildren();
    for (const node of bannerSlot.querySelectorAll('[data-banner="large"]')) node.remove();
    switch (preview) {
      case "markdown":
        return mode === "source" ? renderText() : renderMarkdown();
      case "image":
      case "svg":
        return renderImage();
      case "pdf":
        return renderPdf();
      case "audio":
        return renderAudio();
      case "text":
        return renderText();
      default:
        return element.append(factsCard("No preview for this file type."));
    }
  }

  function setMode(next) {
    if (!choices.includes(next) || next === mode) return;
    mode = next;
    rememberMode(file, mode, model?.user);
    syncSeg();
    if (typeof opts.onMode === "function") opts.onMode(mode);
    if (preview === "markdown") render();
    else for (const frame of element.querySelectorAll(".ws-media")) frame.className = `ws-media is-${mode}`;
  }

  if (choices.length) {
    mode = rememberedMode(file, model?.user) ?? choices[0];
    syncSeg();
  }
  const ready = Promise.resolve(render()).catch((err) => {
    if (destroyed) return;
    element.replaceChildren(factsCard(`The file did not open: ${err?.message ?? err}.`));
  });

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    dropEditor();
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    for (const node of bannerSlot.querySelectorAll('[data-banner="large"]')) node.remove();
    element.remove();
    if (!opts.banner && bannerSlot.childElementCount === 0) bannerSlot.remove();
  }

  return {
    ready,
    element,
    controls,
    destroy,
    get mode() {
      return mode;
    },
    modes: choices,
    setMode,
    get editor() {
      return editor;
    },
    isDirty: () => Boolean(editor?.isDirty()),
    save: (o) => (editor ? editor.save(o) : Promise.resolve({ ok: false, readOnly: true })),
    revert: () => editor?.revert(),
    focus: () => editor?.focus(),
    goTo: (line) => editor?.goTo(line),
    setActive: (next) => editor?.setActive(next),
  };
}
