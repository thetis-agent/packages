// Fixture rows for the one-state rules (lib/state.js), in the shape `lib/rows.js` answers them, with a
// configuration report folded on where the page would have one. Two readers of the same installation:
// bitmuse, an admin whose own Notion was shared with everyone, and sam, a person who is not an admin. Exported
// so @thetis/ui-admin's test can hand the same rows to its mirror and pin that both give the same chips.
//
// What is here:
// - the Notion family: `@thetis/notion` (a promoted copy, everyone's), `@bitmuse/notion` (the original,
//   published to the thetis registry and in bitmuse's folder), `@bitmuse/notion-read` (a copy of it in
//   bitmuse's folder, not installed);
// - `@bitmuse/tool-exec`, bitmuse's copy of an older `@thetis/tool-exec` (0.3.3 against 0.4.1 now): Customized,
//   and a Review in "Needs your attention", never an update;
// - `@bitmuse/notion-read` is a variant with a label of its own, so it keeps its name and is never Customized;
// - `@thetis/exa`, installed with its required secret key unset;
// - `@thetis/skills-hybrid`, whose `${OPENROUTER_API_KEY}` default is missing from the server's environment;
// - `@tg/lore`, a registry offer from thirteen-games;
// - `@thetis/gateway-web`, which Thetis requires, with an update waiting;
// - `@thetis/tool-operator`, for admins only.

const base = {
  version: "0.1.0",
  description: "",
  audience: null,
  needs: [],
  keywords: [],
  registry: null,
  source: null,
  installed: false,
  system: false,
  everyone: false,
  everyoneBy: null,
  own: false,
  local: false,
  pin: null,
  license: "MIT",
  available: false,
  tip: null,
  update: null,
  ahead: null,
  readme: false,
  forkedFrom: null,
  fork: null,
  replaced: null,
  steps: [],
  tools: [],
  service: false,
  skills: 0,
  hasSkills: false,
  pages: 0,
  bench: null,
  component: false,
};
const row = (extra) => ({ ...base, ...extra });
const tools = (...names) => names.map((name) => ({ name, description: `${name} does one thing.` }));

const NOTION_NEEDS = [{ key: "token", secret: true, help: "An internal connection or personal access token from https://www.notion.so/my-integrations." }];
const EXA_HELP = "Your Exa API key, from the Exa dashboard (dashboard.exa.ai → API keys). Every search needs one; Exa charges per search on its own plans.";

const shared = {
  thetisNotion: row({ name: "@thetis/notion", label: "Notion", version: "0.1.1", type: "tool", description: "The Notion API as eleven tools.", installed: true, system: true, everyone: true, everyoneBy: "promoted", tools: tools("notion_search", "notion_read"), needs: NOTION_NEEDS, config: { package: "@thetis/notion", inherits: [], keys: [{ key: "token", state: "missing", secret: true, declared: true, type: "string", required: true, help: NOTION_NEEDS[0].help }], summary: "token is required and not set", broken: true } }),
  thetisToolExec: row({ name: "@thetis/tool-exec", label: "extensions and helper chats", version: "0.4.1", type: "tool", description: "Tools for the model: install, fork and remove packages.", system: true, everyone: true, everyoneBy: "config", tools: tools("install_package", "fork_package") }),
  exa: row({ name: "@thetis/exa", label: "Exa web search", version: "0.1.0", type: "tool", description: "Web search, page contents and deep research through the Exa API.", installed: true, system: true, tools: tools("exa_search", "exa_contents"), needs: [{ key: "apiKey", secret: true, help: EXA_HELP }], config: { package: "@thetis/exa", inherits: [], keys: [{ key: "apiKey", state: "missing", secret: true, declared: true, type: "string", required: true, help: EXA_HELP }], summary: "apiKey is required and not set", broken: true } }),
  skillsHybrid: row({ name: "@thetis/skills-hybrid", label: "skill loader", version: "0.3.2", type: "loader", description: "One brief per skill always in the prompt.", installed: true, system: true, everyone: true, everyoneBy: "config", tools: tools("get_skill"), config: { package: "@thetis/skills-hybrid", inherits: [], keys: [{ key: "embeddings", state: "missing", missing: ["OPENROUTER_API_KEY"], source: "default", secret: false, declared: true, type: "object", value: { apiKey: "${OPENROUTER_API_KEY}" } }], summary: "embeddings: OPENROUTER_API_KEY is not in the environment", broken: true } }),
  lore: row({ name: "@tg/lore", label: "lore", version: "0.2.0", type: "tool", description: "Nova Island's lore as tools.", registry: "thirteen-games", source: "git@github.com:tg/registry.git#lore@" + "c".repeat(40), available: true, tip: "0.2.0", tools: tools("lore_search") }),
  gatewayWeb: row({ name: "@thetis/gateway-web", label: "web gateway", version: "0.16.1", type: "gateway", description: "The web page.", installed: true, system: true, everyone: true, everyoneBy: "config", component: true, pages: 3, update: { apply: "reload", version: "0.16.1", installed: "0.16.0", available: "0.16.1" } }),
  toolOperator: row({ name: "@thetis/tool-operator", label: "restart tool", version: "0.2.2", type: "tool", audience: "admin", description: "Asks this Thetis server to restart itself.", system: true, tools: tools("restart_daemon") }),
};

