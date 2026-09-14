/* Small formatters the transcript uses: the accounting footnote under a reply and the one-line gist of
 * a tool call's arguments. Kept apart so the transcript stays about drawing, not about wording. */

import { fmtCost, fmtTokens, shortModel } from "./activity.js";
import { el } from "./dom.js";

/* The accounting footnote under a reply. Reads the usage by field name; nothing reported means no footnote.
 * `model` is the one the conversation was set to; a recorded usage carries its own. */
export function usageLine(usage, model) {
  if (!usage || typeof usage !== "object") return null;
  const parts = [];
  const answered = typeof usage.model === "string" ? usage.model : model;
  if (answered) parts.push(el("span", { class: "mono", title: answered }, shortModel(answered)));
  const prompt = usage.prompt_tokens;
  if (typeof usage.cache_read_tokens === "number" && prompt) parts.push(el("span", { title: `${usage.cache_read_tokens} of ${prompt} prompt tokens came from the cache` }, `cached ${Math.round((usage.cache_read_tokens / prompt) * 100)}%`));
  if (typeof prompt === "number") parts.push(el("span", {}, `${fmtTokens(prompt)} in`));
  if (typeof usage.completion_tokens === "number") parts.push(el("span", {}, `${fmtTokens(usage.completion_tokens)} out`));
  if (typeof usage.cost === "number") parts.push(el("span", {}, fmtCost(usage.cost)));
  if (!parts.length) return null;
  return el("div", { class: "msg-usage" }, ...parts);
}

/** One line of the arguments: `key: value · key: value`, each value cut short. */
export function gist(args, max) {
  if (!args || typeof args !== "object") return "";
  const parts = [];
  for (const [key, value] of Object.entries(args)) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (text === undefined) continue;
    const one = text.replace(/\s+/g, " ").trim();
    parts.push(`${key}: ${one.length > 60 ? one.slice(0, 59) + "…" : one}`);
  }
  const line = parts.join("  ·  ");
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}
