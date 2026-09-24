/* What the editor knows about step types, and the edits that keep a definition's references whole.
 * DOM-free, so it runs under node:test. Everything here follows the "Steps" table of the package README:
 * the fields a type has, which of them name another step, and what a finished step saves as `<id>.*`. */

export const STEP_ID = /^[a-z][a-z0-9_]{0,31}$/;

/** The palette, in the order it is drawn. `tone` picks the colour family in the stylesheet. */
export const TYPES = {
  prompt: { label: "Send prompt", hint: "Model, conversation, template", group: "Conversation", tone: "accent" },
  tool: { label: "Tool call", hint: "Call a package tool", group: "Data", tone: "data" },
  parse: { label: "Parse reply", hint: "Patterns to variables", group: "Data", tone: "data" },
  branch: { label: "Branch", hint: "On a variable's value", group: "Control", tone: "warn" },
  loop: { label: "Loop back", hint: "To a step, at most N times", group: "Control", tone: "warn" },
  approval: { label: "Wait for approval", hint: "A person signs off", group: "Control", tone: "warn" },
  done: { label: "Done", hint: "The run succeeded", group: "End", tone: "ok" },
  needs: { label: "Needs you", hint: "Stop with a reason", group: "End", tone: "err" },
};

export const GROUPS = ["Conversation", "Data", "Control", "End"];

/**
 * The fields of each type that name another step and are control flow (an edge on the canvas), in the
 * order a connection offers them. `fallback` is what the engine does when the field is empty.
 * `branch.cases` is not listed: each case value is its own edge.
 */
export const FLOW_FIELDS = {
  prompt: [
    { field: "next", fallback: "end as done" },
    { field: "onBreach", fallback: "end as needs-you" },
  ],
  tool: [
    { field: "next", fallback: "end as done" },
    { field: "onError", fallback: "end as failed" },
  ],
  parse: [
    { field: "next", fallback: "end as done" },
    { field: "onNoMatch", fallback: "end as needs-you" },
  ],
  branch: [{ field: "default", fallback: "end as needs-you" }],
  loop: [
    { field: "target", fallback: "no target" },
    { field: "exhausted", fallback: "end as needs-you" },
  ],
  approval: [
    { field: "next", fallback: "end as done" },
    { field: "onReject", fallback: "end as cancelled" },
  ],
  done: [],
  needs: [],
};

export const isEnd = (type) => type === "done" || type === "needs";

/** What a finished step of each type saves, per the README's "saves as" column. */
export function savedFields(step) {
  switch (step?.type) {
    case "prompt":
      return ["text", "conversation", "cost", "toolCalls", "tokens", "ms"];
    case "tool":
      return ["text", "error"];
    case "parse":
      return [...Object.keys(step.fields ?? {}), "matched", "text", "source"];
    case "branch":
      return ["value"];
    case "loop":
      return ["count"];
    case "approval":
      return ["decision", "note"];
    default:
      return [];
  }
}

/** `parse.from` may be one id or a list of ids; the editor always works with the list. */
export function fromList(step) {
  const from = step?.from;
  if (Array.isArray(from)) return from.filter((x) => typeof x === "string" && x);
  return typeof from === "string" && from ? [from] : [];
}

/** Writes a list back the way the README prefers: a single id as a string, several as a list, none removed. */
export function setFrom(step, ids) {
  const list = [...new Set(ids.filter(Boolean))];
  if (!list.length) delete step.from;
  else step.from = list.length === 1 ? list[0] : list;
}

/** A new step of `type` with the fields it needs to be valid-looking, and nothing it does not. */
export function newStep(type, { defaultModel } = {}) {
  switch (type) {
    case "prompt":
      return { type, model: defaultModel || "", conversation: "new", prompt: "" };
    case "tool":
      return { type, package: "", export: "", name: "", args: {} };
    case "parse":
      return { type, from: "", fields: {} };
    case "branch":
      return { type, on: "", cases: {} };
    case "loop":
      return { type, target: "", max: 1 };
    case "approval":
      return { type, message: "" };
    case "done":
      return { type, summary: "" };
    case "needs":
      return { type, reason: "" };
    default:
      throw new Error(`unknown step type "${type}"`);
  }
}

/** A step id not used yet: the type's name, then `_2`, `_3`… */
export function freshId(def, type) {
  const taken = new Set(Object.keys(def?.steps ?? {}));
  const base = String(type).toLowerCase().replace(/[^a-z0-9_]/g, "").replace(/^[^a-z]+/, "") || "step";
  if (!taken.has(base)) return base.slice(0, 32);
  for (let n = 2; ; n++) {
    const id = `${base.slice(0, 28)}_${n}`;
    if (!taken.has(id)) return id;
  }
}

