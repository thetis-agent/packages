// Some tool hosts hand a call's arguments over as text: `true` arrives as "true", a list as '["#1","#2"]'.
// Each tool's arguments are brought back to the types its schema in package.json declares before the tool runs.

/** `value` as the schema says it should be, when it is a string that clearly spells that type; else unchanged. */
export function coerce(value, schema) {
  if (!schema || typeof schema !== "object") return value;
  const types = schema.type ? [schema.type].flat() : (schema.anyOf ?? []).map((s) => s.type).filter(Boolean);
  if (typeof value === "string" && !types.includes("string")) {
    const t = value.trim();
    if (types.includes("boolean") && /^(true|false)$/i.test(t)) return t.toLowerCase() === "true";
    if ((types.includes("integer") || types.includes("number")) && /^-?\d+(\.\d+)?$/.test(t)) return Number(t);
    if ((types.includes("array") || types.includes("object")) && /^[[{]/.test(t)) {
      try { value = JSON.parse(t); } catch { return value; }
    }
  }
  if (Array.isArray(value) && schema.items) return value.map((v) => coerce(v, schema.items));
  if (value && typeof value === "object" && !Array.isArray(value) && schema.properties) {
    const out = { ...value };
    for (const [k, s] of Object.entries(schema.properties)) if (k in out) out[k] = coerce(out[k], s);
    return out;
  }
  return value;
}

/** Wraps each tool export so its first argument is coerced against that tool's parameters. */
export function wrapTools(fns, tools) {
  const byExport = new Map(tools.map((t) => [t.export, t.parameters]));
  const out = {};
  for (const [name, fn] of Object.entries(fns)) {
    const params = byExport.get(name);
    out[name] = params ? (args, ...rest) => fn(coerce(args ?? {}, params), ...rest) : fn;
  }
  return out;
}
