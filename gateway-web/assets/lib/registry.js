/* The slot registry: what every package, the built-in one included, has declared and registered for each
 * UI slot. A slot entry exists from the moment a package's declaration arrives (so the rail button, the
 * panel nav item, the place link are drawn before the module loads) and gains its implementation when the
 * module registers it. Ids are `<package>#<id>`. A registration for an id the package never declared is
 * refused with a console message. A draw, mount, open or render that throws is caught and reported once
 * per package per slot, and the slot shows "<package> could not draw this". Transcript renderers are a
 * list: each may decline (return nothing), a broken one is skipped, and the transcript's own row is the
 * fall-through. Views watch the registry and redraw their slot when it changes. */

import { el } from "./dom.js";
import { toast } from "./toast.js";

/** The package name the shell registers its own pieces under. */
export const BUILTIN = "@thetis/gateway-web";

export const SLOTS = ["dock", "panel", "places", "sidebar", "chips", "composer", "shelf", "statusbar"];

const packages = new Map(); // package name -> { decl, failed: string | null, at: number }
const slots = new Map(SLOTS.map((slot) => [slot, new Map()])); // slot -> key -> entry
const renderers = []; // [{ package, render }]
const reported = new Set(); // "<package>/<slot>" already reported
const watchers = new Set();

export const keyOf = (pkg, id) => `${pkg}#${id}`;

function notify(change) {
  for (const fn of watchers) fn(change);
}

/** Declares a package's UI, from `api/ui` or the built-in's synthetic declaration. Entries appear in every slot at once. */
export function declare(extension) {
  const pkg = extension.package;
  if (packages.has(pkg)) return;
  packages.set(pkg, { decl: extension, failed: null, at: packages.size });
  for (const slot of SLOTS) {
    for (const decl of extension[slot] ?? []) {
      const id = slot === "sidebar" ? decl.slot ?? decl.id : decl.id;
      if (typeof id !== "string") continue;
      slots.get(slot).set(keyOf(pkg, id), { key: keyOf(pkg, id), package: pkg, id, decl, impl: null, order: typeof decl.order === "number" ? decl.order : 100 });
    }
  }
  notify({ kind: "declare", package: pkg });
}

export const declared = (pkg) => packages.get(pkg)?.decl ?? null;

/** Marks a package whose module did not load; its static entries stay, with a "could not load" tooltip. */
export function fail(pkg, message) {
  const record = packages.get(pkg);
  if (!record) return;
  record.failed = message || "could not load";
  notify({ kind: "fail", package: pkg });
}

export const failureOf = (pkg) => packages.get(pkg)?.failed ?? null;

/** Registers the implementation of a declared entry. Refused, with a console message, for an undeclared id. */
export function register(slot, pkg, id, impl) {
  const entry = slots.get(slot)?.get(keyOf(pkg, id));
  if (!entry) {
    console.error(`${pkg} registered ${slot} "${id}", which its declaration does not list; ignored.`);
    return false;
  }
  entry.impl = impl;
  notify({ kind: "register", slot, package: pkg, id });
  return true;
}

/** Every declared entry of a slot, by `order` (default 100), ties in declaration order. */
export function entries(slot) {
  const list = [...(slots.get(slot)?.values() ?? [])];
  return list.map((entry, at) => ({ entry, at })).sort((a, b) => a.entry.order - b.entry.order || a.at - b.at).map(({ entry }) => entry);
}

export const entry = (slot, key) => slots.get(slot)?.get(key) ?? null;

export function addRenderer(pkg, render) {
  renderers.push({ package: pkg, render });
}

/** Asks a package to redraw: a dock, chip or statusbar entry by id, or everything it registered. */
export function redraw(pkg, id) {
  notify({ kind: "redraw", package: pkg, id: id ?? null });
}

export function watch(fn) {
  watchers.add(fn);
  return () => watchers.delete(fn);
}

/**
 * Runs one of a package's callbacks. A throw is reported once per package and slot, on the console and as
 * a toast, and answers `{ ok: false }`; the caller shows `broken(pkg)` in the slot. `{ ok: true, value }` otherwise.
 */
export function guard(pkg, slot, fn, ...args) {
  try {
    return { ok: true, value: fn(...args) };
  } catch (err) {
    const tag = `${pkg}/${slot}`;
    if (!reported.has(tag)) {
      reported.add(tag);
      console.error(`${pkg} threw while drawing its ${slot}:`, err);
      toast(`${pkg} could not draw its ${slot}.`, { tone: "error" });
    }
    return { ok: false, error: err };
  }
}

/** What a slot shows in place of a package's piece that threw. */
export function broken(pkg) {
  return el("div", { class: "ext-broken" }, `${pkg} could not draw this`);
}

/**
 * Offers a transcript event to the registered renderers in order. A renderer answers a Node to draw,
 * `true` for "handled, nothing to draw", or nothing to decline. The first answer wins; a renderer that
 * throws is reported once and skipped. Returns the answer, or null when every renderer declined.
 */
export function renderTranscript(event, ctx) {
  for (const { package: pkg, render } of renderers) {
    const out = guard(pkg, "transcript", render, event, ctx);
    if (!out.ok) continue;
    if (out.value instanceof Node || out.value === true) return out.value;
  }
  return null;
}
