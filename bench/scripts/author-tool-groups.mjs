#!/usr/bin/env node
// Writes the tool-recall@1 corpus and tasks: suites/tool-recall-v1/corpus.jsonl, corpus.json and tasks.jsonl.
// The groups, their briefs and tags are the predecessor's table (thetis agents/agent-core/src/groups.rs); the
// tool names are its built-ins and, for the groups it filled from hot-loaded components, its naming convention;
// the tool descriptions and the queries are authored here. Run from the runtime root:
//
//   node packages/bench/scripts/author-tool-groups.mjs
//
// Deterministic: the same source writes the same bytes, so the digest in corpus.json is reproducible.
import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(here, "../suites/tool-recall-v1");
const SALT = "thetis/bench/tool-groups/v1";

const t = (name, description) => ({ name, description });

/**
 * id, brief, tags, alwaysOn, tools. The brief is one sentence; the canary is added to the last tool, after its
 * first sentence: the first tools of `files` share their names with @thetis/tools-files, and when both are
 * installed the shipped package wins the name, so a canary there would never reach the call.
 */
const GROUPS = [
  ["files", "Reading, searching, writing and deleting files on the host.", ["file", "files", "read", "write", "edit", "search", "grep", "directory", "path", "code", "source"], true, [
    t("read_path", "Read a file as numbered lines, with an offset and a limit."),
    t("edit_path", "Replace one exact text in a file with another."),
    t("search_files", "Search file contents under a directory with a regular expression."),
    t("find_files", "Find files by glob under a directory, newest first."),
    t("write_path", "Write a whole file, creating parent directories."),
    t("list_path", "List a directory, directories first, with sizes."),
    t("delete_path", "Delete a file or an empty directory."),
  ]],
  ["shell", "Terminal sessions for builds, tests, git and long-running processes.", ["run", "build", "test", "tests", "compile", "command", "shell", "terminal", "bash", "process", "script", "cargo", "npm", "python", "git", "clone", "install", "deploy"], false, [
    t("terminal_open", "Open a terminal session that keeps its working directory and shell state."),
    t("terminal_run", "Run a command in a terminal session and wait for it to finish."),
    t("terminal_read", "Read what a terminal session printed since the last read."),
    t("terminal_send", "Send raw input to a terminal session, for a prompt or a REPL."),
    t("terminal_signal", "Send a signal to the command running in a terminal session."),
    t("terminal_close", "Close a terminal session."),
    t("terminal_list", "List the open terminal sessions of this conversation."),
    t("git_clone", "Clone a git repository into the workspace."),
  ]],
  ["ssh", "The named ssh host registry, for shell sessions on other machines.", ["ssh", "remote", "host", "hosts", "machine", "server", "box"], false, [
    t("ssh_host_list", "List the named ssh hosts on record."),
    t("ssh_host_get", "Show one named ssh host: address, user, port and key."),
    t("ssh_host_set", "Add or change a named ssh host."),
    t("ssh_host_remove", "Remove a named ssh host."),
    t("ssh_host_rename", "Rename a named ssh host."),
  ]],
  ["selfmod", "The dev kit: editing and rebuilding your own loop, gateways and tools.", ["yourself", "loop", "gateway", "devkit", "component", "wasm", "rebuild", "recompile", "dependency", "crate", "restart", "scaffold"], false, [
    t("new_tool", "Scaffold a new tool component in the dev kit."),
    t("write_code", "Write a source file of the agent's own code."),
    t("patch_code", "Apply a patch to a source file of the agent's own code."),
    t("add_dependency", "Add a crate to the agent's own manifest."),
    t("remove_dependency", "Remove a crate from the agent's own manifest."),
    t("list_dependencies", "List the crates the agent is built with."),
    t("read_code", "Read a source file of the agent's own code."),
    t("list_code", "List the source tree of the agent's own code."),
    t("restart_orchestrator", "Rebuild and restart the agent on its own code."),
  ]],
  ["branch", "This conversation's sandbox branch: status, history, trunk merges, rollback.", ["branch", "trunk", "merge", "commit", "rollback", "revert", "reset", "conflict"], false, [
    t("branch_status", "Show the state of this conversation's branch against trunk."),
    t("branch_log", "Show the commits on this conversation's branch."),
    t("update_from_trunk", "Merge trunk into this conversation's branch."),
    t("reset_branch", "Reset this conversation's branch to trunk, discarding its commits."),
    t("complete_merge", "Finish a merge whose conflicts have been resolved."),
    t("abort_merge", "Abandon a merge in progress."),
  ]],
  ["config", "Reading and changing Thetis's own settings.", ["config", "configuration", "setting", "settings", "toml", "option"], false, [
    t("list_config", "List every configuration key with its current value."),
    t("read_config", "Read one configuration key."),
    t("set_config", "Set one configuration key."),
  ]],
  ["subagents", "Spawning sub-agents, inspecting them and cancelling them.", ["subagent", "subagents", "delegate", "delegation", "spawn", "concurrently", "parallel", "parallelise", "parallelize", "fan-out", "background"], false, [
    t("spawn_agent", "Start a sub-agent on a task and get its reply."),
    t("agent_status", "Show what a sub-agent is doing now."),
    t("agent_transcript", "Read a sub-agent's conversation so far."),
    t("cancel_agent", "Stop a sub-agent."),
    t("agent_profiles", "List the profiles a sub-agent can be started with."),
  ]],
  ["transcripts", "Reading and searching past conversations and sub-agent logs.", ["conversation", "conversations", "transcript", "transcripts", "chat", "chats", "recall", "earlier", "previously", "before", "remember", "discussed", "decided"], false, [
    t("conversation_list", "List past conversations with their titles and dates."),
    t("conversation_read", "Read one past conversation."),
    t("conversation_grep", "Search past conversations for a phrase."),
    t("subagent_list", "List the sub-agents that ran in a past conversation."),
  ]],
  ["sandbox", "The isolated sandbox: running a command, reading and writing its files.", ["sandbox", "isolated", "scratch"], false, [
    t("exec", "Run a command in the isolated sandbox and return its output."),
    t("write_file", "Write a file inside the isolated sandbox."),
    t("read_file", "Read a file inside the isolated sandbox."),
  ]],
  ["bigquery", "BigQuery: listing, describing, profiling, querying and costing tables.", ["bigquery", "bq", "sql", "dataset", "warehouse", "gcp", "partition", "analytics"], false, [
    t("bq_list_datasets", "List the datasets of a project."),
    t("bq_list_tables", "List the tables of a dataset."),
    t("bq_describe_table", "Show a table's schema, size and partitioning."),
    t("bq_profile_table", "Profile a table's columns: nulls, distinct counts, ranges."),
    t("bq_query", "Run a SQL statement and return the rows."),
    t("bq_estimate_cost", "Estimate the bytes a SQL statement would scan, without running it."),
  ]],
  ["miro", "Miro: boards, items, connectors, tags, members and resources.", ["miro", "whiteboard"], false, [
    t("miro_list_boards", "List the boards the token can see."),
    t("miro_get_board", "Read a board's items, frames and connectors."),
    t("miro_create_item", "Create a sticky note, a card, a shape or a text item on a board."),
    t("miro_update_item", "Move, resize or retext an item on a board."),
    t("miro_connect_items", "Draw a connector between two items on a board."),
    t("miro_list_members", "List the members of a board and their roles."),
  ]],
  ["notion", "Notion: pages, databases, comments and users in a workspace.", ["notion", "wiki"], false, [
    t("notion_search", "Search the pages and databases of the workspace."),
    t("notion_get_page", "Read a page's properties and blocks."),
    t("notion_create_page", "Create a page under a parent page or in a database."),
    t("notion_update_page", "Change a page's properties or append blocks."),
    t("notion_query_database", "Query a database with a filter and a sort."),
    t("notion_add_comment", "Add a comment to a page or a block."),
  ]],
  ["web", "Web search, page fetching and cited summarisation.", ["web", "internet", "online", "arxiv", "paper", "papers", "research", "url", "link", "article", "news", "blog", "google"], false, [
    t("web_search", "Search the web and return titles, addresses and snippets."),
    t("web_fetch", "Fetch a page and return its readable text."),
    t("web_summarize", "Summarise several pages with citations."),
  ]],
  ["browser", "A real headless browser: navigate, read the page, click, type, screenshot.", ["playwright", "headless", "click", "screenshot", "dom", "css", "viewport", "responsive", "render", "frontend"], false, [
    t("web_browser_navigate", "Open an address in the headless browser."),
    t("web_browser_read", "Read the current page as text, with its interactive elements numbered."),
    t("web_browser_click", "Click a numbered element on the current page."),
    t("web_browser_type", "Type into a numbered element on the current page."),
    t("web_browser_screenshot", "Take a screenshot of the current page at a given viewport."),
  ]],
  ["moo", "Torchship mooR: inspect and modify the live world through its web-host API.", ["moo", "moor", "torchship", "object", "verb", "objdef"], false, [
    t("moo_eval", "Evaluate MOO code in the live world and return the result."),
    t("moo_get_object", "Read an object's properties, verbs and parent."),
    t("moo_list_verbs", "List the verbs defined on an object."),
    t("moo_read_verb", "Read the code of one verb."),
    t("moo_write_verb", "Write the code of one verb."),
    t("moo_get_property", "Read one property of an object."),
  ]],
  ["github", "The GitHub API: reading and committing files, repos, branches, PRs.", ["github", "repo", "repository", "pr", "issue", "upstream", "clone"], false, [
    t("git_get_file", "Read a file from a repository at a ref."),
    t("git_put_file", "Commit a file to a repository branch."),
    t("git_list_repos", "List the repositories of a user or an organisation."),
    t("git_list_branches", "List the branches of a repository."),
    t("git_create_pr", "Open a pull request."),
    t("git_list_prs", "List the pull requests of a repository."),
    t("git_get_issue", "Read an issue with its comments."),
  ]],
  ["rpg-core", "Dice, checks, the character sheet, inventory, clock, journal and exact rules values for a tabletop campaign.", ["rpg", "campaign", "tabletop", "dice", "character"], false, [
    t("rpg_roll_dice", "Roll dice by expression and return each die."),
    t("rpg_skill_check", "Resolve a skill check against a difficulty."),
    t("rpg_get_sheet", "Read a character sheet."),
    t("rpg_update_inventory", "Add or remove items from a character's inventory."),
    t("rpg_advance_clock", "Advance the campaign clock."),
    t("rpg_journal_write", "Append an entry to the campaign journal."),
    t("rpg_rules_lookup", "Look up an exact rules value."),
  ]],
  ["rpg-world", "The campaign world: NPCs, factions, locations, plot beats and their relationships.", ["npc", "faction", "lore", "plot"], false, [
    t("rpg_get_npc", "Read a non-player character: traits, wants, relationships."),
    t("rpg_list_factions", "List the factions and their standing with the party."),
    t("rpg_get_location", "Read a location: description, inhabitants, exits."),
    t("rpg_add_plot_beat", "Record a plot beat and tie it to a storyline."),
    t("rpg_link_entities", "Record a relationship between two world entities."),
  ]],
  ["rpg-scene", "Presenting a scene to the player and closing one.", ["scene", "narrate"], false, [
    t("rpg_scene_present", "Present a scene to the player with its setting and options."),
    t("rpg_scene_close", "Close the current scene and record its outcome."),
  ]],
  ["rpg-combat", "Running a fight: initiative, actions, damage.", ["combat", "fight", "initiative"], false, [
    t("rpg_combat_start", "Start a fight: roll initiative and set the turn order."),
    t("rpg_combat_action", "Resolve one combatant's action on its turn."),
    t("rpg_combat_damage", "Apply damage or healing to a combatant."),
    t("rpg_combat_end", "End the fight and record the outcome."),
  ]],
  ["rpg-shop", "Opening a vendor's stock for the player.", ["shop", "vendor", "merchant"], false, [
    t("rpg_shop_open", "Open a vendor's stock with prices for the player."),
    t("rpg_shop_buy", "Buy an item from the open vendor."),
    t("rpg_shop_sell", "Sell an item to the open vendor."),
  ]],
];

