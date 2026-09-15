/* The seam between the shell and a package's UI: the one object an extension module receives as the
 * argument of its default export, `install(ext)`. Everything it can do goes through here, bound to the
 * package it was made for, so a module can never name another package. It never sees the store, the API
 * module, the event stream or the views. Registrations are checked against the package's declaration by
 * the registry; requests go to `api/ext/<package>/<verb>`; the conversation and session facts come from
 * the store through narrow readers; `send` travels the composer's own path, so the pending row and the
 * failure handling apply to an ask form's answers as they do to a typed message. `bindShell` is called
 * once by app.js with the shell functions; `broadcastTurn` feeds every `events.watch` listener. */

import { api } from "./api.js";
import { clear, el, icon, setHidden } from "./dom.js";
import { renderMarkdown } from "./markdown.js";
import * as ui from "./panel-ui.js";
import * as registry from "./registry.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

let shell = null; // { send, openConversation, openDock, openPlace, openShelf, openPanel }
const turnWatchers = new Set();

/** Hands the shell's functions to the seam. Called once, before any extension loads. */
export function bindShell(functions) {
  shell = functions;
}

/** Every turn message off the event stream, for every session, to every `events.watch` listener. */
export function broadcastTurn(message) {
  for (const fn of turnWatchers) {
    try {
      fn(message);
    } catch (err) {
      console.error("an events.watch listener threw:", err);
    }
  }
}

const DOM = Object.freeze({ el, icon, clear, setHidden });
const UI = Object.freeze({ ...ui, section: ui.heading });

export function createExt(extension) {
  const pkg = extension.package;
  const verbs = new Set(extension.commands ?? []);
  const slot = (name) => (id, impl) => registry.register(name, pkg, id, impl);

  const ext = {
    package: pkg,
    dock: slot("dock"),
    panel: slot("panel"),
    place: slot("places"),
    sidebar: (id, mount) => registry.register("sidebar", pkg, id, typeof mount === "function" ? { mount } : mount),
    chip: slot("chips"),
    composer: slot("composer"),
    shelf: slot("shelf"),
    statusbar: slot("statusbar"),
    transcript: (render) => registry.addRenderer(pkg, render),

    async request(verb, { session, args } = {}) {
      if (!verbs.has(verb)) throw new Error(`${pkg} declares no command "${verb}".`);
      const body = { args: args ?? {} };
      if (session) body.session = session;
      return (await api(`/api/ext/${pkg}/${verb}`, { method: "POST", body })) ?? {};
    },

    redraw: (id) => registry.redraw(pkg, id),

    events: Object.freeze({
      watch(fn) {
        turnWatchers.add(fn);
        return () => turnWatchers.delete(fn);
      },
    }),

    conversation: Object.freeze({
      get current() {
        return store.get("current");
      },
      watch: (fn) => store.watch("current", fn),
      send: (text) => shell.send(text),
      open: (id) => shell.openConversation(id),
    }),

    sessions: Object.freeze({
      list: () => store.get("sessions"),
      watch: (fn) => store.watch("sessions", fn),
      /** Narrows the sidebar to the sessions `fn` keeps; null shows every session again. */
      filter: (fn) => store.set({ sessionFilter: typeof fn === "function" ? fn : null }),
    }),

    open: Object.freeze({
      dock: (id) => shell.openDock(registry.keyOf(pkg, id)),
      place: (id, params) => shell.openPlace(registry.keyOf(pkg, id), params),
      shelf: (id) => shell.openShelf(registry.keyOf(pkg, id)),
      panel: (id) => shell.openPanel(registry.keyOf(pkg, id)),
    }),

    dom: DOM,
    ui: UI,
    toast,
    markdown: renderMarkdown,
  };
  return Object.freeze(ext);
}
