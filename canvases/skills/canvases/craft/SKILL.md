---
name: craft
description: Designing well on a canvas. Use when a canvas is more than a sketch, before its first artboard, or when the person pushes back on a design call. Settling the look with the person, the small system to commit to (type, neutrals, accents), options as artboards, layout that survives editing, accessibility as drawn, landing pages, phone screens, recreating a UI, and the content rules.
metadata:
  title: Designing well
  tags: [canvas, design, craft, typography, color, layout, accessibility, landing-page, mobile, mockup, wireframe]
  related: [canvases, canvases/questions, canvases/brand, canvases/print]
  version: 1
---
# Designing well

The `canvases` skill carries the format; this is the reasoning behind a good canvas. Read the sections a piece needs.

## Settle the look with the person, not for them

Without a look, references or a design system from the person, get their input before committing: ask (`canvases/questions`), or sketch 2–4 genuinely different low-fi direction artboards they can see. Picking your own aesthetic in silence is how a canvas turns generic. A concrete subject, an asset or a brand is input; with nobody to ask, commit to one nameable direction and say so rather than ending on a question. Once settled, a decision stays settled.

Then commit to a small system:

- **A type pairing.** Google Fonts loads in an artboard (one `fonts.googleapis.com/css2?family=…&display=swap` link in the head; no other font host does). 1–3 families, each with a system fallback of close metrics. A characterful display face over a refined body face; a utility face for data if the piece needs one.
- **Ground.** A tone (warm, cool, neutral) and subtly toned whites and blacks: a pure mid-grey looks unconsidered, a grey with a slight bias toward the accent looks meant. Pure white and near-black are fine when the subject wants them, chosen rather than inherited.
- **Accents.** 0–2, sharing chroma and lightness, varying hue. Prefer the brand's or the design system's colors; derive harmonious colors from them rather than inventing new ones. Semantic color (good, warning, critical) is separate from the accent and does not count as one.

## When no brand or design system governs

Commit to a bold direction before building:

- **Purpose.** What problem does this design solve, and for whom?
- **Tone.** Pick an extreme and mean it: brutally minimal, maximalist, retro-futuristic, organic, luxury, playful, editorial, brutalist, art deco, soft pastel, industrial. Use these as inspiration and design one that is true to itself.
- **Differentiation.** What is the one thing someone will remember?

Maximalism and refined minimalism both work; the key is intention, not intensity. Execute with precision: distinctive typography (never Arial or Inter as the face of the piece), a dominant color with sharp accents over a timid even spread, one well-orchestrated moment of motion over scattered effects (CSS in the artboard), composition that dares (asymmetry, overlap, diagonal flow, generous space or controlled density), and atmosphere in the ground (texture, pattern, layered transparency, a considered shadow) rather than flat defaults. Vary between light and dark, between faces, between aesthetics: never converge on the same choices canvas after canvas. Match the implementation to the vision: a maximalist piece needs elaborate effects, a minimalist one needs restraint and exact spacing.

## Ground it in the subject

Distinctive choices come from the subject's own world: its materials, instruments and vernacular. Put at least one detail only this subject would have into the content (its real units, its document conventions, its terms of art). Use real content throughout. Structure is information: numbering, eyebrows, dividers and labels encode something true about the content or they are decoration; number steps only when the order matters.

## Hi-fi mockups are rooted in context

A good hi-fi design starts from what exists: the person's repository, brand assets, screenshots of the product, a design system they attached. Spend time acquiring that context and ask for it when you cannot find it. Mocking a whole product from nothing is a last resort and reads as one. State your assumptions and reasoning early, and show work as soon as there is something to react to. Missing an icon, an asset or a component: draw a labelled placeholder; in hi-fi work a placeholder beats a bad attempt at the real thing.

## Variations and options on the canvas

The canvas is built for exploring options; use it deliberately:

- When a direction is still open (the overall direction, the hero, the type pairing, the color stance, the density), settle it before building the deliverable. Offer 2–4 genuinely different candidates, each on an axis you can name ("Warm editorial" against "Dense data-first"); five shades of one idea is no choice. Decision fidelity is not deliverable fidelity: low-fi sketch artboards are enough to pick.
- Give each option an honest motivation and its main tradeoff in your reply, not on its artboard. A set where only your favourite gets a case made is a rigged vote.
- Keep option names stable. Once an artboard is "Option B" or "Warm editorial" it keeps that name; never renumber across turns.
- When the direction is settled and the person wants variations to keep, give three or more across several dimensions, by-the-book beside novel; remix the brand's visual DNA (scale, fills, texture, rhythm, layering, type). Atomic variations they can mix, not the one perfect option.
- For early exploration, wireframe: breadth over polish, 3–5 distinct approaches per idea, simple shapes, placeholder text, minimal color, focused on structure and flow.
- Lay a row of options under one title note (`kind: "title1"`), 80 px apart, and name each artboard (`title`).

