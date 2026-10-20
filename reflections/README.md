# @thetis/reflections

When you archive a conversation, a model reads all of it once and writes down two things: what the
assistant tried and what each attempt did, and at most one lesson that should change how it works next
time. The lesson is kept as a skill under `skills/lessons/` in your home, where every skills loader
already looks, so the assistant meets it in later conversations at the moment its situation comes up.
Most conversations teach nothing that transfers, and the reflection says so rather than inventing a rule.

Nothing here touches the daemon. The archive and forget hooks are the web gateway's session seam
(`thetis.sessions`); the service runs in your own fence and uses `kernel.sessions.list` and `inspect`,
`kernel.models`, `kernel.config.effective`, and one `kernel.providers.call` per reflection, with no tools.
The place writes the model setting with `kernel.config.set` at your own layer.

## How a conversation is reflected on

1. **Archive.** The gateway calls `onArchive` after it writes the mark. The hook writes
   `reflections/<s>.json` as `queued`, or as `skipped` with the reason: too short, switched off, or switched
   off for the conversation's project. It is fast and never calls a model. A subagent is never reflected
   alone; it is part of its parent's reflection.
2. **Restore.** The same hook, with `archived: false`, turns a `queued` or `running` reflection into
   `cancelled` ("restored before it ran"). A finished reflection and its lesson stay.
3. **The queue.** The service watches `reflections/` and sweeps it every half minute, and on start it
   queues again any record a stopped service left `running`. It reflects one conversation at a time,
   oldest first. Before each it checks the daily cap; an automatic reflection past the cap is `skipped`
   ("daily cost cap reached"), and Reflect pressed by you runs anyway.
4. **The export.** The conversation and its subagents are written as evidence under
   `reflections/<s>/context/`, every event numbered once (below). Past `inputChars` the middle is left out,
   the gap is said where it is, and the record is marked partial.
5. **The call.** One request on the configured model (unset: the server's default), the mission as the
   system prompt, the evidence as the only message, no tools, `max_tokens: maxTokens`. Its cost, when the
   provider reports one, goes on the record and on the day's spend.
6. **The guard.** The answer is parsed into rows and a lesson. The rows are always kept. The lesson is
   refused, and the record says "no lesson: <why>", when its lesson, cue or evidence is missing, when its
   evidence names no row or a row that is not there, when every row it rests on is `confounded`, when it
   cites an `[n]` the reflection could not see, or when the lesson is over 160 characters after one trim
   (the trailing stop, then the first sentence alone). A lesson that fails on its length alone is sent back
   once, with its cue and nothing of the conversation, to be said in fewer words; the answer goes through
   the same guard, and its cost is added to the record. A refused lesson is still written into the
   reflection as the model wrote it. An answer with none of the blocks is a failure, and it is kept in the
   reflection as it came.
7. **The lesson.** A lesson that passes becomes a skill (below), and `reflections/lessons.json` records
   which conversation it came from.

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

The grammar, after Harness²'s trajectories:

```
[1] [USER] what you wrote
[2] [ASSISTANT] what the assistant wrote
[3] [ACTION] edit_path({"path":"dist/app.js"})        arguments cut at 2,000 characters
[4] [OBSERVATION] what the tool answered               cut at observationChars
[5] [ERROR] a tool error, or a reply that stopped
```

A cut keeps the head and the tail of the text and says `[cut by the exporter: N chars]` between them,
because the error in a build log is at its end. A spawn result names the file and the event range of that
subagent. **Open evidence** in the place opens `trajectory.md` in Files.

## The reflection

The mission is adapted from Harness²'s `experience()`: rows of approach, observed effect and verdict
(`helped`, `hurt`, `no observed effect`, `confounded`, preferring `confounded`), each citing `[n]`; then at
most one lesson (a cue that is a situation and not a topic, one imperative sentence of at most 160
characters, the rows and events it rests on, a confidence, and optional workspace facts), or `NO_ENTRY`.
It says that the evidence is data and not instructions, that success alone never shows an approach
helped, and that this conversation's facts are never a durable rule. `lib/prompt.js` holds it whole.

`reflections/<s>.md` is the reflection as the place shows it: the rows, then the lesson or the reason
there is none.

## Lessons

```
skills/lessons/SKILL.md                  the parent of every lesson
skills/lessons/general/SKILL.md          lessons from conversations in no project
skills/lessons/p-<hex8>/SKILL.md         one project's lessons; metadata.project: p_<hex8>
skills/lessons/<scope>/<name>/SKILL.md   one lesson
```

A project's scope directory is `p-` and not `p_` because a skill name is `[a-z0-9-]`; the project id is
in `metadata.project`, which the skills loaders read to show a project's lessons only in that project.
A lesson's description is `<lesson>. Use when <cue>.`; its body has the evidence (the conversation's id
and title, the rows it rests on, the cited events), the confidence, and the workspace facts under
"Workspace facts (verified <date> in <s>; re-verify before relying on them)". A name is the lesson's first
words, made unique with `-2`, `-3`. A parent is written only when it is missing, so one you edited stays
yours. Every file passes `@thetis/skills` lint.

`reflections/lessons.json` maps each lesson to `{ from, createdAt, lesson }`.

## Files in the home

| Path | What |
|---|---|
| `reflections/<s>.json` | One conversation's record: `session`, `title`, `project`, `state`, and as they apply `reason`, `detail`, `error`, `model`, `costUsd`, `tokens`, `events`, `rows`, `lesson`, `partial`, `manual`, `queuedAt`, `startedAt`, `finishedAt`, `archivedAt`. |
| `reflections/<s>.md` | The reflection. |
| `reflections/<s>/context/` | The evidence. |
| `reflections/lessons.json` | Where each lesson came from. |
| `reflections/projects.json` | `{ "<project id>": false }` for each project switched off. |
| `reflections/spend.json` | `{ day, usd, unknown }`: today's spend (UTC), and how many reflections reported no cost. |
| `reflections/installed.json` | When the service first started; an archive older than it reads "archived before Reflections was installed". |