/** family: direct uses one of the group's tags; paraphrase uses none of them; scenario is the predecessor's routing check; control needs nothing. */
const TASKS = [
  // shell
  ["shell", "direct", "Run the test suite and tell me which cases fail."],
  ["shell", "paraphrase", "Kick off the release pipeline and watch the output for anything red."],
  ["shell", "paraphrase", "Start a long compilation of the kernel and check back on it in a few minutes."],
  // ssh
  ["ssh", "direct", "Register the new build server in the ssh registry so I can reach it by name."],
  ["ssh", "paraphrase", "Add the staging appliance to the list of places you can log into, with the alias stage-2."],
  ["ssh", "paraphrase", "Which named boxes do we have on record, and what user do we log in as on each?"],
  // selfmod
  ["selfmod", "direct", "Recompile your dev kit with the extra crate and restart."],
  ["selfmod", "paraphrase", "Teach the assistant a fresh capability by writing the Rust for it and putting it into the running binary."],
  ["selfmod", "paraphrase", "Bump the version of the JSON library the agent is built with and make sure it still links."],
  // branch
  ["branch", "direct", "Roll back the last commit on this branch; the change broke the build."],
  ["branch", "paraphrase", "Undo everything we did today and bring my working copy back to where the main line is."],
  ["branch", "paraphrase", "Show me what has happened on my side since we diverged from the shared line of development."],
  // config
  ["config", "direct", "Change the setting that controls the model temperature and show me the current configuration."],
  ["config", "paraphrase", "Turn on the verbose logging switch for this deployment and tell me what else is switchable."],
  ["config", "paraphrase", "What is the daemon's request timeout right now, and can you raise it to ten minutes?"],
  // subagents
  ["subagents", "direct", "Spawn a subagent to read the logs while you fix the parser."],
  ["subagents", "paraphrase", "Have a helper summarise every doc under docs while you keep working on the migration."],
  ["subagents", "paraphrase", "Split the audit across three workers and collect their findings into one report."],
  // transcripts
  ["transcripts", "direct", "What did we decide about the cache layout in an earlier conversation?"],
  ["transcripts", "paraphrase", "Last week you and I settled on a naming scheme for the queues; find it and quote it."],
  ["transcripts", "paraphrase", "Look through the logs of the helpers you ran yesterday and tell me which one stalled."],
  // sandbox
  ["sandbox", "direct", "Try this snippet in the isolated sandbox before touching the real tree."],
  ["sandbox", "paraphrase", "Run this untrusted snippet somewhere it cannot damage anything and show me what it prints."],
  ["sandbox", "paraphrase", "I want a throwaway environment to experiment with the parser; keep it away from my checkout."],
  // bigquery
  ["bigquery", "direct", "Write the SQL to count sign-ups per day from the analytics dataset."],
  ["bigquery", "paraphrase", "How many people signed up last month? The numbers live in the events table of our cloud data store."],
  ["bigquery", "paraphrase", "Estimate what it would cost to scan the whole clickstream table before we do anything."],
  // miro
  ["miro", "direct", "Put a sticky note on the Miro board for each open question."],
  ["miro", "paraphrase", "Lay the roadmap out as cards on the team's shared canvas, one column per quarter."],
  ["miro", "paraphrase", "Who has access to the planning canvas, and can you connect the two boxes I drew this morning?"],
  // notion
  ["notion", "direct", "Add a page to the Notion wiki describing the release process."],
  ["notion", "paraphrase", "Add a row to the team's knowledge base database for the new hire and comment on it."],
  ["notion", "paraphrase", "Find the onboarding checklist in our workspace docs and mark the first three items done."],
  // web
  ["web", "direct", "Search the web for the latest article about bubblewrap and summarise it."],
  ["web", "paraphrase", "What changed in the most recent release of bubblewrap?"],
  ["web", "paraphrase", "Find out what people are saying about the new Rust edition this week."],
  // browser
  ["browser", "direct", "Take a screenshot of the login page at a 375px viewport and check the CSS."],
  ["browser", "paraphrase", "Open our staging site, sign in as the trial user, and tell me whether the dashboard loads."],
  ["browser", "paraphrase", "Verify that the checkout button works on the mobile layout after the redesign."],
  // moo
  ["moo", "direct", "Add a verb to the lobby object in the Torchship moo."],
  ["moo", "paraphrase", "Describe the room the player is standing in and change its exit to lead north."],
  ["moo", "paraphrase", "Rename the wizard's staff item in the live game world and check it worked."],
  // github
  ["github", "direct", "Open a PR against the upstream repo with these changes."],
  ["github", "paraphrase", "Which pull requests are waiting on my review across our organisation?"],
  ["github", "paraphrase", "File a bug report on the tracker for the flaky login check and assign it to me."],
  // rpg-core
  ["rpg-core", "direct", "Roll the dice for a stealth check against the guard."],
  ["rpg-core", "paraphrase", "My rogue tries to sneak past the guard; what does she need and did she make it?"],
  ["rpg-core", "paraphrase", "Add the silver key to my pack and move the calendar forward one day."],
  // rpg-world
  ["rpg-world", "direct", "Tell me about the harbour guild faction and its lore."],
  ["rpg-world", "paraphrase", "Who runs the harbour town, and how do they feel about the party after last session?"],
  ["rpg-world", "paraphrase", "Note that the duke's spy was unmasked and tie that to the coronation storyline."],
  // rpg-scene
  ["rpg-scene", "direct", "Narrate the scene as we enter the temple."],
  ["rpg-scene", "paraphrase", "Set the stage: the party arrives at the flooded temple at dusk."],
  ["rpg-scene", "paraphrase", "Wrap up this moment and move us on to the next morning."],
  // rpg-combat
  ["rpg-combat", "direct", "Roll initiative, the goblins attack!"],
  ["rpg-combat", "paraphrase", "Three bandits jump us from the ridge; start the turn order."],
  ["rpg-combat", "paraphrase", "I swing my axe at the nearest one; resolve the hit and the damage."],
  // rpg-shop
  ["rpg-shop", "direct", "Open the blacksmith's shop so I can buy a sword."],
  ["rpg-shop", "paraphrase", "What does the armourer have for sale, and how much for the chain mail?"],
  ["rpg-shop", "paraphrase", "Sell my spare dagger to the trader in the square."],
  // the predecessor's routing scenarios (scripts/group-routing-check/src/main.rs)
  [["shell"], "scenario", "Refactor the parser in src/lib.rs and run the tests"],
  [["bigquery"], "scenario", "How many rows are in the events table? Query BigQuery."],
  [["notion"], "scenario", "Update the status of the launch page in Notion"],
  [["selfmod"], "scenario", "Add a new tool to your own loop and rebuild it"],
  [["web"], "scenario", "Is there arxiv research on tool retrieval?"],
  [["branch"], "scenario", "Merge trunk into this branch and resolve the conflicts"],
  [["ssh", "shell"], "scenario", "Open a shell on the build-box host over ssh"],
  // more than one group
  [["web"], "mixed", "Look up the current bubblewrap flags online and update our fence code to match."],
  [["subagents", "bigquery"], "mixed", "Spin up a worker to pull the sales numbers from the warehouse while you draft the summary."],
  // controls: nothing beyond the core should help
  [[], "control", "hi"],
  [[], "control", "Say hello."],
  [[], "control", "Explain in two sentences why a prompt cache prefix has to stay byte identical."],
  [[], "control", "What does the word fence mean in this system?"],
  [[], "control", "Do you think a three level skill cache is worth the complexity?"],
  [[], "control", "Thanks, that is all for today."],
];

