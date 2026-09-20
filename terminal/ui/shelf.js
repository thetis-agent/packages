/* The terminal drawer's body: what @thetis/terminal mounts into the shelf.
 *
 * The agent opens long-lived shells and runs builds in them, and this shows them live: a dock along the
 * foot of the conversation column, one row per shell, animating up when the first one opens and shrinking
 * the transcript rather than covering it. The shelf (the gateway's) owns the grip, the title, collapse and
 * hide, the height and its persistence; this file owns everything under the head — the emulator on the
 * left, the shell list on the right, the footer — and puts two buttons of its own in the head.
 *
 * Rendering is xterm.js, vendored under ./vendor and wrapped by screen.js. Shell output is a real
 * terminal protocol — carriage returns rewriting a progress line, cursor moves, 256-colour SGR, wide
 * characters — and every hand-rolled attempt at it turns `cargo build` into a screenful of escape soup.
 * The library is loaded lazily by the first terminal that appears, so a conversation that never opens a
 * shell never pays for the emulator.
 *
 * Writable, unlike the legacy drawer: the session is a real pty, and what you type here goes to the
 * shell — including while the agent holds the prompt, because that is how a person answers the question
 * the agent's command asked. The state word each row draws from is computed where the truth is, on the
 * server; this file only says it and offers the repair. Nothing here derives a state from output, from a
 * clock or from a command line, so the page, the prompt and the command line cannot disagree.
 *
 * The session table and the emulators are the page's, not the drawer's (see index.js): this mounts on a
 * table that is already filled and already live, draws it, and puts the chosen session's screen into the
 * pane. Hiding the shelf leaves this mounted and the emulator's scrollback alone, so showing it again
 * costs no request and loses no output. */

const REDRAW_MS = 1000;   // the clock in the footer
const FIT_MS = 120;       // a drag must not send a `resize` per frame

const ICONS = {
  chevron: "M6 8l4 4 4-4",
  close: "M6 6l8 8M14 6l-8 8",
  trash: "M4 6h12M8 6V4.5h4V6M6 6v9.5h8V6M8.5 9v4M11.5 9v4",
  // Distinct from `trash`: clearing wipes the view, killing ends the shell, and
  // one icon for both is how someone loses a session they meant to tidy.
  eraser: "M5 15h10M7.5 12.5l-2-2 6-6 2 2-6 6zM9 11l-2-2",
  info: "M10 3.5a6.5 6.5 0 100 13 6.5 6.5 0 000-13zM10 9v4.5M10 6.5v.01",
  plus: "M10 4.5v11M4.5 10h11",
  // The interrupt: a stop square, the shape the composer's Stop uses.
  stop: "M6.5 6.5h7v7h-7z",
};

/** The two shapes a fence's home has. The browser is not told where it is, so anything else is shown whole. */
const HOME = /^(?:.*\/userspaces\/[^/]+\/home|\/home\/[^/]+|\/root)(?=\/|$)/;

const TICKING = new Set(["busy", "busy-quiet"]); // the states whose sentence carries a clock

/** How each state reads in the footer and the card. The word itself is always the server's. */
const STATES = {
  idle: () => "idle",
  busy: (s) => `${whose(s)}running ${cmd(s)}${clock(s.since)}`,
  "busy-quiet": (s) => `running ${cmd(s)} · no output for ${lapse(s.quietMs)}`,
  person: (s) => `you are running ${cmd(s)}`,
  fullscreen: () => "a full-screen program has the terminal",
  unframed: () => "this shell does not report exit codes",
  closed: (s) => (typeof s.lastExit === "number" ? `closed · exit ${s.lastExit}` : "closed"),
};

const sentence = (session) => (STATES[session.state] ?? ((s) => `the workspace calls this "${s.state}", which this page does not know`))(session);
const cmd = (session) => session.command || "a command";
const whose = (session) => (session.holder === "agent" ? "the agent is " : session.holder === "person" ? "you are " : "");
const shorten = (cwd) => (typeof cwd === "string" && cwd ? cwd.replace(HOME, "~") : "");
/** What the shell is called. The record names no program; a framed session is bash by definition (only bash gets the rc). */
const shellOf = (session) => (session.shell ? leaf(session.shell) : session.framed ? "bash" : "shell");

