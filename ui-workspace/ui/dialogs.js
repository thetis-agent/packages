/* The dialogs of the Workspace: the upload card, the delete confirm, the two downloads, and the two
 * inline-row starters the explorer owns. Nothing here draws a popover of its own: the confirm is the
 * shell's (`ext.ui.confirm`), the menu is `menu.js`, the rows are the explorer's. Every function is
 * callable with the contract's argument list or with `ext` and `model` passed explicitly; the refs the
 * dock and the links bind through `bindDialogs` fill in whatever a caller left out. `ext.raw` is a
 * gateway seam that may not exist yet: every raw use is guarded and says so in one sentence. */

const MAX_UPLOAD = 64 * 1024 * 1024;   // per file; the server enforces it again
const ZIP_FILES = 20_000;              // the zip refuses past these before it starts
const ZIP_BYTES = 512 * 1024 * 1024;

let bound = { ext: null, model: null };

/** The dock and the links hand their `ext` and `model` here, so a contract-shaped call can find them. */
export function bindDialogs(ext, model) {
  if (ext) bound.ext = ext;
  if (model) bound.model = model;
}

const isExt = (x) => Boolean(x && typeof x === "object" && typeof x.toast === "function" && x.ui);
const isModel = (x) => Boolean(x && typeof x === "object" && typeof x.list === "function" && typeof x.remove === "function");

/** Picks `ext` and `model` out of an argument list, in either order, falling back to the bound refs. */
function refs(...args) {
  const ext = args.find(isExt) ?? bound.ext;
  const model = args.find(isModel) ?? bound.model;
  const rest = args.filter((a) => a !== ext && a !== model);
  return { ext, model, rest };
}

const unwrap = (x) => (x && typeof x === "object" && x.data !== undefined ? x.data : x);
const notAvailable = (what) => `${what} is not available in this gateway version: it needs the raw file route the gateway does not have yet. Update the gateway and reload the page.`;

/**
 * One toast per sentence per moment: the same refusal asked from two places at once (a view's Download and
 * the tab bar's, a menu item and its key) is said once. Informational sentences take the shell's default
 * ttl (`warn` fades); only a real failure is an `error`, which stays until dismissed.
 */
const SAID_WINDOW_MS = 2000;
const said = new Map(); // message -> when
export function toastOnce(ext, message, opts = {}) {
  const now = Date.now();
  for (const [m, at] of said) if (now - at > SAID_WINDOW_MS) said.delete(m);
  if (said.has(message)) return false;
  said.set(message, now);
  ext?.toast?.(message, opts);
  return true;
}

export function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export const basename = (path) => String(path ?? "").replace(/\/+$/, "").split("/").pop() || String(path ?? "");
export const dirname = (path) => {
  const p = String(path ?? "").replace(/\/+$/, "");
  const at = p.lastIndexOf("/");
  return at <= 0 ? (at === 0 ? "/" : "") : p.slice(0, at);
};

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === "class") node.className = v;
    else if (k.startsWith("on")) node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return node;
}

// ---- upload: one card, one queue, files sent one at a time ----

let panel = null; // { card, list, title, cancel, controller, queue: [], busy, failures }

function placeHost() {
  return document.querySelector(".ws-place") ?? document.body;
}

function ensurePanel(ext) {
  if (panel && panel.card.isConnected) return panel;
  const host = placeHost();
  const title = h("span", { class: "ws-uploads-title" }, "Uploads");
  const cancel = h("button", { type: "button", class: "ghost-btn sm ws-uploads-cancel", onClick: () => cancelRemaining() }, "Cancel remaining");
  const hide = h("button", { type: "button", class: "ghost-btn sm ws-uploads-hide", onClick: () => hidePanel() }, "Hide");
  const list = h("div", { class: "ws-uploads-list" });
  const card = h(
    "div",
    { class: `ws-uploads card${host === document.body ? " is-floating" : ""}`, role: "status", "aria-live": "polite" },
    h("div", { class: "card-head ws-uploads-head" }, title, h("span", { class: "ws-uploads-actions" }, cancel, hide)),
    list
  );
  host.append(card);
  panel = { card, list, title, cancel, controller: new AbortController(), queue: [], busy: false, failures: 0, timer: 0 };
  return panel;
}

