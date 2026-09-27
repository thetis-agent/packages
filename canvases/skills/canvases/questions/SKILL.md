---
name: questions
description: What to settle with the person before the first artboard, and how to ask it well with ask_user. Use when a canvas brief leaves two or more result-changing decisions open. One round of at most four questions, written from their brief, each with 2 to 4 concrete directions for this piece; when nobody can answer, decide and state the assumptions in a line.
metadata:
  title: Ask before you build
  tags: [canvas, questions, brief, ask, clarify, directions, options]
  related: [canvases, canvases/craft]
  version: 1
---
# Ask before you build

Only with the `ask_user` tool and a person there to answer. Otherwise (a workflow, an agent caller, "just make it") do what `canvases` says: decide, build, and state your assumptions in one line.

Read what they gave you first. A brief that still leaves two or more result-changing decisions open earns one `ask_user` call of at most four questions before your first write; one point you can default, a full brief, or a small revision earns none.

## Writing the questions

Write them from their material, not from a form: name what you read ("your notes cover four things"), the tension or gap in it, and the decision that would most change what you build, the most decisive first. A question only someone who read their brief could ask. Never ask what the chat already answers; default what the setting implies and say so; the stock intake questions (audience? length? screens or a flow?) only for a genuinely empty brief.

The options are the real work: 2–4 concrete directions for this piece ("lead with the templates", not "a narrative approach"), each on an axis you can name, never shades of one idea; a few words each that carry the choice; your pick first, marked "(recommended)", none on a question of fact. `allow_multiple: true` by default, since people answering are often still exploring; `false` only when the options exclude each other (one size, one format). No "other" or "you decide" option (the form has a free-text field of its own), and no question whose only answer is free text.

`ask_user` takes `{ intro?, questions: [{ id?, question, options?, allow_multiple? }] }`, each question under 500 characters with at most 12 options of 120. It answers with fixed text: end your turn with one short line saying you are waiting, and stop; the answers arrive as the next message.

Treat the answers as decisions and restate them in your one-line assumptions; whatever they leave to you, decide and say what you picked. One more round (at most four new questions) only if they ask for more or an answer opens a question you could not have asked before; otherwise build. Never re-ask.

## Questions for a canvas

Ask what the page, app or brief they gave you leaves open for this design: which job the screen does first when it could do several, who lands on it, what in their product to reuse or break from, which differences between artboards would help them choose. They name a product but attached nothing: ask for it (a link, a screenshot, the repository) rather than design blind. Nothing to match and no look implied: offer two or three concrete directions, or let 2–4 low-fi artboards ask it (`canvases/craft`, Variations). Screens or a flow: settle by what they said; with no signal, pick one and say so.

Say they linked their app's Projects page (dense 13 px tables, a "New project" button top right, an Import from GitHub flow two tabs over in Settings) and asked for "a better empty state for teams with no projects yet". A well-formed call:

```json
{ "intro": "Two things would change what I draw for the empty state.",
  "questions": [
    { "id": "path", "question": "New project already sits top-right and Import from GitHub lives in Settings. What should the empty state push people toward?",
      "options": ["Starter templates (recommended): three cards fill the empty table", "Import from GitHub: the Settings flow surfaces here", "Invite teammates: an inline invite field", "New project, centred: the existing button, moved centre"],
      "allow_multiple": true },
    { "id": "feel", "question": "The page is all business: tight tables, no illustration anywhere in the app. What may the empty state add?",
      "options": ["Stay in system (recommended): your table's type, one line icon", "One warm moment: a small illustration, only here", "A sample row: a faint example project row"],
      "allow_multiple": true },
    { "id": "scope", "question": "A new team hits two more empties right after this one (Members, API keys). Cover them so they read as a set?",
      "options": ["Projects only (recommended): three artboards of this screen", "All three empties: one direction carried across them"],
      "allow_multiple": false } ] }
```
