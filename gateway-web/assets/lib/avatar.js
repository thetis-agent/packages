/* A face per turn: the picture the person uploaded (or, for the agent, the one an admin chose), or, when there
 * is none, letters on a colour worked out from the name, so the same person is the same colour everywhere. */

import { el } from "./dom.js";

function hashOf(text) {
  let hash = 0x811c9dc5;
  for (let at = 0; at < text.length; at++) {
    hash ^= text.charCodeAt(at);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}

export function tintOf(name) {
  const hue = hashOf(String(name || "").trim().toLowerCase()) % 360;
  return `hsl(${hue} 46% 46%)`;
}

export function initialsOf(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "?";
  const last = words.length > 1 ? words[words.length - 1][0] : "";
  return (words[0][0] + last).toUpperCase();
}

/* What goes inside a tile: the picture when there is one, the letters otherwise. The tint stays set either
 * way, so a picture that is still loading — or one the server has since dropped — shows the colour the
 * letters would have had rather than a hole. The `alt` is empty on purpose: the tile itself is the image,
 * and it already carries the name as its label, so a screen reader that read both would say it twice. */
function paint(tile, label, image) {
  tile.replaceChildren(image ? el("img", { class: "turn-img", src: image, alt: "" }) : el("span", { class: "turn-initial" }, initialsOf(label)));
}

/**
 * @param {"agent"|"person"} side
 * @param {string} name
 * @param {string|null} [image] the URL of the picture: the person's own, or the agent's an admin chose
 */
export function avatarFor(side, name, image) {
  const label = String(name || "").trim();
  const tile = el("span", { class: `turn-avatar is-${side}`, role: "img", "aria-label": label || undefined, title: label || undefined });
  if (side !== "agent") tile.style.setProperty("--avatar-tint", tintOf(label));
  paint(tile, label, image);
  return tile;
}

/**
 * Puts the agent's name and picture on every agent tile already on the page, after an admin renamed it or
 * gave it a picture: a transcript builds each row once, so without this the replies already on screen would
 * go on showing the old face until something redrew them.
 * @param {string} name
 * @param {string|null} image
 */
export function repaintAgentAvatars(name, image) {
  for (const tile of document.querySelectorAll(".turn-avatar.is-agent")) {
    tile.setAttribute("aria-label", name);
    tile.title = name;
    paint(tile, name, image);
  }
}

/**
 * Puts a new picture on every person tile already on the page. A transcript builds each row once and keeps
 * it, so without this the person who just chose a picture would see it in the footer and go on seeing their
 * initials beside their own turns until something redrew them. Every `is-person` tile on the page belongs to
 * the one person signed in — the shell draws no one else's face — so they all change together.
 * @param {string|null} image
 */
export function repaintPersonAvatars(image) {
  for (const tile of document.querySelectorAll(".turn-avatar.is-person")) paint(tile, tile.getAttribute("aria-label") || "", image);
}
