/* The shelf body: the shells this workspace has open, on the left, and the one being watched, on the
 * right. The shell owns the grip, the title and the ✕ above it; everything below is this file's.
 *
 * The rule the rows are built on is the one the last feature was built on: the state word is computed
 * where the truth is, on the server, and this file only says it in plain words and offers the repair.
 * Nothing here derives a state from output, from a clock or from a command line, so the page, the prompt
 * and the command line cannot disagree. A fact that is not a state — output the ring buffer dropped, a
 * session another conversation opened, a resize the shell will not hear until its next program starts —
 * is a line under the row, never a word in it.
 *
 * The session table and the emulators are the page's, not the shelf's (see index.js): this mounts on a
 * table that is already filled and already live, draws it, and puts the chosen session's screen into the
 * pane. Closing the shelf takes the element out of the page and leaves the emulator and its scrollback
 * alone, so opening it again costs no request and loses no output. */

const TICKING = new Set(["busy", "busy-quiet"]); // the rows whose sentence carries a clock
const REDRAW_MS = 1000;
const FIT_MS = 120;
const PLUS = ["M10 4.5v11", "M4.5 10h11"];

/** The two shapes a fence's home has. The browser is not told where it is, so anything else is shown whole. */
const HOME = /^(?:.*\/userspaces\/[^/]+\/home|\/home\/[^/]+|\/root)(?=\/|$)/;

/** How each state reads, and what the row offers to do about it. The word itself is always the server's. */
const STATES = {
  idle: { action: "close", line: (s) => shorten(s.cwd) },
  busy: { action: "interrupt", line: (s) => `${whose(s)}running ${cmd(s)}${clock(s.since)}` },
  "busy-quiet": { action: "interrupt", line: (s) => `running ${cmd(s)} · no output for ${lapse(s.quietMs)}` },
  person: { action: "interrupt", line: (s) => `you are running ${cmd(s)}` },
  fullscreen: { action: "interrupt", line: () => "a full-screen program has the terminal" },
  unframed: { action: null, line: () => "this shell does not report exit codes" },
  closed: { action: "reopen", line: (s) => (typeof s.lastExit === "number" ? `closed · exit ${s.lastExit}` : "closed") },
};

const UNKNOWN = { action: null, line: (s) => `the workspace calls this "${s.state}", which this page does not know` };

const specOf = (session) => STATES[session.state] ?? UNKNOWN;
const cmd = (session) => session.command || "a command";
const whose = (session) => (session.holder === "agent" ? "the agent is " : session.holder === "person" ? "you are " : "");
const shorten = (cwd) => (typeof cwd === "string" && cwd ? cwd.replace(HOME, "~") : "no working directory");

