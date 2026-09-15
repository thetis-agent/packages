/* The Tools dock: every tool the open conversation can call, one section per installed package, a
 * card per tool, a filter that narrows by name or description without asking the server again, and a
 * last section, "Turned off right now", naming the declared tools the conversation's last call did not
 * receive. The list comes from the package's own `tools` command, which also answers `lastCall`: the time
 * and the tool names `@thetis/harness-core` recorded after the last completed turn. The withheld set is
 * computed here as declared names minus those, so whatever filters `call.tools` in the call phase (a
 * project, a mode package) shows up without this dock naming it. Drawing never sends: `draw()` only
 * reads what is held here, and the shell has no open hook, so the first draw for a conversation queues
 * the one request after it returns, guarded by `pending`; a redraw finds the answer and draws it, or
 * finds the request in flight and waits. A `turn.end` of the open conversation marks the answer stale and
 * asks once more, so the section is right after the first turn; the seam does not say whether the dock
 * is open, so this happens for every turn of that conversation, one request per turn, and a turn that
 * ends during a request queues a single follow-up. A refused request shows its sentence in the body,
 * where the person is looking, not as a toast. The module does nothing at import; the shell calls
 * `install(ext)` once after the page has mounted. */

const DOCK = "tools";
const VERB = "tools";

