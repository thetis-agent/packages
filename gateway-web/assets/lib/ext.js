/* The seam between the shell and a package's UI: the one object an extension module receives as the
 * argument of its default export, `install(ext)`. Everything it can do goes through here, bound to the
 * package it was made for, so a module can never name another package. It never sees the store, the API
 * module, the event stream or the views. Registrations are checked against the package's declaration by
 * the registry; requests go to `api/ext/<package>/<verb>`; the conversation and session facts come from
 * the store through narrow readers; `send` travels the composer's own path, so the pending row and the
 * failure handling apply to an ask form's answers as they do to a typed message. A package that declared
 * a raw command gets `ext.raw`: a URL the browser may fetch or navigate to, and an upload with progress.
 * `bindShell` is called once by app.js with the shell functions; `broadcastTurn` feeds every `events.watch`
 * listener. */

import { api, ApiError } from "./api.js";
import { clear, el, icon, setHidden } from "./dom.js";
import { frameSeam } from "./frame.js";
import { awaitReturn, onTurnsIdle, turnsRunning } from "./lifecycle.js";
import { renderMarkdown } from "./markdown.js";
import { openMenu } from "./menu.js";
import { notice } from "./notice.js";
import * as ui from "./panel-ui.js";
import * as registry from "./registry.js";
import { store } from "./store.js";
import { toast } from "./toast.js";

let shell = null; // { send, openConversation, openDock, openPlace, openShelf, closeShelf, shelfOpen, openPanel, openTab, closeTab }
const turnWatchers = new Set();
const creationWatchers = new Set();

/** Only this page's create action invokes these hooks, before opening or sending to the session. */
export async function notifySessionCreated(id) {
  for (const fn of creationWatchers) await fn(id);
}

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
const UI = Object.freeze({ ...ui, section: ui.heading, menu: openMenu });

/**
 * The raw seam of one package: `url(verb, args)` names the route the browser fetches, navigates to or
 * puts in an `img`, relative like a stream's; `put(verb, args, blob, { onProgress, signal })` sends the
 * blob as the whole body and resolves with the parsed JSON reply. An XMLHttpRequest, because `fetch` has
 * no upload progress: `onProgress({ loaded, total })` follows the bytes on their way up. A refusal rejects
 * with the server's sentence; a cancel rejects with an `AbortError`.
 */
function rawSeam(pkg, raws) {
  const url = (verb, args, { session } = {}) => {
    if (!raws.has(verb)) throw new Error(`${pkg} declares no raw command "${verb}".`);
    const query = new URLSearchParams({ args: JSON.stringify(args ?? {}) });
    if (session) query.set("session", session);
    return `api/ext/${pkg}/${verb}/raw?${query}`;
  };
  const put = (verb, args, blob, { onProgress, signal, session } = {}) =>
    new Promise((resolve, reject) => {
      const at = url(verb, args, { session });
      const xhr = new XMLHttpRequest();
      const cancelled = () => Object.assign(new Error("The upload was cancelled."), { name: "AbortError" });
      if (signal?.aborted) return reject(cancelled());
      xhr.open("PUT", at);
      xhr.responseType = "text";
      xhr.setRequestHeader("accept", "application/json");
      if (onProgress) xhr.upload.addEventListener("progress", (event) => onProgress({ loaded: event.loaded, total: event.lengthComputable ? event.total : blob?.size ?? 0 }));
      xhr.addEventListener("load", () => {
        let data = null;
        try {
          data = xhr.responseText ? JSON.parse(xhr.responseText) : null;
        } catch {
          data = null;
        }
        if (xhr.status === 401) {
          location.assign(`/login?next=${encodeURIComponent(location.pathname + location.search)}`);
          return reject(new ApiError(401, "Signed out."));
        }
        if (xhr.status < 200 || xhr.status >= 300) return reject(new ApiError(xhr.status, (data && data.error) || xhr.statusText || "Request failed."));
        resolve(data ?? {});
      });
      xhr.addEventListener("error", () => reject(new ApiError(0, "Not connected.")));
      xhr.addEventListener("abort", () => reject(cancelled()));
      signal?.addEventListener("abort", () => xhr.abort(), { once: true });
      xhr.send(blob);
    });
  return Object.freeze({ url, put });
}

