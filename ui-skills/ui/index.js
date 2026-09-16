/* The Skills dock: what the open conversation can reach among the skills, and which are in force. The
 * loader in force (or the fact that none is installed), the universal skills, the pinned cards with their
 * score and `how`, the bodies the model loaded, what the project switched off, and the catalogue with a
 * search box that ranks the rows by BM25 in the page, on the answer already held, so a keystroke sends
 * nothing. Every row opens the skill's text in the dock, rendered through `ext.markdown`, with a back link.
 * The data comes from the package's `skills` command, which merges the loader's state for the conversation
 * (`harness["@thetis/skills"]`) with the catalogue and the project's switches; a body comes from `skill`
 * once per skill and content hash. Drawing never sends: `draw()` reads what is held here and, finding no
 * answer for the conversation, queues the one request after it returns, guarded by `pending`. A `turn.end`
 * of the open conversation marks the answer stale and asks once more, as the Tools dock does. A refused
 * request shows its sentence in the body. The module does nothing at import; the shell calls
 * `install(ext)` once after the page has mounted. */

import { bm25Index, bm25Search } from "./rank.js";

const DOCK = "skills";
const NO_LOADER = "No skill loader is installed. Install one of @thetis/skills-hybrid, @thetis/skills-l1 or @thetis/skills-all.";