function hidePanel() {
  if (!panel) return;
  clearTimeout(panel.timer);
  panel.card.remove();
  panel = null;
}

function cancelRemaining() {
  if (!panel) return;
  panel.controller.abort();
  const dropped = panel.queue.splice(0);
  for (const job of dropped) { setStatus(job, "Cancelled", "muted"); job.batch.remaining -= 1; }
  panel.cancel.hidden = true;
  for (const batch of new Set(dropped.map((j) => j.batch))) if (batch.remaining <= 0) finishBatch(batch);
}

function makeRow(file) {
  const fill = h("div", { class: "ws-upload-fill" });
  const status = h("span", { class: "ws-upload-status" }, "Queued");
  const node = h(
    "div",
    { class: "ws-upload-row", "data-state": "queued" },
    h("div", { class: "ws-upload-line" }, h("span", { class: "ws-upload-name", title: file.name }, file.name), h("span", { class: "ws-upload-size" }, fmtSize(file.size)), status),
    h("div", { class: "ws-upload-bar", role: "progressbar", "aria-valuemin": "0", "aria-valuemax": "100", "aria-valuenow": "0" }, fill)
  );
  return { node, fill, status };
}

function setStatus(job, text, state) {
  job.state = state;
  job.row.status.textContent = text;
  job.row.node.dataset.state = state;
}

function setProgress(job, fraction) {
  const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
  job.row.fill.style.setProperty("--ws-progress", `${pct}%`);
  job.row.node.querySelector(".ws-upload-bar")?.setAttribute("aria-valuenow", String(pct));
}

const fractionOf = (p) => {
  if (typeof p === "number") return p > 1 ? p / 100 : p;
  if (p && typeof p === "object" && p.total) return (p.loaded ?? 0) / p.total;
  return 0;
};

function finishBatch(batch) {
  if (batch.finished) return;
  batch.finished = true;
  const { ext, model } = refs(batch.ext, batch.model);
  try { model?.invalidate?.(batch.dir); } catch { /* the listing refreshes on the next look */ }
  const summary = { dir: batch.dir, uploaded: batch.jobs.filter((j) => j.state === "done").map((j) => j.result), failed: batch.jobs.filter((j) => j.state === "err").length, skipped: batch.jobs.filter((j) => j.state === "muted").length };
  try { batch.onDone?.(summary); } catch (err) { console.warn("upload onDone threw:", err); }
  if (summary.uploaded.length && ext) ext.toast(`Uploaded ${summary.uploaded.length === 1 ? basename(summary.uploaded[0]?.path ?? "") || "1 file" : `${summary.uploaded.length} files`} to ${basename(batch.dir) || batch.dir}.`);
}

async function sendOne(ext, job) {
  const { file, dir } = job;
  const args = { dir, name: file.name };
  const opts = { signal: panel.controller.signal, onProgress: (p) => setProgress(job, fractionOf(p)) };
  setStatus(job, "Uploading…", "busy");
  let answer = unwrap(await ext.raw.put("upload", args, file, opts));
  if (answer?.exists) {
    setStatus(job, "Already there", "warn");
    const replace = await ext.ui.confirm(job.row.node, {
      title: `Replace ${file.name}?`,
      lines: [["In", dir], ["New size", fmtSize(file.size)]],
      note: "The file already there is overwritten. There is no trash: it cannot be undone.",
      confirmLabel: "Replace",
      tone: "warn",
    });
    if (!replace) { setStatus(job, "Kept the existing file", "muted"); return; }
    setProgress(job, 0);
    setStatus(job, "Replacing…", "busy");
    answer = unwrap(await ext.raw.put("upload", { ...args, replace: true }, file, opts));
  }
  job.result = answer;
  setProgress(job, 1);
  setStatus(job, answer?.replaced ? "Replaced" : "Done", "done");
}

