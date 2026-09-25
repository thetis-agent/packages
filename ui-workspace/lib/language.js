// What a file's name says about it: the editor grammar (`language`), how the place shows it (`preview`),
// and what the raw route serves it as (`contentType`). All three come from the extension alone, because
// that is all a listing knows before the file is opened; `stat` adds the binary sniff for the text kinds.
//
// A name with an extension this table does not know is treated as text (`plain`), since most such files
// are: Makefile, LICENSE, a dotfile, a config with a private suffix. The sniff catches the ones that are not.
import { basename, extname } from "node:path";

/** Every language the editor can name; `plain` is text with no grammar. */
export const LANGUAGES = ["ts", "js", "jsx", "tsx", "json", "md", "html", "css", "py", "sh", "toml", "yaml", "plain"];

/** Every preview kind the place knows. */
export const PREVIEWS = ["text", "markdown", "image", "svg", "pdf", "audio", "none"];

/**
 * Extension (without the dot, lower case) → { language, preview, type }. `language` is null for a file
 * the editor never opens; `type` is the media type the raw route serves. Text types get a charset there.
 */
export const TABLE = Object.freeze({
  // code
  js: { language: "js", preview: "text", type: "text/javascript" },
  mjs: { language: "js", preview: "text", type: "text/javascript" },
  cjs: { language: "js", preview: "text", type: "text/javascript" },
  jsx: { language: "jsx", preview: "text", type: "text/javascript" },
  ts: { language: "ts", preview: "text", type: "text/typescript" },
  mts: { language: "ts", preview: "text", type: "text/typescript" },
  cts: { language: "ts", preview: "text", type: "text/typescript" },
  tsx: { language: "tsx", preview: "text", type: "text/typescript" },
  json: { language: "json", preview: "text", type: "application/json" },
  jsonc: { language: "json", preview: "text", type: "application/json" },
  json5: { language: "json", preview: "text", type: "application/json" },
  map: { language: "json", preview: "text", type: "application/json" },
  md: { language: "md", preview: "markdown", type: "text/markdown" },
  markdown: { language: "md", preview: "markdown", type: "text/markdown" },
  html: { language: "html", preview: "text", type: "text/html" },
  htm: { language: "html", preview: "text", type: "text/html" },
  xml: { language: "html", preview: "text", type: "application/xml" },
  svg: { language: "html", preview: "svg", type: "image/svg+xml" },
  css: { language: "css", preview: "text", type: "text/css" },
  py: { language: "py", preview: "text", type: "text/x-python" },
  pyi: { language: "py", preview: "text", type: "text/x-python" },
  sh: { language: "sh", preview: "text", type: "text/x-shellscript" },
  bash: { language: "sh", preview: "text", type: "text/x-shellscript" },
  zsh: { language: "sh", preview: "text", type: "text/x-shellscript" },
  toml: { language: "toml", preview: "text", type: "application/toml" },
  yaml: { language: "yaml", preview: "text", type: "application/yaml" },
  yml: { language: "yaml", preview: "text", type: "application/yaml" },
  // plain text
  txt: { language: "plain", preview: "text", type: "text/plain" },
  text: { language: "plain", preview: "text", type: "text/plain" },
  log: { language: "plain", preview: "text", type: "text/plain" },
  csv: { language: "plain", preview: "text", type: "text/csv" },
  tsv: { language: "plain", preview: "text", type: "text/tab-separated-values" },
  ini: { language: "plain", preview: "text", type: "text/plain" },
  cfg: { language: "plain", preview: "text", type: "text/plain" },
  conf: { language: "plain", preview: "text", type: "text/plain" },
  env: { language: "plain", preview: "text", type: "text/plain" },
  lock: { language: "plain", preview: "text", type: "text/plain" },
  sql: { language: "plain", preview: "text", type: "text/plain" },
  rs: { language: "plain", preview: "text", type: "text/plain" },
  go: { language: "plain", preview: "text", type: "text/plain" },
  c: { language: "plain", preview: "text", type: "text/plain" },
  h: { language: "plain", preview: "text", type: "text/plain" },
  cpp: { language: "plain", preview: "text", type: "text/plain" },
  cs: { language: "plain", preview: "text", type: "text/plain" },
  java: { language: "plain", preview: "text", type: "text/plain" },
  rb: { language: "plain", preview: "text", type: "text/plain" },
  php: { language: "plain", preview: "text", type: "text/plain" },
  lua: { language: "plain", preview: "text", type: "text/plain" },
  // images
  png: { language: null, preview: "image", type: "image/png" },
  jpg: { language: null, preview: "image", type: "image/jpeg" },
  jpeg: { language: null, preview: "image", type: "image/jpeg" },
  gif: { language: null, preview: "image", type: "image/gif" },
  webp: { language: null, preview: "image", type: "image/webp" },
  avif: { language: null, preview: "image", type: "image/avif" },
  bmp: { language: null, preview: "image", type: "image/bmp" },
  ico: { language: null, preview: "image", type: "image/x-icon" },
  // documents and sound
  pdf: { language: null, preview: "pdf", type: "application/pdf" },
  mp3: { language: null, preview: "audio", type: "audio/mpeg" },
  wav: { language: null, preview: "audio", type: "audio/wav" },
  ogg: { language: null, preview: "audio", type: "audio/ogg" },
  oga: { language: null, preview: "audio", type: "audio/ogg" },
  opus: { language: null, preview: "audio", type: "audio/ogg" },
  m4a: { language: null, preview: "audio", type: "audio/mp4" },
  aac: { language: null, preview: "audio", type: "audio/aac" },
  flac: { language: null, preview: "audio", type: "audio/flac" },
  // known binary: no preview, download only
  zip: { language: null, preview: "none", type: "application/zip" },
  gz: { language: null, preview: "none", type: "application/gzip" },
  tgz: { language: null, preview: "none", type: "application/gzip" },
  tar: { language: null, preview: "none", type: "application/x-tar" },
  bz2: { language: null, preview: "none", type: "application/x-bzip2" },
  xz: { language: null, preview: "none", type: "application/x-xz" },
  "7z": { language: null, preview: "none", type: "application/x-7z-compressed" },
  wasm: { language: null, preview: "none", type: "application/wasm" },
  woff: { language: null, preview: "none", type: "font/woff" },
  woff2: { language: null, preview: "none", type: "font/woff2" },
  ttf: { language: null, preview: "none", type: "font/ttf" },
  otf: { language: null, preview: "none", type: "font/otf" },
  mp4: { language: null, preview: "none", type: "video/mp4" },
  webm: { language: null, preview: "none", type: "video/webm" },
  mov: { language: null, preview: "none", type: "video/quicktime" },
  exe: { language: null, preview: "none", type: "application/octet-stream" },
  dll: { language: null, preview: "none", type: "application/octet-stream" },
  so: { language: null, preview: "none", type: "application/octet-stream" },
  o: { language: null, preview: "none", type: "application/octet-stream" },
  a: { language: null, preview: "none", type: "application/octet-stream" },
  bin: { language: null, preview: "none", type: "application/octet-stream" },
  dat: { language: null, preview: "none", type: "application/octet-stream" },
  db: { language: null, preview: "none", type: "application/octet-stream" },
  sqlite: { language: null, preview: "none", type: "application/octet-stream" },
  class: { language: null, preview: "none", type: "application/octet-stream" },
  jar: { language: null, preview: "none", type: "application/java-archive" },
  pyc: { language: null, preview: "none", type: "application/octet-stream" },
  doc: { language: null, preview: "none", type: "application/msword" },
  docx: { language: null, preview: "none", type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
  xls: { language: null, preview: "none", type: "application/vnd.ms-excel" },
  xlsx: { language: null, preview: "none", type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" },
  ppt: { language: null, preview: "none", type: "application/vnd.ms-powerpoint" },
  pptx: { language: null, preview: "none", type: "application/vnd.openxmlformats-officedocument.presentationml.presentation" },
});

/** Names with no extension that are text all the same, by their whole (case-insensitive) name. */
const TEXT_NAMES = new Map([
  ["makefile", "plain"],
  ["dockerfile", "plain"],
  ["license", "plain"],
  ["readme", "md"],
  ["changelog", "md"],
  [".gitignore", "plain"],
  [".gitattributes", "plain"],
  [".npmrc", "plain"],
  [".editorconfig", "plain"],
  [".env", "plain"],
  [".bashrc", "sh"],
  [".bash_profile", "sh"],
  [".profile", "sh"],
  [".zshrc", "sh"],
]);

const PLAIN = Object.freeze({ language: "plain", preview: "text", type: "text/plain" });

/** The extension of a name, lower case, without the dot; a dotfile like `.bashrc` has none. */
export function extensionOf(name) {
  const base = basename(String(name ?? ""));
  const ext = extname(base);
  return ext && ext !== base ? ext.slice(1).toLowerCase() : "";
}

/** `{ language, preview, type }` for a file name. Unknown names are plain text; the sniff decides after. */
export function kindOf(name) {
  const base = basename(String(name ?? "")).toLowerCase();
  const named = TEXT_NAMES.get(base);
  if (named) return { ...PLAIN, language: named, preview: named === "md" ? "markdown" : "text", type: named === "md" ? "text/markdown" : "text/plain" };
  const ext = extensionOf(base);
  return TABLE[ext] ?? PLAIN;
}

/** The editor grammar for a name, or null when the file is not text. */
export const languageOf = (name) => kindOf(name).language;

/** The preview kind for a name. */
export const previewOf = (name) => kindOf(name).preview;

/** The media type the raw route serves a name as, with a charset on the text kinds. */
export function contentTypeOf(name) {
  const { type, preview } = kindOf(name);
  return preview === "text" || preview === "markdown" ? `${type}; charset=utf-8` : type;
}
