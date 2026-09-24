// The validator: what is wrong with a definition, as sentences a person can act on, each tied to the step
// it is about. Errors stop a publish; warnings are shown and allowed. It is pure: the list of models the
// kernel serves is passed in, and when it is not, the model warning is simply not given.
import { holes } from "./template.js";
import { STEP_TYPES, isProjectId, isStepId } from "./definition.js";

const isObject = (v) => !!v && typeof v === "object" && !Array.isArray(v);
const has = (v) => typeof v === "string" && v.length > 0;
const RESERVED = new Set(["input", "run"]);
const PARSE_SAVES = ["matched", "text", "source"];

/** A parse step's `from`, always as a list. */
export function sourcesOf(step) {
  if (Array.isArray(step?.from)) return step.from.filter((s) => typeof s === "string");
  return typeof step?.from === "string" && step.from ? [step.from] : [];
}

/**
 * Every outgoing edge of a step, as `[field, target]`. The engine ignores `layout`; the canvas draws these.
 * `branch` cases are `cases.<value>`.
 */
export function edges(step) {
  if (!isObject(step)) return [];
  const out = [];
  const add = (field, target) => {
    if (has(target)) out.push([field, target]);
  };
  switch (step.type) {
    case "prompt":
      add("next", step.next);
      add("onBreach", step.onBreach);
      break;
    case "tool":
      add("next", step.next);
      add("onError", step.onError);
      break;
    case "parse":
      add("next", step.next);
      add("onNoMatch", step.onNoMatch);
      break;
    case "branch":
      if (isObject(step.cases)) for (const [value, target] of Object.entries(step.cases)) add(`cases.${value}`, target);
      add("default", step.default);
      break;
    case "loop":
      add("target", step.target);
      add("exhausted", step.exhausted);
      break;
    case "approval":
      add("next", step.next);
      add("onReject", step.onReject);
      break;
  }
  return out;
}

