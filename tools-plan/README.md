# @thetis/tools-plan

A per-conversation todo list for the model and a structured way to ask the person clarifying questions, answered as a form on the gateway page. It is a `tool` package in the default `systemPackages["*"]`, so it runs in each person's fence. It is plain ECMAScript with no build step and no dependencies, and it carries its own browser files for the web gateway.

## What it provides

Six tools, declared in `thetis.tools`. Every `todo_*` tool returns the whole rendered plan, one item per line with its stage mark, then a tally of done, active and pending items:

| Tool | Arguments | Rule |
|---|---|---|
| `todo_write` | `items` (required): strings or `{ text, stage, note }` | Replaces the plan. Ids `t-1`, `t-2`, ... are minted by the tool and keep counting across writes, so a finished id never names a different line. At most 64 items; text is one line of at most 200 characters. |
| `todo_add` | `items` (required) | Appends. When the plan would exceed 64 items the call is refused; old items are never dropped. |
| `todo_mark` | `ids`, `stage` (required; `pending`, `active`, `done` or `dropped`) | Every id must exist. Only one item is active at a time: marking a second one active returns the previous one to pending, and the reply says so. |
| `todo_order` | `ids` (required) | The listed ids come first in that order; the rest keep their relative order after them. |
| `todo_read` | none | The plan as it is. |
| `ask_user` | `questions` (required, 1 to 4 of `{ id?, question, options?, allow_multiple? }`; at most 500 characters per question, 12 options of 120 characters), `intro` | Records the questions and returns fixed text telling the model to end its reply with one short line saying it is waiting, and stop. The answers arrive as the next user message. |

The web gateway UI, declared in `thetis.ui` (`dir: "ui"`, entry `index.js`, style `index.css`):

| Slot | Entry |
|---|---|
| Dock `todo` | Labelled **Todo**: the plan with a checkbox per item, which marks the item through the `mark` command. |
| Chip `todo` | The `todo done/total` chip in the chat bar; it opens the dock. |
| Command `plan` | `uiPlan`: answers the items and the done/total tally of the conversation on screen, as data. |
| Command `mark` | `uiMark`: takes `{ id, stage }`, validates it like `todo_mark`, writes the plan, and answers the plan it left. |

Both commands refuse when no conversation is open. The transcript folds every `todo_*` call into one quiet line and draws an `ask_user` call as a form: radios or checkboxes per question, a "Something else" text option, a free text area when there are no options, a Skip per question, and one Submit that sends one user message. A gateway that does not read the `ui` field (the CLI) sees only the tools.

Bench suites: `assembly-cost@1` and `tool-recall@1`, peer group `tools`. `BENCH.md` in this directory is the generated comparison.

No steps, no service.

## Configuration

`config.packages["@thetis/tools-plan"]` has no keys. The package reads no environment variables. State lives in the person's home, one file per conversation, written atomically: the plan at `plans/<session id>.json` and the questions at `questions/<session id>.json`.

## Use

Start a plan, then record progress:

```
todo_write { items: ["Read the failing test", { text: "Fix the parser", note: "the off-by-one in scan()" }, "Run the suite"] }
todo_mark { ids: ["t-1"], stage: "done" }
todo_mark { ids: ["t-2"], stage: "active" }
```

What comes back:

```
[x] t-1 Read the failing test
[>] t-2 Fix the parser — the off-by-one in scan()
[ ] t-3 Run the suite
1 done · 1 active · 1 pending
```

Ask before guessing:

```
ask_user { intro: "Two things before I start.", questions: [
  { id: "target", question: "Which package should the change go in?", options: ["@alice/notes", "a new package"] },
  { question: "Anything the tests must keep passing?" }
] }
```

## Files

| File | Content |
|---|---|
| `package.json` | The manifest: six tools, the `ui` block, the bench declaration. |
| `index.js` | Re-exports the tools and the two commands. |
| `lib/plan.js` | Minting ids, the 64-item cap, the single-active rule, rendering. |
| `lib/todo-tools.js`, `lib/ask-user.js`, `lib/ui-commands.js` | The tools and the commands. |
| `lib/store.js` | Atomic JSON files under `plans/` and `questions/`. |
| `ui/index.js`, `ui/plan-text.js`, `ui/ask.js`, `ui/index.css` | The dock, the chip, the transcript lines and the ask form. |
| `BENCH.md`, `bench/` | The generated benchmark view and reports. |

## Tests

`npm test` from the runtime root. The files are `test/todo.test.js`, `test/ask.test.js` and `test/ui-commands.test.js`, plain `node --test` files over a temporary directory.

See docs/20-tools.md in the runtime repository.