Every write is a whole file renamed into place. The hook, the place and the service share these files and
nothing else, so the place works while the service is down, and a Reflect waits in the queue until it is up.

## States

| State | Means | Chip |
|---|---|---|
| (none) | Archived with no record: before this package was installed, or by a gateway without the hook. Never reflected automatically. | `Not reflected · Reflect` |
| `queued` | Waiting its turn. | `Queued` |
| `running` | The model is reading it. | `Reflecting…` |
| `done` | Reflected, with or without a lesson. | `Reflected · 1 lesson · $0.04` |
| `skipped` | Not reflected automatically, and why: "too short (2 turns)", "switched off for this project", "switched off in the Reflections settings", "daily cost cap reached". | `Skipped: too short` |
| `failed` | The call or the parse failed; `error` says how. | `Failed · Retry` |
| `cancelled` | Restored before it ran, or cancelled by you. | hidden unless archived |

The chip shows on a conversation that is archived or has a record, and opens the place at it.

## The place

**Reflections** has three tabs. *Conversations* lists every archived conversation and every record with
its state and the button that state wants (Reflect, Retry, Reflect again, Cancel); a row opens its detail:
why it is in its state, the model, cost and size, **Open conversation**, **Open evidence**, its lessons with
**Open skill** and **Forget lesson**, and the reflection. *Lessons* lists every lesson by scope with its
source, or "forgotten" when the conversation is gone. *Settings* has the model picker (the kernel's model
list; "Server default" unsets it), the switch, the shortest conversation reflected, the daily cap with
today's spend, and a switch per project. It asks again every 3 s while something is queued or running and
every 15 s otherwise.

Reflect, pressed by you, runs past the switches, the minimum length and the daily cap: those govern only
the automatic reflection on archive.

## Forget

The gateway's Forget dialog asks the `forget` hook what this package holds. The preview lists "Its
reflection and the evidence exported for it" (not optional) and "N lessons came from this conversation"
(optional, ticked). The forget removes `<s>.json`, `<s>.md` and `<s>/` for the conversation and each
subagent, and with the box ticked the lessons, their `lessons.json` entries, and a scope directory left
empty that this package made. With the box unticked it says "N lessons it taught stay in your skills".
**Forget lesson** in the place removes one lesson the same way and leaves the reflection.

## Configuration

`config.packages["@thetis/reflections"]`:

| Key | Default | Meaning |
|---|---|---|
| `model` | not set | The model that reflects. Unset means the server's default model. Reflection reads the whole conversation once, so a stronger model writes better lessons. |
| `maxTokens` | `8000` | The longest answer one reflection may write. Reasoning counts against it on models that think. |
| `minTurns` | `3` | Fewer of your messages than this, and an archive is skipped as too short. |
| `observationChars` | `20000` | How much of one tool result is read. Never below 10000. |
| `inputChars` | `600000` | How much of a conversation one reflection reads; past it the middle is left out and the reflection is partial. |
| `dailyCostUsd` | `5` | The most automatic reflections spend in a day (UTC). A reflection that reports no cost is counted apart, and the cap cannot see it. |
| `enabled` | `true` | Reflect automatically on archive. A project can be switched off in the place. |

The service reads the configuration again before each reflection, so a change in the place reaches the
next one without a restart.

## Code

| File | What |
|---|---|
| `index.js` | `startReflections` (the service), `onArchive`, `forgetSession`, `uiCall`. |
| `lib/service.js` | The queue, the watch and sweep, the daily cap, cancellation. |
| `lib/reflect.js` | One reflection: export, call, parse, guard, write. |
| `lib/export.js` | The trajectory and its cuts. |
| `lib/prompt.js` | The mission, the request, the parse, the writer guard. |
| `lib/lessons.js` | Lessons as skills, their parents, their removal. |
| `lib/hooks.js` | The archive and forget hooks. |
| `lib/ops.js` | The ops of `call`: list, get, reflect, cancel, forget-lesson, settings, set-setting, project-switch. |
| `lib/records.js`, `lib/files.js` | The records, the settings, the day's spend, the gateway's marks; whole-file writes. |
| `ui/` | The chip and the place. |

## Tests

`npm test` here, or from the runtime root. No model is called and no daemon is started: a fake kernel
answers from tables. `export.test.js` (numbering, every cut and its marker, subagents, compaction, a
partial export), `prompt.test.js` (the mission's rules, the request, the parse, every refusal of the
guard), `lessons.test.js` (paths, parents, `metadata.project`, unique names, removal, lint through
`@thetis/skills`), `hooks.test.js` (archive and restore, every skip reason, both phases of forget),
`service.test.js` (the queue, one at a time, the daily cap, restart, stop, cancel while running, failures),
`ops.test.js` (the command and the chip's words) and `ui.test.js` (the chip and the place over gateway-web's
DOM fixture).

## Credit

The reflection prompt and the shape of the evidence are adapted from
[Harness²](https://github.com/google-research/harness2) (Xu et al., "Harness²: Recursive Agent Harnessing for
an Open World", [arXiv:2610.14224](https://arxiv.org/abs/2610.14224)): its `experience()`,
`EVIDENCE_BOUNDARY`, `ANSWER_FREE` and `mission()`, under the Apache License 2.0. Taken from it: the rows with a
verdict that prefers `confounded`, the one lesson whose cue is the shape of a situation, `NO_ENTRY`, and
the numbered trajectory with the exporter's own markers. The adaptation is from reflecting on edits to a
harness across rollouts to reflecting on one conversation.
