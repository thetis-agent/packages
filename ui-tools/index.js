// The one command of @thetis/ui-tools: `tools` answers the tools the person's installed packages
// declare, reduced to what the dock draws. It reads `env.kernel.packages.list()`, which is the same
// list the control panel shows, so the dock never disagrees with it. No package configuration is
// available here: the gateway hands a UI command the fence environment, the person, and the session,
// and the kernel sends `config.packages[<name>]` only into that package's own steps and tools
// (docs/15-web-gateway.md section 11.4). This command needs none.

/** Tool names that read and never write, by their first word. `todo_read` is the one exception to the word rule. */
const READING_WORDS = new Set(["read", "search", "find", "get", "list"]);

/**
 * A guess from the name alone: `read_path`, `search_files`, `find_files`, `get_directory`, `list_*`
 * and `todo_read` read; everything else is taken to change something. The manifest declares no
 * effect, so this is the honest limit of what the dock can say without running the tool.
 */
export function readsOnly(name) {
  if (typeof name !== "string") return false;
  if (name === "todo_read") return true;
  const first = name.split(/[_-]/, 1)[0];
  return READING_WORDS.has(first);
}

/** The parameter names a tool's JSON schema marks as required, in declaration order. */
function requiredOf(parameters) {
  const required = parameters && typeof parameters === "object" ? parameters.required : null;
  return Array.isArray(required) ? required.filter((p) => typeof p === "string") : [];
}

function reduceTool(tool) {
  return {
    name: tool.name,
    description: typeof tool.description === "string" ? tool.description : "",
    required: requiredOf(tool.parameters),
    reads: readsOnly(tool.name),
  };
}

function reducePackage(info) {
  const tools = Array.isArray(info.thetis?.tools) ? info.thetis.tools : [];
  return {
    name: info.name,
    version: info.version,
    type: info.type,
    description: typeof info.description === "string" ? info.description : "",
    tools: tools.filter((t) => t && typeof t.name === "string").map(reduceTool),
  };
}

/** The `tools` command. `args` is unused; `env.session` is the conversation on screen, and today every conversation sees the same tools. */
export async function uiTools(_args, env) {
  const packages = await env.kernel.packages.list();
  return { data: { packages: packages.map(reducePackage) } };
}
