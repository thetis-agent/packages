/* The dock: a terminal along the foot of the conversation column.
 *
 * Deliberately not drawn in the rail. The rail holds one inspector at a time and an inspector is
 * something you consult; a terminal is something you watch while the agent works, in parallel with
 * reading the transcript. So this sits under the conversation and shortens it rather than covering
 * it, stopping short of the rail and the status bar because it belongs to the conversation column
 * and not to the installation. The rail tab this package also registers is the way to open it again
 * once it has been closed, and the list of what has run.
 *
 * All of the chrome is built here and none of it is gateway-web's: this module owns a single
 * `<section>` it inserts ahead of the composer, so adding this panel leaves `git diff
 * packages/gateway-web` empty, which is the acceptance test contract/surface set for a contributed
 * panel. Every per-element colour goes through `element.style.setProperty` (screen.js), never a
 * `style=` attribute, because the surface is served under `default-src 'self'`.
 */

import { blank, draw, write } from "./screen.js";

const ICONS = {
  chevron: ["M6 8l4 4 4-4"],
  close: ["M5 5l10 10", "M15 5l-10 10"],
  plus: ["M10 5v10", "M5 10h10"],
  stop: ["M6.5 6.5h7v7h-7z"],
};

/** The surface's own icon factory, handed in by the entry module. Taken as a dependency rather than
 *  drawn here because only the entry module may reach the seam, and because an SVG built by hand
 *  would need the SVG namespace URL written into a served asset. */
let drawIcon = () => null;

const MIN_HEIGHT = 140;
const DEFAULT_HEIGHT = 300;
/** Remembered on this screen rather than with the conversation: the height is a property of how
 *  somebody likes to work, and following them between conversations is the point. */
const HEIGHT_KEY = "thetis.terminal.height";

function make(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  for (const child of children) if (child != null) node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  return node;
}

function button(className, title, paths, onClick) {
  const node = make("button", className);
  node.type = "button";
  node.title = title;
  node.setAttribute("aria-label", title);
  node.append(drawIcon(paths, { size: 14, width: 1.8 }));
  node.addEventListener("click", onClick);
  return node;
}

function storedHeight() {
  const saved = Number.parseInt(localStorage.getItem(HEIGHT_KEY) ?? "", 10);
  return Number.isFinite(saved) && saved >= MIN_HEIGHT ? saved : DEFAULT_HEIGHT;
}

export class Dock {
  /**
   * @param {object} handlers
   * @param {(command: string) => void} handlers.onRun
   * @param {(text: string) => void} handlers.onType
   * @param {(id: string) => void} handlers.onStop
   * @param {(id: string) => void} handlers.onSelect
   * @param {() => void} handlers.onClose
   */
  constructor(handlers, icon) {
    drawIcon = icon;
    this.handlers = handlers;
    this.screens = new Map();
    this.commands = [];
    this.active = null;
    this.forceRun = false;
    this.readOnly = false;
    this.node = null;
    this.collapsed = false;
  }

