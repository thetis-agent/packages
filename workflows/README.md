# @thetis/workflows

A workflow is a graph of steps — send a prompt to a conversation on a chosen model, call a package's tool,
parse a reply into variables, branch on them, loop back a bounded number of times, wait for a person — that
the workflow service runs **unattended** in the person's own fence, in their own conversations, so every
turn it takes is an ordinary conversation they can open and read. A workflow is edited on a canvas in the
**Workflows** place of the web page, and each run is watched there step by step.

It exists because running a multi-phase job by hand (a plan on one model, the implementation on another, a
verification, a nudge every time a phase over-investigates, a RESULT line read by eye) is a person acting as
the watchdog a program should be. The first workflow built with it is the Nova Island bug fix.

Nothing here touches the daemon. The service uses `kernel.sessions` (`create`, `send` with a per-turn
`model`, and `send` with no input to resume; `cancel` with a reason; `inspect`), `kernel.turns.yielding` when
the kernel has it, `env.invokeTool` for tool steps, and the person's home for its files.

## Files in the home

Everything lives under `workflows/` in the person's home, written only by the service:

| Path | What |
|---|---|
| `workflows/defs/<wf>/draft.json` | The definition being edited. Always present once a workflow exists. |
| `workflows/defs/<wf>/v<N>.json` | Published version N, immutable. A run keeps the version it was queued with. |
| `workflows/runs/<run>.json` | One run: its state, variables and step history. |
| `workflows/queue.json` | `{ paused: boolean }` — the queue's one setting. |

Ids: a workflow id is `wf_` + 8 hex; a run id is `r_` + 10 hex; a step id is `[a-z][a-z0-9_]{0,31}`.

## The definition (the shared contract)

```jsonc
{
  "id": "wf_1a2b3c4d",
  "name": "Nova Island bug fix",
  "description": "Plan on Fable, implement on Opus, verify on Sonnet.",
  "version": 3,                 // in draft.json: the version this draft will publish as; in vN.json: N
  "project": "p_624f67bc",      // optional: every conversation the run opens is assigned to this project
  "costCapUsd": 40,             // optional: else the package config's costCapUsd
  "input": { "kind": "lines", "label": "Notion bug links", "placeholder": "One link per line" },
  "start": "lookup",
  "steps": { "<step id>": Step, ... },
  "layout": { "<step id>": { "x": 0, "y": 0 } }   // editor positions only; the engine ignores it
}
```

`input.kind` is `"lines"` (each non-empty line queues one run; the line is `{{input}}`) or `"text"` (the
whole text is one run).

### Templates

Every string field marked *template* may hold `{{path}}` holes: a dotted lookup, never an expression. The
scope is:

- `input` — the run's input text; `run.id`, `run.number` (1-based count of runs of this workflow);
- `<step id>.*` — what a finished step saved (below). A hole naming something not yet set renders as an
  empty string, and the validator warns about holes that can never be set.

### Steps

Every step has `type`, an optional `label` (shown on the canvas; else the id) and the fields of its type.
`next`-style fields name another step id.