export default function install(ext) {
  const { el, clear } = ext.dom;
  let answer = null; // { session, packages, lastCall } | { session, error }, for the conversation it was asked for
  let pending = null; // { session } while the request is out
  let stale = false; // a turn ended since the answer was asked for; ask again
  let filter = "";

  const current = () => ext.conversation.current ?? null;

  async function ask() {
    const session = current();
    if (pending || (answer && answer.session === session && !stale)) return;
    pending = { session };
    stale = false;
    try {
      const out = await ext.request(VERB, { session: session ?? undefined });
      const packages = Array.isArray(out?.data?.packages) ? out.data.packages : [];
      const lastCall = out?.data?.lastCall && Array.isArray(out.data.lastCall.tools) ? out.data.lastCall : null;
      answer = { session, packages, lastCall };
    } catch (err) {
      answer = { session, error: err?.message || "The gateway did not answer." };
    } finally {
      pending = null;
    }
    ext.redraw(DOCK);
    if (stale) queueMicrotask(ask);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function when(iso) {
    const ms = Date.parse(iso);
    return Number.isFinite(ms) ? new Date(ms).toLocaleString() : "an unknown time";
  }

  function matches(tool, q) {
    return !q || tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q);
  }

  function params(required) {
    if (!required.length) return ["no required parameters"];
    return ["requires ", ...required.flatMap((name, i) => [i ? ", " : null, el("code", {}, name)])];
  }

  function card(tool, badge = ext.ui.badge(tool.reads ? "reads only" : "changes files", tool.reads ? "ok" : "warn")) {
    return el(
      "div",
      { class: "card ui-tools-card", "data-tool": tool.name },
      el("div", { class: "ui-tools-card-head" }, el("span", { class: "ui-tools-card-title" }, tool.name), badge),
      tool.description && el("p", { class: "ui-tools-card-desc" }, tool.description),
      el("div", { class: "ui-tools-card-params" }, params(tool.required))
    );
  }

  function section(pkg) {
    const head = el(
      "div",
      { class: "section-head" },
      el("span", { class: "section-label ui-tools-name" }, pkg.name),
      el("span", { class: "ui-tools-version" }, pkg.version),
      el("span", { class: "ui-tools-count" }, plural(pkg.tools.length, "tool")),
      pkg.description && el("span", { class: "section-note" }, pkg.description)
    );
    const body = pkg.tools.length ? el("div", { class: "ui-tools-grid" }, ...pkg.tools.map((tool) => card(tool))) : el("div", { class: "ui-tools-empty" }, "This package declares no tools.");
    return el("section", { class: "ui-tools-section", "data-package": pkg.name }, head, body);
  }

  /** The declared tools whose names the last call did not carry, in declaration order; empty before a call. */
  function withheldOf(packages, lastCall) {
    if (!lastCall) return [];
    const sent = new Set(lastCall.tools);
    return packages.flatMap((pkg) => pkg.tools.filter((tool) => !sent.has(tool.name)));
  }

  /* Whatever filtered `call.tools` in the call phase (a project, a mode package) left these out of the
   * last call. The dock names the tools, not the package that held them back: it only knows the difference. */
  function withheld(packages, lastCall, q) {
    const tools = withheldOf(packages, lastCall).filter((tool) => matches(tool, q));
    const note = !lastCall
      ? "No call yet in this conversation."
      : tools.length
        ? `Not sent on the last call (${when(lastCall.at)}). A project or a mode package holds these back.`
        : "Nothing is withheld in this conversation.";
    return el(
      "section",
      { class: "ui-tools-section is-withheld" },
      el("div", { class: "section-head" }, el("span", { class: "section-label" }, "Turned off right now"), tools.length ? el("span", { class: "ui-tools-count" }, plural(tools.length, "tool")) : null, el("span", { class: "section-note" }, note)),
      tools.length ? el("div", { class: "ui-tools-grid" }, ...tools.map((tool) => card(tool, ext.ui.badge("withheld", "dim")))) : null
    );
  }

  /** Fills `list` from `packages` and `lastCall` under the current filter. Client-side only; no request. */
  function render(list, packages, lastCall) {
    clear(list);
    const q = filter.trim().toLowerCase();
    const shown = packages
      .map((pkg) => ({ ...pkg, tools: pkg.tools.filter((tool) => matches(tool, q)) }))
      .filter((pkg) => !q || pkg.tools.length || pkg.name.toLowerCase().includes(q));
    if (!shown.length) list.append(el("div", { class: "ui-tools-empty" }, q ? `No tool matches "${filter.trim()}".` : "No packages are installed."));
    for (const pkg of shown) list.append(section(pkg));
    list.append(withheld(packages, lastCall, q));
  }

  function draw() {
    const session = current();
    const fresh = answer && answer.session === session;
    if (!fresh && !pending) queueMicrotask(ask);
    const root = el("div", { class: "ui-tools" });
    if (!fresh) {
      root.append(el("div", { class: "panel-empty" }, "Asking the gateway…"));
      return { title: "Tools", subtitle: "Asking…", body: root };
    }
    if (answer.error) {
      root.append(el("div", { class: "ui-tools-error" }, answer.error));
      return { title: "Tools", subtitle: "Could not list the tools", body: root };
    }
    const { packages, lastCall } = answer;
    const total = packages.reduce((n, pkg) => n + pkg.tools.length, 0);
    const withTools = packages.filter((pkg) => pkg.tools.length).length;
    const list = el("div", { class: "ui-tools-list" });
    const input = el("input", {
      class: "input ui-tools-filter",
      type: "search",
      placeholder: "Filter by name or description",
      "aria-label": "Filter tools",
      value: filter,
      onInput: (e) => {
        filter = e.target.value;
        render(list, packages, lastCall);
      },
    });
    render(list, packages, lastCall);
    root.append(input, list);
    return { title: "Tools", subtitle: `${plural(total, "tool")} from ${plural(withTools, "package")}`, body: root };
  }

  ext.dock(DOCK, { draw });
  // A new conversation on screen: the open dock redraws, finds no answer for it, and asks once more.
  ext.conversation.watch(() => ext.redraw(DOCK));
  // A turn of the open conversation ended: its last call may have changed, so the answer is stale. The
  // old one stays on screen until the new one lands; a turn that ends mid-request queues one follow-up.
  ext.events.watch((message) => {
    if (message?.event?.type !== "turn.end" || message.session !== current()) return;
    stale = true;
    ask();
  });
}