export default function install(ext) {
  const { el, clear } = ext.dom;
  let answer = null; // { session, data, byId, index } | { session, error }, for the conversation it was asked for
  let pending = null; // { session } while the request is out
  let stale = false; // a turn ended since the answer was asked for; ask again
  let query = "";
  let open = null; // the id of the skill whose text is on screen, or null for the list
  const bodies = new Map(); // `${id}@${contentHash}` -> the `skill` answer, or { error }
  let reading = null; // the key of the body being asked for

  const current = () => ext.conversation.current ?? null;

  async function ask() {
    const session = current();
    if (pending || (answer && answer.session === session && !stale)) return;
    pending = { session };
    stale = false;
    try {
      const out = await ext.request("skills", { session: session ?? undefined });
      const data = normalize(out?.data);
      answer = { session, data, byId: new Map(data.skills.map((s) => [s.id, s])), index: bm25Index(data.skills) };
    } catch (err) {
      answer = { session, error: err?.message || "The gateway did not answer." };
    } finally {
      pending = null;
    }
    ext.redraw(DOCK);
    if (stale) queueMicrotask(ask);
  }

  /** Asks for one skill's text, once per id and content hash. */
  async function read(skill) {
    const key = keyOf(skill);
    if (bodies.has(key) || reading === key) return;
    reading = key;
    try {
      const out = await ext.request("skill", { session: current() ?? undefined, args: { id: skill.id } });
      bodies.set(key, out?.data && typeof out.data.text === "string" ? out.data : { error: "The gateway answered without a text." });
    } catch (err) {
      bodies.set(key, { error: err?.message || "The gateway did not answer." });
    } finally {
      reading = null;
    }
    ext.redraw(DOCK);
  }

  function show(id) {
    open = id;
    ext.redraw(DOCK);
  }

  // --- rows ---

  function badges(skill, data) {
    const out = [];
    if (skill.universal) out.push(ext.ui.badge("always", "ok"));
    if (data.pinnedIds.has(skill.id)) out.push(ext.ui.badge("pinned", "accent"));
    if (data.loaded.includes(skill.id)) out.push(ext.ui.badge("loaded", "accent"));
    if (data.excluded.includes(skill.id)) out.push(ext.ui.badge("switched off", "warn"));
    if (data.dropped.includes(skill.id)) out.push(ext.ui.badge("dropped", "dim"));
    if (skill.error) out.push(ext.ui.badge("left out", "warn"));
    return out;
  }

  /** One clickable row: the id, the title, the badges, where it comes from, and the first sentence. */
  function row(skill, data, extra = null) {
    const off = data.excluded.includes(skill.id);
    return el(
      "button",
      { type: "button", class: `sk-row${off ? " is-off" : ""}${skill.id.includes("/") ? " is-nested" : ""}`, "data-skill": skill.id, title: `Open ${skill.id}`, onClick: () => show(skill.id) },
      el(
        "span",
        { class: "sk-row-head" },
        el("code", { class: "sk-row-id" }, skill.id),
        skill.title ? el("span", { class: "sk-row-title" }, skill.title) : null,
        ...badges(skill, data),
        extra,
        el("span", { class: "sk-row-pkg" }, skill.package ?? "your skills/")
      ),
      skill.short ? el("span", { class: "sk-row-brief" }, skill.short) : null
    );
  }

  /** A row for an id the state names; an id the catalogue no longer has gets a plain row that opens nothing. */
  function rowFor(id, data, extra = null) {
    const skill = answer.byId.get(id);
    if (skill) return row(skill, data, extra);
    return el("div", { class: "sk-row is-missing", "data-skill": id }, el("span", { class: "sk-row-head" }, el("code", { class: "sk-row-id" }, id), ext.ui.badge("not in the catalogue", "dim")));
  }

  function section(cls, label, note, ...body) {
    return el("section", { class: `sk-section ${cls}` }, el("div", { class: "section-head" }, el("span", { class: "section-label" }, label), note ? el("span", { class: "section-note" }, note) : null), ...body);
  }

  const empty = (sentence) => el("div", { class: "sk-empty" }, sentence);
  const rows = (nodes) => el("div", { class: "sk-rows" }, ...nodes);

  // --- the list ---

  function loaderSection(data, session) {
    if (!session) return section("sk-loader", "Loader", null, empty("Open a conversation to see which loader is in force and what it put in the prompt."));
    if (data.loader) return section("sk-loader", "Loader", "Wrote the prompt of the last turn.", el("code", { class: "sk-loader-name" }, data.loader));
    if (data.loaders.length) return section("sk-loader", "Loader", null, empty(`${data.loaders.join(", ")} is installed; it writes what it did after the first turn of this conversation.`));
    return section("sk-loader", "Loader", null, empty(NO_LOADER));
  }

  function universalSection(data) {
    if (data.loader) {
      const list = data.universal.map((id) => rowFor(id, data));
      return section("sk-universal", "Always in force", "The bodies every prompt carries.", list.length ? rows(list) : empty("No skill is universal."));
    }
    const declared = data.skills.filter((s) => s.universal && !data.excluded.includes(s.id));
    return section("sk-universal", "Always in force", "Declared universal; a loader puts these in force.", declared.length ? rows(declared.map((s) => row(s, data))) : empty("No skill is universal."));
  }

  function pinnedSection(data) {
    const list = data.pinned.map((p) => rowFor(p.id, data, el("span", { class: "sk-row-score" }, p.score == null ? "" : `score ${p.score}`, p.how ? ` · ${p.how}` : "")));
    return section("sk-pinned", "Retrieved for this conversation", "Pinned on the first turn and kept since.", rows(list));
  }

  function loadedSection(data) {
    return section("sk-loaded", "Loaded in this conversation", "Bodies the model asked for; they stay in the prompt.", rows(data.loaded.map((id) => rowFor(id, data))));
  }

  function offSection(data) {
    const list = data.excluded.map((id) => rowFor(id, data));
    return section("sk-off", "Switched off by the project", list.length ? "Left out of the prompt and of skill_fetch. A switched-off parent takes its nested skills with it." : null, list.length ? rows(list) : empty("Nothing is switched off by a project."));
  }

  function droppedSection(data) {
    return section("sk-dropped", "Left out for the budget", "The loader ran out of room before these.", rows(data.dropped.map((id) => rowFor(id, data))));
  }

  function notesSection(data) {
    return section("sk-notes", "Notes", null, el("ul", { class: "sk-notes-list" }, ...data.notes.map((n) => el("li", {}, n))));
  }

  /** Fills `list` from the catalogue under the current query: BM25 over the rows held here, no request. */
  function renderCatalogue(list, data) {
    clear(list);
    const q = query.trim();
    if (!q) {
      if (!data.skills.length) return list.append(empty("No skills are installed. A package that declares thetis.skills, or a skills/ directory under your home, adds some."));
      return list.append(rows(data.skills.map((s) => row(s, data))));
    }
    const hits = bm25Search(answer.index, q, 50);
    if (!hits.length) return list.append(empty(`No skill matches "${q}".`));
    list.append(rows(hits.map((h) => row(answer.byId.get(h.id), data, el("span", { class: "sk-row-score" }, `score ${h.score}`)))));
  }

  function catalogueSection(data) {
    const list = el("div", { class: "sk-catalogue-list" });
    const input = el("input", {
      class: "input sk-search",
      type: "search",
      placeholder: "Search by name, description or tag",
      "aria-label": "Search skills",
      value: query,
      onInput: (e) => {
        query = e.target.value;
        renderCatalogue(list, data);
      },
    });
    renderCatalogue(list, data);
    const packages = new Set(data.skills.map((s) => s.package ?? ""));
    return section("sk-catalogue", "Catalogue", `${plural(data.skills.length, "skill")} from ${plural(packages.size, "source")}`, input, list);
  }

  function drawList(root, data, session) {
    root.append(loaderSection(data, session), universalSection(data));
    if (data.pinned.length) root.append(pinnedSection(data));
    if (data.loaded.length) root.append(loadedSection(data));
    root.append(offSection(data));
    if (data.dropped.length) root.append(droppedSection(data));
    if (data.notes.length) root.append(notesSection(data));
    root.append(catalogueSection(data));
    return { title: "Skills", subtitle: `${plural(data.skills.length, "skill")} · ${data.loader ?? "no loader in force"}`, body: root };
  }

  // --- one skill ---

  function drawSkill(root, skill, data) {
    const back = el("button", { type: "button", class: "btn is-quiet sk-back", onClick: () => show(null) }, "← Skills");
    const head = el("div", { class: "sk-body-head" }, el("code", { class: "sk-body-id" }, skill.id), skill.title ? el("span", { class: "sk-row-title" }, skill.title) : null, ...badges(skill, data), el("span", { class: "sk-row-pkg" }, skill.package ?? "your skills/"));
    const body = bodies.get(keyOf(skill));
    if (!body && reading !== keyOf(skill)) queueMicrotask(() => read(skill));
    const text = !body ? el("div", { class: "panel-empty" }, "Reading…") : body.error ? el("div", { class: "sk-error" }, body.error) : el("div", { class: "sk-body" }, ext.markdown(body.text));
    root.append(back, head, text);
    return { title: skill.id, subtitle: skill.short || skill.brief, body: root };
  }

  function draw() {
    const session = current();
    const fresh = answer && answer.session === session;
    if (!fresh && !pending) queueMicrotask(ask);
    if (!fresh) return { title: "Skills", subtitle: "Asking…", body: el("div", { class: "sk-dock" }, el("div", { class: "panel-empty" }, "Asking the gateway…")) };
    if (answer.error) return { title: "Skills", subtitle: "Could not list the skills", body: el("div", { class: "sk-dock" }, el("div", { class: "sk-error" }, answer.error)) };
    const skill = open ? answer.byId.get(open) : null;
    if (open && !skill) open = null;
    const root = el("div", { class: `sk-dock${skill ? " is-open" : ""}` });
    return skill ? drawSkill(root, skill, answer.data) : drawList(root, answer.data, session);
  }

  ext.dock(DOCK, { draw });
  // A new conversation on screen: back to the list; the open dock redraws, finds no answer for it, and asks.
  ext.conversation.watch(() => {
    open = null;
    ext.redraw(DOCK);
  });
  // A turn of the open conversation ended: the loader's state may have changed, so the answer is stale.
  ext.events.watch((message) => {
    if (message?.event?.type !== "turn.end" || message.session !== current()) return;
    stale = true;
    ask();
  });
}

const keyOf = (skill) => `${skill.id}@${skill.contentHash ?? ""}`;

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);

/** The `skills` answer with every field present, so drawing never tests for one. */
function normalize(data) {
  const d = data && typeof data === "object" ? data : {};
  const skills = (Array.isArray(d.skills) ? d.skills : []).filter((s) => s && typeof s.id === "string");
  const pinned = (Array.isArray(d.pinned) ? d.pinned : []).filter((p) => p && typeof p.id === "string");
  return {
    loader: typeof d.loader === "string" ? d.loader : null,
    loaders: strings(d.loaders),
    universal: strings(d.universal),
    pinned,
    pinnedIds: new Set(pinned.map((p) => p.id)),
    loaded: strings(d.loaded),
    catalogue: strings(d.catalogue),
    dropped: strings(d.dropped),
    notes: strings(d.notes),
    excluded: strings(d.excluded),
    skills,
  };
}