/** The key an `ext.open` call means: the package's own entry, else the first declared anywhere under that id, else a full key as given. */
export function entryKey(slot, pkg, id) {
  const own = registry.keyOf(pkg, id);
  if (registry.entry(slot, own)) return own;
  if (typeof id === "string" && id.includes("#") && registry.entry(slot, id)) return id;
  return registry.entries(slot).find((e) => e.id === id)?.key ?? own;
}

export function createExt(extension) {
  const pkg = extension.package;
  const verbs = new Set(extension.commands ?? []);
  const streams = new Set(extension.streams ?? []);
  const raws = new Set(extension.raw ?? []);
  const frames = new Set(extension.frames ?? []);
  const slot = (name) => (id, impl) => registry.register(name, pkg, id, impl);

  const ext = {
    package: pkg,
    dock: slot("dock"),
    panel: slot("panel"),
    place: slot("places"),
    sidebar: (id, mount) => registry.register("sidebar", pkg, id, typeof mount === "function" ? { mount } : mount),
    chip: slot("chips"),
    composer: slot("composer"),
    /** `ext.shelf(id, { mount })` registers; `ext.shelf.isOpen()` says whether the shelf is open right now. */
    shelf: Object.freeze(Object.assign(slot("shelf"), { isOpen: () => Boolean(shell.shelfOpen?.()) })),
    statusbar: slot("statusbar"),
    /**
     * `ext.tab(kind, { open })` registers a kind of tab: `open(root, handle)` draws one into `root`, the whole
     * pane, and answers `{ unmount?, activate?, deactivate? }` (or the unmount function alone). `handle` is
     * `{ id, kind, params, setTitle(text), setNote(text), close() }`.
     */
    tab: slot("tabs"),
    transcript: (render) => registry.addRenderer(pkg, render),

    /** Whether this package declares `verb` and the person's role clears it: how a UI hides an admin's control. */
    can: (verb) => verbs.has(verb) || streams.has(verb) || raws.has(verb) || frames.has(verb),

    async request(verb, { session, args } = {}) {
      if (!verbs.has(verb)) throw new Error(`${pkg} declares no command "${verb}".`);
      const body = { args: args ?? {} };
      if (session) body.session = session;
      return (await api(`/api/ext/${pkg}/${verb}`, { method: "POST", body })) ?? {};
    },

    /**
     * Subscribes to a verb the package declared with `stream: true`. `onEvent(value)` gets each value the
     * export yields; `onClose(error)` is called once, with null when the stream ended and an Error when it
     * failed. Returns the stop function; nothing else closes the stream, so a view must call it when it goes.
     */
    subscribe(verb, { args, session, onEvent, onClose } = {}) {
      if (!streams.has(verb)) throw new Error(`${pkg} declares no stream "${verb}".`);
      const query = new URLSearchParams({ args: JSON.stringify(args ?? {}) });
      if (session) query.set("session", session);
      const source = new EventSource(`api/ext/${pkg}/${verb}/stream?${query}`);
      const stop = () => source.close();
      source.addEventListener("item", (event) => onEvent && onEvent(JSON.parse(event.data)));
      source.addEventListener("end", () => {
        stop();
        if (onClose) onClose(null);
      });
      // A named `error` frame and the EventSource's own failure arrive under the same name; only the frame
      // carries data. Either way the subscription ends here, the browser's own silent retry included: a
      // reconnect it performs by itself is invisible to the caller, so the page would go on showing what it
      // last heard as though it were live. Ending it hands the retry, and saying so, to the one view that can.
      source.addEventListener("error", (event) => {
        stop();
        if (!onClose) return;
        if (typeof event.data === "string") onClose(new Error(JSON.parse(event.data).message));
        // A refusal and a workspace that stopped answering are the same event here, and guessing between
        // them from the ready state gets it wrong: say what is known, and leave the sentence for the view
        // to end. The view retries, and the gateway answers the refusal again if that is what it was.
        else onClose(new Error(`the stream "${verb}" to your space ended`));
      });
      return stop;
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
      /** Setup for a conversation created here. An async callback completes before its first send. */
      onCreate(fn) {
        creationWatchers.add(fn);
        return () => creationWatchers.delete(fn);
      },
      /** Narrows the sidebar to the sessions `fn` keeps; null shows every session again. */
      filter: (fn) => store.set({ sessionFilter: typeof fn === "function" ? fn : null }),
    }),

    /**
     * Opens a dock, place, shelf or panel section. `id` is this package's own entry first; failing that, the
     * one entry of that id any package declared (`open.place("marketplace", { name })` from a package that is
     * not the marketplace), or a full `<package>#<id>` key.
     */
    open: Object.freeze({
      dock: (id) => shell.openDock(entryKey("dock", pkg, id)),
      place: (id, params) => shell.openPlace(entryKey("places", pkg, id), params),
      shelf: (id) => shell.openShelf(registry.keyOf(pkg, id)),
      panel: (id) => shell.openPanel(registry.keyOf(pkg, id)),
      /** A tab of `kind` for `id`, beside the conversations: this package's own kind first, else another's by that id. The one already open for `id` is shown again. */
      tab: (kind, id, params) => shell.openTab(entryKey("tabs", pkg, kind), id, params),
    }),

    /** The shelf closes whoever is in it, and a tab of a kind closes by its id; nothing else on the page closes on a package's word. */
    close: Object.freeze({
      shelf: () => shell.closeShelf(),
      tab: (kind, id) => shell.closeTab(entryKey("tabs", pkg, kind), id),
    }),

    dom: DOM,
    ui: UI,
    toast,
    /**
     * A persistent card in the bottom-right corner, above the toasts: `notice(id, { title, body?, tone?,
     * actions?, progress?, dismissible?, onDismiss? })` answers `{ update(partial), close() }`. One card per
     * id, replaced in place; the id is this package's own, so two packages cannot replace each other's.
     */
    notice: Object.freeze(Object.assign((id, spec) => notice(`${pkg}:${id}`, spec), { close: (id) => notice.close(`${pkg}:${id}`) })),
    /** Waits for Thetis to go away and come back: `awaitReturn({ timeoutMs?, onState?, since? })` answers "back" or "timeout". */
    awaitReturn,
    /** Whether the person asked to see developer details (raw dumps, problem lists, internal rows). */
    developer: () => store.get("developer") === true,
    /** `fn(on)` each time that preference changes. Answers the function that stops it. */
    onDeveloper: (fn) => store.watch("developer", (on) => fn(on === true)),
    /** Whether any of the person's turns runs (subagents included), and `onIdle(fn)` for when none does any more. */
    turns: Object.freeze({ running: turnsRunning, onIdle: onTurnsIdle }),
    /** The build the page was loaded with. The page refreshes itself when Thetis's build changes. */
    get build() {
      return Object.freeze({ id: store.get("build")?.id ?? "" });
    },
    /** Only for a package that declared a raw command; a module must guard `ext.raw?.url` on an older gateway. */
    ...(raws.size ? { raw: rawSeam(pkg, raws) } : {}),
    /** Only for a package that declared a `kind: "frame"` command; a module must guard `ext.frame?.url` on an older gateway. */
    ...(frames.size ? { frame: frameSeam(pkg, frames) } : {}),
    /** The shell's renderer. `opts.image(src)` may turn a relative image path into a URL; one argument still works. */
    markdown: (text, opts) => renderMarkdown(text, opts),
  };
  return Object.freeze(ext);
}