const canaryOf = (id) => `⟦c:${createHash("sha256").update(`${SALT}:${id}`).digest("hex").slice(0, 10)}⟧`;

function recordOf([id, brief, tags, alwaysOn, tools]) {
  const canary = canaryOf(id);
  const withCanary = tools.map((x, i) => (i === tools.length - 1 ? { ...x, description: `${x.description} ${canary}` } : x));
  const body = [`# ${id}`, brief, `Tags: ${tags.join(", ")}`, "Tools:", ...withCanary.map((x) => `- ${x.name}: ${x.description}`), ""].join("\n");
  return { id, name: id, description: brief, tags, alwaysOn, tools: withCanary, canary, body };
}

const records = GROUPS.map(recordOf);
const jsonl = `${records.map((r) => JSON.stringify(r)).join("\n")}\n`;
const sha256 = `sha256:${createHash("sha256").update(jsonl).digest("hex")}`;
writeFileSync(resolve(out, "corpus.jsonl"), jsonl);
writeFileSync(
  resolve(out, "corpus.json"),
  `${JSON.stringify(
    {
      id: "tool-groups@1",
      version: "1.0.0",
      sha256,
      records: records.length,
      file: "corpus.jsonl",
      seed: SALT,
      sampling: {
        rule: "authored: the predecessor's group table (thetis agents/agent-core/src/groups.rs) with its briefs and tags; tool names are its built-ins and its component naming convention; tool descriptions are authored here; the canary sits in the last tool's description",

        routable: records.filter((r) => !r.alwaysOn).length,
        alwaysOn: records.filter((r) => r.alwaysOn).map((r) => r.id),
      },
    },
    null,
    2,
  )}\n`,
);

const counts = new Map();
const tasks = TASKS.map(([groups, family, query]) => {
  const ids = Array.isArray(groups) ? groups : [groups];
  const key = ids.join("+") || "control";
  const n = (counts.get(key) ?? 0) + 1;
  counts.set(key, n);
  return { id: `tg-${key}-${n}`, query, groups: ids, family, tags: [family, ids.length > 1 ? "multi-group" : ids.length ? "single-group" : "negative"], ...(ids.length ? {} : { control: true }), turns: 2 };
});
writeFileSync(resolve(out, "tasks.jsonl"), `${tasks.map((x) => JSON.stringify(x)).join("\n")}\n`);
process.stdout.write(`wrote ${records.length} records (${sha256.slice(0, 19)}…) and ${tasks.length} tasks to ${out}\n`);
