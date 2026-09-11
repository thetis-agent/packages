/* A face per turn, in the gutter beside the conversation.
 *
 * Every turn gets a small square tile outside the text column — the agent's in
 * the left gutter, the reader's in the right — so a long transcript can be
 * skimmed by picture rather than by reading each message to work out who is
 * speaking. Placing them is app.css's job (`.turn-avatar`); nothing here
 * measures or positions anything.
 *
 * The tiles are drawn, not fetched. The legacy surface kept an uploaded picture
 * in a key-value store the host offered; this runtime has no such store, and
 * inventing one to hold a 44-pixel thumbnail would mean deciding where a
 * person's bytes live, who may read them and who reaps them — a real feature,
 * not a detail of a chat window. So a tile is a letter on a colour worked out
 * from the name itself: no round trip, nothing to 404, and the same person is
 * the same colour in every conversation on every device, because the name is
 * the only input.
 *
 * `pictureFor` is the single place a stored picture would arrive. It answers
 * "nothing" today and every caller already draws the letter when it does, so
 * the day there is somewhere to keep pictures, that function is the change.
 */

import { el } from "./dom.js";

/** Tile colours. Fixed saturation and lightness so every face sits at the same
 *  weight against the transcript and only the hue tells them apart. */
const TINT = { saturation: 46, lightness: 46 };

/** FNV-1a over the name's code units. Any cheap, stable, well-spread hash would
 *  do; what matters is that it is computed here rather than handed out, so two
 *  browsers showing the same conversation agree without being told. */
function hashOf(text) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

/** The colour a name is drawn on: one hue off the hash, the rest held steady. */
export function tintOf(name) {
  const hue = hashOf(String(name || "").trim().toLowerCase()) % 360;
  return `hsl(${hue} ${TINT.saturation}% ${TINT.lightness}%)`;
}

/* A grapheme, not a code unit: a name may begin with an emoji built from
 * several code points, or with a script whose letter carries a combining mark,
 * and half of either is not a letter. Built once — constructing one is not
 * cheap and this runs per row. */
const graphemes = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function firstLetterOf(word) {
  return [...graphemes.segment(word)][0]?.segment || "";
}

/** Up to two letters: the first of the first word and the first of the last, or
 *  just the one when there is a single word. */
export function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const last = words.length > 1 ? firstLetterOf(words[words.length - 1]) : "";
  return (firstLetterOf(words[0]) + last).toUpperCase();
}

/* The seam. A stored picture would be looked up here — by name today, by
 * whatever a real store keys on later — and returned as a URL the tile shows
 * instead of the letters. Nothing stores one yet, so this answers null and
 * every tile falls through to the drawn face. */
export function pictureFor(_name) {
  return null;
}

/**
 * One turn's tile.
 *
 * @param {"agent"|"person"} side  which gutter it belongs in
 * @param {string} name  who is speaking, for the letters and the colour
 */
export function avatarFor(side, name) {
  const label = String(name || "").trim();
  const tile = el("span", {
    class: `turn-avatar is-${side}`,
    role: "img",
    "aria-label": label || undefined,
    title: label || undefined,
  });
  /* Only a person's tile is given a colour here. The agent's comes from the
   * stylesheet, which already holds the configured accent and already darkens
   * it for a light-mode browser — handing it the raw colour instead would put
   * the dark palette's pale blue on a near-white tile, which is the reading
   * this was first drawn with and could not be read.
   *
   * Through CSSOM, never a style= attribute: the page's policy drops those, so
   * a per-tile colour written into markup would silently not apply. */
  if (side !== "agent") tile.style.setProperty("--avatar-tint", tintOf(label));

  const picture = pictureFor(label);
  if (picture) {
    const image = el("img", { class: "turn-img", alt: "", decoding: "async", src: picture });
    const letters = el("span", { class: "turn-initial" }, initialsOf(label));
    letters.hidden = true;
    // A stored picture can 404 or turn out not to be one. Falling back to the
    // letters beats leaving a broken-image glyph where a face should be.
    image.addEventListener("error", () => { image.hidden = true; letters.hidden = false; });
    tile.append(image, letters);
    return tile;
  }
  tile.append(el("span", { class: "turn-initial" }, initialsOf(label)));
  return tile;
}
