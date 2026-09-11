/* The Terminal: commands running in this person's own space, live.
 *
 * Two pieces of screen, one state. The dock (./dock.js) sits under the conversation and is where
 * output is watched and input typed; the rail tab is the way to open it again once it has been
 * closed, plus a plain list of what has run. Both draw from the same answer, because there is one
 * set of commands and both the agent and the person drive it — the agent starts a build with
 * `run_command` and the person watches it here and types into it, rather than reading about it
 * afterwards in a tool result.
 *
 * Nothing here touches the socket. The four verbs below are declared in this package's own manifest
 * and answered by its own stage (../index.ts); the host checks the verb, the role and the
 * conversation before it forwards anything (ADR 0051, gateway-web/surface-request.ts). `request` is
 * the one thing a panel may originate and this file is the only one that reaches for the seam.
 *
 * Output arrives by asking, not by being pushed: there is no streaming channel on that route. So the
 * loop below paces itself — quick while something is running and the dock is on screen, slow when it
 * is folded away or everything has finished, and immediately again while it is still behind.
 */

import { registerPanel, onEvent, conversation, request, el, icon, section } from "/lib/surface.js";
import { Dock } from "./dock.js";

/** A screen with a prompt in it. */
const MARK = ["M4 5.5 8 9l-4 3.5", "M10.5 13.5h5.5"];

const PACE = { live: 600, idle: 2500, hidden: 5000 };

/** Where this browser has read to in each command's output. The stage keeps its own place for the
 *  model, so the two read the same command without either consuming what the other has not seen. */
const cursors = new Map();
let commands = [];
let readOnly = false;
let asking = false;
let timer = null;
/** Set once the person closes the dock, so a later command does not push it back over their reading. */
let dismissed = false;
let failure = "";

function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

const dock = new Dock({
  onRun: (command) => { send("start", { command, name: nameOf(command) }); },
  onType: (text) => { send("input", { id: dock.active, text: `${text}\n` }); },
  onStop: (id) => { send("stop", { id }); },
  onSelect: () => { schedule(0); },
  onClose: () => { dismissed = true; dock.show(false); panel.redraw(); schedule(PACE.hidden); },
}, icon);

/** A short name for the list, taken from the command itself: the first word or two is what somebody
 *  would call it anyway, and asking for a label before running something is a form to fill in. */
