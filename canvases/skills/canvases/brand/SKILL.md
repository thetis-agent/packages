---
name: brand
description: The Anthropic brand kit for artboards that carry the Claude or Anthropic look. Use when the person asks for Anthropic or Claude branding, and only then; every other canvas gets its own look. Ivory, Slate and Clay, the warm grayscale, the secondary and tertiary scales, the serif-over-sans type stacks and scale, the mark rules.
metadata:
  title: The Anthropic brand kit
  tags: [canvas, brand, anthropic, claude, colors, typography, ivory, slate, clay]
  related: [canvases, canvases/craft]
  version: 1
---
# The Anthropic brand kit

For artboards that are Anthropic or Claude work, and for nothing else. Values go into the artboard's own `<style>`; the font stacks are written as given, with their fallbacks, since the Anthropic faces are not bundled and the fallback renders where they are not installed. Source: the design team's kit (colors and typography, December 2025).

## Colors

**Primary.** Most surfaces are just these two.

| Name | Hex | Use |
|---|---|---|
| Ivory | `#FAF9F5` | The page and artboard ground. Never pure `#FFF` for a whole page. |
| Slate | `#141413` | Text, dark surfaces. |

Content surfaces (cards, panels) sit as `#FFFFFF` on Ivory. Tinted hover and selected surfaces: `rgba(115,114,108,0.1)`. Borders derive from Slate at low opacity, `0.5px solid rgba(31,30,29,0.15)` by default and `rgba(31,30,29,0.3)` stronger; never colored borders for structure.

**Claude system.** Claude primary, Clay, the Spark's color: `#D97757`, the single emphasis color on Claude surfaces. Claude accent, Oat: `#E3DACC`, subtle fills and dividers. Main accent, Blue: `#2A78D6`, the primary accent for actions that are not Claude's.

**Secondary, prismatic** (illustration and composition, not UI chrome). Strong: Fig `#C46686`, Sky `#6A9BCC`, Olive `#788C5D`, Clay `#D97757`. Subtle: Coral `#EBCECE`, Heather `#CBCADB`, Cactus `#BCD1CA`, Oat `#E3DACC`.

**Warm grayscale**, black to white, 21 steps: `#000000` 1000 · `#141413` 950 (Slate) · `#1A1918` 900 · `#1F1E1D` 850 · `#262624` 800 · `#30302E` 750 · `#3D3D3A` 700 · `#4D4C48` 650 · `#5E5D59` 600 · `#73726C` 550 · `#87867F` 500 · `#9C9A92` 450 · `#B0AEA5` 400 · `#C2C0B6` 350 · `#D1CFC5` 300 · `#DEDCD1` 250 · `#E8E6DC` 200 · `#F0EEE6` 150 · `#F5F4ED` 100 · `#FAF9F5` 050 (Ivory) · `#FFFFFF` 000. These are warm greys; never substitute a cool or neutral ramp.

**Tertiary scales** (marketing, slides, charts; not product UI). Nine-step scales exist for orange, yellow, green, aqua, blue, violet, magenta and red; the 500 anchors: orange `#D97757`, yellow `#C9A82D`, green `#558A42`, aqua `#2E9191`, blue `#6A9BCC`, violet `#6B4D9E`, magenta `#A64D87`. For charts and illustration accents only; product-looking UI stays in the primary and grayscale system.

## Typography

Stacks, written as given:

- Sans (UI text, labels, body): `'Anthropic Sans', system-ui, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif`
- Serif (display headings, the editorial voice): `'Anthropic Serif', Georgia, 'Times New Roman', Times, serif`
- Mono (code): `'Anthropic Mono', 'JetBrains Mono', 'SF Mono', Monaco, 'Courier New', monospace`

Both Anthropic Sans and Serif are variable, weight 300–800.

| Role | Family | Size | Weight | Line height |
|---|---|---|---|---|
| Display (hero) | Serif | 38px | 330 | 1.2 |
| Title | Serif | 28px | 500 | 1.3 |
| Heading | Serif | 24px | 500 | 1.3 |
| UI XL | Sans | 20px | 400 | 1.4 |
| Body | Sans | 16px | 400 | 1.5 |
| Small, labels | Sans | 14px | 400 | 1.4 |
| Caption | Sans | 12px | 400 | 1.35 |

Letter-spacing stays 0: the look comes from the warm palette, generous whitespace and serif display over sans body, not from tracking. Headings in the serif at moderate weights (330–500), never faux-bold. Arial and Helvetica appear only inside the fallback stacks.

## The marks

Where the design carries the Claude or Anthropic marks: the Claude Spark appears once per surface, never rotated, distorted or in a lockup; the Claude logo is dark on light and light on dark, with clearspace, at its native aspect ratio; Claude and Anthropic marks appear in sequence, never combined. Store the mark files with `canvas_asset` and reference them as `assets/<name>`; without the files, draw a labelled placeholder rather than an approximation.