## Layout that survives editing

The person drags, resizes and retypes on the canvas, and you replace one artboard at a time. Lay out sibling groups (buttons, chips, nav items, cards, toolbars) with `display: flex` or `grid` plus `gap`, never with inline siblings spaced by whitespace or per-element margins that collapse or double. Inline flow is for runs of text with a link or an emphasis inside a sentence. Make repeated elements consistent: the same edges, baselines and inner padding on every card in a row, any recurring element in the same place on each. Let content set a container's height; pick a column count the items fill. Text that can outgrow its track wraps or scrolls in its own container; clipped text is a bug. Use card styling selectively, by role: a border, a fill, a radius and a shadow each mark an element as a separate object, and giving them to every block flattens the hierarchy. Digits in columns get `font-variant-numeric: tabular-nums`. Headings get `text-wrap: balance`, body `text-wrap: pretty`, uppercase labels a little letter-spacing.

## Scales and accessibility, as drawn

In mockup content, hit targets are never under 44 px; print body type never under 12 pt; text is sized for its real viewing distance. Draw controls with the real elements even in a static mockup: `<button>`, `<a href>`, `<input>` with a `<label>`. A `div` with a `role` looks the same but Tab skips it and a screen reader has nothing to say. Give an icon-only button an `aria-label`. Text keeps 4.5:1 against what is behind it (3:1 from 24 px); what fails most is caption grey and colored fills under white text, so darken both. Colors that must be told apart also differ in lightness, not hue alone; prefer blue and orange to red and green. Charts are drawn to one scale, every label names a value the chart reaches, and marks stay clear of each other and inside the drawing.

## Landing pages and marketing artboards

Marketing-page anatomy: a hero that states the offer in one sentence with one clear call to action; proof the visitor can trust (testimonials, logos, numbers, from the person's material or visibly marked placeholders); benefit sections that answer a visitor's real doubts rather than listing features. One primary action per page, repeated down it, not three competing buttons. The copy is the product: write it from what the person told you, their product, their customers, their voice. Never "Welcome to our website", never filler that could describe any business. A missing fact (a price, a date, an address) is a marked placeholder like `[YOUR PRICE]`, never an invention. Design a phone width as you go: no headlines that break badly, no squashed grids, no text too small to read.

## Phone screens

390×844 with `radius: 40` on the frame. No fake chrome: do not draw an iOS status bar (the "9:41 · battery · wifi" strip) or a keyboard; on a real phone the real ones render over the layout, and a painted one looks doubled up. Leave that space alone. Body 14–16 px; targets 44 px.

## Recreating an existing UI

When the source is reachable (a repository, pasted files, a design system), build from it, not from memory of the app: read the components and styles, copy the assets the page really loads, and copy exact values (paddings, radii, sizes, line-heights) rather than snapping them to a grid or a framework default. Screenshots are high-level guidance beside source. Without source, say so rather than inventing. And do not recreate another company's distinctive UI, command structure or branded elements unless the person tells you they work there; help them make an original design instead.

## Content rules that always hold

- **No filler.** No placeholder prose, dummy sections or stats added to fill space; a thin section is a layout problem, not a content gap. Less is more.
- **Ask before adding material.** More sections, pages or copy that would help: ask first; the person knows their audience.
- **Targeted changes stay targeted.** Asked for one text, one color, one element: change only that and leave every other position, size, font and color alone. A redesign is a different request. A broader change you would recommend: finish the small one, then suggest it.
- **Follow an existing design's vocabulary.** Adding to an existing UI or document, match its copy style, palette, states, shadows, density.
- **No AI tropes.** Gradient washes, emoji as icons or markers, rounded cards with a colored left border, everything centred, Inter, Roboto, Arial or Fraunces as the face, warm cream with terracotta as the reflex palette, a purple-to-blue hero. When the person asks for one of these, their words win; when nothing is specified, do not spend the freedom on a default.
- **Write like a person.** Name things by what people recognise, in active voice; a control says exactly what it does. No mannered devices: asides set off by dashes, "not X but Y", colon-then-reveal, scare quotes, "worth noting".
