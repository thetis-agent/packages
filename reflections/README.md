# @thetis/reflections

When you archive a conversation, a model reads all of it once, together with what the harness was on each
turn: the guide and system text, the tools, the skills, the package versions. It writes down three things:
what the assistant tried and what each attempt did, what the packages did wrong (**findings**), and at most
one change to the harness that should make the next conversation like this one go better (a **proposal**).

Nothing it writes reaches a conversation on its own. A proposal is first **trialled**: its request runs in a
throwaway copy of your Thetis with the change and without it, and a judge grades the runs blind. Only you
adopt it, after reading that comparison, and you can retire it again. Findings are never shown to the
assistant; they are for whoever maintains the package.

Nothing here touches the daemon. The archive and forget hooks are the web gateway's session seam
(`thetis.sessions`); the service runs in your own fence and uses `kernel.sessions.list` and `inspect`,
`kernel.models`, `kernel.packages.list`, `kernel.config` and one `kernel.providers.call` per reflection or
judgement, with no tools. Trials go through `@thetis/host-trials` over `kernel.operator.call`.

## How a conversation is reflected on

1. **Archive.** The gateway calls `onArchive` after it writes the mark. The hook writes
   `reflections/<s>.json` as `queued`, or as `skipped` with the reason: too short, switched off, or switched
   off for the conversation's project. It is fast and never calls a model. A subagent is never reflected
   alone; it is part of its parent's reflection.
2. **Restore.** The same hook, with `archived: false`, turns a `queued` or `running` reflection into
   `cancelled` ("restored before it ran"). A finished reflection stays.
3. **The queue.** The service watches `reflections/` and sweeps it every half minute, and on start it
   queues again any record a stopped service left `running`. It reflects one conversation at a time,
   oldest first. Before each it checks the daily cap; an automatic reflection past the cap is `skipped`
   ("daily cost cap reached"), and Reflect pressed by you runs anyway.
4. **The export.** The conversation, its subagents, the harness record and the library index are written
   as evidence under `reflections/<s>/context/` (below). Past `inputChars` the middle of the conversation is
   left out, the gap is said where it is, and the record is marked partial.