  /** Inserts the dock into the conversation column, ahead of the composer. Returns false when there
   *  is no column to sit in, which is what the administration view looks like. */
  mount() {
    if (this.node) return true;
    const main = document.querySelector(".main");
    const composer = main?.querySelector(".composer-wrap");
    if (!main || !composer) return false;
    this.pane = make("pre", "tt-screen");
    this.pane.setAttribute("tabindex", "0");
    // Clicking the output and then typing should reach the field, the way it would in a terminal.
    this.pane.addEventListener("click", () => { if (!window.getSelection()?.toString()) this.field.focus(); });
    this.list = make("nav", "tt-list");
    this.standing = make("span", "tt-standing");
    this.prompt = make("span", "tt-prompt");
    this.field = document.createElement("input");
    this.field.type = "text";
    this.field.className = "tt-field";
    this.field.autocomplete = "off";
    this.field.spellcheck = false;
    const form = make("form", "tt-input", this.prompt, this.field);
    form.addEventListener("submit", (event) => { event.preventDefault(); this.#submit(); });
    this.fold = button("tt-icon", "Fold away", ICONS.chevron, () => { this.collapsed = !this.collapsed; this.render(); });
    const grip = make("div", "tt-grip");
    grip.addEventListener("pointerdown", (event) => { this.#drag(event); });
    this.body = make("div", "tt-body", make("div", "tt-panes", this.pane), this.list);
    this.node = make("section", "tt-dock",
      grip,
      make("header", "tt-head",
        make("span", "tt-name", "Terminal"),
        this.standing,
        button("tt-icon", "Add another command", ICONS.plus, () => { this.forceRun = true; this.render(); this.field.focus(); }),
        this.fold,
        button("tt-icon", "Hide the terminal", ICONS.close, () => { this.handlers.onClose(); })),
      this.body,
      form);
    this.node.style.setProperty("height", `${String(storedHeight())}px`);
    main.insertBefore(this.node, composer);
    return true;
  }

  get open() { return Boolean(this.node) && !this.node.hidden; }

  show(open) {
    if (!this.mount()) return;
    this.node.hidden = !open;
    if (open) this.field.focus();
  }

  /** Drags the top edge. The height is written once at the end rather than on every move, so a slow
   *  disk cannot make the drag stutter. */
  #drag(event) {
    const startY = event.clientY;
    const startHeight = this.node.getBoundingClientRect().height;
    const most = Math.round(window.innerHeight * 0.72);
    const move = (moved) => {
      const height = Math.min(Math.max(startHeight - (moved.clientY - startY), MIN_HEIGHT), most);
      this.node.style.setProperty("height", `${String(Math.round(height))}px`);
    };
    const done = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", done);
      try { localStorage.setItem(HEIGHT_KEY, String(Math.round(this.node.getBoundingClientRect().height))); } catch { /* a browser that refuses storage still resizes */ }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", done);
    event.preventDefault();
  }

  #current() { return this.commands.find((command) => command.id === this.active) ?? null; }

  #submit() {
    const value = this.field.value;
    if (!value.trim() && !this.#typing()) return;
    this.field.value = "";
    if (this.#typing()) this.handlers.onType(value);
    else { this.forceRun = false; this.handlers.onRun(value); }
  }

  #typing() {
    const current = this.#current();
    return Boolean(current?.running) && !this.forceRun;
  }

  /** Folds a chunk of one command's output into its own screen, so switching back to a command
   *  shows what it printed while it was not on top. */
  receive(id, text) {
    if (!text) return;
    const screen = this.screens.get(id) ?? blank();
    write(screen, text);
    this.screens.set(id, screen);
  }

  forget(ids) {
    for (const id of [...this.screens.keys()]) if (!ids.includes(id)) this.screens.delete(id);
  }

  update(commands, readOnly) {
    this.commands = commands;
    this.readOnly = readOnly;
    if (!this.#current()) this.active = commands.find((command) => command.running)?.id ?? commands.at(-1)?.id ?? null;
  }

  select(id) {
    this.active = id;
    this.forceRun = false;
    this.handlers.onSelect(id);
    this.render();
    this.field.focus();
  }

  render() {
    if (!this.node) return;
    this.node.classList.toggle("is-folded", this.collapsed);
    this.body.hidden = this.collapsed;
    this.fold.title = this.collapsed ? "Open it back up" : "Fold away";
    this.fold.setAttribute("aria-label", this.fold.title);
    const current = this.#current();
    this.standing.replaceChildren(document.createTextNode(this.#standing(current)));
    this.prompt.replaceChildren(document.createTextNode(this.readOnly ? "Watching only" : this.#typing() ? `Type into ${current.name}` : "Run a command"));
    this.field.disabled = this.readOnly;
    this.field.placeholder = this.readOnly ? "This conversation is read-only." : this.#typing() ? "" : "for example, npm test";
    this.#drawList();
    if (this.collapsed) return;
    const screen = current ? this.screens.get(current.id) : null;
    const stuck = this.pane.scrollTop + this.pane.clientHeight >= this.pane.scrollHeight - 24;
    this.pane.replaceChildren(screen ? draw(screen) : document.createTextNode(current ? "" : "Nothing has been run here yet. Type a command below to run one."));
    if (stuck) this.pane.scrollTop = this.pane.scrollHeight;
  }

  #standing(current) {
    const running = this.commands.filter((command) => command.running).length;
    if (!this.commands.length) return "";
    if (!current) return running ? `${String(running)} still running` : "";
    return current.running ? `${current.name} — still running` : `${current.name} — ${this.#ended(current)}`;
  }

  #ended(command) {
    if (command.why === "asked") return "stopped";
    if (command.why === "idle") return "stopped after going quiet";
    if (command.why === "flood") return "stopped after printing too much";
    return command.code === 0 ? "finished" : `finished with exit code ${String(command.code)}`;
  }

  /** A row is a div rather than a button because it carries the Stop button, and a button inside a
   *  button is markup the browser takes apart. It still answers the keyboard like one. */
  #drawList() {
    this.list.replaceChildren(...this.commands.map((command) => {
      const tab = make("div", `tt-tab${command.id === this.active ? " is-active" : ""}${command.running ? " is-live" : ""}`);
      tab.setAttribute("role", "button");
      tab.setAttribute("tabindex", "0");
      tab.title = command.command;
      tab.append(make("span", "tt-dot"), make("span", "tt-tab-name", command.name));
      tab.addEventListener("click", () => { this.select(command.id); });
      tab.addEventListener("keydown", (event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); this.select(command.id); } });
      if (command.running) tab.append(button("tt-stop", `Stop ${command.name}`, ICONS.stop, (event) => { event.stopPropagation(); this.handlers.onStop(command.id); }));
      return tab;
    }));
  }
}
