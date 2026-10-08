---
name: canvases
description: How to build a canvas of HTML artboards with the canvas_* tools. Use when asked for a design, mockup, screen, poster or wireframe, and before writing or changing an artboard. What a canvas is, what the person edits themselves, the rules an artboard's HTML keeps (a fixed-size root, self-contained styles, assets by relative path, the props block), and the order of work.
metadata:
  title: Canvases
  tags: [canvas, artboard, design, mockup, wireframe, html, props, layout]
  related: [canvases/craft, canvases/questions, canvases/brand, canvases/print]
  version: 1
---
# Canvases

A canvas is a board the person opens from **Canvases** in the sidebar: artboards laid out on a pan-and-zoom surface, with sticky notes and titles between them, optionally grouped into pages. Each artboard is one self-contained HTML document you write, shown live in a sandboxed frame at the size of its frame. You make and revise canvases with the `canvas_*` tools from any conversation; the person pans, zooms, focuses one artboard, and edits the layout in place.

Say "canvas" and "artboard" with the person. A canvas belongs to a project or is global; `canvas_create` puts it in this conversation's project unless told otherwise.

This skill is the format. Its children carry the craft: `canvases/questions` (what to settle with the person before the first artboard), `canvases/craft` (designing well: the look, the system, variations, layout, accessibility, landing pages, phone screens, the content rules), `canvases/brand` (the Anthropic kit, only for Anthropic or Claude work) and `canvases/print` (posters, flyers, documents at paper sizes). Read `questions` and `craft` before anything more than a sketch.

## What the person changes themselves

On the canvas the person can move, resize and rename artboards, reorder them, add and edit notes, add pages, tweak the props an artboard declares, rename the canvas and move it between projects. All of that is in the index, not in your HTML. So:

- Before changing a canvas that has existed for a while, `canvas_read` it and keep what you find. Do not rewrite frames you were not asked to move.
- Change only what was asked. For a change smaller than a rewrite — a colour, a heading, one section — use `canvas_edit_board` with exact `old_text`/`new_text` pairs: it sends a few lines instead of the whole document. Replace a whole artboard (`canvas_write_board` with the same `file`) only when most of it changes; never rebuild the canvas. Either way the artboard keeps its frame and its prop overrides.
- Let `x`/`y` be placed for you unless you are arranging deliberately: a new artboard goes to the right of the last one on its page.

## An artboard's rules

1. Start with `<!doctype html>`, then `<html>`, `<head>` with `<meta charset="utf-8">` and a `<title>`, and `<body>`.
2. One root element, `<div id="board">`, sized exactly to the frame: `width: <w>px; height: <h>px; overflow: hidden; box-sizing: border-box`. Everything is inside it. For a page that scrolls, use `min-height` instead and give the frame `expand: "fill"`.
3. All CSS in one `<style>` in the head. No external stylesheets except Google Fonts (`<link href="https://fonts.googleapis.com/css2?family=…" rel="stylesheet">` is allowed). No other network: the frame refuses it, and a picture from the web shows as nothing.
4. Pictures, fonts and other files: store them first with `canvas_asset`, then reference them by relative path, `assets/<name>` — `<img src="assets/hero.png">`, `url(assets/pattern.svg)`, `@font-face { src: url(assets/Inter.woff2) }`.
5. Scripts are allowed but rarely needed; they run sandboxed with no network. Links do nothing (an artboard is a picture of a page), so do not build navigation between artboards.
6. Sizes: a phone screen is 390×844 (frame `radius: 40`), a desktop page 1440×900 (or 1280×800), a poster or social image its real pixel size. Text stays legible: body 14–16 px on a phone, never under 12 px.
7. No lorem ipsum, no invented numbers or names; a fact you do not have is a placeholder like `[PRICE]`. No emoji as icons: inline SVG.

## Props: levers the person can tweak

An artboard may declare props in a JSON block in its head:

```html
<script type="application/json" id="canvas-props">
{ "accent": { "editor": "color", "default": "#d97757", "label": "Accent" },
  "headline": { "editor": "text", "default": "Ship faster" },
  "dark": { "editor": "toggle", "default": false },
  "density": { "editor": "select", "default": "cozy", "options": ["compact", "cozy", "roomy"] },
  "columns": { "editor": "number", "default": 3, "min": 1, "max": 6, "step": 1 } }
</script>
```

Editors are `color`, `text`, `number`, `select` (with `options`) and `toggle`. The page shows one field per prop; the value reaches the artboard three ways, live:

- as a CSS custom property on the root: `color: var(--prop-accent)`;
- as an attribute on `<html>`: `html[data-prop-dark="true"] #board { background: #111 }`;
- as the text of any element with `data-prop="<name>"`: `<h1 data-prop="headline">Ship faster</h1>` (an `<img data-prop>` gets it as `src`).

Write the default into the markup too, so the artboard reads right on its own. Props are levers, not copy: a heading the person may retype is a `text` prop; a paragraph is just markup. Overrides the person sets are kept per artboard in the index (`boards[file].props`); you may set them with `props` on `canvas_write_board` or `canvas_layout`.

## Notes and pages

`canvas_layout` adds notes: a sticky (`{ x, y, text, w?, fill? }`, fills gray red orange green teal blue purple pink) for a remark beside an artboard, or a title (`{ x, y, text, kind: "title1", maxW? }`) for one bold line above a row of artboards — put it 120 px above the row. Pages (`pages: [{ id, name }]`) group artboards; an artboard or note without a `page` is on every page. `order` is back to front; the files you name go to the front.

## The order of work

1. `canvas_create` with a title (and pages, if the work has stages).
2. `canvas_asset` for any picture or font the artboards need.
3. `canvas_write_board` per artboard, in reading order; sizes and placement come for free.
4. `canvas_layout` for titles over rows, notes, the launch view (`{ view: "focused", file }` opens on one artboard).
5. Tell the person where it is: "It's in Canvases in the sidebar", and what you assumed.

To change one artboard later, `canvas_read` (with `sources: true, boards: [file]`) and `canvas_edit_board` the parts that change; `canvas_write_board` that file again only for a redesign.

## Example

A 390×844 phone screen with two props:

```html
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Welcome</title>
<link href="https://fonts.googleapis.com/css2?family=Fraunces:wght@600&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<script type="application/json" id="canvas-props">
{ "accent": { "editor": "color", "default": "#2563eb", "label": "Accent" },
  "headline": { "editor": "text", "default": "Welcome back" } }
</script>
<style>
  body { margin: 0; font-family: Inter, system-ui, sans-serif; color: #141413; }
  #board { width: 390px; height: 844px; overflow: hidden; box-sizing: border-box; padding: 72px 24px 32px; background: #faf9f5; display: flex; flex-direction: column; gap: 16px; }
  h1 { font-family: Fraunces, Georgia, serif; font-size: 34px; margin: 0; }
  .cta { margin-top: auto; padding: 16px; border: 0; border-radius: 12px; background: var(--prop-accent, #2563eb); color: #fff; font: 600 16px Inter, sans-serif; }
</style>
</head>
<body>
<div id="board">
  <h1 data-prop="headline">Welcome back</h1>
  <p>Pick up where you left off.</p>
  <button class="cta" type="button">Continue</button>
</div>
</body>
</html>
```

Written with `canvas_write_board { canvas, file: "Welcome.html", html, w: 390, h: 844, radius: 40, title: "Welcome" }`.
