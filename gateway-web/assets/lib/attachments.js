/* The composer's attachments: the pictures a person pastes, drops or picks before sending. Each one is
 * uploaded to `POST /api/media` the moment it arrives, so by the time the send button is pressed the
 * message only has to carry asset references — the same `asset` parts the transcript already draws and
 * the provider adapters already translate. A file that is still uploading holds the send; one whose
 * upload failed is shown as such and left out of the message, never sent as a broken reference.
 *
 * The model is deliberately DOM-free so it can be tested under node: `Attachments` keeps the list and
 * tells its watcher when it changes, and `pickFiles` says which of a paste's or a drop's items are worth
 * taking. What is accepted is what the shipped adapters and the transcript understand — images first;
 * the audio, video and PDF kinds the runtime's OpenRouter adapter also translates are taken too, so a
 * person is not refused a file the model would have read. */

import { apiBytes } from "./api.js";

/** The kinds the transcript renders inline and the shipped adapters translate. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const OTHER_TYPES = ["application/pdf", "audio/mpeg", "audio/mp3", "audio/wav", "audio/x-wav", "audio/ogg", "audio/flac", "audio/aac", "audio/mp4", "video/mp4", "video/webm", "video/ogg"];
export const ACCEPTED_TYPES = [...IMAGE_TYPES, ...OTHER_TYPES];

/** The runtime's upload boundary (`MAX_ASSET_BYTES`), so the refusal happens here and not after 8 MiB has travelled. */
export const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** The most one message carries. Past this the tray is a mistake, not a message. */
export const MAX_ATTACHMENTS = 10;

export function accepts(type) {
  return ACCEPTED_TYPES.includes(String(type || "").toLowerCase());
}

/**
 * The files worth taking off a `DataTransfer` (a paste's clipboardData or a drop's dataTransfer). A paste
 * of text carries no files and yields nothing, so the textarea's own paste goes on as before; a paste
 * from a screenshot tool carries one image item and no text. Files of a kind nothing here understands are
 * reported apart so the composer can say why they were left.
 */
export function pickFiles(transfer) {
  const taken = [];
  const refused = [];
  if (!transfer) return { taken, refused };
  const items = transfer.items ? Array.from(transfer.items) : [];
  const files = items.length ? items.filter((it) => it.kind === "file").map((it) => it.getAsFile()).filter(Boolean) : Array.from(transfer.files ?? []);
  for (const file of files) {
    if (accepts(file.type)) taken.push(file);
    else refused.push(file);
  }
  return { taken, refused };
}

/** A pasted screenshot arrives as `image.png` from every browser; a name with a clock in it tells them apart in a transcript. */
export function nameFor(file, now = new Date()) {
  if (file.name && file.name !== "image.png" && file.name !== "image.jpg" && file.name !== "blob") return file.name;
  const ext = (file.type.split("/")[1] || "bin").replace("jpeg", "jpg");
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z").replace("T", "-");
  return `pasted-${stamp}.${ext}`;
}

export function describeSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

let nextKey = 1;

/**
 * The tray's model: an ordered list of `{ key, file, name, mediaType, size, status, asset?, error? }`.
 * `status` is `uploading`, `ready` or `failed`. `upload` is injected so a test can stand in for the server.
 */
export class Attachments {
  constructor({ upload = defaultUpload, onChange = () => {} } = {}) {
    this.items = [];
    this.upload = upload;
    this.onChange = onChange;
  }

  get length() {
    return this.items.length;
  }

  /** True while any upload is still on its way: a send has to wait for it. */
  get busy() {
    return this.items.some((it) => it.status === "uploading");
  }

  /** The attachments a message can carry: uploaded, with an asset id. */
  get ready() {
    return this.items.filter((it) => it.status === "ready");
  }

  /**
   * Takes the files in, refusing the ones too large or too many, and starts each upload. Returns the
   * refusals so the composer can say what was left out and why; the accepted ones show in the tray.
   */
  add(files) {
    const refused = [];
    const room = MAX_ATTACHMENTS - this.items.length;
    let taken = 0;
    for (const file of files) {
      if (!accepts(file.type)) { refused.push({ file, reason: `${file.name || "That file"} is ${file.type || "of an unknown kind"}, which the model cannot read.` }); continue; }
      if (file.size > MAX_ATTACHMENT_BYTES) { refused.push({ file, reason: `${file.name || "That file"} is ${describeSize(file.size)}, and the limit is 8 MB.` }); continue; }
      if (taken >= room) { refused.push({ file, reason: `A message carries at most ${MAX_ATTACHMENTS} attachments.` }); continue; }
      taken++;
      const item = { key: nextKey++, file, name: nameFor(file), mediaType: file.type.toLowerCase(), size: file.size, status: "uploading", asset: null, error: null };
      this.items.push(item);
      void this.#send(item);
    }
    if (taken) this.onChange();
    return refused;
  }

  async #send(item) {
    try {
      const asset = await this.upload(item.file, item.name);
      if (!this.items.includes(item)) return; // removed while it travelled
      item.asset = asset;
      item.status = "ready";
    } catch (err) {
      if (!this.items.includes(item)) return;
      item.status = "failed";
      item.error = err?.message || "The upload failed.";
    }
    this.onChange();
  }

  /** Tries a failed upload again. */
  retry(key) {
    const item = this.items.find((it) => it.key === key);
    if (!item || item.status !== "failed") return;
    item.status = "uploading";
    item.error = null;
    this.onChange();
    void this.#send(item);
  }

  remove(key) {
    const at = this.items.findIndex((it) => it.key === key);
    if (at < 0) return;
    this.items.splice(at, 1);
    this.onChange();
  }

  clear() {
    if (!this.items.length) return;
    this.items = [];
    this.onChange();
  }

  /** Puts a cleared list back, for a send that was refused. */
  restore(items) {
    if (!items?.length) return;
    this.items = [...items];
    this.onChange();
  }

  /** The `asset` parts of what is ready, in the order they were added. */
  parts() {
    return this.ready.map((it) => ({ type: "asset", data: { id: it.asset.id, mediaType: it.asset.mediaType || it.mediaType, ...(it.name ? { name: it.name } : {}) } }));
  }
}

async function defaultUpload(file, name) {
  const asset = await apiBytes(`/api/media?name=${encodeURIComponent(name)}`, file, { method: "POST" });
  if (!asset || typeof asset.id !== "string") throw new Error("The server did not return an attachment id.");
  return asset;
}

/**
 * The `TurnInput` a message with attachments is sent as: one user message whose content is the text part
 * (when there is text) followed by the asset parts. Text alone stays a string, which is the wire shape
 * every older gateway and test already knows.
 */
export function buildInput(text, parts) {
  const trimmed = String(text ?? "").trim();
  if (!parts?.length) return trimmed;
  const content = [];
  if (trimmed) content.push({ type: "text", data: { text: trimmed } });
  content.push(...parts);
  return { role: "user", content };
}

/** What the transcript draws for the person's own row before the server echoes it: the same content the message carries. */
export function localContent(input) {
  return typeof input === "string" ? input : input.content;
}
