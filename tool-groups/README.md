# @thetis/tool-groups

Scopes the tool list to the groups a conversation looks like it needs. Every package that declares tools is one group. The groups of the packages everyone has are the core and are always in the call; the rest, a person's own installs and marketplace installs, are routed once, on the first user message, by three signals unioned: a pinned or universal skill tagged `tool-group:<id>`, a tag match on the message, and, when those admit nothing, the closest groups by embedding. The decision is pinned in the harness for the whole conversation and never made again, so the prompt prefix stays cached; `tool_search` and a call to a withheld tool by name grow it, and nothing is ever unloaded. It is a `loader` with a `prompt` step, a `call` step, one tool and the two `bench` steps, plain ECMAScript with no build step and no dependency beyond `@thetis/skills`, which must be installed beside it.

The predecessor (the Rust Thetis, `agents/agent-core/src/groups.rs`) shipped the tag matcher and benchmarked the dense fallback without shipping it: on 1,634 queries over 13 groups, tags alone reached F1 0.24 and routed nothing for 945 of them; tags with a dense fallback reached F1 0.42 and routed nothing for none, improving 31 of 35 query families and regressing none. This package ships both, with a bench to show it.

## What it provides

| Step | Phase | Export | Effect |
|---|---|---|---|
| `route` | `prompt` | `route` | Routes on the first turn and pins the result under `harness["@thetis/tool-groups"]`; reads the pin back on every later turn, merging what `tool_search` loaded and what a stray call admitted. Appends the `# Tool groups` section to `call.system`. |
| `scope` | `call` | `scope` | After every `tools`-phase step: keeps the tools of the active groups in the order they were attached, never drops `tool_search`, and names the dropped tools in `call.hints.withheld`. |
| `bench-import` | `bench` | `importCorpus` | The corpus's vectors from `bench/vectors/<corpus sha256>.json` into the cache under the home. |
| `bench-report` | `bench` | `benchReport` | The claim: `direct` the active corpus groups, `offered` the rest, `reach: "catalogue"`, the ranking when there was one. |

| Tool | Arguments | Returns |
|---|---|---|
| `tool_search` | `query` (optional), `load` (optional, group ids) | With neither: the catalogue and `Call this again with a query or load to add one.` With a query: loads every group whose tags match, or the best-ranked group when none does (lexical and dense fused when a key is configured), then lists each loaded group's tools one line each, then the catalogue. With `load`: those ids; an unknown id is refused by name and nothing changes. |

The core is what the guide teaches. The system prompt names the file tools, the shell, the plan tools and `spawn_subagent`, and a tool it names must never be missing, so every group whose packages everyone has (`config.systemPackages["*"]`, promoted packages, packages marked for everyone) is always on. So is any package declaring `alwaysOn: true`, any id in this package's `alwaysOn` setting, and this package's own group, which holds the escape hatch.

The pin under `harness["@thetis/tool-groups"]`:

```js
{ active: ["tool-groups", "files", "web"], why: { "tool-groups": "always-on", files: "always-on", web: "tag" }, catalogue: [{ id, brief, tools: [names], alwaysOn }], mode: "lexical", ranked: [{ id, score }], notes: [] }
```

The reasons are `always-on`, `configured`, `skill`, `tag`, `dense`, `fusion`, `search` and `call`. `mode` is `lexical`, `fallback` or `fusion`, and says what decided the first turn. `notes` says why the dense path was skipped when it was, which skill pointed at a group that does not exist, and which pinned group vanished.

The section, byte-stable across turns except when the active set or the catalogue grows:

```
# Tool groups
Your tool list is scoped to what this conversation looks like it needs, so a tool you have may not be in it right now. Call tool_search the moment you suspect a tool exists but cannot see it; do not work around the gap. Nothing is ever unloaded.

- `moo` [available] — Drive the live Torchship world over its web-host API.
- `web` [loaded] — Search and read the web with Exa.
```

Always-on groups are not listed unless `listAlwaysOn` is set: they are always there, and the line would only cost bytes. When nothing is routable there is no section and no scoping.

## Groups

A group has an id, a brief, lowercase tags, an always-on flag and members. It derives from the packages:

- The id is the package name without its scope: `@bitmuse/moo` is `moo`. When two packages share an unscoped name each keeps its scope, `bitmuse/moo`.
- The brief is the first sentence of the package description; the tags are none.
- A manifest overrides any of these with `"thetis": { "toolGroup": { "id", "brief", "tags", "alwaysOn" } }`.
- A tool with `"group": "<id>"` sits in that group instead of its package's. A group only tools declare takes its brief from the first such tool's description.
- The first package to declare a tool name owns it, as `attachTools` does.

A package that declares nothing is still one group and is still reachable: by the dense fallback, a skill edge, `tool_search`, or a call by name. Tagging is an optimisation, never a precondition for being callable.

