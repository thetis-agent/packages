/* The project pill in the composer, beside the model pill: "● Torchship ▾", or "No project ▾". It says where
 * the message being typed will land, and it is where that is changed. On the draft, picking a project
 * enters its space, and the draft and the typed text come along. On a conversation the list is headed "Move
 * to": picking moves the conversation, and the shell's space follows it. A subagent's conversation is in
 * its root's project, so its pill only says which. The dot's colour comes from the project id, one of
 * eight classes in index.css, grey for none: the page's CSP forbids an inline style. */

const CARET = ["M5 8l5 5 5-5"];
const CHECK = ["M4.5 10.5l3.5 3.5 7.5-8"];
const COLOURS = 8;
const PLACE = "project";

/** One of the dot classes, the same for an id on every page. */
export function dotClass(id) {
  if (!id) return "is-none";
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `is-c${h % COLOURS}`;
}

export function mountPill(ext, state, root) {
  const { el, icon } = ext.dom;
  let close = null;

  const dot = el("span", { class: "pj-dot is-none", "aria-hidden": "true" });
  const label = el("span", { class: "pj-pill-label" });
  const button = el(
    "button",
    { type: "button", class: "pj-pill", "aria-haspopup": "menu", "aria-expanded": "false", onClick: () => (close ? close() : open()) },
    dot,
    label,
    icon(CARET, { size: 10, width: 2 })
  );
  button.querySelector("svg").classList.add("pj-caret");
  root.append(button);

  /** The open conversation, and whether it is a root one: subagents are not in the sidebar's list. */
  function target() {
    const id = ext.conversation.current ?? null;
    if (!id) return { session: null, root: false };
    return { session: id, root: (ext.sessions.list() ?? []).some((s) => s.id === id) };
  }

  /** The project the pill names: the draft's space, a conversation's own, or the space while unknown. */
  function shown({ session, root: isRoot }) {
    if (!session || !isRoot) return state.chosen;
    const of = state.of(session);
    return of === undefined ? state.chosen : of;
  }

  function draw() {
    const now = target();
    const id = shown(now);
    const project = id ? state.project(id) : null;
    dot.className = `pj-dot ${dotClass(project ? id : null)}`;
    label.textContent = project ? project.name : id && !state.known ? "Project" : "No project";
    const fixed = Boolean(now.session && !now.root);
    button.disabled = fixed;
    button.title = fixed ? "A subagent works in its conversation's project" : now.session ? "Which project this conversation is in" : "Which project the new conversation starts in";
  }

  function pick(now, id) {
    if (!now.session) return state.enter(id);
    state.assign(now.session, id).catch((err) => ext.toast(err?.message || "The conversation could not be moved.", { tone: "error" }));
  }

  function open() {
    const now = target();
    if (now.session && !now.root) return;
    const selected = shown(now) ?? null;
    const row = (id, text) => ({ label: text, icon: (id ?? null) === selected ? CHECK : null, run: () => pick(now, id) });
    const items = [
      now.session ? { label: "Move to", disabled: true } : null,
      ...state.projects.map((p) => row(p.id, p.name)),
      row(null, "No project"),
      "-",
      { label: "New project…", run: () => ext.open.place(PLACE, { new: true }) },
    ].filter(Boolean);
    button.setAttribute("aria-expanded", "true");
    close = ext.ui.menu(button, items, {
      onClose: () => {
        close = null;
        button.setAttribute("aria-expanded", "false");
      },
    });
    void state.refresh();
  }

  const stops = [state.watch(draw), ext.conversation.watch(draw), ext.sessions.watch?.(draw)];
  draw();
  return () => {
    close?.();
    for (const stop of stops) if (typeof stop === "function") stop();
    button.remove();
  };
}