async function pump(ext) {
  if (!panel || panel.busy) return;
  panel.busy = true;
  try {
    while (panel && panel.queue.length) {
      const job = panel.queue.shift();
      const batch = job.batch;
      try {
        if (panel.controller.signal.aborted) setStatus(job, "Cancelled", "muted");
        else if (job.file.size > MAX_UPLOAD) { setStatus(job, "Over 64 MB", "err"); panel.failures += 1; } // a mark the card must keep, like any failure
        else await sendOne(ext, job);
      } catch (err) {
        if (panel?.controller.signal.aborted) setStatus(job, "Cancelled", "muted");
        else { setStatus(job, err?.message || "The upload failed", "err"); if (panel) panel.failures += 1; }
      }
      batch.remaining -= 1;
      if (batch.remaining <= 0) finishBatch(batch);
      if (panel) panel.title.textContent = panel.queue.length ? `Uploading · ${panel.queue.length} to go` : "Uploads";
    }
  } finally {
    if (panel) {
      panel.busy = false;
      panel.cancel.hidden = true;
      if (!panel.failures) panel.timer = setTimeout(hidePanel, 4000);
    }
  }
}

/**
 * Uploads `files` (a FileList or array) into `dir`, one after the other, in the `.ws-uploads` card in the
 * place's corner (or the page's corner when the place is not open). Rows over 64 MB are marked and never
 * sent; a name already taken asks before it is replaced; Cancel remaining stops the queue. Calls `onDone`
 * with `{ dir, uploaded, failed, skipped }` when this call's files are all settled.
 */
export function upload(...args) {
  const { ext, model, rest } = refs(...args);
  const opts = rest.find((a) => a && typeof a === "object") ?? {};
  const files = Array.from(opts.files ?? []);
  const dir = String(opts.dir ?? "");
  if (!ext || !files.length || !dir) return;
  const p = ensurePanel(ext);
  const batch = { ext, model, dir, onDone: opts.onDone, jobs: [], remaining: files.length, finished: false };
  for (const file of files) {
    const job = { file, dir, batch, row: makeRow(file), state: "queued", result: null };
    batch.jobs.push(job);
    p.list.append(job.row.node);
  }
  if (!ext.raw?.put) {
    for (const job of batch.jobs) setStatus(job, "Uploads need a newer gateway", "err");
    p.failures += batch.jobs.length;
    p.cancel.hidden = true;
    toastOnce(ext, notAvailable("Uploading"), { tone: "warn" });
    return;
  }
  if (p.controller.signal.aborted) p.controller = new AbortController();
  clearTimeout(p.timer);
  p.cancel.hidden = false;
  p.queue.push(...batch.jobs);
  void pump(ext);
}

// ---- delete ----

function projectOf(roots, path) {
  for (const project of roots?.projects ?? []) {
    for (const dir of project.directories ?? []) {
      const base = String(dir.path ?? "").replace(/\/+$/, "");
      if (base && (path === base || path.startsWith(base + "/"))) return project;
    }
  }
  return null;
}

/** Whether the roots data, or the shell's session list, says a conversation runs on `project` right now. */
function runningOn(ext, project) {
  if (!project) return false;
  if (project.running === true || project.busy === true) return true;
  const inProject = (s) => s && (s.project === project.id || s.projectId === project.id || s.project?.id === project.id);
  const running = (s) => s && (s.running === true || s.state === "running" || s.activity?.state === "running");
  for (const list of [project.sessions, project.conversations]) if (Array.isArray(list) && list.some(running)) return true;
  try {
    const sessions = ext?.sessions?.list?.();
    if (Array.isArray(sessions) && sessions.some((s) => inProject(s) && running(s))) return true;
  } catch { /* no session facts here */ }
  return false;
}