function lapse(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

const clock = (since) => (typeof since === "number" && since > 0 ? ` · ${lapse(Date.now() - since)}` : "");

/** One sentence for the whole shelf when any row is not idle, the way a project's directory list has one. */
function summaryOf(list, busy) {
  const running = list.filter((s) => busy(s)).length;
  const closed = list.filter((s) => s.state === "closed").length;
  if (!running && !closed) return null;
  const parts = [];
  if (running) parts.push(`${running} of ${list.length} ${list.length === 1 ? "shell" : "shells"} ${running === 1 ? "is" : "are"} running something.`);
  if (closed) parts.push(`${closed} ${closed === 1 ? "is" : "are"} closed.`);
  return parts.join(" ");
}

export function mountShelf(ext, store, root) {
  const { el, clear, icon, setHidden } = ext.dom;
  const { button } = ext.ui;
  let alive = true;
  let chosen = null;          // the session whose screen is in the pane
  let renaming = null;        // the id whose name is an input right now; a redraw must not steal it
  let attached = null;        // the screen in the pane, so it is detached and not disposed when this goes
  let sizing = null;
  const lines = new Map();    // id -> the node carrying the state sentence, so the clock ticks without a redraw

  const summary = el("p", { class: "tm-summary" });
  const reconnect = button("Reconnect", { onClick: () => store.reconnect() });
  const add = el("button", { type: "button", class: "icon-btn sm tm-add", title: "Open a shell in this conversation", "aria-label": "Open a shell in this conversation" }, icon(PLUS, { size: 14, width: 1.9 }));
  const list = el("ul", { class: "tm-list" });
  const paneBody = el("div", { class: "tm-pane-body" });
  const paneNote = el("p", { class: "tm-pane-note" });
  add.addEventListener("click", () => void open(add, null));

  root.append(el("div", { class: "tm" },
    el("div", { class: "tm-head" }, summary, el("span", { class: "tm-gap" }), reconnect, add),
    el("div", { class: "tm-body" },
      el("div", { class: "tm-side" }, list),
      el("div", { class: "tm-pane" }, paneBody, paneNote))));

  // ---- the requests ----

  /** Every verb goes through here: a refusal is one sentence in the corner, never a row that lies. */
  async function ask(anchor, verb, args, whenRefused) {
    if (anchor) anchor.disabled = true;
    try {
      return await ext.request(verb, { args });
    } catch (err) {
      ext.toast(`${whenRefused}: ${err?.message || "the gateway did not answer"}`, { tone: "error" });
      return null;
    } finally {
      if (anchor && alive) anchor.disabled = false;
    }
  }

  /** `from` is the closed session being reopened: a new shell, with its name and where it stood. */
  async function open(anchor, from) {
    const args = { conversation: ext.conversation.current ?? undefined };
    if (from) {
      args.name = from.name;
      args.cwd = from.cwd;
    }
    const out = await ask(anchor, "open", args, from ? "That shell was not reopened" : "No shell was opened");
    const session = out?.data?.session;
    if (!session?.id || !alive) return;
    chosen = session.id;
    store.adopt(session); // the stream says the same thing a moment later; this shows the row now
  }

  async function act(anchor, session, action) {
    if (action === "interrupt") return void (await ask(anchor, "interrupt", { id: session.id }, "The shell was not interrupted"));
    if (action === "close") return void (await ask(anchor, "close", { id: session.id }, "The shell was not closed"));
    if (action === "reopen") return void (await open(anchor, session));
  }

  async function rename(session, name) {
    const out = await ask(null, "rename", { id: session.id, name }, "That shell was not renamed");
    if (out?.data?.session) store.adopt(out.data.session);
    else draw();
  }

  /**
   * Measures the pane, resizes the emulator and tells the shell. Only the session on screen is sized;
   * another one is sized when it is put in the pane, because its size is the pane's, not its own.
   * `applied: false` is the limitation of section 2.5 made visible: the shell has the new size written
   * down and hands it over when it is next idle, so the program running now keeps the old one.
   */
  async function fit() {
    const session = store.get(chosen);
    if (!session || !attached || attached.id !== session.id) return;
    const size = attached.fit();
    if (!size) return;
    if (session.state === "closed") return; // the picture reflows to the pane; a closed shell has no size to learn
    try {
      const out = await ext.request("resize", { args: { id: session.id, rows: size.rows, cols: size.cols } });
      store.setNote(session.id, out?.data?.applied === false ? "the program now running keeps the old size; the next one starts at this one" : null);
    } catch (err) {
      store.setNote(session.id, `the shell was not told the new size: ${err?.message || "the gateway did not answer"}`);
    }
  }

  // ---- the rows ----

  function nameField(session) {
    const input = el("input", { class: "input tm-rename", type: "text", value: session.name ?? "", "aria-label": "Rename this shell", maxlength: "40", spellcheck: "false" });
    const done = (commit) => {
      if (renaming !== session.id) return;
      const value = input.value.trim();
      renaming = null;
      if (commit && value && value !== session.name) void rename(session, value);
      else draw();
    };
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
      event.stopPropagation();
    });
    input.addEventListener("click", (event) => event.stopPropagation());
    input.addEventListener("blur", () => done(false));
    setTimeout(() => {
      input.focus();
      input.select();
    }, 0);
    return input;
  }

  function name(session) {
    if (renaming === session.id) return nameField(session);
    const node = el("button", { type: "button", class: "tm-name", title: "Rename this shell" }, session.name || session.id);
    node.addEventListener("click", (event) => {
      event.stopPropagation();
      renaming = session.id;
      draw();
    });
    return node;
  }

  /** The conversation that opened a session, when it is not the open one: a fact about the row. */
  function elsewhere(session) {
    const current = ext.conversation.current ?? null;
    if (!session.conversation || session.conversation === current) return null;
    const other = ext.sessions.list().find((s) => s.id === session.conversation);
    const title = other?.title?.trim();
    return title ? `opened by "${title}"` : "opened by another conversation";
  }

  function row(session) {
    const spec = specOf(session);
    const line = el("p", { class: "tm-line" }, spec.line(session));
    lines.set(session.id, line);
    const control = spec.action
      ? button(spec.action === "interrupt" ? "Interrupt" : spec.action === "close" ? "Close" : "Reopen", { tone: spec.action === "interrupt" ? "warn" : "quiet" })
      : null;
    control?.addEventListener("click", (event) => {
      event.stopPropagation();
      void act(control, session, spec.action);
    });
    const opener = elsewhere(session);
    const note = store.note(session.id);
    const facts = [
      session.dropped > 0 ? { text: "some output was dropped", warn: true } : null,
      opener ? { text: opener } : null,
      note ? { text: note, warn: true } : null,
    ].filter(Boolean);
    const node = el("li", { class: `tm-row is-${session.state}${session.id === chosen ? " is-chosen" : ""}`, "data-id": session.id, tabindex: "0" },
      el("div", { class: "tm-row-top" }, name(session), el("span", { class: "tm-gap" }), control),
      line,
      ...facts.map((fact) => el("p", { class: `tm-fact${fact.warn ? " is-warn" : ""}` }, fact.text)));
    const choose = () => {
      if (chosen === session.id) return;
      chosen = session.id;
      draw();
    };
    node.addEventListener("click", choose);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        choose();
      }
    });
    return node;
  }

  // ---- the pane ----

  /** What the pane says when there is no picture to show: never blank, and never a stale one. */
  function words(session, screen) {
    if (!session) return "No shell is open. The + above opens one in this conversation.";
    const failure = screen?.failure();
    if (failure) return `The terminal emulator did not load (${failure}), so there is no picture of this shell. It is still running, and the tools still reach it.`;
    // A session already closed when this page found it: the host kept the row, but its output is gone.
    if (session.state === "closed") return `${specOf(session).line(session)}. What it printed was not kept; Reopen in the row starts a new one.`;
    return "This shell has printed nothing yet.";
  }

  function pane() {
    const session = store.get(chosen);
    // A closed session keeps the screen it had: the last screenful is usually the answer to why it closed.
    const screen = session ? store.screen(session.id) : null;
    const usable = screen && !screen.failure();
    if (!usable) {
      attached?.detach();
      attached = null;
      paneBody.replaceChildren(el("p", { class: "panel-empty" }, words(session, screen)));
    } else if (attached !== screen) {
      attached?.detach();
      paneBody.replaceChildren();
      screen.attach(paneBody);
      attached = screen;
    }
    // Always, not only on a change: the emulator may have arrived since the last draw, and a fit whose
    // size is the size it already has answers null and sends nothing.
    if (attached) void fit();
    // Where the keys go. A terminal that silently redirects keystrokes is worse than one that swallows
    // them, so this is said whenever the agent holds the prompt; and a closed shell that keeps its picture
    // must say that it keeps nothing else, because a screenful of text looks like a prompt.
    const shut = usable && session.state === "closed";
    const held = session && session.holder === "agent" && store.busy(session);
    paneNote.classList.toggle("is-dim", shut);
    paneNote.textContent = shut
      ? `This shell is closed, so it takes no more keys. What it printed is still here; Reopen in the row starts a new one.`
      : held
        ? `What you type reaches the agent's command: ${cmd(session)}.`
        : "";
    // The note is one line, so a long command line is cut with an ellipsis; the whole of it is on hover.
    if (paneNote.textContent) paneNote.setAttribute("title", paneNote.textContent);
    else paneNote.removeAttribute("title");
    setHidden(paneNote, !paneNote.textContent);
  }

  // ---- drawing ----

  function draw() {
    if (!alive) return;
    const all = store.list();
    if (!chosen || !all.some((s) => s.id === chosen)) {
      const mine = all.find((s) => s.conversation && s.conversation === ext.conversation.current && s.state !== "closed");
      chosen = (mine ?? all.find((s) => s.state !== "closed") ?? all[0])?.id ?? null;
    }
    const stream = store.stream();
    summary.classList.toggle("is-warn", !stream.live);
    summary.textContent = stream.live ? summaryOf(all, store.busy) ?? "" : `Not live: ${stream.why}. What the rows say may be out of date.`;
    setHidden(summary, !summary.textContent);
    setHidden(reconnect, stream.live);
    lines.clear();
    clear(list);
    if (all.length) list.append(...all.map(row));
    else list.append(el("li", { class: "tm-empty panel-empty" }, "No shells are open."));
    pane();
  }

  /** The clocks, without a redraw: a rebuilt list would take the focus from a rename or a pressed control. */
  function tick() {
    if (!alive || renaming) return;
    for (const [id, node] of lines) {
      const session = store.get(id);
      if (session && TICKING.has(session.state)) node.textContent = specOf(session).line(session);
    }
  }

  // A redraw while a name is being typed would take the field away mid-word, as the sidebar's rename does not.
  const redraw = () => {
    if (!renaming) draw();
  };
  const unwatch = store.watch(redraw);
  // Which conversation is open decides which row is chosen first and which rows say they belong elsewhere.
  const unwatchConversation = ext.conversation.watch(redraw);
  const ticking = setInterval(tick, REDRAW_MS);
  // One observer for all three: the mount, the shell's grip, and the window. Every one of them ends in a
  // pane of a new size, and a debounce keeps a drag from sending a `resize` per frame.
  const observer = new ResizeObserver(() => {
    clearTimeout(sizing);
    sizing = setTimeout(() => void fit(), FIT_MS);
  });
  observer.observe(paneBody);
  draw();

  return () => {
    alive = false;
    clearInterval(ticking);
    clearTimeout(sizing);
    observer.disconnect();
    unwatch();
    unwatchConversation?.();
    attached?.detach(); // the emulator and its scrollback belong to the session, not to this view
    attached = null;
    clear(root);
  };
}
