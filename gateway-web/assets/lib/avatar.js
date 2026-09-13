/* A face per turn: letters on a colour worked out from the name, so the same person is the same colour everywhere. */

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

/** @param {"agent"|"person"} side */
export function avatarFor(side, name) {
  const label = String(name || "").trim();
  const tile = el("span", { class: `turn-avatar is-${side}`, role: "img", "aria-label": label || undefined, title: label || undefined });
  if (side !== "agent") tile.style.setProperty("--avatar-tint", tintOf(label));
  tile.append(el("span", { class: "turn-initial" }, initialsOf(label)));
  return tile;
}