/**
 * Asks before removing `entry` (a file or a folder), with the server's dry-run count in the popover,
 * the running-conversation note when a conversation is on that project, and, for folders, a checkbox
 * the Delete button waits on. Then removes it, closes its tab, invalidates the parent listing and toasts.
 * Resolves true when something was deleted.
 */
export async function confirmDelete(anchor, ...args) {
  const { ext, model, rest } = refs(...args);
  const entry = rest.find((a) => a && typeof a === "object" && typeof a.path === "string");
  if (!ext || !model || !entry) return false;
  const name = entry.name || basename(entry.path);
  const parent = entry.display ? dirname(entry.display) : dirname(entry.path);
  const isDir = entry.kind === "dir";
  let dry = null;
  let roots = null;
  try {
    [dry, roots] = await Promise.all([
      model.remove(entry.path, { dryRun: true }).then(unwrap),
      Promise.resolve(model.roots?.({ session: ext.conversation?.current })).then(unwrap, () => null),
    ]);
  } catch (err) {
    ext.toast(`${name} was not deleted: ${err?.message || "the count failed"}`, { tone: "error" });
    return false;
  }
  const files = Number(dry?.files ?? 0);
  const dirs = Number(dry?.dirs ?? 0);
  const size = fmtSize(dry?.bytes ?? 0);
  const counted = dry?.capped ? `more than ${files} files` : `${files} ${files === 1 ? "file" : "files"}`;
  const project = projectOf(roots, entry.path);
  const lines = isDir
    ? [["Folder", name], ["In", parent || "/"], ["Contains", `${counted}${dirs ? `, ${dirs} ${dirs === 1 ? "folder" : "folders"}` : ""} (${size})`]]
    : [["File", name], ["In", parent || "/"], ["Size", size]];
  const note = h("span", { class: "ws-del" });
  note.append(h("span", { class: "ws-del-line" }, isDir ? `This removes the folder and its ${counted} (${size}) from ${parent || "/"}.` : `This removes the file (${size}) from ${parent || "/"}.`));
  note.append(h("span", { class: "ws-del-line" }, "There is no trash: it cannot be undone."));
  if (runningOn(ext, project)) note.append(h("span", { class: "ws-del-line is-warn" }, `A conversation is running in ${project.name || "this project"} right now: it may be reading or writing here.`));
  let check = null;
  if (isDir) {
    check = h("input", { type: "checkbox", class: "ws-del-check" });
    note.append(h("label", { class: "ws-del-ack" }, check, h("span", {}, `Delete ${name} and everything in it`)));
  }
  const asked = ext.ui.confirm(anchor ?? document.body, { title: `Delete ${name}?`, lines, note, confirmLabel: "Delete", tone: "warn" });
  if (check) {
    // The shell's confirm has no checkbox slot: the box rides in the note, and the Delete button waits on it.
    const button = () => check.closest(".popover")?.querySelector(".popover-actions .btn.is-warn");
    const sync = () => { const b = button(); if (b) b.disabled = !check.checked; };
    check.addEventListener("change", sync);
    queueMicrotask(sync);
  }
  if (!(await asked)) return false;
  try {
    await model.remove(entry.path);
  } catch (err) {
    ext.toast(`${name} was not deleted: ${err?.message || "the workspace did not answer"}`, { tone: "error" });
    return false;
  }
  try {
    const tabs = model.tabs?.list?.() ?? [];
    for (const tab of tabs) if (tab.path === entry.path || (isDir && tab.path.startsWith(entry.path.replace(/\/+$/, "") + "/"))) model.tabs.close(tab.path);
  } catch { /* the tab goes on the next redraw */ }
  try { model.invalidate?.(dirname(entry.path)); } catch { /* refreshed on the next look */ }
  ext.toast(`Deleted ${name}`);
  return true;
}

// ---- downloads ----

