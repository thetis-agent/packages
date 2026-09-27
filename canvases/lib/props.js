// What an artboard's HTML says about itself. An artboard may declare tweakable props in a JSON block,
// `<script type="application/json" id="canvas-props">`, which the page's properties panel draws as fields
// and the frame runtime turns into CSS custom properties and text; `declaredProps` reads that block and
// never throws, because a bad block is a warning for the model and a note in the panel, not a broken
// artboard. `injectRuntime` puts the frame runtime into a document on its way to the frame, and
// `externalRefs` finds what a document would fetch from elsewhere, so the tool can warn: the frame's policy
// lets nothing but Google Fonts through, and a picture from the web shows as nothing.
import { readFileSync } from "node:fs";

export const EDITORS = ["color", "text", "number", "select", "toggle"];
export const FONT_HOSTS = ["fonts.googleapis.com", "fonts.gstatic.com"];
const PROP = /^[a-z][a-z0-9_-]{0,31}$/;
const BLOCK = /<script\b[^>]*\bid\s*=\s*["']canvas-props["'][^>]*>([\s\S]*?)<\/script>/i;
const MAX_PROPS = 32;

let runtime = null;
/** The frame runtime's source, read once. */
export function runtimeSource() {
  if (runtime === null) runtime = readFileSync(new URL("./frame-runtime.js", import.meta.url), "utf8");
  return runtime;
}

/**
 * The props an artboard declares: `{ decl, problems }`, `decl` an object by prop name of
 * `{ editor, default, label?, options?, min?, max?, step? }` or null when there is no block, and `problems`
 * the sentences about what was wrong (a block that does not parse, an unknown editor, too many keys).
 */
export function declaredProps(html) {
  const problems = [];
  const match = BLOCK.exec(String(html ?? ""));
  if (!match) return { decl: null, problems };
  let raw;
  try {
    raw = JSON.parse(match[1]);
  } catch (err) {
    return { decl: null, problems: [`The #canvas-props block is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { decl: null, problems: ["The #canvas-props block must be an object of props by name."] };
  const decl = {};
  for (const [key, spec] of Object.entries(raw)) {
    if (!PROP.test(key)) {
      problems.push(`${JSON.stringify(key)} is not a prop name: lowercase letters, digits, _ and -, starting with a letter, up to 32.`);
      continue;
    }
    if (Object.keys(decl).length >= MAX_PROPS) {
      problems.push(`More than ${MAX_PROPS} props; ${key} and the rest are ignored.`);
      break;
    }
    if (!spec || typeof spec !== "object" || Array.isArray(spec)) {
      problems.push(`The prop ${key} must be an object with an editor and a default.`);
      continue;
    }
    if (!EDITORS.includes(spec.editor)) {
      problems.push(`The prop ${key} has the editor ${JSON.stringify(spec.editor)}; one of ${EDITORS.join(", ")} was expected.`);
      continue;
    }
    const out = { editor: spec.editor, default: spec.default ?? (spec.editor === "toggle" ? false : spec.editor === "number" ? 0 : "") };
    if (typeof spec.label === "string" && spec.label) out.label = spec.label.slice(0, 80);
    if (spec.editor === "select") {
      const options = Array.isArray(spec.options) ? spec.options.filter((o) => typeof o === "string").slice(0, 32) : [];
      if (!options.length) {
        problems.push(`The select prop ${key} needs options: a list of strings.`);
        continue;
      }
      out.options = options;
      if (!options.includes(out.default)) out.default = options[0];
    }
    if (spec.editor === "number") {
      for (const k of ["min", "max", "step"]) if (typeof spec[k] === "number" && Number.isFinite(spec[k])) out[k] = spec[k];
      if (typeof out.default !== "number") out.default = Number(out.default) || 0;
    }
    if (spec.editor === "toggle") out.default = Boolean(out.default);
    if ((spec.editor === "color" || spec.editor === "text") && typeof out.default !== "string") out.default = String(out.default);
    decl[key] = out;
  }
  return { decl, problems };
}

/** The document with the frame runtime in it: right after `<head>`, else after `<html>`, else at the top. */
export function injectRuntime(html, script = runtimeSource()) {
  const tag = `<script data-canvas-runtime>${script}</script>`;
  const text = String(html ?? "");
  const head = /<head\b[^>]*>/i.exec(text);
  if (head) return text.slice(0, head.index + head[0].length) + tag + text.slice(head.index + head[0].length);
  const root = /<html\b[^>]*>/i.exec(text);
  if (root) return text.slice(0, root.index + root[0].length) + tag + text.slice(root.index + root[0].length);
  return tag + text;
}

/** The hosts a document would reach over the network, other than the fonts the frame policy allows. */
export function externalRefs(html) {
  const text = String(html ?? "");
  const hosts = new Set();
  const take = (url) => {
    try {
      const host = new URL(url).host.toLowerCase();
      if (host && !FONT_HOSTS.includes(host)) hosts.add(host);
    } catch {
      /* not a URL */
    }
  };
  for (const re of [/\b(?:src|href)\s*=\s*["']?\s*(https?:\/\/[^"'\s>]+)/gi, /url\(\s*["']?\s*(https?:\/\/[^"')\s]+)/gi, /@import\s+(?:url\(\s*)?["']?\s*(https?:\/\/[^"')\s;]+)/gi]) {
    for (const m of text.matchAll(re)) take(m[1]);
  }
  return [...hosts].sort();
}
