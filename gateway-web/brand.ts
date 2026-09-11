/** Fill the configured name and colour into the pages, styles and tab icon this gateway serves, before
 * the bytes leave; ADR 0005, ADR 0038 §4. */
import type { Rewrite } from '@/lib/assets/index.ts';
import type { Brand } from './index.ts';

/* The markers the served files carry, for reference when editing them: `{agent_name}` wherever the
 * agent is named, `{agent_accent}` wherever its colour is, `{agent_initial}` for the tab icon's letter.
 * Only the types listed in `filled` are opened as text, so a marker written into a .js file would be
 * served verbatim — scripts read the name out of the page instead, via `assets/lib/brand.js`. */
const filledTypes = ['text/html', 'text/css', 'image/svg+xml'];

/** Escape for both element text and a double-quoted attribute, since the name lands in each.
 *
 * A name is configuration rather than anything a person typed at this surface, so this guards against
 * a surprising character — the ampersand in "Ada & Co" — more than against an attacker. */
function escape(value: string): string {
  return value.replace(/&/gu, '&amp;').replace(/</gu, '&lt;').replace(/>/gu, '&gt;').replace(/"/gu, '&quot;');
}

/* A grapheme, not a code unit and not a code point: a name may begin with an emoji built from several
 * code points, or with a script whose letter carries a combining mark, and half of either is not a
 * letter. One segmenter, built once, because constructing one is not cheap. */
const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The letter drawn in the tab icon: the name's first character, capitalised. */
export function initial(name: string): string {
  return ([...graphemes.segment(name.trim())][0]?.segment ?? '?').toUpperCase();
}

/** The edit each served row needs, for `lib/assets`' `load`.
 *
 * Doing this once at startup rather than per request is the whole reason it is cheap: the branding
 * cannot change under a running process — the profile is read when it spawns — so a rewritten row is
 * hashed and measured once and then revalidates like any other file. */
export function filled(brand: Brand): Rewrite {
  const name = escape(brand.agentName); const accent = escape(brand.accent); const letter = escape(initial(brand.agentName));
  return asset => filledTypes.includes(asset.type)
    ? text => text.replace(/\{agent_name\}/gu, name).replace(/\{agent_accent\}/gu, accent).replace(/\{agent_initial\}/gu, letter)
    : undefined;
}
