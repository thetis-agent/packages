// The one command of @thetis/ui-tools: `tools` answers the tools the person's installed packages
// declare, reduced to what the dock draws, plus what the conversation's last call actually received.
// It reads `env.kernel.packages.list()`, which is the same list the control panel shows, so the dock
// never disagrees with it; and, when a conversation is open, `env.kernel.sessions.inspect(env.session)`
// for the record `@thetis/harness-core` keeps under its own key in `harness` after every completed
// turn (docs/04-pipeline.md section 10). Only the time and the tool names of that record travel: the
// dock subtracts them from the declarations to name what a project or a mode package withheld in the
// call phase, without this package knowing which one did. No package configuration is available here:
// the gateway hands a UI command the fence environment, the person, and the session, and the kernel
// sends `config.packages[<name>]` only into that package's own steps and tools (docs/15-web-gateway.md
// section 11.4). This command needs none.

/** The key `@thetis/harness-core` keeps its per-session state under. */
const HARNESS = "@thetis/harness-core";

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

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

/** `{ at, tools }` of the last completed call in `harness`, or null when nothing has been recorded there. */
function lastCallOf(harness) {
  const own = isRecord(harness) ? harness[HARNESS] : null;
  const lastCall = isRecord(own) ? own.lastCall : null;
  if (!isRecord(lastCall)) return null;
  const tools = Array.isArray(lastCall.tools) ? lastCall.tools.filter((name) => typeof name === "string") : [];
  return { at: typeof lastCall.at === "string" ? lastCall.at : null, tools };
}

/**
 * The `tools` command: `{ data: { packages, lastCall } }`. `args` is unused. `env.session` is the
 * conversation on screen; without one, `lastCall` is null, as it is before the conversation's first call.
 */
export async function uiTools(_args, env) {
  const packages = await env.kernel.packages.list();
  const record = env.session ? await env.kernel.sessions.inspect(env.session) : null;
  return { data: { packages: packages.map(reducePackage), lastCall: lastCallOf(record?.harness) } };
}