## How it works

The query is the first user message without its `[Turn context: ...]` line, cut to 2000 characters. Tokens are lowercase alphanumeric runs. A group's score is `m / (m + 1)` over the distinct tags present, so one match is 0.5 and further matches add less; a multi-word tag needs its words adjacent; there is no stemming. A group is admitted at `routeThreshold` (0.15: any single match). Always-on groups are admitted first, then the skill edges, then the tags.

When the skill edges and the tags admitted nothing beyond the core, the dense fallback ranks the routable groups by the cosine between the query's vector and each group's, and admits the top `denseFallback` (2) of those at or above `denseThreshold` (0.25); a cosine below the floor is not evidence, since a greeting is closest to some group too. What is embedded for a group is its id, brief, tags, the tool names with underscores split, and the first sentence of each tool description, never a whole schema. With `denseMode: "fusion"` the lexical and dense lists are fused by weighted reciprocal rank (K 60, `fusionWeight` the dense share) and the top `denseFallback` are admitted whatever the tags said, each one at or above `denseThreshold` or matched by a tag; it is an option so the bench can compare the arms.

The floor comes from `tool-recall@1` (21 groups, 75 tasks, `openai/text-embedding-3-small`): the gold groups' cosine against their query has median 0.337 and a 10th percentile of 0.20, and the controls' best group never exceeds 0.253. At 0.25, 80% of the gold groups pass and 5 of the 6 controls get nothing; at 0.3 it is 58% and all 6. A group wrongly withheld costs a capability and one admitted needlessly costs tokens, so the floor sits low. Another embedding model moves the whole scale, so the key is per installation. With `denseMode: "off"` the routing is tags only.

Vectors come from `POST <baseUrl>/embeddings`, 64 texts per request, 20 seconds each, through the shared library in `@thetis/skills`, and are cached at `tool-groups/vectors.json` under the home, keyed `model|dimensions|contentHash`. A turn embeds only what the cache lacks; the query's vector is never cached. Without a key, or when a request fails, the dense path is skipped for the turn, one note says why, and the key appears in no note, no error and no file.

On every later turn the step reads the pin back: the active ids that are still installed, in the current table order, plus the always-on groups forced back in, plus what `tool_search` wrote to `env.storage("sessions")` under the session id, plus any group whose tool was called while withheld (a `tool` message in the conversation with that name), reason `call`. A group that appears later, from a package installed mid-conversation, joins the catalogue as available; one that vanished is dropped with a note. No re-routing, ever.

The scoping step runs in the `call` phase, after every `tools`-phase step, and only removes. A project's `tools.disable` (`@thetis/projects`) applies in the same phase and in either order; a tool the project switched off is never named in `withheld`, so it stays refused. The kernel's built-in call resolves a call to a name in `withheld` against the installed packages and runs it: scoping is an attention and token optimisation, never a permission boundary. The next turn's pin then carries the group.

## Benchmarks

![tool-recall@1 comparison](bench/tool-recall-v1/chart.svg)

![assembly-cost@1 comparison](bench/assembly-cost-v1/chart.svg)

