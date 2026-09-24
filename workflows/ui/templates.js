/* Template holes and parse patterns, as the inspector offers and tests them. DOM-free. The scope follows
 * the README's "Templates" section: `input`, `run.id`, `run.number`, and what every other step saves. */

import { savedFields } from "./steps.js";

/** The holes a template in step `self` may use: `[{ path, step? }]`, the run's own first. */
export function templateVariables(def, self) {
  const out = [{ path: "input" }, { path: "run.id" }, { path: "run.number" }];
  for (const [id, step] of Object.entries(def?.steps ?? {})) {
    if (id === self) continue;
    for (const field of savedFields(step)) out.push({ path: `${id}.${field}`, step: id });
  }
  return out;
}

/** The text with `{{path}}` put in place of [start, end), and where the caret goes after it. */
export function insertHole(text, start, end, path) {
  const hole = `{{${path}}}`;
  const s = Math.max(0, Math.min(start ?? text.length, text.length));
  const e = Math.max(s, Math.min(end ?? s, text.length));
  return { text: text.slice(0, s) + hole + text.slice(e), caret: s + hole.length };
}

/** Every `{{path}}` a template names, trimmed, in order, without repeats. */
export function holes(text) {
  const out = [];
  for (const m of String(text ?? "").matchAll(/\{\{\s*([^{}]*?)\s*\}\}/g)) if (m[1] && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/**
 * Runs a parse step's fields against sample text the way the engine does (flags `m`; the first capture
 * group, else the whole match): `[{ name, ok, value?, error? }]`, where `error` is a pattern that does not
 * compile and `ok: false` without one is a miss.
 */
export function testParse(fields, sample) {
  return Object.entries(fields ?? {}).map(([name, source]) => {
    let re;
    try {
      re = new RegExp(String(source ?? ""), "m");
    } catch (err) {
      return { name, ok: false, error: err.message };
    }
    const m = re.exec(String(sample ?? ""));
    if (!m) return { name, ok: false };
    return { name, ok: true, value: m[1] !== undefined ? m[1] : m[0] };
  });
}
