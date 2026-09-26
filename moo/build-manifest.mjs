// Generates package.json's thetis.tools from one table, so 40+ declarations
// cannot drift in shape from each other.
import fs from "node:fs";

const OBJ = { type: "string", description: "Object reference: #number, a corified reference such as $you or $sys.utils, a UUID id such as #0011E5-9CB7359F34, or a mooR CURIE such as sysobj:system." };
const TIMEOUT = { type: "integer", minimum: 0, maximum: 300000, description: "Task deadline in milliseconds. mooR's ceiling is 300000." };
const INHERITED = { type: "boolean", description: "Include definitions inherited from ancestors. Defaults to false." };

// [name, export, description, properties, required]
const T = [
  // --- execution
  ["moo_eval", "eval_",
   "Evaluate a MOO expression in the live world and return its value, with anything the task printed. This MUTATES world state if the expression does. A timeout can occur AFTER side effects have committed, so never blindly retry a mutating call — read state back first.",
   { expression: { type: "string", description: "MOO source. `return <expr>;` to get a value back." }, timeout_ms: TIMEOUT }, ["expression"]],

  ["moo_command", "command",
   "Execute a parsed MOO command as the configured character, the way a player typing it would. Command OUTPUT IS INVISIBLE here — it goes to the player's connection — so verify what happened by reading database state back, not by looking for text in the result.",
   { command: { type: "string", description: "The command line, e.g. \"look at sign\"." }, timeout_ms: TIMEOUT }, ["command"]],

  ["moo_invoke_verb", "invokeVerb",
   "Call one verb on an object with explicit arguments and return its value. This mutates world state if the verb does. Note that parse globals (argstr, dobjstr, dobj, iobj, verb) are EMPTY here: they only exist inside a genuine parsed command, so a command verb called this way may misbehave.",
   { object: OBJ, verb: { type: "string" }, args: { type: "array", description: "Arguments, as JSON values. Each is converted to a MOO literal." }, timeout_ms: TIMEOUT }, ["object", "verb"]],

  ["moo_dispatch_command_verb", "dispatchCommandVerb",
   "Dispatch a command verb from a parsed command spec, as a player's command would reach it.",
   { player: OBJ, command: { type: "string" }, timeout_ms: TIMEOUT }, ["player", "command"]],

  // --- verbs
  ["moo_list_verbs", "listVerbs",
   "List the verbs defined on an object. FlatBuffers union wrappers are stripped, so an owner reads as `#36` rather than five levels of nesting. If an inherited behaviour seems to do nothing, list the verbs defined DIRECTLY on the object: a local stub shadows every inherited implementation.",
   { object: OBJ, inherited: INHERITED }, ["object"]],

  ["moo_get_verb", "getVerb",
   "Read one verb: its source, its owner, its permissions and its argument specification.",
   { object: OBJ, verb: { type: "string" } }, ["object", "verb"]],

  ["moo_program_verb", "programVerb",
   "Replace the entire source of an existing verb. This MUTATES world state. A successful compile is not proof of correct behaviour. Prefer moo_apply_patch_verb for a targeted change: it cannot silently discard code you did not mean to replace.",
   { object: OBJ, verb: { type: "string" }, source: { type: "string", description: "The complete new verb body." } }, ["object", "verb", "source"]],

  ["moo_apply_patch_verb", "applyPatchVerb",
   "Fetch a verb, apply one unified diff to it locally, and store the exact patched source. A patch that does not apply cleanly performs NO write. This is the safe way to change part of a verb.",
   { object: OBJ, verb: { type: "string" }, patch: { type: "string", description: "A unified diff with @@ hunk headers. Context and removal lines must match exactly." } }, ["object", "verb", "patch"]],

  ["moo_add_verb", "addVerb",
   "Add a verb to an object, optionally with its source. Mutates world state.",
   { object: OBJ, names: { type: ["string", "array"], description: "Verb name, or names/aliases. MOO wildcards like `wield*ed` are allowed." }, source: { type: "string" }, owner: OBJ, perms: { type: "string", description: "Permission bits, default \"rxd\"." }, args: { type: "array", description: "[dobj, preposition, iobj], default [\"this\",\"none\",\"this\"]." }, timeout_ms: TIMEOUT }, ["object", "names"]],

  ["moo_delete_verb", "deleteVerb",
   "Delete a verb definition from an object. Mutates world state. If you are removing an unintended local override that shadows an inherited verb, this is the right tool.",
   { object: OBJ, verb: { type: "string" }, timeout_ms: TIMEOUT }, ["object", "verb"]],

  ["moo_set_verb_args", "setVerbArgs",
   "Set a verb's direct-object, preposition and indirect-object specification.",
   { object: OBJ, verb: { type: "string" }, dobj: { type: "string", description: "none, this, or any." }, preposition: { type: "string" }, iobj: { type: "string" }, timeout_ms: TIMEOUT }, ["object", "verb", "dobj", "preposition", "iobj"]],

  ["moo_set_verb_info", "setVerbInfo",
   "Change a verb's owner, permissions or names. Only the fields you pass are changed; the others are read and put back unaltered.",
   { object: OBJ, verb: { type: "string" }, owner: OBJ, perms: { type: "string" }, names: { type: ["string", "array"] }, timeout_ms: TIMEOUT }, ["object", "verb"]],

  ["moo_find_verb_definition", "findVerbDefinition",
   "Find every object in an inheritance chain that defines a verb, and which definition is therefore active. Use this when a helper works but the main inherited behaviour silently does nothing.",
   { object: OBJ, verb: { type: "string" }, timeout_ms: TIMEOUT }, ["object", "verb"]],

  // --- properties
  ["moo_list_properties", "listProperties",
   "List the properties on an object. Union wrappers are stripped, so an owner reads as `#36`.",
   { object: OBJ, inherited: INHERITED }, ["object"]],

  ["moo_get_property", "getProperty",
   "Read one property's value and its metadata (owner and permission bits).",
   { object: OBJ, property: { type: "string" } }, ["object", "property"]],

  ["moo_set_property", "setProperty",
   "Set a property from a JSON value. MUTATES world state. The value is serialized to an injection-safe MOO literal, so a string containing quotes or newlines stays a string.",
   { object: OBJ, property: { type: "string" }, value: { description: "Any JSON value: string, number, boolean, null, array, or object (which becomes a MOO map)." }, timeout_ms: TIMEOUT }, ["object", "property", "value"]],

  ["moo_add_property", "addProperty",
   "Define a new property on an object. Defaults to `rwc` permissions, which is what mutable instance state needs. An E_INVARG from here on an ancestor usually means a DESCENDANT already defines that name: migrate the collision, do not delete it.",
   { object: OBJ, property: { type: "string" }, value: { description: "Initial value, injection-safe. Defaults to 0." }, owner: OBJ, perms: { type: "string", description: "Default \"rwc\"." }, timeout_ms: TIMEOUT }, ["object", "property"]],

  ["moo_delete_property", "deleteProperty",
   "Delete a property definition from an object. Mutates world state.",
   { object: OBJ, property: { type: "string" }, timeout_ms: TIMEOUT }, ["object", "property"]],

  // --- objects
  ["moo_resolve", "resolve",
   "Resolve an object reference and return what it is. Accepts #number, a corified reference such as $you, a UUID id such as #0011E5-9CB7359F34, or a CURIE such as oid:36 or sysobj:system. Use this rather than a full dump to confirm an object exists.",
   { object: OBJ }, ["object"]],

  ["moo_list_objects", "listObjects",
   "List objects, optionally those with a given parent. name_pattern and limit are applied after fetching, and the reply says how many were cut.",
   { parent: OBJ, name_pattern: { type: "string", description: "Case-insensitive regular expression." }, limit: { type: "integer", minimum: 1 } }, []],

  ["moo_create_object", "createObject",
   "Create an object with a parent and optional owner and name. Mutates world state. If creation raises or times out, a PARTIAL object may already exist: inspect for it and recycle it through $recycler before retrying.",
   { parent: OBJ, owner: OBJ, name: { type: "string" }, timeout_ms: TIMEOUT }, ["parent"]],

  ["moo_recycle_object", "recycleObject",
   "Permanently recycle an object. Mutates world state irreversibly. System object #0 is refused twice — by spelling here, and again inside the MOO task, because toobj() of an invalid CURIE evaluates to #0.",
   { object: OBJ, timeout_ms: TIMEOUT }, ["object"]],

  ["moo_move_object", "moveObject",
   "Move an object to a destination and return its resulting location.",
   { object: OBJ, destination: OBJ, timeout_ms: TIMEOUT }, ["object", "destination"]],

  ["moo_set_parent", "setParent",
   "Change an object's parent (chparent) and return the resulting parent.",
   { object: OBJ, parent: OBJ, timeout_ms: TIMEOUT }, ["object", "parent"]],

  ["moo_object_flags", "objectFlags",
   "Inspect the player, programmer, wizard, fertile, readable and writable flags on an object.",
   { object: OBJ, timeout_ms: TIMEOUT }, ["object"]],

  ["moo_set_object_flag", "setObjectFlag",
   "Set one object flag. Mutates world state, and the wizard and programmer flags grant real authority — think before setting either.",
   { object: OBJ, flag: { type: "string", enum: ["player", "programmer", "wizard", "fertile", "readable", "writable"] }, value: { type: "boolean" }, timeout_ms: TIMEOUT }, ["object", "flag", "value"]],

  ["moo_object_graph", "objectGraph",
   "Show an object's ancestors and a bounded list of its children. Descendants are capped because a query near the root of a large world would otherwise exceed the tick limit.",
   { object: OBJ, limit: { type: "integer", minimum: 1, maximum: 500, description: "Maximum children to list. Default 100." }, timeout_ms: TIMEOUT }, ["object"]],

  ["moo_dump_object", "dumpObject",
   "Dump a live object as objdef source, optionally writing it beneath workspace/torchship-objdef. A FAILED dump is not evidence the object is absent: prefer moo_resolve, moo_list_verbs and moo_list_properties for targeted inspection.",
   { object: OBJ, path: { type: "string", description: "Optional relative path under workspace/torchship-objdef." }, timeout_ms: TIMEOUT }, ["object"]],

  // --- objdef
  ["moo_load_object", "loadObject",
   "Load inline objdef source into the world, creating an object. Mutates world state.",
   { objdef: { type: "string" }, timeout_ms: TIMEOUT }, ["objdef"]],

  ["moo_reload_object", "reloadObject",
   "Replace an existing object from inline objdef source. Mutates world state.",
   { objdef: { type: "string" }, timeout_ms: TIMEOUT }, ["objdef"]],

  ["moo_read_objdef_file", "readObjdefFile",
   "Read an objdef file from beneath workspace/torchship-objdef. Traversal and symlink escapes are rejected.",
   { path: { type: "string" } }, ["path"]],

  ["moo_write_objdef_file", "writeObjdefFile",
   "Atomically write UTF-8 objdef text beneath workspace/torchship-objdef. Traversal and symlink escapes are rejected.",
   { path: { type: "string" }, contents: { type: "string" } }, ["path", "contents"]],

  ["moo_load_objdef_file", "loadObjdefFile",
   "Load an objdef file from beneath workspace/torchship-objdef into the world. Mutates world state.",
   { path: { type: "string" }, timeout_ms: TIMEOUT }, ["path"]],

  ["moo_reload_objdef_file", "reloadObjdefFile",
   "Reload an existing object from an objdef file beneath workspace/torchship-objdef. Mutates world state.",
   { path: { type: "string" }, timeout_ms: TIMEOUT }, ["path"]],

  ["moo_apply_patch_objdef", "applyPatchObjdef",
   "Dump an object, apply one unified diff to its objdef locally, and reload the result. A patch that does not apply performs NO write.",
   { object: OBJ, patch: { type: "string" }, timeout_ms: TIMEOUT }, ["object", "patch"]],

  ["moo_diff_object", "diffObject",
   "Line-diff a live object's dump against objdef source given inline or read from workspace/torchship-objdef. Read-only.",
   { object: OBJ, objdef: { type: "string" }, path: { type: "string" }, timeout_ms: TIMEOUT }, ["object"]],

  // --- parsing
  ["moo_parse_command", "parseCommand",
   "Parse a command line against an explicit object/name environment, without running it.",
   { command: { type: "string" }, environment: { type: "array", description: "Entries: an object reference, or {obj, names} to give an object extra match names." }, timeout_ms: TIMEOUT }, ["command"]],

  ["moo_parse_command_for_player", "parseCommandForPlayer",
   "Parse a command line using a player's own match environment, falling back to their inventory and location.",
   { command: { type: "string" }, player: OBJ, timeout_ms: TIMEOUT }, ["command", "player"]],

  ["moo_find_command_verb", "findCommandVerb",
   "Find the command verbs that match a parsed command in a given environment.",
   { command: { type: "string" }, environment: { type: "array" }, timeout_ms: TIMEOUT }, ["command"]],

  ["moo_list_prepositions", "listPrepositions",
   "List the canonical mooR preposition table, ids 0-15. Answered locally: it is a constant of the language.",
   {}, []],

  // --- runtime
  ["moo_connected_players", "connectedPlayers",
   "List the connected players with their names, idle time and connection age.",
   {}, []],

  ["moo_queued_tasks", "queuedTasks",
   "List queued and suspended tasks. A task sitting at bf_read with start=0 is blocked forever waiting for a player's input: kill it.",
   {}, []],

  ["moo_kill_task", "killTask",
   "Kill a running or suspended task by id.",
   { task_id: { type: "integer" } }, ["task_id"]],

  ["moo_notify", "notify",
   "Send a line of text to a connected player's connection.",
   { player: OBJ, message: { type: "string" } }, ["player", "message"]],

  ["moo_function_help", "functionHelp",
   "Show the documentation for a builtin function, or list every builtin when no name is given.",
   { function: { type: "string" } }, []],

  ["moo_server_info", "serverInfo",
   "Report the server's health, version and feature flags. /health and /version need no authentication, so this answers even when the credentials are wrong — which makes it the right first call when something fails.",
   {}, []],

  ["moo_reconnect", "reconnect",
   "Drop the cached authentication token and log in again. Use it when calls start failing with 401 after working.",
   {}, []],

  // --- dynamic
  ["moo_dynamic_list", "dynamicList",
   "List the tools the world itself declares through #0:external_agent_tools(). These are DATA, not registered tools: call one with moo_dynamic_invoke.",
   {}, []],

  ["moo_dynamic_refresh", "dynamicRefresh",
   "Re-read the world's declared external agent tools. Identical to moo_dynamic_list, which never caches.",
   {}, []],

  ["moo_dynamic_invoke", "dynamicInvoke",
   "Invoke a tool the world declares, by name, with an argument map. The declarations are re-read on every call, so a tool removed from the world stops being callable at once.",
   { name: { type: "string" }, arguments: { type: "object" }, timeout_ms: TIMEOUT }, ["name", "arguments"]],

  // --- added here
  ["moo_grep", "grep",
   "Search verb source across the database for a substring, returning object, verb, line number and text. Torchship has no source files to grep — everything is objects and verbs — so this is how you find where something is implemented. Narrow it with `object` when you can: a whole-database search is expensive.",
   { pattern: { type: "string", description: "Substring to find in verb source. Matched with MOO's index(), case-sensitive." }, object: OBJ, limit: { type: "integer", minimum: 1, maximum: 200, description: "Maximum matches. Default 50." }, timeout_ms: TIMEOUT }, ["pattern"]],
];

