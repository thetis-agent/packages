# Where this gold came from

Each task names the tool groups a competent answer needs, as corpus ids (`groups`), and a `family` that says
what kind of query it is:

| family | what it is |
|---|---|
| `direct` | Uses one of the group's own tags. The tag matcher should get these. |
| `paraphrase` | Uses none of the group's tags. Only a dense ranking, or a skill edge, can get these. |
| `scenario` | The predecessor's routing scenarios from `scripts/group-routing-check/src/main.rs`, must-include sets. |
| `mixed` | Needs more than one group. |
| `control` | Needs nothing beyond the core. An arm that attaches groups here is spending bytes for no reason. |

The corpus (`corpus.jsonl`, written by `scripts/author-tool-groups.mjs`) is the predecessor's group table:
the 20 routable groups of `agents/agent-core/src/groups.rs` with their briefs and tags, plus `files` marked
always-on. Tool names are its built-ins and, for the groups it filled from hot-loaded components, its naming
convention (`bq_`, `notion_`, `web_browser_`, `rpg_`); the tool descriptions are authored here. The canary
sits in the last tool's description, so it lands in the tool segment of the call whenever the group is attached
(the first tools of `files` share their names with `@thetis/tools-files`, which wins the name when both are installed).

This gold is **authored**, not imported. The predecessor measured its routing on 1,634 external queries over
9,529 tool documents in 13 synthesised groups (tags alone F1 0.24, tags with a dense fallback F1 0.42); that
query set is not on disk, so these 75 tasks are written by hand, every routable group at least three times,
with paraphrases that avoid the tags on purpose. What keeps it honest for now:

- The gold is written against groups and tags that already existed, not against the mechanism competing to
  be chosen; a `paraphrase` task is one the tag matcher is expected to miss.
- Every routing figure is read beside the floor, which attaches everything: its recall is one by construction
  and its precision is the base rate a routing arm has to beat.

`route_recall`, `route_precision` and `route_f1` are scored on the routable groups only: the always-on groups
are in every call for every arm, and counting them would punish every arm alike. `routed_nothing` is the share
of tasks with a need where no routable group was admitted. `surface_tools` counts the corpus tools attached.