function nameOf(command) {
  const clean = command.trim().replace(/\s+/g, " ");
  const words = clean.split(" ");
  // "for" and its friends say nothing about what is running, so a shell construct keeps the whole
  // line; anything else is named after the program and its first argument, which is what a person
  // would call it. The full command is on the row's tooltip either way.
  const label = /^(for|while|until|if|do|then|\{|\()$/.test(words[0]) ? clean : words.slice(0, 2).join(" ");
  const trimmed = label.replace(/[;&|]+$/, "");
  return trimmed.length > 22 ? `${trimmed.slice(0, 21)}…` : trimmed;
}

function send(verb, args) {
  return request(verb, args)
    .then((answer) => { failure = ""; apply(answer.text); })
    .catch((error) => { failure = error.message; dock.render(); panel.redraw(); })
    .finally(() => { schedule(0); });
}

/** Folds one answer into the dock and the rail tab. The answer is the whole picture rather than a
 *  diff, so nothing here has to reconcile against whatever was drawn last. */
function apply(text) {
  let answer;
  try { answer = JSON.parse(text || "{}"); } catch { return; }
  commands = Array.isArray(answer.commands) ? answer.commands : [];
  readOnly = answer.readOnly === true;
  dock.update(commands, readOnly);
  dock.forget(commands.map((command) => command.id));
  for (const id of [...cursors.keys()]) if (!commands.some((command) => command.id === id)) cursors.delete(id);
  if (typeof answer.started === "string") { cursors.set(answer.started, 0); dock.active = answer.started; dock.forceRun = false; }
  if (typeof answer.id === "string") {
    if (answer.skipped > 0) dock.receive(answer.id, `\r\n[ ${String(answer.skipped)} bytes of earlier output were dropped ]\r\n`);
    dock.receive(answer.id, answer.text ?? "");
    if (typeof answer.next === "number") cursors.set(answer.id, answer.next);
  }
  if (commands.length && !dismissed) dock.show(true);
  dock.render();
  panel.redraw();
}

/** True while the browser is still behind what the active command has printed. */
function behind() {
  const current = commands.find((command) => command.id === dock.active);
  return Boolean(current) && (cursors.get(current.id) ?? 0) < current.bytes;
}

function pace() {
  if (behind()) return 0;
  if (!dock.open || dock.collapsed) return PACE.hidden;
  return commands.some((command) => command.running) ? PACE.live : PACE.idle;
}

function schedule(delay = pace()) {
  if (timer !== null) clearTimeout(timer);
  timer = setTimeout(poll, delay);
}

function poll() {
  timer = null;
  if (asking || !conversation.current) { schedule(PACE.idle); return; }
  asking = true;
  const id = dock.active ?? "";
  request("output", { id, since: cursors.get(id) ?? 0 })
    .then((answer) => { failure = ""; apply(answer.text); })
    .catch((error) => { failure = error.message; panel.redraw(); })
    .finally(() => { asking = false; schedule(); });
}

function rows() {
  return commands.map((command) => {
    const stop = command.running
      ? el("button", { class: "ghost-btn sm is-danger", type: "button", onClick: () => send("stop", { id: command.id }) }, "Stop")
      : null;
    return el("div", { class: `card${command.id === dock.active ? " is-on" : ""}` },
      el("div", { class: "card-head" },
        el("div", { class: "card-heading" },
          el("p", { class: "card-title mono" }, command.name),
          el("p", { class: "card-desc" }, command.running ? "Still running" : endedText(command))),
        el("div", { class: "card-badges" }, stop)),
      el("p", { class: "card-meta" }, command.command));
  });
}

function endedText(command) {
  if (command.why === "asked") return "Stopped";
  if (command.why === "idle") return "Stopped after going quiet";
  if (command.why === "flood") return "Stopped after printing too much";
  return command.code === 0 ? "Finished" : `Finished with exit code ${String(command.code)}`;
}

function draw() {
  const running = commands.filter((command) => command.running).length;
  const toggle = el("button", { class: "ghost-btn sm is-primary", type: "button", onClick: () => { dismissed = dock.open; dock.show(!dock.open); dock.render(); panel.redraw(); schedule(0); } },
    dock.open ? "Hide the terminal" : "Show the terminal");
  return {
    title: "Terminal",
    subtitle: commands.length ? `${String(running)} of ${String(commands.length)} still running` : "Nothing has been run here yet",
    blocks: [
      el("div", { class: "panel-list" }, toggle),
      failure ? el("p", { class: "panel-warning" }, failure) : null,
      readOnly ? el("p", { class: "panel-warning" }, "This conversation is read-only, so nothing can be run in it.") : null,
      section({ title: "Commands", count: commands.length, note: "Everything run here, by you or by the agent. The output appears under the conversation." }),
      ...rows(),
    ].filter(Boolean),
  };
}

link("/surface/tools-terminal/panel.css");

const panel = registerPanel({
  id: "terminal",
  label: "Terminal",
  hint: "Terminal — commands running in your space, live",
  icon: () => icon(MARK, { size: 17, width: 1.6 }),
  draw,
});

// A command the agent starts brings the dock up on its own, which is the whole reason for a dock
// rather than a tool result read afterwards — unless the person has closed it, which stops the
// auto-open for the rest of the session exactly as collapsing the rail does (views/rail.js). The
// tab is still there, and it still says what is running.
onEvent("tool-call", (frame) => {
  if (frame.session !== conversation.current || frame.name !== "run_command") return;
  schedule(0);
});

conversation.watch(() => { schedule(0); });
schedule(0);