On `tool-recall@1` (75 tasks, 69 of them with a need) the shipped default, tags with the dense fallback, reaches route_recall 0.790, route_precision 0.688, route_f1 0.720 and routes nothing for 8.7% of the tasks with a need, with 14 tools in the call against the floor's 110 (bytes_tools 2,674 against 15,106; bytes_turn1 6,279 against 16,557, the difference less the 2,154 bytes of the section). Before `denseThreshold` the same arm reached recall 0.877, precision 0.623, F1 0.705 with 17 tools and two groups admitted on every control task; the floor trades six paraphrases it no longer reaches for the controls and the wrong second group. Tags alone reach recall 0.413, precision 0.391, F1 0.396 and route nothing for 55% of the tasks with a need: every `direct` and `scenario` task, none of the 40 `paraphrase` tasks. Fusion reaches recall 0.819 at precision 0.623, F1 0.688: it admits a second group more often than the fallback, direct tasks included. Read `BENCH.md` beside this file, and the Notes of each report, before quoting a figure. The suite `tool-recall@1` gives every arm the same 21 tool groups (the predecessor's table: 20 routable, `files` always on) as installed packages, and 75 tasks that name the groups they need, labelled `direct` (a tag is in the query), `paraphrase` (no tag of the group is), `scenario` (the predecessor's routing checks), `mixed` and `control`. `route_recall`, `route_precision` and `route_f1` are scored on the routable groups from the canaries in the tool segment of the first round; `routed_nothing` is the share of tasks with a need where no routable group was admitted; `surface_tools` counts the corpus tools attached. The floor `none` attaches everything: recall 1 by construction, precision the base rate. The arms are one package under three settings: `tool-groups` is the shipped default (`denseMode: fallback`, with the vectors a person with a key would have), `tool-groups-lexical` is `denseMode: off` (what a person without a key gets), `tool-groups-fusion` is `denseMode: fusion`.

In the bench there is no key. `bench/vectors/<corpus sha256>.json` holds the vectors of every corpus group and of every task query, produced once by `scripts/embed-corpus.mjs`:

```sh
set -a; . ./.env; set +a; node packages/tool-groups/scripts/embed-corpus.mjs
```

The script derives the groups from the same manifests the bench fixture installs, so the content hashes agree; the importer copies the group vectors into the cache and the step looks a query up in the file before it would call the network. A run is deterministic and free. `assembly-cost@1` measures what the package costs a conversation that has nothing to route.

## Configuration

`config.packages["@thetis/tool-groups"]`:

| Key | Default | Effect |
|---|---|---|
| `routeThreshold` | `0.15` | The tag score at which a group is admitted. One match scores 0.5, so the default admits on a single match. |
| `denseFallback` | `2` | How many groups the dense ranking admits. `0` turns it off. |
| `denseThreshold` | `0.25` | The cosine a group must reach against the query before the dense ranking may admit it. Below it nothing is routed beyond the core, and a note says so. `0` keeps every dense hit. `tool_search` ignores it: a search asks for the closest thing whatever its distance. |
| `denseMode` | `fallback` | `off`: tags only. `fallback`: dense only when the tags admitted nothing. `fusion`: the fused list's top `denseFallback` whatever the tags said. |
| `fusionWeight` | `0.7` | The dense share in the fusion of `denseMode: fusion` and of `tool_search`. |
| `alwaysOn` | `[]` | Group ids admitted for every conversation, on top of the core. |
| `listAlwaysOn` | `false` | List the always-on groups in the prompt section too. |
| `embeddings.baseUrl` | `https://openrouter.ai/api/v1` | An OpenAI-compatible endpoint. |
| `embeddings.apiKey` | `${OPENROUTER_API_KEY}` | The key, interpolated by the kernel from the daemon's environment. The kernel's default `packages` block sets it. Empty means lexical. |
| `embeddings.model` | `openai/text-embedding-3-small` | The embedding model. |
| `embeddings.dimensions` | `1536` | The vector size. |

The package reads no environment variables itself. It writes `tool-groups/vectors.json` in the home and one document per session under `env.storage("sessions")`.

The package is in the default `systemPackages["*"]` after `@thetis/skills-hybrid`. An existing installation has its own list in `thetis.config.json`, which the kernel does not rewrite: add `@thetis/tool-groups` there, or install it for everyone with `thetis packages install @thetis/tool-groups`.

## Limits

- The routing is decided by the first message alone. A conversation that turns to another subject relies on `tool_search` or on a call by name, and the prompt section says so.
- A group without tags and without a skill edge is reached by the dense fallback only when the tags admitted nothing; with `denseMode: fusion` it competes on every turn.
- Attaching a group mid-conversation changes the tool list and re-writes the prompt prefix once. That is the one cache miss the design pays for.
- The order of groups is the install order of their packages. A package installed mid-conversation adds a line to the section, which moves the prefix once.
- `denseThreshold` is a number for one embedding model. A change of model wants a new measurement, and the bench vectors file with it.
- The bench file is 1.4 MB of numbers. A new corpus needs the script run again.

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: the four steps, the tool, the settings, the bench declaration with its `lexical` and `fusion` arms. |
| `index.js` | `route`, `scope`, `toolSearch`, `importCorpus`, `benchReport`. |
| `lib/groups.js` | `deriveGroups`, the tokenizer, `tagPresent`, `score`, `lexicalRank`, the table order. |
| `lib/route.js` | `routeOnce`, the skill edges, the stray calls, the project switch-off, the prompt section. |
| `lib/dense.js` | The index text and content hash of a group, the vector cache, the bench file, `denseRank`. |
| `lib/store.js` | The session document `tool_search` and the prompt step share. |
| `lib/bench.js` | The importer and the claim. |
| `scripts/embed-corpus.mjs` | Writes the bench vector file. Needs `OPENROUTER_API_KEY`. |
| `bench/vectors/<sha256>.json` | The vectors of the `tool-groups@1` corpus and the queries of `tool-recall@1`. |
| `test/groups.test.js` | Derivation, the tokenizer and the score (the predecessor's tests ported). |
| `test/route.test.js` | The routing scenarios, the pin across turns, skill edges, the dense fallback and fusion, the section's bytes, the scoping step, a stray call. |
| `test/search.test.js` | `tool_search` and its persistence through storage. |

## Tests

`npm test` from the runtime root, or `node --test "test/*.test.js"` in this directory. The kernel's side of a stray call is tested in `packages/kernel/test/unit.test.ts`; the suite's own consistency in `packages/bench/test/tool-corpus.test.js`.