const tools = T.map(([name, exp, description, properties, required]) => ({
  name,
  description,
  parameters: { type: "object", properties, ...(required.length ? { required } : {}), additionalProperties: false },
  export: exp,
}));

const pkg = {
  name: "@bitmuse/moo",
  version: "0.2.0",
  private: true,
  description:
    "The live mooR world as tools: evaluate, run commands, read and program verbs and properties, " +
    "create and recycle objects, objdef round-trips, command parsing, task control and MOO-declared " +
    "tools — sharing one client module instead of fifty copies of it.",
  type: "module",
  main: "index.js",
  thetis: {
    type: "tool",
    tools,
    config: {
      base_url: { type: "string", help: "The mooR web host, e.g. http://10.10.10.1:7892. Defaults to that address." },
      username: { type: "string", required: true, help: "The MOO character these tools log in as. Every moo_* tool uses it. Its permission bits decide what the tools can do: a wizard can do anything." },
      password: { type: "string", secret: true, required: true, help: "That character's password. Exchanged at /auth/connect for a token, which is cached per session." },
      request_timeout_secs: { type: "number", help: "HTTP timeout in seconds. Default 30. Separate from a MOO task's own timeout_ms." },
    },
  },
};

fs.writeFileSync(new URL("./package.json", import.meta.url), JSON.stringify(pkg, null, 2) + "\n");
console.log(`wrote package.json with ${tools.length} tools`);