| type | fields | saves as `<id>.*` |
|---|---|---|
| `prompt` | `model` (string, required), `conversation`: `"new"` or the id of an earlier `prompt` step whose conversation to continue, `title` (template, only with `"new"`: sent as the first line of the first message, which is what the conversation list shows), `prompt` (template, required), `budget` `{ toolCalls, tokens, minutes }` (each optional, a positive number), `nudge` (template: the message sent after the first budget breach), `onBreach` (step id taken on the second breach; default: end as needs-you), `next` | `text` (the last assistant reply), `conversation` (session id), `cost`, `toolCalls`, `tokens` (the largest prompt size seen), `ms` |
| `tool` | `package`, `export`, `name` (the tool's declared name), `args` (object whose string values are templates), `next`, `onError` (step id; default: end as failed) | `text` (the tool's output as text), `error` |
| `parse` | `from` (id of a `prompt` or `tool` step whose `text` is parsed, or a list of such ids: the one that finished most recently is parsed), `fields` `{ name: regex }` (JavaScript source, flags `m`; the value is the first capture group, else the whole match), `required` (field names; default all), `followUp` (template, only when `from` is a `prompt` step: on a miss it is sent once to that step's conversation on that step's model (with a list, the step that was parsed), the reply replaces that step's `text`, and the fields are parsed again), `next`, `onNoMatch` (step id; default: end as needs-you) | each field; `matched` (`"true"`/`"false"`); `text` (the text that was parsed); `source` (the step id it came from) |
| `branch` | `on` (template), `cases` `{ value: step id }`, `default` (step id; default: end as needs-you) | `value` |
| `loop` | `target` (step id), `max` (≥ 1), `exhausted` (step id; default: end as needs-you) | `count` |
| `approval` | `message` (template), `next`, `onReject` (step id; default: end as cancelled) | `decision` (`approved`/`rejected`), `note` |
| `done` | `summary` (template) | — |
| `needs` | `reason` (template) | — |

A `loop` step, each time it is reached, increments its own counter and jumps to `target` while the count is
at most `max`; past that it goes to `exhausted`. Re-running a step overwrites what it saved.

### Budgets, nudges and the cost cap

For a `prompt` step the engine counts, from the turn's events: `tool.call` events, the largest
`usage.prompt_tokens` (or `input_tokens`) seen, and wall-clock minutes. When any count passes its budget:

1. **first breach** — `kernel.sessions.cancel(conversation, { why: "budget" })`, then the `nudge` text (default: *"Budget
   reached. Stop exploring and finish now with what you have; say plainly what is unverified."*) is sent to
   the same conversation on the same model, with the budget counters reset;
2. **second breach** — the turn is cancelled and the run goes to `onBreach`.

A budget cut and a cost-cap cut both cancel with the reason `budget`, which the kernel does not keep as an
interrupted turn, so nothing resumes it by itself.

A dropped connection to the model is retried inside the turn by `@thetis/harness-core`. A turn that still
ends in an error has used those retries, and it fails the step; **Retry** in the run view goes on from where
it stopped (see below). A turn that Thetis cut is not the step's failure. That is a turn whose record says
`interrupted` with `why` `restart`, `reload` or `crash`, or a turn that gave way at a round boundary (a
`yield` event) to a restart or an update. The step goes on with a turn that has no input,
`kernel.sessions.send(conversation, [])`. That turn runs over the saved conversation, adds no message and
does nothing again that had finished. After a `yield`, the engine first waits while `kernel.turns.yielding()`
says a restart or an update is still on its way (a short pause on a kernel without it). When a send finds a
turn already running in the conversation (`busy`: most often the harness's own resume after a restart), the
engine waits for that turn to end and never cancels it. When its own send was a resume, it takes that turn's
reply. At most three such resumes per turn, with the budget counters carried over; then the step fails.

The cost of a run is the sum of `usage.cost` over its turns. When it reaches the cap the running turn is
cancelled and the run ends as needs-you with the reason `Cost cap of $X reached`.

### Validation

`validate(definition)` answers `{ ok, issues: [{ step?, level: "error"|"warn", message }] }`. Errors: no
`start` or a `start`/`next`/target that names no step; an unknown type; a `prompt` without `model` or
`prompt`; `conversation` naming a step that is not a `prompt` step; a `parse` whose `from` is not a
`prompt`/`tool` step or whose regex does not compile; a `loop` without `max ≥ 1`; a non-end step with no way
out. Warnings: a `prompt` step with no budget; a step no path reaches; a hole that no step saves; a `model`
the kernel does not list. Publishing refuses a definition with errors.

## Runs

```jsonc
{
  "id": "r_0a1b2c3d4e", "workflow": "wf_1a2b3c4d", "version": 3, "name": "Nova Island bug fix",
  "number": 12, "input": "https://www.notion.so/…",
  "state": "queued" | "running" | "waiting" | "done" | "needs" | "failed" | "cancelled",
  "step": "impl",               // the current step while running/waiting, else the last one
  "reason": "…",                // for needs / failed / cancelled; the done summary for done
  "vars": { "<step id>": { … } },
  "history": [ { "step": "plan", "type": "prompt", "status": "running"|"done"|"failed"|"skipped",
                 "startedAt": "…", "endedAt": "…", "model": "…", "conversation": "s_…",
                 "toolCalls": 33, "tokens": 112480, "cost": 3.58, "ms": 540000,
                 "breaches": 0, "note": "…", "activity": ["shell: dotnet test …", "…"] } ],
  "cost": 13.61, "costCapUsd": 40,
  "conversations": ["s_…"], "titles": { "s_…": "Bug 1083: …" }, "createdAt": "…", "updatedAt": "…"
}
```

`activity` keeps the last 20 tool calls of the step, each as `"<tool name>: <first 120 chars of its
arguments>"`, so the run view can show what a step is doing without opening the conversation.

The queue runs `queued` runs oldest first, `concurrency` at a time, unless paused. `waiting` is an
`approval` step. After the service starts (boot, `thetis reload`), a run left `running` is resumed at its
current step. For a `prompt` step the engine first waits for any turn running in its conversation to end,
and never cancels it. Then:
- when the record says the last turn was cut (`interrupted`), or the conversation ends on something the
  model has not answered, it goes on with a turn that has no input;
- when the last message is a finished assistant reply, that reply is the step's result;
- when the step's message never reached the conversation (its length is still the `at` the history entry
  noted), the message is sent.

**Retry** at the `prompt` step a run failed in goes on in that step's conversation. A cut turn goes on with
no input. A conversation that ended on a reply (a second budget breach, or an older kernel that left a cut
reply unmarked) is sent *"Carry on with the task. Your last reply did not finish it."*: there is no cut turn
to go on from, and a turn with no input would ask the model to go on from its own last word. No message
like "Your previous turn was interrupted" is ever sent.

## The service socket

The service listens on `<root>/run/workflows.sock` and speaks JSON lines, the terminal package's shape:
a request `{ "i": 1, "op": "…", ...args }`, an answer `{ "i": 1, "ok": true, "result": … }` or
`{ "i": 1, "ok": false, "error": "a sentence" }`, and, on a subscribed connection, events `{ "ev": … }`.

| op | args | result |
|---|---|---|
| `list` | — | `[{ id, name, description, published: N or null, draftVersion, updatedAt, runs: { total, active, needs, lastAt } }]` |
| `get` | `id` | `{ draft, versions: [N…], published: vN definition or null }` |
| `create` | `name`, `from?` (a workflow id to copy) | the new draft |
| `save` | `id`, `definition` | `{ draft, validation }` (a draft is saved even with errors) |
| `publish` | `id` | `{ version, validation }`, or an error naming the first validation error |
| `remove` | `id` | `{}` (runs are kept) |
| `validate` | `definition` | `{ ok, issues }` |
| `enqueue` | `id`, `text` | `{ runs: [run…] }` (uses the published version; refuses a workflow never published) |
| `runs` | `workflow?`, `limit?` | `[run…]` newest first, without `vars` |
| `run` | `id` | the full run |
| `cancel` | `id` | the run (a running turn is cancelled) |
| `retry` | `id`, `from?` (step id; default the step it stopped at) | the run, queued again from that step, keeping its vars; retried at the `prompt` step it failed in, the step goes on in its conversation (a turn with no input when its last turn was cut) rather than starting again |
| `approve` | `id`, `decision` (`approved`/`rejected`), `note?` | the run |
| `queue` | `paused?` | `{ paused, running: [run ids], queued: n }` |
| `conversations` | — | `{ "<conversation id>": { title?, model? } }` for every conversation a run opened: the title it gave and the model its last prompt step ran on there |
| `forget` | `id` | `{}`; deletes a finished run's record (a run still going is refused) and broadcasts `{ ev: "forgotten", id }` |
| `catalog` | — | `{ models: [{ id, label? }], defaultModel, projects: [{ id, name }], tools: [{ package, export, name, description }] }` |
| `subscribe` | — | `{ runs: [run…] }` (latest 50, without `vars`); then events `{ ev: "run", run }` (without `vars`) whenever a run changes, `{ ev: "workflow", id }` when a definition changes, `{ ev: "queue", queue }` |

## The browser side

The sidebar's derived title is the kernel's summary of the first message, newlines collapsed, so a title
line sent first would run into the prompt; and a turn the page only watched carries no model. Names and
models live in the web page's own store, so the browser module applies them: on every page load and list
change it asks the service's `conversations` once per conversation that lacks a name or a model, and posts
what is missing to the page's own `api/sessions/<id>/title` and `api/sessions/<id>/model` (with
`remember: false`, so the person's default for new conversations is untouched). A name or model the person
chose is never changed (`ui/titles.js`).

Two UI verbs, both thin clients of the socket:

- `call` — `args: { op, ...args }`, answers `{ data: result }` or a 400 with the service's sentence;
- `watch` (`stream: true`) — subscribes and yields every event, starting with `{ ev: "snapshot", runs }`.

The **Workflows** place has three views, one URL-free state machine inside the place: the **library**
(workflows with their last runs, a "New workflow" button, and each workflow's input box to queue runs),
the **editor** (the canvas: a step palette, the graph with draggable nodes and edges drawn from each
step's outgoing fields, an inspector for the selected step, Validate, Publish, the version and cost cap),
and the **run view** (the graph read-only with each step's status, the run's cost against its cap, the
step list with model, time, cost and tool calls, the parsed values, the recent activity, links that open
each conversation, and Cancel / Retry from here / Approve / Reject).

## Tests

`npm test` here: the template filler, the validator, the engine against a fake kernel (a run through
prompt → parse → branch → loop → done with a model per step, a budget breach that nudges and then takes
`onBreach`, the cost cap, a follow-up on a parse miss, an approval, resume after a restart: a cut turn
goes on with no input, a turn that gave way waits for `turns.yielding`, a running turn is waited for and
never cancelled, a busy send takes the other turn's reply, a Retry after a reply sends the carry-on
message), and the socket.
