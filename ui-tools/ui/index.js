/* The Tools dock: every tool the open conversation can call, one section per installed package, a
 * card per tool, and a filter that narrows by name or description without asking the server again.
 * The list comes from the package's own `tools` command once per conversation. Drawing never sends:
 * `draw()` only reads what is held here, and the shell has no open hook, so the first draw for a
 * conversation queues the one request after it returns, guarded by `pending`; a redraw finds the answer
 * and draws it, or finds the request in flight and waits. A refused request shows its sentence in the
 * body, where the person is looking, not as a toast. The module does nothing at import; the shell calls
 * `install(ext)` once after the page has mounted. */

const DOCK = "tools";
const VERB = "tools";

export default function install(ext) {
  const { el, clear } = ext.dom;
  let answer = null; // { session, packages } | { session, error }, for the conversation it was asked for
  let pending = null; // { session } while the request is out
  let filter = "";

  const current = () => ext.conversation.current ?? null;

  async function ask() {
    const session = current();
    if (pending || (answer && answer.session === session)) return;
    pending = { session };
    try {
      const out = await ext.request(VERB, { session: session ?? undefined });
      const packages = Array.isArray(out?.data?.packages) ? out.data.packages : [];
      answer = { session, packages };
    } catch (err) {
      answer = { session, error: err?.message || "The gateway did not answer." };
    } finally {
      pending = null;
    }
    ext.redraw(DOCK);
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  function matches(tool, q) {
    return !q || tool.name.toLowerCase().includes(q) || tool.description.toLowerCase().includes(q);
  }

  function params(required) {
    if (!required.length) return ["no required parameters"];
    return ["requires ", ...required.flatMap((name, i) => [i ? ", " : null, el("code", {}, name)])];
  }

  function card(tool) {
    return el(
      "div",
      { class: "card ui-tools-card", "data-tool": tool.name },
      el("div", { class: "ui-tools-card-head" }, el("span", { class: "ui-tools-card-title" }, tool.name), ext.ui.badge(tool.reads ? "reads only" : "changes files", tool.reads ? "ok" : "warn")),
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
    const body = pkg.tools.length ? el("div", { class: "ui-tools-grid" }, ...pkg.tools.map(card)) : el("div", { class: "ui-tools-empty" }, "This package declares no tools.");
    return el("section", { class: "ui-tools-section", "data-package": pkg.name }, head, body);
  }

  /* Projects (phase 5) and mode packages will name here the tools they withhold from this
   * conversation. Nothing withholds a tool yet, so the section says so and stays empty. */
  function withheld() {
    return el(
      "section",
      { class: "ui-tools-section is-withheld" },
      el("div", { class: "section-head" }, el("span", { class: "section-label" }, "Turned off right now"), el("span", { class: "section-note" }, "Nothing is withheld in this conversation."))
    );
  }

  /** Fills `list` from `packages` under the current filter. Client-side only; no request. */
  function render(list, packages) {
    clear(list);
    const q = filter.trim().toLowerCase();
    const shown = packages
      .map((pkg) => ({ ...pkg, tools: pkg.tools.filter((tool) => matches(tool, q)) }))
      .filter((pkg) => !q || pkg.tools.length || pkg.name.toLowerCase().includes(q));
    if (!shown.length) list.append(el("div", { class: "ui-tools-empty" }, q ? `No tool matches "${filter.trim()}".` : "No packages are installed."));
    for (const pkg of shown) list.append(section(pkg));
    list.append(withheld());
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
    const packages = answer.packages;
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
        render(list, packages);
      },
    });
    render(list, packages);
    root.append(input, list);
    return { title: "Tools", subtitle: `${plural(total, "tool")} from ${plural(withTools, "package")}`, body: root };
  }

  ext.dock(DOCK, { draw });
  // A new conversation on screen: the open dock redraws, finds no answer for it, and asks once more.
  ext.conversation.watch(() => ext.redraw(DOCK));
}
