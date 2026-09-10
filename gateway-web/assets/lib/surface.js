/* The published API a contributed panel imports.
 *
 * A panel package ships an ES module under its own `/surface/<package>/` path and this is the only
 * thing it may import from the surface. Keeping the seam here rather than letting panels reach into
 * `views/*` means the surface can move its own internals without breaking a package it has never
 * heard of, and it is the boundary `contract/surface` describes in prose.
 *
 * Panels never touch the socket. They read frames the surface has already received, so a panel cannot
 * invent traffic, cannot outlive its conversation, and cannot see anything the person could not.
 */

import { el, icon, clear } from "./dom.js";
import { store } from "./store.js";
import { section, collapsibleSection } from "../views/panel.js";
import * as rail from "../views/rail.js";

/** Registered transcript renderers, by event kind. views/transcript.js consults this first. */
const renderers = new Map();
/** Handlers watching a frame kind, in registration order. */
const watchers = new Map();

export { el, icon, clear, section, collapsibleSection };

/** The conversation on screen, and a way to be told when it changes. */
export const conversation = {
  get current() { return store.current; },
  watch(handler) { store.watch("current", handler); },
};

/**
 * Contributes an inspector tab. `draw` is called when the tab is activated and whenever the panel
 * asks to redraw; it returns the same config `rail.open` takes, minus the id.
 */
export function registerPanel({ id, label, hint, wide, icon: drawIcon, draw }) {
  const tab = {
    id, label, hint, wide,
    icon: drawIcon,
    activate: () => rail.open({ id, ...draw() }),
  };
  rail.addTab(tab);
  return { redraw: () => { if (rail.isOpen(id)) tab.activate(); } };
}

/** Contributes a transcript row for one event kind. `render` returns a Node, or null to fall back. */
export function registerRenderer(kind, render) {
  renderers.set(kind, render);
}

/** Used by views/transcript.js; not part of the panel-facing API. */
export function rendererFor(kind) {
  return renderers.get(kind);
}

/** Calls `handler` for every frame of `kind` the surface receives, for any conversation. */
export function onEvent(kind, handler) {
  const list = watchers.get(kind) ?? [];
  list.push(handler);
  watchers.set(kind, list);
}

/** Used by app.js to fan a received frame out to whoever asked for it. */
export function deliver(frame) {
  for (const handler of watchers.get(frame.kind) ?? []) handler(frame);
}
