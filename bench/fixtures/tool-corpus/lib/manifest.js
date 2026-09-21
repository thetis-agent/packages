// One corpus record as a package manifest. The record's id is the group id, its brief and tags go to
// `thetis.toolGroup`, and its tools are declared as they are, canary and all, so the tool segment of the
// assembled call carries the canary whenever the group is attached. scripts/embed-corpus.mjs in
// @thetis/tool-groups builds the same objects, so the vectors it writes are keyed by the hashes a run derives.

/** The directory name under `packages/` in the home, and the unscoped package name. */
export const dirOf = (record) => `tg-${String(record.id).toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;

export function manifestOf(record, scope) {
  const tools = (Array.isArray(record.tools) ? record.tools : []).map((t) => ({
    name: String(t.name),
    description: String(t.description ?? ""),
    parameters: t.parameters && typeof t.parameters === "object" ? t.parameters : { type: "object", properties: {} },
    export: "run",
  }));
  return {
    name: `@${scope}/${dirOf(record)}`,
    version: "1.0.0",
    description: String(record.description ?? ""),
    type: "module",
    main: "index.js",
    thetis: {
      type: "tool",
      toolGroup: { id: record.id, brief: String(record.description ?? ""), tags: Array.isArray(record.tags) ? record.tags : [], alwaysOn: record.alwaysOn === true },
      tools,
    },
  };
}

/** What `ctx.packages` would show for the record once installed: enough for deriveGroups. */
export function packageInfoOf(record, scope = "bench") {
  const m = manifestOf(record, scope);
  return { name: m.name, version: m.version, type: m.thetis.type, description: m.description, root: "", thetis: m.thetis, everyone: false };
}

/** The module every corpus package ships: one export, `run`, that answers a fixed line. */
export const MODULE = 'export async function run(args) {\n  return `ok: ${JSON.stringify(args ?? {})}`;\n}\n';