/** Counts first, refuses over the zip caps with the numbers, then lets the browser save the zip. */
export async function downloadZip(...args) {
  const { ext, model, rest } = refs(...args);
  const entry = rest.find((a) => a && typeof a === "object" && typeof a.path === "string");
  if (!ext || !entry) return false;
  const name = entry.name || basename(entry.path);
  if (!ext.raw?.url) { toastOnce(ext, notAvailable("Downloading a folder as a zip"), { tone: "warn" }); return false; }
  let count = null;
  try {
    count = unwrap(await model?.count?.(entry.path));
  } catch (err) {
    ext.toast(`${name} was not zipped: ${err?.message || "the count failed"}`, { tone: "error" });
    return false;
  }
  // `zip` is what the archive holds (totals include .git and node_modules); `skipped` is what it leaves out.
  const held = count?.zip && typeof count.zip === "object" ? count.zip : count;
  const files = Number(held?.files ?? 0);
  const bytes = Number(held?.bytes ?? 0);
  if (count?.capped || files > ZIP_FILES || bytes > ZIP_BYTES) {
    ext.toast(`${name} is too big to zip: ${count?.capped ? "more than " : ""}${files.toLocaleString()} files and ${fmtSize(bytes)}, and the limit is ${ZIP_FILES.toLocaleString()} files or ${fmtSize(ZIP_BYTES)}. Download its folders one at a time.`, { tone: "warn" });
    return false;
  }
  const skipped = Number(count?.skipped?.files ?? 0);
  const skipNote = skipped ? ` ${skipped.toLocaleString()} ${skipped === 1 ? "file" : "files"} in .git and node_modules ${skipped === 1 ? "is" : "are"} left out.` : " .git and node_modules are left out.";
  ext.toast(`Zipping ${name}: ${files.toLocaleString()} ${files === 1 ? "file" : "files"}, ${fmtSize(bytes)}.${skipNote}`);
  location.assign(ext.raw.url("zip", { path: entry.path }));
  return true;
}

/** Lets the browser save one file through the raw route. */
export function downloadFile(...args) {
  const { ext, rest } = refs(...args);
  const entry = rest.find((a) => a && typeof a === "object" && typeof a.path === "string");
  if (!ext || !entry) return false;
  if (!ext.raw?.url) { toastOnce(ext, notAvailable("Downloading a file"), { tone: "warn" }); return false; }
  location.assign(ext.raw.url("raw", { path: entry.path, download: true }));
  return true;
}

// ---- the explorer's inline rows ----

/** Starts the explorer's inline row for a new file or folder in `dir`. `kind` is "file" or "dir". */
export function newEntry(explorer, ...args) {
  const { rest } = refs(...args);
  const [dir, kind = "file"] = rest.filter((a) => typeof a === "string");
  if (typeof explorer?.beginNew === "function") return explorer.beginNew(dir, kind === "folder" ? "dir" : kind);
  console.warn("ui-workspace: the explorer has no beginNew(dir, kind); a new entry cannot be started here.");
}

/** Starts the explorer's inline rename of `entry`. */
export function rename(explorer, ...args) {
  const { rest } = refs(...args);
  const entry = rest.find((a) => a && typeof a === "object" && typeof a.path === "string");
  if (typeof explorer?.beginRename === "function") return explorer.beginRename(entry);
  console.warn("ui-workspace: the explorer has no beginRename(entry); a rename cannot be started here.");
}

/** Copies a path to the clipboard and says so. */
export async function copyPath(...args) {
  const { ext, rest } = refs(...args);
  const path = rest.find((a) => typeof a === "string") ?? rest.find((a) => a && typeof a.path === "string")?.path;
  if (!path) return false;
  try {
    await navigator.clipboard.writeText(path);
    ext?.toast(`Copied ${path}`);
    return true;
  } catch {
    ext?.toast("The path was not copied: the browser refused clipboard access. Select it and copy it by hand.", { tone: "warn" });
    return false;
  }
}