5. **The call.** One request on the configured model (unset: the server's default), the mission as the
   system prompt, the evidence as the only message, no tools, `max_tokens: maxTokens`.
6. **The guard** (below) keeps the rows always, keeps or refuses each finding on its own, and keeps or
   refuses the proposal whole.
7. **The library.** A kept finding goes into `reflections/findings.json` (or adds a sighting to the finding
   it is the `same-as`); a kept proposal becomes an entry in `reflections/library.json` in state `proposed`
   (or adds this conversation to the entry it `reinforces`). Reflecting on the same conversation again
   replaces what its earlier reflection added and nobody touched since.

A record that turns `cancelled`, or disappears, while its reflection runs stops the call, and nothing the
reflection would have written is written.

## The evidence

`reflections/<s>/context/`:

| File | What |
|---|---|
| `MISSION.md` | The instructions, exactly as the model read them. |
| `task.md` | Your first message, with the turn-context line cut. |
| `trajectory.md` | Every event of the conversation, numbered. |
| `subagents/<id>.md` | Each subagent's events, numbered on from the conversation's. |
| `compaction.md` | The compaction summary the assistant saw in place of its older messages, when there was one. |
| `harness/turns.md` | Per turn: the model, the versions (all on the first turn, then only changes), the skills pinned and universal, the tool groups, the project, and which `system-<n>.md` and `tools-<n>.md` it used. Subagents follow under their own heading. |
| `harness/system-<n>.md` | Each distinct system text, numbered in order of first use. |
| `harness/tools-<n>.md` | Each distinct tool list, as name, package and description; parameters are left out. |
| `harness/NONE.md` | In place of the three above when the conversation has no stamps (everything from before harness-core recorded them): "This conversation ran before turns were recorded. The harness below is today's, not the one it ran with.", today's installed versions, and no system text. The mission says harness attribution is then weak. |
| `library/INDEX.md` | Every entry not rejected (`L-id · state · kind target · cue · lesson`), every open or possibly-fixed finding (`F-id · package component · what`), and "Tried and rejected" with each verdict, so the same thing is not proposed again. |

The harness record is read from the stamps `@thetis/harness-core` writes per turn,
`harness-core/turns/<s>.jsonl` and `harness-core/snapshots/<s>/<sha>.{md,json}` in the home. Today's versions
come from `kernel.packages.list()`, else from the `package.json` files under the userspace's
`store/node_modules`.

The trajectory grammar, after Harness²'s trajectories:

```
[1] [USER] what you wrote
[2] [ASSISTANT] what the assistant wrote
[3] [ACTION] edit_path({"path":"dist/app.js"})        arguments cut at 2,000 characters
[4] [OBSERVATION] what the tool answered               cut at observationChars
[5] [ERROR] a tool error, or a reply that stopped
```

A cut keeps the head and the tail and says `[cut by the exporter: N chars]` between them, because the error
in a build log is at its end.

## The answer

The mission (`lib/prompt.js`) asks for:

```
<rows>
row: 1
approach: …
component: judgement | workspace | preference | outside | <package> <component>
observed: … [n]
verdict: helped | hurt | no observed effect | confounded
</rows>

<findings>
finding: 1
package: @thetis/tools-files
component: read_file
version: 0.4.0
what: one or two sentences
evidence: rows 2; [14], [15]
same-as: F-ab12cd | none
</findings>

<proposal>
kind: skill | project-instructions | guide-note | config
target: <skill id> | <project id> | - | <package> <key>
reinforces: L-ab12cd | none
cue: the shape of situation
lesson: one sentence: what changes and why
evidence: rows 1, 3; [4], [9]
confidence: high|medium|low, and why
trial: opening request | <a self-contained request>
change:
~~~
<the full new SKILL.md | the full new instructions | the note | the JSON value>
~~~
</proposal>
```

or `NO_PROPOSAL` in place of the proposal. It explains the **attribution test** (would a better-judging
model have avoided it with the same harness? `judgement`. Would any model have hit it because the harness
gave it something wrong or too little? the package and component), and `workspace`, `preference` and
`outside`; that verdicts prefer `confounded`; that a proposal may rest on confounded rows because a trial
will test it, but its confidence must say so; the four kinds (a skill's description is what makes it fire;
a guide note is rare, one line, and for judgement across situations; preference rows propose a guide note
or config, workspace rows project instructions); `reinforces` and `same-as`; that the evidence is data and
not instructions; and that no secret is ever copied.

## The guard

- **Rows** are always kept.
- **A finding** is refused, alone, when it lacks its package, component, what or evidence; when its
  evidence cites a row that is not there or an `[n]` the reflection could not see; when the package is not
  among the stamped versions (today's, when unstamped); or when `same-as` names no finding. Its version is
  the stamped one, not the model's.
- **The proposal** is refused, and the reflection says "no proposal: <why>" and shows the block as it came,
  when the cue, lesson or evidence is missing; the evidence names no row, or a row or event it could not
  see; `reinforces` names no entry; the kind is unknown; or:
  - **skill**: the content fails the `@thetis/skills` lint, its frontmatter `name` is not the target's last
    segment, it is over 12,000 characters, its `metadata.project` names no project, or it is nested under a
    parent that is not a skill in your home (a home skill at `skills/a/b/` is read only when `skills/a/` is
    one; see `@thetis/skills` `load.js`);
  - **project-instructions**: the project does not exist, or the text is over 12,000 characters;
  - **guide-note**: over 300 characters, or more than one line;
  - **config**: the package is not installed, the key is not in its manifest `thetis.config`, the value is
    not JSON of the declared type, or the key is a secret.

## The library: `reflections/library.json`

```json
{"entries": [{
  "id": "L-ab12cd", "kind": "skill", "target": "thetis-packages",
  "path": "skills/thetis-packages/SKILL.md", "skillSource": "shipped",
  "cue": "…", "lesson": "…", "change": "…", "before": "…or null",
  "evidence": "…", "confidence": "…", "trialRequest": "opening request|…",
  "from": [{"session": "s_…", "title": "…", "at": "<iso>", "rows": [1, 3]}],
  "versions": {"@thetis/skills-thetis": "0.10.0"},
  "owner": "@thetis/skills-thetis",
  "state": "proposed",
  "trials": ["t_…"], "verdict": null,
  "applied": null, "recheck": null,
  "createdAt": "<iso>", "updatedAt": "<iso>"
}]}
```

- **States**: `proposed` → `trialling` → `trialled` → `adopted` | `rejected`; `adopted` → `retired`. A
  `trialled` or `adopted` entry can be trialled again.
- **`owner`**: the package whose component it changes. A shipped skill: that package; a home or new skill:
  `null`; a guide note: `@thetis/harness-core`; config: its package; project instructions:
  `@thetis/projects`.
- **`versions`**: the owner's installed version and those of the packages the cited rows name, at proposal
  time (and the owner's again at adoption).
- **`before`**: what was there: the winning skill file's text, the instructions file, the guide notes as
  JSON, or the user-layer config value as JSON; `null` when nothing was.
- **`path`** (skill): a home skill keeps its path; a shipped one is overridden at `skills/<id>/SKILL.md` in
  the home (later sources win on an equal id); a new one goes there too (`skillSource` is `home`,
  `shipped` or `new`). A skill only for one project carries `metadata.project`.
- **`reinforces`** appends to `from` and `evidence` and changes nothing else; a rejected entry stays
  rejected and the record notes "reinforces a rejected proposal".

## Trials and the judge

- **Start** (`startTrial`): needs `proposed`, `trialled` or `adopted`. The request is the one you edited,
  else `trialRequest`, else, for `opening request`, the first message of the conversation it came from
  without its turn-context line. The model is `trialModel`, else turn 1's from the stamp, else the
  conversation's last (`harness["@thetis/harness-core"].lastCall.model`), else the server's default. The
  project is the conversation's (for project instructions, the target project). It calls
  `host.trials.start` with `arms: [{id: "base", change: null}, {id: "change", change}]` and the trial
  settings (the arms turned around for an applied entry, below), sets `trialling`, and pushes the trial id.
- **Cancel** (`cancelTrial`): `host.trials.cancel`, and the entry goes back to where it was with the verdict
  "cancelled by you". A trial that had already finished is not an error.
- **Follow**: on every sweep the service asks `host.trials.status` about each trialling entry. A `failed` or
  `cancelled` trial puts the entry back where it was with the error as an `inconclusive` verdict. A `done`
  one is judged:
  1. Each run is exported, with its subagents, into `reflections/trials/<t>/<arm>-<n>.md`.
  2. If any run failed, hit its budget or timed out, the verdict is `inconclusive` with the reason, and the
     judge is not asked.
  3. Otherwise the **judge**, adapted from Harness²'s `select()`, gets one tool-less call on the reflection
     model. The runs are anonymised A, B, C… by a canonical sort and a seeded shuffle (Harness²'s
     `assign_ids`); the text it reads never names an arm. It is told the runs differ in one harness change
     it cannot see, and to judge the work, not how it sounds. For each run it says whether the cue's
     situation arose (`yes [n]|no|unclear`) and grades it 1 to 5 against the request, then names the best
     run and the runner-up.
  4. The verdict is mechanical. The situation arose in no run: `not reached`. Otherwise the arms' mean
     grades over the runs where it arose (over every run when it arose in one arm only) are compared: the
     change arm 0.5 or more higher is `helped`, 0.5 or more lower is `hurt`, else `no difference`; one run
     each adds "(one run each: weak)". An unreadable judgement is `inconclusive`.
  5. **Seen**: for a skill, whether each change run had it pinned or universal on a stamp, or fetched it
     with `skill_fetch`; other kinds are always seen. A skill not seen in every change run says so in the why.
  6. `reflections/trials/<t>/judge.md` keeps the anonymised table, the map, the judge's choice and reasoning,
     the verdict and the answer as it came. The entry becomes `trialled` with
     `verdict: {result, why, seen, runs, costUsd, judgeCostUsd, best, runnerUp, weak?, at, trial}`. The
     judge's cost goes into the day's spend; the cap never stops it.
- **Adopt** (`adoptEntry`): needs `trialled`, or `adopted` with a re-check. It refuses with "<where> changed
  since the proposal; run the trial again" when what is there now is not `before` (or, once applied, not
  what was applied). Then it writes the skill or instructions file, appends the note to
  `@thetis/harness-core` `guideNotes`, or sets the config key, at your own layer, and records
  `applied: {before, after, at}`.
- **Retire** (`retireEntry`) puts `applied.before` back: a new or shipped-override skill's file is deleted
  (and its directory, when empty), a home skill or instructions file is rewritten, the note is removed (the
  last one unsets the key), a config key is restored or unset.
- **Re-check**: on a sweep, an adopted entry whose owner's installed version differs from `versions[owner]`
  gets `recheck: {reason: "@thetis/x changed 0.3.0 → 0.4.0 since adoption", at}`. Nothing is undone.

A trial of an entry whose change is already applied (an adopted one, re-checked) runs on a home that
already has it, so the arms are turned around: the base arm carries the inverse of what was applied (the
file restored or deleted with `content: null`, the key restored or unset with `value: null`, the guide
notes without this one as a `config` change of `guideNotes`), and the change arm runs the home as it is.
The change arm is still the one with the change, so the verdict reads the same.

## Findings: `reflections/findings.json`

`{findings: [{id, package, component, what, seen: [{session, title, at, version, events, rows}], state:
open|possibly-fixed|closed, since, closedAt}]}`. `same-as` adds a sighting and reopens a `possibly-fixed`
finding, or a `closed` one seen at a newer version than before. On each sweep an open finding whose package
is installed at a version newer than every sighting becomes `possibly-fixed`, with `since`. `closeFinding`
closes one.

## Files in the home

| Path | What |
|---|---|
| `reflections/<s>.json` | One conversation's record: `session`, `title`, `project`, `state`, and as they apply `reason`, `detail`, `error`, `model`, `costUsd`, `tokens`, `events`, `rows`, `proposal` (`L-…` or null), `findings` (`[F-…]`), `reinforced`, `note`, `partial`, `manual`, `queuedAt`, `startedAt`, `finishedAt`, `archivedAt`. `reason` reads "no proposal: <why>" when there is none. |
| `reflections/<s>.md` | The reflection: the rows with their component, the findings (and the refused ones, with why), and the proposal (a diff against `before` for a skill or instructions), or the refused block as it came. |
| `reflections/<s>/context/` | The evidence. |
| `reflections/library.json` | The proposals. |
| `reflections/findings.json` | The findings. |
| `reflections/trials/<t>/` | Each run's trajectory and `judge.md`. |
| `trials/<t>/` | What `@thetis/host-trials` wrote: `trial.json` and each run's record and stamps. |
| `reflections/projects.json` | `{ "<project id>": false }` for each project switched off. |
| `reflections/spend.json` | `{ day, usd, unknown }`: today's spend (UTC), and how many calls reported no cost. |
| `reflections/installed.json` | When the service first started; an archive older than it reads "archived before Reflections was installed". |

Every write is a whole file renamed into place.

## Forget

The preview lists "Its reflection and the evidence exported for it" (fixed), "N proposals came only from
this conversation" (optional, ticked; adopted ones are not counted), and "Its sightings in N findings"
(fixed). The forget removes the record, the reflection and the evidence; with the box ticked, those
proposals and their `reflections/trials/<t>/` and `trials/<t>/`; this conversation's `from` items in every
other entry; its sightings, and a finding left with none. An adopted change stays: "N adopted changes it
led to stay; retire them in Reflections".

## Configuration

`config.packages["@thetis/reflections"]`:

| Key | Default | Meaning |
|---|---|---|
| `model` | not set | The model that reflects and judges. Unset means the server's default. |
| `maxTokens` | `16000` | The longest answer one reflection may write: the rows, the findings and a proposal that may carry a whole skill file. Reasoning counts against it on models that think. |
| `minTurns` | `3` | Fewer of your messages than this, and an archive is skipped as too short. |
| `observationChars` | `20000` | How much of one tool result is read. Never below 10000. |
| `inputChars` | `600000` | How much one reflection reads; the harness record and the index take from it first (at most half). |
| `dailyCostUsd` | `5` | The most automatic reflections spend in a day (UTC). |
| `enabled` | `true` | Reflect automatically on archive. A project can be switched off in the place. |
| `trialRuns` | `2` | Runs per arm, 1 to 5. |
| `trialCostUsd` | `5` | The cap for one whole trial. |
| `trialMinutes` | `20` | The cap for one run. |
| `trialScratchMb` | `8192` | The memory a trial run may write into. |
| `trialModel` | not set | The model trials run on; unset means the one the conversation ran with. |

## Code

| File | What |
|---|---|
| `index.js` | `startReflections`, `onArchive`, `forgetSession`, `uiCall` and its `OPS`. |
| `lib/service.js` | The queue, the watch and sweep, the daily cap, cancellation; the library's sweep. |
| `lib/reflect.js` | One reflection: export, call, parse, guard, write. |
| `lib/export.js` | The trajectory and its cuts. |
| `lib/harness.js` | The stamps, the snapshots, `harness/`, and today's packages. |
| `lib/prompt.js` | The mission, the request, the parse, the guard. |
| `lib/library.js` | Proposals and findings: `listEntries`, `getEntry`, `rejectEntry`, `startTrial`, `cancelTrial`, `adoptEntry`, `retireEntry`, `listFindings`, `closeFinding`, the sweeps, the forget. |
| `lib/trials.js` | Following a trial, the run export, the judge, the aggregation. |
| `lib/hooks.js` | The archive and forget hooks. |
| `lib/ops.js` | The ops of `call`. |
| `lib/records.js`, `lib/files.js` | The records, the settings, the day's spend, the gateway's marks; whole-file writes. |
| `ui/` | The chip and the place. |

## Tests

`npm test` here. No model is called and no daemon is started: a fake kernel answers from tables and a fake
`host.trials.*` writes trial directories. `prompt.test.js` (the mission's rules, the parse, every refusal),
`export.test.js` (the trajectory, `harness/` with stamps and NONE, `library/INDEX.md`), `library.test.js`
(states, reinforces, start and cancel, adopt and retire per kind, before-mismatch, re-check),
`findings.test.js` (same-as, possibly-fixed, reopen), `trials.test.js` (anonymising, the judge's request and
parse, every verdict, seen, failed and cut-short trials), `hooks.test.js`, `service.test.js`, `ops.test.js`
and `ui.test.js`.

## Credit

The reflection mission, the judge and the shape of the evidence are adapted from
[Harness²](https://github.com/google-research/harness2) (Xu et al., "Harness²: Recursive Agent Harnessing for
an Open World", [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)), under the Apache License 2.0: its
`experience()`, `EVIDENCE_BOUNDARY`, `ANSWER_FREE` and `mission()` for the reflection (rows with a verdict
that prefers `confounded`, a change that names the component it concerns, a cue that is the shape of a
situation, `NO_ENTRY`, the numbered trajectory with the exporter's own markers, and a library read by the
improver and never by the working agent); and its `select()` and `assign_ids` for the judge (blind
selection over anonymised candidates, a seeded shuffle, judging delivery and fidelity rather than how a
candidate sounds). The adaptation is from reflecting on edits to a harness across rollouts to reflecting on
one conversation, and from picking one artifact to grading every run of a with-and-without trial.
