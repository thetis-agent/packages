/* The published API a contributed panel imports.
 *
 * A panel package ships an ES module under its own `/surface/<package>/` path and this is the only
 * thing it may import from the surface. Keeping the seam here rather than letting panels reach into
 * `views/*` means the surface can move its own internals without breaking a package it has never
 * heard of, and it is the boundary `contract/surface` describes in prose.
 *
 * Panels never touch the socket. They read frames the surface has already received, so a panel cannot
 * outlive its conversation and cannot see anything the person could not. The one thing a panel may
 * originate is `request` below, and it is not the socket: it is a verb its own package published in
 * its own manifest, which the host checks against that list, against the signed-in role and against
 * the conversation on screen before it forwards anything (ADR 0051, gateway-web/surface-request.ts).
 */

import { el, icon, clear } from "./dom.js";
import { Pending, packageOf } from "./requests.js";
import { store } from "./store.js";
import { section, collapsibleSection } from "../views/panel.js";
import * as rail from "../views/rail.js";

/** Requests sent and not yet answered; the bookkeeping and the caller attribution are in
 *  ./requests.js, apart from the DOM so both can be tested (see that file's own comment). */
const pending = new Pending();
/** app.js hands this module the one way it may send; until then a request is refused, not queued. */
let dispatch = null;

/** Registered transcript renderers, by event kind, in registration order. views/transcript.js
 *  consults these before its own table; lib/dispatch.js says how they are tried. */
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

/** Asks this panel's own package to do one thing it declared, for the conversation on screen.
 *
 * Resolves with `{ text, data }` — whatever the package answered — and rejects with a message the
 * panel may show the person as it is. Everything that decides whether this is allowed is checked by
 * the host: this function cannot name another package (./requests.js reads the call site rather than
 * taking the name), cannot name another conversation, and cannot send a verb the host has not
 * already read out of the package's own manifest.
 *
 * @param {string} verb  one of the verbs this package declared in its `surface` block
 * @param {object} [args]  arguments for it, as the package defines them
 * @returns {Promise<{text: string, data: object}>}
 */
export function request(verb, args = {}) {
  const name = packageOf(new Error().stack);
  if (!name) return Promise.reject(new Error("That panel is not allowed to do this."));
  if (!dispatch) return Promise.reject(new Error("Not connected — try again once the connection is back."));
  if (pending.full) return Promise.reject(new Error("Too much is happening at once. Try that again in a moment."));
  const current = store.current;
  if (!current) return Promise.reject(new Error("That conversation is not open any more."));
  return new Promise((resolve, reject) => {
    const id = pending.open(resolve, reject);
    if (dispatch({ type: "surface-request", request: id, id: current, package: name, verb, args })) return;
    pending.drop(id);
    reject(new Error("Not connected — try again once the connection is back."));
  });
}

/** Used by app.js to give this module the socket's send, without giving panels the socket. */
export function attach(send) {
  dispatch = send;
}

/** Used by app.js when an answer arrives; it settles the one request that asked, and no other. */
export function answer(frame) {
  pending.settle(frame);
}

/** Contributes a transcript row for one event kind. `render` returns a Node, or null to fall back.
 *
 *  More than one package may draw a kind: each is asked in turn and the first to return a node wins,
 *  so a package draws the rows that are its own and declines the rest. Returning null is how a
 *  contributor says "not mine", and it is the only reason two packages can share a kind at all. */
export function registerRenderer(kind, render) {
  const list = renderers.get(kind) ?? [];
  list.push(render);
  renderers.set(kind, list);
}

/** Used by views/transcript.js; not part of the panel-facing API. */
export function rendererFor(kind) {
  return renderers.get(kind) ?? [];
}

/** Calls `handler` for every frame of `kind` the surface receives, for any conversation. */
export function onEvent(kind, handler) {
  const list = watchers.get(kind) ?? [];
  list.push(handler);
  watchers.set(kind, list);
}

/** Used by app.js to fan a received frame out to whoever asked for it.
 *
 * Each watcher is isolated: one contributor throwing must not stop the frame reaching the others,
 * for the same reason a refused panel does not stop the surface starting. */
export function deliver(frame) {
  for (const handler of watchers.get(frame.kind) ?? []) {
    try { handler(frame); }
    catch (error) { console.error(`a contributed watcher for ${frame.kind} frames failed`, error); }
  }
}
