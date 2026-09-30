/* What the model picker lists, worked out from `/api/models` and the conversation on screen. Kept free of
 * the DOM so it runs under `node:test`. The order is the order a person looks in:
 *
 *   1. This chat — the model that answers here now (for a `+` draft, the one the new chat will start with);
 *   2. Your default — what a NEW chat starts with: the model the person chose last, or, when they never
 *      chose one, the configured default. That is what the server does (`POST /api/sessions`), so the row
 *      says what really happens. When the person has a choice of their own and the configured default is a
 *      different model, a second row picks the configured one and forgets the choice (the empty id);
 *   3. Recent — the last models the person chose, newest first, without the ones already shown above;
 *   4. All models (N) — the catalogue, folded until opened or filtered, with price and context size where
 *      the provider's catalogue gives them.
 *
 * A filter looks through every row at once and answers one "Matches" section, each model once. */

import { agentName } from "./agent.js";

/** How many recent models the picker shows. The server keeps as many. */
export const RECENT_SHOWN = 5;

/** The part of a model id after its last slash: `anthropic/claude-sonnet-5` reads `claude-sonnet-5`. */
export function shortModel(id) {
  return String(id || "").split("/").pop() || "";
}

function shortPackage(name) {
  return String(name).replace(/^@thetis\/provider-/, "").replace(/^@[^/]+\//, "");
}

/** A price per token as a price per million tokens, in the fewest characters that still say it. */
export function perMillion(perToken) {
  const n = Number(perToken) * 1e6;
  if (!Number.isFinite(n) || n < 0) return null;
  if (n === 0) return "free";
  if (n < 0.01) return "<$0.01";
  if (n < 10) return `$${Number(n.toFixed(2))}`;
  return `$${Math.round(n)}`;
}

/** A context window in tokens: `200k`, `1M`, `1.5M`. */
export function contextSize(tokens) {
  const n = Number(tokens);
  if (!Number.isFinite(n) || n <= 0) return null;
  if (n >= 1e6) return `${Number((n / 1e6).toFixed(1))}M`;
  return `${Math.round(n / 1000)}k`;
}

/** The price and context columns of one catalogue row, each `{ text, title }`, or none when the catalogue says nothing. */
function columns(model) {
  const cols = [];
  const input = model?.pricing ? perMillion(model.pricing.prompt) : null;
  const output = model?.pricing ? perMillion(model.pricing.completion) : null;
  if (input || output) {
    const both = input === "free" && output === "free";
    cols.push({ kind: "price", text: both ? "free" : `${input ?? "?"} / ${output ?? "?"}`, title: both ? "Free to use" : `${input ?? "unknown"} per million tokens read, ${output ?? "unknown"} per million written` });
  }
  const ctx = contextSize(model?.contextLength);
  if (ctx) cols.push({ kind: "context", text: ctx, title: `Reads up to ${Number(model.contextLength).toLocaleString("en")} tokens at once` });
  return cols;
}

/**
 * One row for a model id: its catalogue name when listed, else the id itself. The note says why the row is
 * there when `why` is given (the top sections), else where the model comes from; the full id is always the
 * row's tooltip.
 */
function row(id, catalogue, why) {
  const model = catalogue.get(id);
  const label = model?.name && model.name !== id ? model.name : shortModel(id);
  const where = model ? (model.provider ? `${id} · ${shortPackage(model.provider)}` : id) : `${id} · not listed by any provider`;
  return { id, label, note: why ?? where, title: where, cols: columns(model) };
}

/**
 * The sections of the picker.
 * @param {object} choices    `/api/models`: `{ model, models, yours?: { model, recent } }`
 * @param {object} chat       `{ model?: string }` for a conversation (its chosen model, or none for the
 *                            default), `{ draft: true, model?: string }` for a `+` draft (its pick, `""` for
 *                            the configured default, or undefined when nothing was picked)
 * @returns {{ sections: { id, title, collapsible?, options }[], selected: string, effective: string }}
 */
export function modelSections(choices, chat = {}) {
  if (!choices) return { sections: [], selected: "", effective: "" };
  const configured = choices.model || "";
  const yours = choices.yours?.model || "";
  const recent = Array.isArray(choices.yours?.recent) ? choices.yours.recent.filter((m) => typeof m === "string" && m) : [];
  const catalogue = new Map((choices.models ?? []).filter((m) => m && typeof m.id === "string" && m.id !== "*").map((m) => [m.id, m]));
  const newChat = yours || configured; // what `POST /api/sessions` starts a conversation with

  // What answers here: a chat's own model, else the configured default it runs on; a draft's pick, else
  // what a new chat starts with. A draft's "" is the configured default, picked on purpose.
  const effective = chat.draft ? (chat.model === "" ? configured : chat.model || newChat) : chat.model || configured;
  const thisNote = chat.draft
    ? chat.model === undefined ? "a new chat starts with your default" : "picked for this new chat"
    : chat.model ? "chosen for this chat" : "the configured default";

  const sections = [];
  // Only this row is marked as the choice: the same model further down is the same model, not a second choice.
  if (effective) sections.push({ id: "this", title: chat.draft ? "New chat" : "This chat", options: [{ ...row(effective, catalogue, thisNote), selected: true }] });

  const defaults = [];
  if (newChat) defaults.push({ ...row(newChat, catalogue, yours ? "new chats start with this: the model you chose last" : "new chats start with this: set by the configuration"), selected: false });
  if (yours && configured && configured !== yours) defaults.push({ ...row(configured, catalogue, "set by the configuration · forgets your choice"), id: "", label: `${agentName()} default · ${catalogue.get(configured)?.name || shortModel(configured)}`, selected: false });
  if (defaults.length) sections.push({ id: "default", title: "Your default", options: defaults });

  const above = new Set([effective, newChat]);
  const recentRows = [...new Set(recent)].filter((m) => !above.has(m)).slice(0, RECENT_SHOWN).map((m) => ({ ...row(m, catalogue), selected: false }));
  if (recentRows.length) sections.push({ id: "recent", title: "Recent", options: recentRows });

  const all = [...catalogue.keys()].map((id) => ({ ...row(id, catalogue), selected: false }));
  if (all.length) sections.push({ id: "all", title: `All models (${all.length})`, collapsible: true, options: all });

  return { sections, selected: effective, effective };
}

/** The rows a filter keeps: every section's, each model once (its first appearance), whose words contain the query. */
export function filterSections(sections, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return sections;
  const seen = new Set();
  const options = [];
  for (const section of sections) {
    for (const option of section.options) {
      if (seen.has(option.id)) continue;
      if (!`${option.label} ${option.note ?? ""} ${option.id}`.toLowerCase().includes(q)) continue;
      seen.add(option.id);
      options.push(option);
    }
  }
  return [{ id: "matches", title: "Matches", options }];
}

/**
 * The choices after the person chose `model` somewhere, as the server now has them: it is what a new chat
 * starts with and the newest of the recent ones. `""` forgets the choice (new chats start with the
 * configured default again) and leaves Recent as it was.
 */
export function rememberChoice(choices, model) {
  if (!choices) return choices;
  const recent = Array.isArray(choices.yours?.recent) ? choices.yours.recent : [];
  return { ...choices, yours: { model: model || null, recent: model ? [model, ...recent.filter((m) => m !== model)].slice(0, RECENT_SHOWN) : recent } };
}