/** The last path segment, which is what identifies a shell at a glance. The
 *  full path is in the title and in the footer, so nothing is lost. */
function leaf(path) {
  if (!path) return "";
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || "/";
}

function lapse(ms) {
  const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${String(m % 60).padStart(2, "0")}m`;
}

const clock = (since) => (typeof since === "number" && since > 0 ? ` · ${lapse(Date.now() - since)}` : "");

/** Sorts `2` before `10`, which a plain string sort gets backwards. */
function collate(a, b) {
  return String(a).localeCompare(String(b), undefined, { numeric: true });
}

export function mountShelf(ext, store, root, shelf) {
  const { el, clear, icon } = ext.dom;
  const { button } = ext.ui;
  let alive = true;
  let chosen = null;          // the session whose screen is in the pane
  let renaming = null;        // the id whose label is an input right now; a redraw must not steal it
  let attached = null;        // the screen in the pane, so it is detached and not disposed when this goes
  let sizing = null;
  let card = null;            // the open details card: { node, id, anchor, onKey, onClick }
  let popover = null;         // the open kill confirmation: { node, onKey, onClick }
  const unread = new Set();   // rows with activity since you last looked; only ever decorates one not chosen

  // A list, not a tab strip. Cursor puts the shells down the right-hand side,
  // and it is the better shape here for the same reason: a shell's name, its
  // state and its directory do not fit in a tab, and the list has room to grow
  // downwards where a strip would start scrolling sideways after four.
  const listEl = el("nav", { class: "term-list", "aria-label": "Terminal sessions" });
  const panesEl = el("div", { class: "term-panes" });
  const bodyEl = el("div", { class: "term-body" }, panesEl, listEl);
  const footEl = el("div", { class: "term-foot" });
  root.append(bodyEl, footEl);

  // The head's two buttons are the drawer's; the shelf places them before its own collapse and hide.
  const addBtn = el("button", {
    type: "button",
    class: "icon-btn sm term-add",
    title: "Open a shell in this conversation",
    "aria-label": "Open a shell in this conversation",
    onClick: () => void open(addBtn, null),
  }, icon(ICONS.plus, { size: 14, width: 1.9 }));
  const clearBtn = el("button", {
    type: "button",
    class: "icon-btn sm term-clear",
    title: "Clear this terminal's view (the shell keeps running)",
    "aria-label": "Clear this terminal's view",
    onClick: clearActive,
  }, icon(ICONS.eraser, { size: 14 }));
  if (shelf?.actions) shelf.actions(addBtn, clearBtn);
  else root.prepend(el("div", { class: "term-head-actions" }, addBtn, clearBtn)); // an older shelf: the buttons still exist

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

  /** `from` is a closed session being reopened: a new shell, with its name and where it stood. */
  async function open(anchor, from) {
    const args = { conversation: ext.conversation.current ?? undefined };
    if (from) {
      args.name = from.name;
      args.cwd = from.cwd;
    }
    const out = await ask(anchor, "open", args, from ? "That shell was not reopened" : "No shell was opened");
    const session = out?.data?.session;
    if (!session?.id || !alive) return;
    chosen = session.id; // the person asked for it, so it is the one on screen
    store.adopt(session); // the stream says the same thing a moment later; this shows the row now
  }

  async function interrupt(anchor, session) {
    await ask(anchor, "interrupt", { id: session.id }, "The shell was not interrupted");
  }

  async function rename(session, name) {
    const out = await ask(null, "rename", { id: session.id, name }, "That shell was not renamed");
    if (out?.data?.session) store.adopt(out.data.session);
    else draw();
  }

  /**
   * Measures the pane, resizes the emulator and tells the shell. Only the session on screen is sized;
   * another one is sized when it is put in the pane, because its size is the pane's, not its own. The
   * answer is applied at once (an ioctl on the device from outside the shell); `applied: false` is the
   * fallback for a shell that did not report its device, and the footer says so.
   */
  async function fit() {
    const session = store.get(chosen);
    if (!session || !attached || attached.id !== session.id) return;
    const size = attached.fit();
    if (!size) return;
    if (session.state === "closed") return; // the picture reflows to the pane; a closed shell has no size to learn
    try {
      const out = await ext.request("resize", { args: { id: session.id, rows: size.rows, cols: size.cols } });
      store.setNote(session.id, out?.data?.applied === false ? "size applies at the next prompt" : null);
    } catch (err) {
      store.setNote(session.id, `the shell was not told the new size: ${err?.message || "the gateway did not answer"}`);
    }
  }

  function scheduleFit() {
    clearTimeout(sizing);
    sizing = setTimeout(() => void fit(), FIT_MS);
  }

  // ---- the rows ----

  /** The rows in the order the list shows them: this conversation's shells and the person's own first, then the rest. */
  function ordered() {
    const key = (s) => s.name || s.id;
    const here = store.list().filter((s) => store.mine(s)).sort((a, b) => collate(key(a), key(b)));
    const elsewhere = store.list().filter((s) => !store.mine(s)).sort((a, b) => collate(key(a), key(b)));
    return [...here, ...elsewhere];
  }

  function renameField(session) {
    const input = el("input", { class: "term-tab-rename", type: "text", value: session.name ?? "", "aria-label": "Rename this shell", maxlength: "40", spellcheck: "false" });
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

  function drawTabs() {
    // Rows are rebuilt wholesale, which detaches the anchor an open card was
    // placed against. The card is reopened at the end against its new row rather
    // than dismissed: a busy shell redraws this list on every command, and a
    // details card that evaporated as soon as the shell did something would be
    // unreadable exactly when it is most wanted.
    const cardFor = card?.id;
    closeCard();
    clear(listEl);
    const current = ext.conversation.current ?? null;
    for (const session of ordered()) {
      const busy = store.busy(session);
      const closed = session.state === "closed";
      const dot = busy ? "term-dot is-busy" : closed ? "term-dot is-done" : "term-dot is-ok";
      const elsewhere = !store.mine(session, current);
      const title = elsewhere ? store.conversationTitle(session.conversation) || "another conversation" : null;
      // The label takes the input's place while a name is being typed.
      const label = renaming === session.id
        ? renameField(session)
        : el("span", { class: "term-tab-label", title: "Double-click to rename", onDblclick: (e) => {
          e.preventDefault();
          e.stopPropagation();
          renaming = session.id;
          drawTabs();
        } }, session.name || session.id);
      // A row, not a button: it holds controls of its own, and a button
      // inside a button is invalid and does not receive its own clicks.
      const row = el(
        "div",
        {
          class: `term-tab${session.id === chosen ? " is-active" : ""}${unread.has(session.id) ? " has-activity" : ""}${elsewhere ? " is-elsewhere" : ""}`,
          "data-id": session.id,
        },
        el(
          "button",
          {
            type: "button",
            class: "term-tab-pick",
            title: `${session.id} — ${shellOf(session)} in ${session.cwd || "?"}`,
            onClick: () => choose(session.id),
          },
          el("span", { class: dot }),
          // One line, not two: the row is compact, so the directory is
          // dimmed inline beside the name and the full path stays in the footer
          // and the details card.
          el(
            "span",
            { class: "term-tab-text" },
            label,
            el("span", { class: "term-tab-sub" }, elsewhere ? `${leaf(session.cwd)} · “${title}”` : leaf(session.cwd))
          ),
          closed && el("span", { class: "term-tab-note" }, "exited")
        ),
        busy && el(
          "button",
          {
            type: "button",
            class: "icon-btn sm term-tab-stop",
            title: `Interrupt ${session.name || session.id} (Ctrl-C to the program running)`,
            "aria-label": `Interrupt ${session.name || session.id}`,
            onClick: (e) => {
              e.stopPropagation();
              void interrupt(e.currentTarget, session);
            },
          },
          icon(ICONS.stop, { size: 12 })
        ),
        el(
          "button",
          {
            type: "button",
            class: "icon-btn sm term-tab-info",
            title: `Details for ${session.name || session.id}`,
            "aria-label": `Details for ${session.name || session.id}`,
            "data-info": session.id,
            onClick: (e) => {
              e.stopPropagation();
              toggleDetails(e.currentTarget, session.id);
            },
          },
          icon(ICONS.info, { size: 12 })
        ),
        el(
          "button",
          {
            type: "button",
            class: "icon-btn sm term-tab-kill",
            title: closed ? `Remove ${session.name || session.id} from the list` : `Close ${session.name || session.id}`,
            "aria-label": closed ? `Remove ${session.name || session.id}` : `Close ${session.name || session.id}`,
            onClick: (e) => {
              e.stopPropagation();
              confirmKill(e.currentTarget, session.id);
            },
          },
          icon(ICONS.trash, { size: 12 })
        )
      );
      listEl.append(row);
    }
    if (!store.list().length) {
      listEl.append(el("span", { class: "term-empty" }, "No shells open — open one with +, or the agent opens one when it needs to run something."));
    }
    // Re-anchor a card that was open before the rebuild, if its shell still
    // exists. Skipped when the row is gone: the card would have nothing to
    // describe.
    if (cardFor && store.get(cardFor)) {
      const anchor = listEl.querySelector(`[data-info="${CSS.escape(cardFor)}"]`);
      if (anchor) showDetails(anchor, cardFor);
    }
  }

  function choose(id) {
    chosen = id;
    unread.delete(id);
    draw();
    attached?.focus();
  }

  /* Killing a shell is destructive and cannot be undone — a background process
   * dies with its group — so it takes two steps and names what it is about to
   * end, per the house rule against bare `confirm()`. */
  function confirmKill(anchor, id) {
    const session = store.get(id);
    if (!session) return;
    if (session.state === "closed") {
      // Nothing to kill; this is just tidying a dead row away, so it needs no
      // confirmation. The host keeps its record; the row stays hidden for this page.
      store.hide(id);
      if (chosen === id) chosen = null;
      draw();
      return;
    }
    closePopover();
    const name = session.name || session.id;
    const node = el(
      "div",
      { class: "term-popover shelf-scheme", role: "dialog", "aria-label": `Close ${name}?` },
      el("div", { class: "term-popover-message" }, `Close ${name}?`),
      el("div", { class: "term-popover-detail" }, `The shell in ${shorten(session.cwd) || "?"} and everything it is running will be terminated. The agent may be using it.`),
      el(
        "div",
        { class: "term-popover-actions" },
        button("Cancel", { onClick: closePopover }),
        button("Close", { tone: "warn", onClick: () => {
          closePopover();
          void ask(anchor, "close", { id }, "The shell was not closed");
        } })
      )
    );
    document.body.append(node);
    const at = anchor.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const left = Math.max(8, Math.min(at.right - w, window.innerWidth - w - 8));
    const top = at.top - h - 8 >= 8 ? at.top - h - 8 : Math.min(at.bottom + 8, window.innerHeight - h - 8);
    node.style.setProperty("left", `${left}px`);
    node.style.setProperty("top", `${top}px`);
    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closePopover();
      }
    };
    const onClick = (e) => {
      if (!node.contains(e.target)) closePopover();
    };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("click", onClick, true), 0);
    popover = { node, onKey, onClick };
    node.querySelector(".btn.is-warn")?.focus();
  }

  function closePopover() {
    if (!popover) return;
    document.removeEventListener("keydown", popover.onKey, true);
    document.removeEventListener("click", popover.onClick, true);
    popover.node.remove();
    popover = null;
  }

  /* The details card, as in the reference: what this shell actually is.
   *
   * Not a popover — that one is confirm-shaped and always draws Confirm and
   * Cancel, and there is nothing here to confirm. This is a floating read-only
   * card, dismissed by leaving the row, pressing Escape, or clicking away.
   *
   * It is one of the few things allowed a real shadow, because it genuinely
   * floats above the drawer rather than being docked in it. */
  function closeCard() {
    if (!card) return;
    document.removeEventListener("keydown", card.onKey, true);
    document.removeEventListener("click", card.onClick, true);
    card.node.remove();
    card = null;
  }

  /* The button toggles: a second click on the same row closes the card rather
   * than redrawing it under the pointer. Separate from `showDetails` because a
   * redraw re-anchors the card and must *not* toggle it shut. */
  function toggleDetails(anchor, id) {
    const wasFor = card?.id;
    closeCard();
    if (wasFor !== id) showDetails(anchor, id);
  }

  function showDetails(anchor, id) {
    closeCard();
    const session = store.get(id);
    if (!session) return;
    const busy = store.busy(session);
    const current = ext.conversation.current ?? null;
    const conversation = !session.conversation
      ? "opened by you"
      : store.conversationTitle(session.conversation) || (session.conversation === current ? "this conversation" : "another conversation");
    const rows = [
      ["Name", session.name || "—"],
      ["Session id", session.id],
      ["Working directory", session.cwd || "not reported"],
      ["Conversation", conversation],
      ["Shell", shellOf(session)],
      ["State", sentence(session)],
      busy && session.command && ["Command", session.command],
      busy && typeof session.since === "number" && session.since > 0 && ["Running since", new Date(session.since).toLocaleTimeString()],
      typeof session.lastExit === "number" && ["Last exit", String(session.lastExit)],
      ["Terminal", typeof session.tty === "string" && session.tty ? session.tty : "not reported"],
      ["Reports exit codes", session.framed ? "yes" : "no — this shell is unframed"],
    ].filter(Boolean);

    const node = el(
      "div",
      { class: "term-card shelf-scheme", role: "dialog", "aria-label": `Details for ${session.name || id}` },
      el(
        "div",
        { class: "term-card-head" },
        el("span", { class: "term-card-title" }, session.name || id),
        el("span", { class: "term-card-id" }, session.name ? `${shellOf(session)} · ${id}` : shellOf(session))
      ),
      ...rows.map(([label, value]) =>
        el("div", { class: "term-card-row" }, el("span", { class: "term-card-label" }, label), el("span", { class: "term-card-value" }, value))
      ),
      el("div", { class: "term-card-foot" }, "What you type here goes to the shell.")
    );
    document.body.append(node);

    // Placed left of the *list*, not of the button: the list sits at the right
    // edge of the drawer, so a card hung below the button would fall off the
    // viewport, and one placed only left of the button would still overlap the
    // rows it describes. Clamped both ways regardless.
    const at = anchor.getBoundingClientRect();
    const listBox = listEl.getBoundingClientRect();
    const w = node.offsetWidth;
    const h = node.offsetHeight;
    const rightEdge = (listBox.width ? listBox.left : at.left) - 8;
    const left = Math.max(8, Math.min(rightEdge - w, window.innerWidth - w - 8));
    const top = Math.max(8, Math.min(at.top - 8, window.innerHeight - h - 8));
    node.style.setProperty("left", `${left}px`);
    node.style.setProperty("top", `${top}px`);

    const onKey = (e) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeCard();
      }
    };
    const onClick = (e) => {
      if (!node.contains(e.target) && e.target !== anchor && !anchor.contains(e.target)) closeCard();
    };
    document.addEventListener("keydown", onKey, true);
    setTimeout(() => document.addEventListener("click", onClick, true), 0);
    card = { node, id, anchor, onKey, onClick };
  }

  // ---- the footer ----

  /** The chosen shell's full directory and one sentence about it; the stream's state when it is not live. */
  function drawFoot() {
    const session = store.get(chosen);
    const stream = store.stream();
    clear(footEl);
    if (!stream.live) {
      footEl.append(
        el("span", { class: "term-cwd", title: session?.cwd || "" }, session ? shorten(session.cwd) : ""),
        el(
          "span",
          { class: "term-meta is-stale" },
          `not live: ${stream.why} · `,
          el("button", { type: "button", class: "term-reconnect", onClick: () => store.reconnect() }, "Reconnect")
        )
      );
      return;
    }
    if (!session) return;
    const note = store.note(session.id);
    footEl.append(
      el("span", { class: "term-cwd", title: session.cwd || "" }, shorten(session.cwd)),
      el("span", { class: "term-meta" }, `${shellOf(session)} · ${sentence(session)}${note ? ` · ${note}` : ""}`)
    );
  }

  /** The clock, without a redraw: a rebuilt list would take the focus from a rename or a pressed control. */
  function tick() {
    if (!alive || renaming) return;
    const session = store.get(chosen);
    if (session && TICKING.has(session.state) && store.stream().live) drawFoot();
  }

  // ---- the pane ----

  function showPane() {
    const session = store.get(chosen);
    // A closed session keeps the screen it had: the last screenful is usually the answer to why it closed.
    const screen = session ? store.screen(session.id) : null;
    const failure = screen?.failure();
    if (!screen || failure) {
      attached?.detach();
      attached = null;
      clear(panesEl);
      // Shown only if the vendored emulator fails to load: an empty black box would look like a hang.
      if (failure) {
        panesEl.append(
          el("div", { class: "term-fallback" }, el("p", {}, "The terminal renderer did not load."), el("p", { class: "term-fallback-note" }, String(failure)))
        );
      }
    } else if (attached !== screen) {
      attached?.detach();
      clear(panesEl);
      screen.attach(panesEl);
      attached = screen;
    }
    // Always, not only on a change: the emulator may have arrived since the last draw, and a fit whose
    // size is the size it already has answers null and sends nothing.
    if (attached) void fit();
  }

  function clearActive() {
    const screen = attached;
    if (!screen) return ext.toast("No terminal selected.", { tone: "info" });
    screen.clear();
  }

  // ---- drawing ----

  function draw() {
    if (!alive) return;
    const all = store.list();
    if (!chosen || !all.some((s) => s.id === chosen)) {
      // The open conversation's first live shell, else any live shell, else whatever there is.
      const rows = ordered();
      chosen = (rows.find((s) => store.mine(s) && s.state !== "closed") ?? rows.find((s) => s.state !== "closed") ?? rows[0])?.id ?? null;
    }
    unread.delete(chosen); // the row on screen is being looked at, whatever printed before it was chosen
    drawTabs();
    drawFoot();
    showPane();
  }

  // A redraw while a name is being typed would take the field away mid-word, as the sidebar's rename does not.
  const redraw = () => {
    if (!renaming) draw();
  };
  const unwatch = store.watch(redraw);
  // Output arrived in a shell you are not looking at: its row brightens. Once is enough until it is chosen,
  // and a replay of what the shell printed before this page found it is not news.
  const unwatchOutput = store.watchOutput((id, replay) => {
    if (replay || id === chosen || unread.has(id) || renaming) return;
    unread.add(id);
    drawTabs();
  });
  // Which conversation is open decides which rows come first and which say they belong elsewhere; the
  // chosen row follows to the new conversation's first shell.
  const unwatchConversation = ext.conversation.watch((id) => {
    const first = ordered().find((s) => store.mine(s, id ?? null) && s.state !== "closed");
    if (first) chosen = first.id;
    redraw();
  });
  const ticking = setInterval(tick, REDRAW_MS);
  // One observer for the pane: the mount, the shelf's grip, the window and the open animation all end in
  // a pane of a new size, and the debounce keeps a drag from sending a `resize` per frame.
  const observer = new ResizeObserver(scheduleFit);
  observer.observe(panesEl);
  // The shelf says when its animation, a drag or a collapse has settled; the chip's `.is-on` follows the same word.
  const unfit = shelf?.fit?.(() => {
    scheduleFit();
    ext.redraw("terminal");
  });
  draw();

  return () => {
    alive = false;
    clearInterval(ticking);
    clearTimeout(sizing);
    observer.disconnect();
    unfit?.();
    unwatch();
    unwatchOutput();
    unwatchConversation?.();
    closeCard();
    closePopover();
    attached?.detach(); // the emulator and its scrollback belong to the session, not to this view
    attached = null;
    clear(root);
  };
}