/** Every step-id reference a step holds, as [path, id] pairs: flow fields, cases, `conversation`, `from`. */
function references(step) {
  const out = [];
  for (const { field } of FLOW_FIELDS[step.type] ?? []) if (typeof step[field] === "string" && step[field]) out.push([field, step[field]]);
  if (step.type === "branch") for (const [value, to] of Object.entries(step.cases ?? {})) out.push([`cases.${value}`, to]);
  if (step.type === "prompt" && step.conversation && step.conversation !== "new") out.push(["conversation", step.conversation]);
  if (step.type === "parse") for (const id of fromList(step)) out.push(["from", id]);
  return out;
}

/** Removes a step and every reference to it, so no field is left naming a step that is gone. */
export function removeStep(def, id) {
  if (!def.steps?.[id]) return def;
  delete def.steps[id];
  if (def.layout) delete def.layout[id];
  if (def.start === id) def.start = "";
  for (const step of Object.values(def.steps)) {
    for (const [path, to] of references(step)) {
      if (to !== id) continue;
      if (path.startsWith("cases.")) delete step.cases[path.slice(6)];
      else if (path === "conversation") step.conversation = "new";
      else if (path === "from") setFrom(step, fromList(step).filter((x) => x !== id));
      else delete step[path];
    }
  }
  return def;
}

/**
 * Renames a step: the key, the layout entry, `start`, every reference, and every template hole that
 * starts with `<old>.`. Returns an error sentence, or null when it was done.
 */
export function renameStep(def, from, to) {
  if (from === to) return null;
  if (!STEP_ID.test(to)) return "A step id is a lowercase letter, then up to 31 lowercase letters, digits or underscores.";
  if (def.steps[to]) return `There is already a step "${to}".`;
  if (!def.steps[from]) return `There is no step "${from}".`;
  const steps = {};
  for (const [id, step] of Object.entries(def.steps)) steps[id === from ? to : id] = step;
  def.steps = steps;
  if (def.layout?.[from]) {
    def.layout[to] = def.layout[from];
    delete def.layout[from];
  }
  if (def.start === from) def.start = to;
  const hole = new RegExp(`(\\{\\{\\s*)${from}\\.`, "g");
  const retemplate = (value) => (typeof value === "string" ? value.replace(hole, `$1${to}.`) : value);
  for (const step of Object.values(def.steps)) {
    for (const [path, id] of references(step)) {
      if (id !== from) continue;
      if (path.startsWith("cases.")) step.cases[path.slice(6)] = to;
      else if (path === "from") setFrom(step, fromList(step).map((x) => (x === from ? to : x)));
      else step[path] = to;
    }
    for (const key of ["title", "prompt", "nudge", "followUp", "on", "message", "summary", "reason"]) if (key in step) step[key] = retemplate(step[key]);
    if (step.args && typeof step.args === "object") for (const k of Object.keys(step.args)) step.args[k] = retemplate(step.args[k]);
  }
  return null;
}

/** "60 calls · 250k tok · 45 min", or "" when the step has no budget. */
export function budgetLine(budget) {
  if (!budget || typeof budget !== "object") return "";
  const parts = [];
  if (budget.toolCalls) parts.push(`${budget.toolCalls} calls`);
  if (budget.tokens) parts.push(`${compact(budget.tokens)} tok`);
  if (budget.minutes) parts.push(`${budget.minutes} min`);
  return parts.join(" · ");
}

/** 1500 -> "1.5k", 250000 -> "250k", 1200000 -> "1.2M". */
export function compact(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1e6) return `${trim(v / 1e6)}M`;
  if (Math.abs(v) >= 1e3) return `${trim(v / 1e3)}k`;
  return String(v);
}
const trim = (x) => (x >= 100 ? Math.round(x) : Math.round(x * 10) / 10).toString();

/** The one-line subtitle a node shows under its label. */
export function nodeSummary(step, def) {
  const name = (id) => def?.steps?.[id]?.label || id;
  const first = (text) => String(text ?? "").split("\n").find((l) => l.trim())?.trim() ?? "";
  switch (step?.type) {
    case "tool":
      return step.name || "no tool chosen";
    case "parse": {
      const fields = Object.keys(step.fields ?? {});
      return fields.length ? fields.join(" · ") : "no fields";
    }
    case "branch":
      return step.on ? `on ${step.on.replace(/^\{\{\s*|\s*\}\}$/g, "")}` : "on nothing yet";
    case "loop":
      return `${step.target ? `to ${name(step.target)}` : "no target"} · max ${step.max ?? "?"}`;
    case "approval":
      return first(step.message) || "a person signs off";
    case "done":
      return first(step.summary);
    case "needs":
      return first(step.reason);
    default:
      return "";
  }
}
