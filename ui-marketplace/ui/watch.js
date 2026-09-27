/* When things change under the person. While the Extensions place is open, what they have can change without
 * them: an admin removes an extension for them, or installs one. Every view of the place reads the rows again
 * now and then (every half minute, when a reply ends, when the tab comes back into view) and after a failed
 * action, and hands them to `observe`, which compares what is installed with what the place saw last and
 * answers one line per difference, in the journal's words when the journal knows who did it: "bitmuse removed
 * Exa Web Search for you." The place's own acts say `expectChange()` first, so what the person did themselves is
 * never announced back to them. What was seen is kept for the page's life, across the place's views, so a
 * change between two views is caught by the second. */

import { labelOf } from "./state.js";

/** name -> label of what the place saw installed; `complete` once a whole list was seen, not one page's family. */
let known = null;
let complete = false;
let expecting = false;

/** The place is about to change what the person has itself: the next difference is theirs, and not said. */
export const expectChange = () => {
  expecting = true;
};

/** An act failed: whatever differs now was not the person's doing. */
export const unexpectChange = () => {
  expecting = false;
};

/** Forgets what was seen, for the tests. */
export const resetWatch = () => {
  known = null;
  complete = false;
  expecting = false;
};

/** One line for one difference, from the latest journal row about it by somebody else, when there is one. */
function said(kind, name, label, changes) {
  const by = [...(changes ?? [])].reverse().find((c) => c.name === name && c.kind === kind);
  if (kind === "uninstall") return by ? `${by.actor} removed ${label} for you.` : `${label} is no longer installed for you.`;
  return by ? `${by.actor} installed ${label} for you.` : `${label} is now installed for you.`;
}

/**
 * Compares the rows with what was seen and answers the lines to say, `[]` when nothing changed or the change was
 * expected. `only` narrows the comparison to some names (a page knows its family, not every row).
 */
export function observe(rows, { changes = [], only = null } = {}) {
  const installed = new Map((rows ?? []).filter((r) => r?.installed && (!only || only.has(r.name))).map((r) => [r.name, labelOf(r)]));
  const names = only ? [...only] : [...new Set([...(known?.keys() ?? []), ...installed.keys()])];
  const lines = [];
  if (known && !expecting) {
    for (const name of names) {
      const was = known.has(name);
      const is = installed.has(name);
      // A name never seen before says nothing unless a whole list was seen: it may simply not have been looked at.
      if (was && !is) lines.push(said("uninstall", name, known.get(name), changes));
      else if (!was && is && complete) lines.push(said("install", name, installed.get(name), changes));
    }
  }
  if (!known) known = new Map();
  if (only) {
    for (const name of only) {
      if (installed.has(name)) known.set(name, installed.get(name));
      else known.delete(name);
    }
  } else {
    known = installed;
    complete = true;
  }
  expecting = false;
  return lines;
}

/**
 * Runs `fn` now and then while a view is open: every `ms`, when the person's replies end, and when the tab comes
 * back into view. Answers the function that stops it.
 */
export function every(ext, fn, ms = 30_000) {
  const stops = [];
  const t = setInterval(fn, ms);
  stops.push(() => clearInterval(t));
  // Each time the person's replies end: an admin's change is often made while they wait for one.
  const off = typeof ext.turns?.onIdle === "function" ? ext.turns.onIdle(fn) : null;
  if (typeof off === "function") stops.push(off);
  const visible = () => {
    if (document.visibilityState === "visible") fn();
  };
  document.addEventListener("visibilitychange", visible);
  stops.push(() => document.removeEventListener("visibilitychange", visible));
  return () => stops.forEach((s) => s());
}
