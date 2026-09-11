/* What may be attached to a message, and what to say when something may not.
 *
 * The host decides this too — gateway-web/index.ts holds the same three numbers, http.ts refuses an
 * upload that breaks them and wire.ts refuses a message that names a file it cannot find. None of that
 * is a good way to learn that a 30 MB photograph was never going to work: the person should be told
 * while they are still looking at the file they dropped, not after the upload has finished. So the rules
 * are stated twice on purpose, and `attach.test.ts` reads both copies and fails if they disagree.
 *
 * The decisions live here, apart from the tray that draws them, for the reason lib/dispatch.js gives:
 * this is the part with branches worth testing and the part that needs no DOM to make. It is handed
 * plain `{name, type, size}` records rather than reaching for `File`, and it returns what to keep and
 * what to say rather than keeping or saying anything. There is no DOM harness in this repository, and
 * attach.test.ts covers these branches only because nothing in this file touches `document`, `fetch` or
 * `FileReader`. Keep it that way: an import of ./dom.js here would take the test with it.
 */

/** The same three numbers as `settings.attachmentBytes`, `settings.attachments` and
 *  `settings.attachmentTypes` in gateway-web/index.ts. Changing one without the other is a test failure. */
export const limits = {
  bytes: 8388608,
  count: 8,
  types: ["image/png", "image/jpeg", "image/gif", "image/webp"],
};

/** Megabytes, as the refusal says them: the limit is a round number and should read like one. */
function megabytes(bytes) {
  return Math.round(bytes / 1048576);
}

/** A size a person can read. Under a megabyte, kilobytes; over it, one decimal place. */
export function describeSize(bytes) {
  const value = bytes;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  if (value < 1024) return `${Math.round(value)} B`;
  if (value < 1048576) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1048576).toFixed(1)} MB`;
}

/** The line under the tray: how much is going with this message. */
export function summarise(files) {
  const list = Array.isArray(files) ? files : [];
  if (list.length === 0) return "";
  const total = list.reduce((sum, file) => sum + (Number(file?.size) || 0), 0);
  return `${String(list.length)} ${list.length === 1 ? "image" : "images"} · ${describeSize(total)}`;
}

/**
 * Sorts a batch of dropped, pasted or picked files into the ones that can go and the reasons the rest
 * cannot. Reasons are collected rather than thrown so that dropping ten files, one of them a PDF, still
 * attaches the nine — and says once what happened to the tenth rather than ten times.
 *
 * @param {Iterable<{name?: string, type?: string, size?: number}>} files  what was dropped or picked
 * @param {number} held  how many are already in the tray
 * @param {{bytes: number, count: number, types: string[]}} [bounds]
 * @returns {{accept: object[], refusals: string[]}}
 */
export function reviewFiles(files, held, bounds = limits) {
  const accept = [];
  const refusals = [];
  const say = (message) => { if (!refusals.includes(message)) refusals.push(message); };
  let room = Math.max(0, bounds.count - (Number(held) || 0));

  for (const file of files ?? []) {
    if (!file) continue;
    if (!bounds.types.includes(file.type)) { say("Only images can be attached."); continue; }
    if (!(Number(file.size) > 0)) { say(nameOf(file) ? `${nameOf(file)} is empty.` : "That file is empty."); continue; }
    if (file.size > bounds.bytes) {
      const limit = `the limit is ${String(megabytes(bounds.bytes))} MB`;
      say(nameOf(file) ? `${nameOf(file)} is too large — ${limit}.` : `That image is too large — ${limit}.`);
      continue;
    }
    if (room === 0) { say(`You can attach up to ${String(bounds.count)} images to a message.`); continue; }
    room -= 1;
    accept.push(file);
  }
  return { accept, refusals };
}

/** A file's own name, trimmed to something showable — clipboard images often arrive with none at all. */
export function nameOf(file) {
  const raw = typeof file?.name === "string" ? file.name.trim() : "";
  return raw.slice(0, 128);
}

/** Where one image is uploaded to. The name rides in the query because the body is the image itself. */
export function uploadPath(conversation, name) {
  const query = name ? `?name=${encodeURIComponent(name)}` : "";
  return `./api/attachments/${encodeURIComponent(conversation)}${query}`;
}

/**
 * Reads what the upload endpoint answered. Every endpoint on this surface answers the same
 * `{ok:true,value}` / `{ok:false,error:{code,message}}` shape, and the message it sends back is already
 * written for a person to read — so a refusal is shown as the host worded it rather than reworded here,
 * and only an answer that is not that shape at all gets a sentence of our own.
 *
 * @returns {{ok: true, value: object} | {ok: false, message: string}}
 */
export function readAnswer(payload) {
  if (payload && payload.ok === true && payload.value && typeof payload.value === "object") {
    const { name, mime, bytes, hash, path } = payload.value;
    if (typeof name === "string" && typeof mime === "string" && typeof bytes === "number"
      && typeof hash === "string" && typeof path === "string") return { ok: true, value: { name, mime, bytes, hash, path } };
  }
  const message = payload && payload.error && typeof payload.error.message === "string" ? payload.error.message : "";
  return { ok: false, message: message || "That image could not be added. Try again." };
}