/** What a step of this type saves under its id, for the hole check. */
function saves(step) {
  switch (step?.type) {
    case "prompt":
      return ["text", "conversation", "cost", "toolCalls", "tokens", "ms"];
    case "tool":
      return ["text", "error"];
    case "parse":
      return [...(isObject(step.fields) ? Object.keys(step.fields) : []), ...PARSE_SAVES];
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

/** The template fields of a step, as `[field, template]`. */
function templates(step) {
  const out = [];
  const add = (field, v) => {
    if (typeof v === "string") out.push([field, v]);
  };
  switch (step?.type) {
    case "prompt":
      add("title", step.title);
      add("prompt", step.prompt);
      add("nudge", step.nudge);
      break;
    case "tool": {
      const walk = (v, path) => {
        if (typeof v === "string") out.push([path, v]);
        else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}.${i}`));
        else if (isObject(v)) for (const [k, x] of Object.entries(v)) walk(x, `${path}.${k}`);
      };
      walk(step.args, "args");
      break;
    }
    case "parse":
      add("followUp", step.followUp);
      break;
    case "branch":
      add("on", step.on);
      break;
    case "approval":
      add("message", step.message);
      break;
    case "done":
      add("summary", step.summary);
      break;
    case "needs":
      add("reason", step.reason);
      break;
  }
  return out;
}

/**
 * `validate(definition, { models })` answers `{ ok, issues: [{ step?, level, message }] }`. `ok` is true
 * when there are no errors. `models` is the list of model ids the kernel serves, or omitted.
 */
export function validate(definition, { models } = {}) {
  const issues = [];
  const error = (message, step) => issues.push(step ? { step, level: "error", message } : { level: "error", message });
  const warn = (message, step) => issues.push(step ? { step, level: "warn", message } : { level: "warn", message });

  if (!isObject(definition)) {
    error("The definition is not an object.");
    return { ok: false, issues };
  }
  const steps = isObject(definition.steps) ? definition.steps : {};
  const ids = Object.keys(steps);
  const exists = (id) => has(id) && Object.prototype.hasOwnProperty.call(steps, id) && isObject(steps[id]);
  const typeOf = (id) => (exists(id) ? steps[id].type : undefined);

  if (definition.costCapUsd !== undefined && !(Number.isFinite(definition.costCapUsd) && definition.costCapUsd > 0)) {
    error("The cost cap must be a number of dollars greater than zero, or left empty to use the package's.");
  }
  if (definition.project !== undefined && !isProjectId(definition.project)) {
    error(`${JSON.stringify(definition.project)} is not a project id; pick a project from the list or leave it empty.`);
  }
  if (definition.input !== undefined && isObject(definition.input) && definition.input.kind !== undefined && !["lines", "text"].includes(definition.input.kind)) {
    error(`The input kind must be "lines" or "text", not ${JSON.stringify(definition.input.kind)}.`);
  }
  if (!ids.length) error("The workflow has no steps. Add one and make it the start.");
  if (!has(definition.start)) error("The workflow has no start step. Choose which step runs first.");
  else if (!exists(definition.start)) error(`The start step "${definition.start}" does not exist.`);

  for (const id of ids) {
    const step = steps[id];
    if (!isStepId(id)) error(`"${id}" is not a usable step id: use a lowercase letter, then up to 31 lowercase letters, digits or underscores.`, id);
    if (RESERVED.has(id)) error(`"${id}" is reserved for the template scope ({{${id}}}); rename the step.`, id);
    if (!isObject(step)) {
      error(`Step "${id}" is not an object.`, id);
      continue;
    }
    if (!STEP_TYPES.includes(step.type)) {
      error(`Step "${id}" has an unknown type ${JSON.stringify(step.type)}; it must be one of ${STEP_TYPES.join(", ")}.`, id);
      continue;
    }
    for (const [field, target] of edges(step)) {
      if (!exists(target)) error(`Step "${id}" sends ${field} to "${target}", which is not a step.`, id);
    }
    const need = (field, what) => {
      if (!has(step[field])) error(`Step "${id}" has no ${what}.`, id);
    };

    switch (step.type) {
      case "prompt": {
        need("model", "model; pick the model its turns run on");
        need("prompt", "prompt text");
        const conv = step.conversation ?? "new";
        if (conv !== "new") {
          if (typeOf(conv) !== "prompt") error(`Step "${id}" continues the conversation of "${conv}", which is not a prompt step. Use "new" or name a prompt step.`, id);
        }
        if (conv !== "new" && has(step.title)) warn(`Step "${id}" has a title, but only a new conversation uses one; it is ignored.`, id);
        const budget = step.budget;
        if (budget !== undefined && budget !== null && !isObject(budget)) error(`Step "${id}" has a budget that is not an object of toolCalls, tokens and minutes.`, id);
        const limits = isObject(budget) ? ["toolCalls", "tokens", "minutes"].filter((k) => budget[k] !== undefined && budget[k] !== null) : [];
        for (const k of limits) {
          if (!(typeof budget[k] === "number" && Number.isFinite(budget[k]) && budget[k] > 0)) error(`Step "${id}" has a ${k} budget that is not a positive number.`, id);
        }
        if (!limits.length) warn(`Step "${id}" has no budget, so nothing stops a turn that keeps exploring except the cost cap.`, id);
        if (has(step.model) && Array.isArray(models) && models.length && !models.includes(step.model)) {
          warn(`Step "${id}" uses the model "${step.model}", which this workspace's providers do not list.`, id);
        }
        if (!has(step.next)) error(`Step "${id}" has no next step, so a run would have no way out of it.`, id);
        break;
      }
      case "tool":
        need("package", "package");
        need("export", "export");
        need("name", "tool name");
        if (step.args !== undefined && !isObject(step.args)) error(`Step "${id}" has args that are not an object.`, id);
        if (!has(step.next)) error(`Step "${id}" has no next step, so a run would have no way out of it.`, id);
        break;
      case "parse": {
        const from = sourcesOf(step);
        if (!from.length || (Array.isArray(step.from) && from.length !== step.from.length)) {
          error(`Step "${id}" does not say which step's text to parse; set from to a prompt or tool step, or a list of them.`, id);
        }
        for (const src of from) {
          if (!["prompt", "tool"].includes(typeOf(src))) error(`Step "${id}" parses "${src}", which is not a prompt or tool step.`, id);
        }
        if (has(step.followUp) && from.length && from.every((s) => typeOf(s) === "tool")) {
          warn(`Step "${id}" has a follow-up, but it parses a tool step, which cannot be asked again; the follow-up is ignored.`, id);
        }
        const fields = isObject(step.fields) ? step.fields : {};
        if (!Object.keys(fields).length) error(`Step "${id}" has no fields to parse.`, id);
        for (const [name, source] of Object.entries(fields)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(name)) error(`Step "${id}" has a field named ${JSON.stringify(name)}; a field name is a letter or underscore, then letters, digits or underscores.`, id);
          if (PARSE_SAVES.includes(name)) error(`Step "${id}" has a field named "${name}", which the step saves itself; rename the field.`, id);
          if (typeof source !== "string" || !source) {
            error(`Step "${id}" has no pattern for the field "${name}".`, id);
            continue;
          }
          try {
            new RegExp(source, "m");
          } catch (e) {
            error(`Step "${id}" has a pattern for "${name}" that does not compile: ${e.message}.`, id);
          }
        }
        if (step.required !== undefined) {
          if (!Array.isArray(step.required)) error(`Step "${id}" has required that is not a list of field names.`, id);
          else for (const r of step.required) if (!Object.prototype.hasOwnProperty.call(fields, r)) error(`Step "${id}" requires "${r}", which is not one of its fields.`, id);
        }
        if (!has(step.next)) error(`Step "${id}" has no next step, so a run would have no way out of it.`, id);
        break;
      }
      case "branch":
        need("on", "value to branch on");
        if (step.cases !== undefined && !isObject(step.cases)) error(`Step "${id}" has cases that are not an object of value to step.`, id);
        if (!edges(step).length) error(`Step "${id}" has no cases and no default, so a run would have no way out of it.`, id);
        break;
      case "loop":
        if (!(Number.isInteger(step.max) && step.max >= 1)) error(`Step "${id}" needs a max of at least 1: how many times it may send the run back.`, id);
        if (!has(step.target)) error(`Step "${id}" has no target to loop back to.`, id);
        break;
      case "approval":
        if (!has(step.next)) error(`Step "${id}" has no next step for an approval, so a run would have no way out of it.`, id);
        break;
    }
  }

  // Reachability, from the start over every edge.
  if (exists(definition.start)) {
    const seen = new Set([definition.start]);
    const queue = [definition.start];
    while (queue.length) {
      const id = queue.shift();
      for (const [, target] of edges(steps[id])) if (exists(target) && !seen.has(target)) (seen.add(target), queue.push(target));
    }
    for (const id of ids) if (!seen.has(id)) warn(`Step "${id}" cannot be reached from the start.`, id);
  }

  // Holes that nothing can ever set.
  for (const id of ids) {
    const step = steps[id];
    if (!isObject(step)) continue;
    for (const [field, template] of templates(step)) {
      for (const path of holes(template)) {
        const [head, key, ...rest] = path.split(".");
        if (head === "input" && key === undefined) continue;
        if (head === "run" && (key === "id" || key === "number") && !rest.length) continue;
        if (!exists(head)) {
          warn(`Step "${id}" uses {{${path}}} in its ${field}, but there is no step "${head}".`, id);
          continue;
        }
        if (key === undefined || !saves(steps[head]).includes(key)) {
          warn(`Step "${id}" uses {{${path}}} in its ${field}, but step "${head}" never saves ${key === undefined ? "a value by that name" : `"${key}"`}.`, id);
        }
      }
    }
  }

  return { ok: !issues.some((i) => i.level === "error"), issues };
}

/** The first error as one sentence, for a refusal. */
export function firstError(validation) {
  const e = validation?.issues?.find((i) => i.level === "error");
  return e ? e.message : null;
}
