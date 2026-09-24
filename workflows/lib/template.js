// Templates: `{{path}}` holes in a string, each a dotted lookup into the run's scope and never an
// expression. A hole that names nothing renders as an empty string, because a run that reaches a step
// before the step it names has run is a graph a person can read and fix, not a crash.
//
// The scope is `input`, `run.id`, `run.number`, and `<step id>.<field>` for every step that has saved
// something. `scopeOf(run)` builds it; `fill` renders; `holes` lists the paths a template names, which is
// what the validator checks against what the steps save.

const HOLE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*)\s*\}\}/g;

/** The paths a template names, in order, duplicates kept out. A non-string names none. */
export function holes(template) {
  if (typeof template !== "string") return [];
  const out = [];
  for (const m of template.matchAll(HOLE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

/** One dotted lookup. `undefined` when any segment is missing. */
export function lookup(scope, path) {
  let value = scope;
  for (const key of String(path).split(".")) {
    if (value === null || value === undefined || typeof value !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(value, key)) return undefined;
    value = value[key];
  }
  return value;
}

/** How a value reads inside a string: text as it is, numbers and booleans as written, anything else as JSON. */
export function render(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/** Renders every hole of `template` against `scope`. A non-string template renders as an empty string. */
export function fill(template, scope) {
  if (typeof template !== "string") return "";
  return template.replace(HOLE, (_, path) => render(lookup(scope ?? {}, path)));
}

/** Fills every string inside a JSON-shaped value (a tool step's `args`), leaving other values alone. */
export function fillDeep(value, scope) {
  if (typeof value === "string") return fill(value, scope);
  if (Array.isArray(value)) return value.map((v) => fillDeep(v, scope));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, scope)]));
  return value;
}

/** The scope a run's templates see: its input, its id and number, and what each finished step saved. */
export function scopeOf(run) {
  return { ...(run?.vars ?? {}), input: run?.input ?? "", run: { id: run?.id ?? "", number: run?.number ?? 0 } };
}
