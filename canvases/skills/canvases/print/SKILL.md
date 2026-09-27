---
name: print
description: Print pieces on a canvas at real paper sizes in CSS px. Use when a poster, flyer, brochure, certificate, résumé, memo or report is asked for, before its first artboard. The sheets and units, fixed pages against running documents, a multi-page piece as a series of artboards, and the type, table and ink rules that survive paper.
metadata:
  title: Print pieces
  tags: [canvas, print, poster, flyer, brochure, document, report, letter, a4, pdf]
  related: [canvases, canvases/craft]
  version: 1
---
# Print pieces

A printed piece is designed at its real size. Decide the sheet before the first artboard; if the brief does not say and someone can answer, ask in plain terms ("what size? one designed page each, or running text?"). Nobody to ask: a document runs at Letter or A4, everything else is a fixed page on Letter or A4. The canvas has no PDF export of its own yet; the person prints from the focused artboard or takes it on from there, so what you draw is what they get.

## Sheets and units (CSS px at 96 px per inch)

- Letter 816×1056 · A4 794×1123 · landscape swaps them. Letter for North American readers, A4 for anyone clearly metric; unsure, Letter.
- Legal 816×1344 · Tabloid 1056×1632 · A5 559×794 · A3 1123×1587 · a poster at a size the person gave is inches × 96 (18×24 in is 1728×2304; a side at most 8000). No size given: design it on Letter or A4, never an invented sheet.
- 1 in = 96 px · 1 pt = 4/3 px (12 pt = 16 px, 9 pt = 12 px) · 0.75 in = 72 px · 1 mm ≈ 3.78 px. Write px; think in points and inches. Never `vh`, `vw` or window percentages: the frame is the paper.

## Fixed pages

- The root element is fixed to the frame's `w`×`h` and fills the page; anything past an edge is lost. Budget heights before writing.
- Pages are full-bleed: a background may run to the edge, content may not. Keep at least 40 px clear inside every edge, 72 px (0.75 in) around running text.
- A multi-page piece is a series of artboards, one per page, in reading order (left to right, then the next row) on its own canvas page, with nothing else on that page. Page numbers, running heads and a letterhead are drawn on each artboard.
- A two-sided flyer is two artboards. A trifold is two artboards of three panels: the outside face is inside flap, back cover, front cover (rightmost); the inside face is one spread read left to right, written in the order the reader unfolds it (the cover promises, the inside delivers in three beats, the back carries logistics and contact).

## Documents (running text)

- `w` 816 (Letter) or 794 (A4), portrait; the root `width` is `w`, its height the content's, and the frame gets `expand: "fill"` so it grows with the text. Pad the root 72 px all round: that padding is the printed margin. Set the paper color on `body`.
- One column of running text. Side-by-side columns and CSS `columns` only inside a block shorter than a page.
- Place photos as `<img>`, never as a background, and keep each figure with its caption well under a page. Nothing repeats per page; nothing is `position: fixed` or `sticky`.

## Type, tables, ink

- A document opens with its own `<h1>` (no separate masthead), then a clear h2/h3 ladder; body 16 px (12 pt) at line-height 1.5–1.65, a measure of 60–75 characters; captions and footnotes at least 12 px (9 pt), nothing smaller. `text-wrap: balance` on headings, `pretty` on body.
- Tables: a header row, rules of at least 1 px (finer hairlines vanish on paper), numbers right-aligned; figures and code blocks carry a one-line caption.
- Ink: body near-black on light stock; no huge dark floods; no grey text lighter than `#767676`; strokes at least 1 px; it must still read in grayscale.
- A flyer is read from across a room in three seconds: one dominant line (at most six words, 80 px or 60 pt and up), everything else clearly subordinate; the five Ws (what, when, where, cost, one way to act: a short URL, a phone number, an optional tear-off fringe of dashed cells) grouped tight, not spread through prose; flat color blocks and vector shapes over photos and gradients; cut copy until the hierarchy is unmissable.