/** bitmuse, an admin: their original Notion is in their folder and published; their copy of it is in the folder too. */
const bitmuse = [
  shared.thetisNotion,
  row({ name: "@bitmuse/tool-exec", label: "extensions and helper chats", version: "0.3.3-fork.1", type: "tool", description: "Tools for the model: install, fork and remove packages.", installed: true, own: true, local: true, tools: tools("install_package", "fork_package"), forkedFrom: { name: "@thetis/tool-exec", version: "0.3.3" }, fork: { name: "@thetis/tool-exec", version: "0.3.3", shipped: "0.4.1", identical: false, everyone: true }, update: { apply: "unfork", version: "0.4.1", installed: "0.3.3", available: "0.4.1", origin: "@thetis/tool-exec" }, source: { kind: "local", ref: "packages/tool-exec" } }),
  shared.exa,
  shared.skillsHybrid,
  shared.gatewayWeb,
  shared.thetisToolExec,
  shared.toolOperator,
  row({ name: "@bitmuse/notion", label: "Notion", version: "0.1.1", type: "tool", description: "The Notion API as eleven tools.", registry: "thetis", source: "https://github.com/thetis-agent/packages.git#notion@" + "b".repeat(40), available: true, tip: "0.1.1", folder: { dir: "packages/notion" }, local: true, tools: tools("notion_search", "notion_read"), needs: NOTION_NEEDS }),
  shared.lore,
  row({ name: "@bitmuse/notion-read", label: "Notion (read only)", labelGiven: true, version: "0.1.1-fork.1", type: "tool", description: "The Notion API, reading only.", folder: { dir: "packages/notion-read" }, local: true, tools: tools("notion_search"), forkedFrom: { name: "@bitmuse/notion", version: "0.1.1" }, needs: NOTION_NEEDS }),
];

/** sam, not an admin: the promoted Notion was given to them, and bitmuse's original is a registry offer. */
const sam = [
  shared.thetisNotion,
  shared.exa,
  shared.skillsHybrid,
  shared.gatewayWeb,
  // sam has no copy of Thetis's tool-exec: theirs is Thetis's own, installed by default.
  { ...shared.thetisToolExec, installed: true },
  shared.toolOperator,
  row({ name: "@bitmuse/notion", label: "Notion", version: "0.1.1", type: "tool", description: "The Notion API as eleven tools.", registry: "thetis", source: "https://github.com/thetis-agent/packages.git#notion@" + "b".repeat(40), available: true, tip: "0.1.1", tools: tools("notion_search", "notion_read"), needs: NOTION_NEEDS }),
  shared.lore,
];

export const FIXTURES = Object.freeze({
  bitmuse: Object.freeze({ user: "bitmuse", admin: true, rows: bitmuse }),
  sam: Object.freeze({ user: "sam", admin: false, rows: sam }),
});

/**
 * The chips each reader sees on each row, by label, in order: what `stateOf(row, { admin, origin, user })`
 * answers with the row's official member as `origin`. A mirror of the rules gives exactly these.
 */
export const EXPECTED_CHIPS = Object.freeze({
  bitmuse: {
    "@thetis/notion": ["Needs setup", "For everyone"],
    "@bitmuse/tool-exec": ["Customized"],
    "@thetis/exa": ["Needs setup"],
    "@thetis/skills-hybrid": ["Needs setup"],
    "@thetis/gateway-web": ["Update available"],
    "@thetis/tool-exec": [],
    "@thetis/tool-operator": [],
    "@bitmuse/notion": [],
    "@tg/lore": [],
    "@bitmuse/notion-read": [],
  },
  sam: {
    "@thetis/notion": ["Needs setup", "For everyone"],
    "@thetis/exa": ["Needs setup"],
    "@thetis/skills-hybrid": [],
    "@thetis/gateway-web": ["Update available"],
    "@thetis/tool-exec": [],
    "@thetis/tool-operator": [],
    "@bitmuse/notion": [],
    "@tg/lore": [],
  },
});
