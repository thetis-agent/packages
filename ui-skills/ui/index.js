/* The Skills dock: what the open conversation can reach among the skills, and which are in force. The
 * groups fold, as the inspector's always did: the loader in force (or that none is installed), the
 * problems lint found, the skills always in force, the ones retrieved for this conversation with their
 * score drawn as a bar against the best in the group and how they got there in words, the bodies the
 * model loaded, what the project switched off, what the loader dropped for its budget, its notes, and
 * the catalogue, grouped by skill family (the first segment of the id) with each family its own fold.
 * Every group carries a count and a sentence saying what it means; which groups the reader has folded is
 * remembered across redraws and visits. A card shows the name, the id, the brief, pills for what is
 * nested and what files sit beside the body, and a Details fold with the whole description, the nested
 * ids, the files, the tags and the related skills; clicking its head opens the skill's text in the dock.
 * The search ranks the catalogue by BM25 in the page, on the answer already held, so a keystroke sends
 * nothing. The data comes from the package's `skills` command; a body from `skill` once per skill and
 * content hash. Drawing never sends: `draw()` reads what is held here and, finding no answer for the
 * conversation, queues the one request after it returns, guarded by `pending`. A `turn.end` of the open
 * conversation marks the answer stale and asks once more. The module does nothing at import; the shell
 * calls `install(ext)` once after the page has mounted. */

import { bm25Index, bm25Search } from "./rank.js";

const DOCK = "skills";
const NO_LOADER = "No skill loader is installed. Install one of @thetis/skills-hybrid, @thetis/skills-l1 or @thetis/skills-all.";
const FOLDS = "thetis.skills.folds";

/** How a skill got where it is, in words, with the longer reading on hover. */
const HOW = {
  dense: { label: "semantic match", hint: "The opening message and this skill's card were embedded, and their meanings landed close together." },
  lexical: { label: "word overlap", hint: "Scored on the words the opening message and this skill's card share." },
  "parent-of-match": { label: "parent of a match", hint: "A skill nested inside this one matched, so the parent came along to explain it." },
  "whole-corpus": { label: "everything included", hint: "The corpus is no larger than the retrieval limit, so ranking was skipped and every skill was included." },
  pinned: { label: "pinned earlier", hint: "Retrieved for this conversation before scores were recorded, so no score is shown." },
};

export default function install(ext) {
  const { el, clear } = ext.dom;
  let answer = null; // { session, data, byId, index } | { session, error }, for the conversation it was asked for
  let pending = null; // { session } while the request is out
  let stale = false; // a turn ended since the answer was asked for; ask again
  let query = "";
  let open = null; // the id of the skill whose text is on screen, or null for the list
  const bodies = new Map(); // `${id}@${contentHash}` -> the `skill` answer, or { error }
  let reading = null; // the key of the body being asked for
  const folds = loadFolds(); // group key -> open (true) or folded (false), as the reader last left it

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

  // --- pieces ---

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

  /** The quiet pills: what is nested under the skill and what files sit beside its body. */
  function pills(skill) {
    const out = [];
    if (skill.children.length) out.push(el("span", { class: "sk-pill", title: `Contains ${skill.children.join(", ")}` }, `${skill.children.length} nested`));
    if (skill.resources.length) out.push(el("span", { class: "sk-pill", title: `Read on demand: ${skill.resources.join(", ")}` }, `${plural(skill.resources.length, "file")}`));
    if (skill.version) out.push(el("span", { class: "sk-pill" }, `v${skill.version}`));
    return out;
  }

  /** The score as a bar against the best in the group, the number, and how the skill got there. */
  function score(p, top) {
    const how = HOW[p.how];
    if (p.score == null) return how ? el("span", { class: "sk-row-score", title: how.hint }, how.label) : null;
    const share = Math.max(4, Math.round((p.score / (top || p.score || 1)) * 100));
    const fill = el("span", { class: "sk-score-fill" });
    fill.style?.setProperty?.("--share", `${share}%`);
    return el("span", { class: "sk-score", title: how?.hint ?? null }, el("span", { class: "sk-score-bar" }, fill), el("span", { class: "sk-row-score" }, `score ${p.score}${p.how ? ` · ${p.how}` : ""}`));
  }

  /** What the Details fold of a card holds: everything the head leaves out. */
  function details(skill) {
    const rows = [];
    if (skill.description && skill.description !== skill.short) rows.push(el("p", { class: "sk-desc" }, skill.description));
    if (skill.children.length) rows.push(el("p", { class: "sk-meta" }, el("strong", {}, "Nested: "), skill.children.join(", ")));
    if (skill.resources.length) rows.push(el("p", { class: "sk-meta" }, el("strong", {}, "Files: "), skill.resources.join(", ")));
    if (skill.tags.length) rows.push(el("p", { class: "sk-meta" }, el("strong", {}, "Tags: "), skill.tags.join(", ")));
    if (skill.related.length) rows.push(el("p", { class: "sk-meta" }, el("strong", {}, "Related: "), skill.related.join(", ")));
    for (const p of skill.problems) rows.push(el("p", { class: `sk-meta sk-problem is-${p.level}` }, el("strong", {}, `${p.level}: `), p.message));
    rows.push(el("p", { class: "sk-meta" }, el("strong", {}, "From: "), skill.package ?? "your skills/"));
    return rows.length ? el("details", { class: "sk-more" }, el("summary", {}, "Details"), ...rows) : null;
  }

  /**
   * One card: the head opens the skill's text; the pills and the Details fold stay on the card. `extra`
   * is a score or a note the group adds; `tree` indents by depth so a subtree reads as one.
   */
  function row(skill, data, { extra = null, tree = false } = {}) {
    const off = data.excluded.includes(skill.id);
    const depth = skill.id.split("/").length - 1;
    const card = el(
      "article",
      { class: `sk-row${off ? " is-off" : ""}${depth ? " is-nested" : ""}${skill.universal ? " is-on" : ""}`, "data-skill": skill.id },
      el(
        "button",
        { type: "button", class: "sk-row-open", title: `Open ${skill.id}`, onClick: () => show(skill.id) },
        el("span", { class: "sk-row-head" }, el("span", { class: "sk-row-name" }, skill.title || skill.name || skill.id), el("code", { class: "sk-row-id" }, skill.id), ...badges(skill, data), ...pills(skill), el("span", { class: "sk-row-pkg" }, skill.package ?? "your skills/")),
        skill.short ? el("span", { class: "sk-row-brief" }, skill.short) : null,
        extra
      ),
      details(skill)
    );
    if (tree && depth) card.style?.setProperty?.("--depth", String(depth));
    return card;
  }

  /** A row for an id the state names; an id the catalogue no longer has gets a plain row that opens nothing. */
  function rowFor(id, data, opts) {
    const skill = answer.byId.get(id);
    if (skill) return row(skill, data, opts);
    return el("div", { class: "sk-row is-missing", "data-skill": id }, el("span", { class: "sk-row-head" }, el("code", { class: "sk-row-id" }, id), ext.ui.badge("not in the catalogue", "dim")));
  }

  /** A group that folds: the title, its count, its sentence, then the rows; open as the reader last left it, else as `openByDefault`. */
  function group(key, label, { count = null, note = null, openByDefault = true, extra = null, cls = `sk-section sk-${key}` }, ...body) {
    const isOpen = folds.has(key) ? folds.get(key) : openByDefault;
    const node = el(
      "details",
      { class: cls, open: isOpen ? "" : null, onToggle: (e) => { folds.set(key, Boolean(e.target.open)); saveFolds(folds); } },
      el("summary", { class: "sk-summary" }, el("span", { class: "section-label" }, label), count != null ? el("span", { class: "sk-count" }, String(count)) : null, extra, note ? el("span", { class: "section-note" }, note) : null),
      el("div", { class: "sk-group-body" }, ...body)
    );
    return node;
  }

  const empty = (sentence) => el("div", { class: "sk-empty" }, sentence);
  const rows = (nodes) => el("div", { class: "sk-rows" }, ...nodes);

  function legend() {
    const step = (level, name, note) => el("li", { class: "sk-legend-step" }, el("span", { class: "sk-legend-tag" }, level), el("span", {}, el("strong", {}, name), " ", note));
    return el(
      "details",
      { class: "sk-legend", open: folds.get("legend") ? "" : null, onToggle: (e) => { folds.set("legend", Boolean(e.target.open)); saveFolds(folds); } },
      el("summary", {}, "How skills reach the prompt"),
      el("ol", { class: "sk-legend-steps" }, step("L0", "Brief", "one line. Universal skills are named in every prompt by this alone."), step("L1", "Card", "brief, when to use, nested skills. Added for the skills retrieved below."), step("L2", "Body", "the instructions. Read only when the agent opens the skill by id."), step("L3", "Files", "references, scripts and assets, read one at a time on demand."))
    );
  }

  // --- the groups ---

  function loaderSection(data, session) {
    if (!session) return el("section", { class: "sk-section sk-loader" }, el("div", { class: "section-head" }, el("span", { class: "section-label" }, "Loader")), empty("Open a conversation to see which loader is in force and what it put in the prompt."));
    const body = data.loader
      ? el("div", { class: "sk-loader-line" }, el("code", { class: "sk-loader-name" }, data.loader), el("span", { class: "text-faint" }, "wrote the prompt of the last turn"))
      : empty(data.loaders.length ? `${data.loaders.join(", ")} is installed; it writes what it did after the first turn of this conversation.` : NO_LOADER);
    return el("section", { class: "sk-section sk-loader" }, el("div", { class: "section-head" }, el("span", { class: "section-label" }, "Loader")), body);
  }

  function problemsSection(data) {
    const broken = data.skills.filter((s) => s.problems.length);
    if (!broken.length) return null;
    const errors = broken.filter((s) => s.problems.some((p) => p.level === "error"));
    const list = [...errors, ...broken.filter((s) => !errors.includes(s))].map((s) => el("div", { class: `sk-diag is-${s.problems.some((p) => p.level === "error") ? "error" : "warning"}` }, el("code", { class: "sk-row-id" }, s.id), ...s.problems.map((p) => el("span", { class: "sk-diag-text" }, p.message))));
    return group("problems", "Problems", { count: broken.length, note: errors.length ? "A skill with an error is left out entirely, so it can never be retrieved." : "These skills load, but retrieval finds them less reliably.", openByDefault: true }, ...list);
  }

  function universalSection(data) {
    const top = Math.max(0, ...data.pinned.map((p) => p.score ?? 0));
    if (data.loader) {
      const list = data.universal.map((id) => { const p = data.pinned.find((x) => x.id === id); return rowFor(id, data, { extra: p ? score(p, top) : null }); });
      return group("universal", "Always in force", { count: list.length, note: "Named in every prompt by their brief, whatever the conversation is about; their bodies travel too." }, list.length ? rows(list) : empty("No skill is universal."));
    }
    const declared = data.skills.filter((s) => s.universal && !data.excluded.includes(s.id));
    return group("universal", "Always in force", { count: declared.length, note: "Declared universal; a loader puts these in force." }, declared.length ? rows(declared.map((s) => row(s, data))) : empty("No skill is universal."));
  }

  function pinnedSection(data) {
    const top = Math.max(0, ...data.pinned.map((p) => p.score ?? 0));
    const chosen = data.pinned.filter((p) => !data.universal.includes(p.id));
    const list = chosen.map((p) => rowFor(p.id, data, { extra: score(p, top) }));
    const note = chosen.length ? "Ranked against the opening message, then pinned; the same set every turn, which keeps the prompt cacheable." : data.pinned.length ? "Everything that ranked highest is always in force already, so retrieval added nothing new." : "Nothing yet. Retrieval runs once, on the first message of a conversation.";
    return group("pinned", "Retrieved for this conversation", { count: chosen.length, note }, list.length ? rows(list) : empty(data.pinned.length ? "The scores sit on the always-in-force rows above." : "Nothing retrieved yet."));
  }

  function loadedSection(data) {
    return group("loaded", "Loaded in this conversation", { count: data.loaded.length, note: "Bodies the model asked for; they stay in the prompt." }, rows(data.loaded.map((id) => rowFor(id, data))));
  }

  function offSection(data) {
    const list = data.excluded.map((id) => rowFor(id, data));
    return group("off", "Switched off by the project", { count: list.length, note: list.length ? "Left out of the prompt and of skill_fetch. A switched-off parent takes its nested skills with it." : null, openByDefault: false }, list.length ? rows(list) : empty("Nothing is switched off by a project."));
  }

  function droppedSection(data) {
    return group("dropped", "Left out for the budget", { count: data.dropped.length, note: "The loader ran out of room before these.", openByDefault: false }, rows(data.dropped.map((id) => rowFor(id, data))));
  }

  function notesSection(data) {
    return group("notes", "Notes", { count: data.notes.length, openByDefault: false }, el("ul", { class: "sk-notes-list" }, ...data.notes.map((n) => el("li", {}, n))));
  }

  /** The catalogue by family (the first segment of the id), each a fold with its count and where its skills come from; a query flattens it to a ranked list. */
  function renderCatalogue(list, data) {
    clear(list);
    const q = query.trim();
    if (!q) {
      if (!data.skills.length) return list.append(empty("No skills are installed. A package that declares thetis.skills, or a skills/ directory under your home, adds some."));
      const families = new Map();
      for (const s of data.skills) {
        const family = s.id.split("/")[0];
        if (!families.has(family)) families.set(family, []);
        families.get(family).push(s);
      }
      for (const [family, members] of families) {
        const sources = [...new Set(members.map((s) => s.package ?? "your skills/"))];
        const inForce = members.filter((s) => s.universal || data.pinnedIds.has(s.id) || data.loaded.includes(s.id)).length;
        list.append(group(`family:${family}`, family, { count: members.length, note: `${sources.join(", ")}${inForce ? ` · ${inForce} in this prompt` : ""}`, openByDefault: false, cls: "sk-family" }, rows(members.map((s) => row(s, data, { tree: true })))));
      }
      return;
    }
    const hits = bm25Search(answer.index, q, 50);
    if (!hits.length) return list.append(empty(`No skill matches "${q}".`));
    list.append(rows(hits.map((h) => row(answer.byId.get(h.id), data, { extra: el("span", { class: "sk-row-score" }, `score ${h.score}`) }))));
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
    return group("catalogue", "Catalogue", { count: data.skills.length, note: `${plural(data.skills.length, "skill")} from ${plural(packages.size, "source")}, by family. The agent can open any of them by id.` }, input, list);
  }

  function drawList(root, data, session) {
    if (data.skills.length) root.append(legend());
    root.append(loaderSection(data, session));
    const problems = problemsSection(data);
    if (problems) root.append(problems);
    root.append(universalSection(data));
    if (data.pinned.length || data.loader) root.append(pinnedSection(data));
    if (data.loaded.length) root.append(loadedSection(data));
    root.append(offSection(data));
    if (data.dropped.length) root.append(droppedSection(data));
    if (data.notes.length) root.append(notesSection(data));
    root.append(catalogueSection(data));
    const parts = [plural(data.skills.length, "skill")];
    if (data.universal.length) parts.push(`${data.universal.length} always`);
    const chosen = data.pinned.filter((p) => !data.universal.includes(p.id)).length;
    if (chosen) parts.push(`${chosen} retrieved`);
    parts.push(data.loader ?? "no loader in force");
    return { title: "Skills", subtitle: parts.join(" · "), body: root };
  }

  // --- one skill ---

  function drawSkill(root, skill, data) {
    const back = el("button", { type: "button", class: "btn is-quiet sk-back", onClick: () => show(null) }, "← Skills");
    const head = el("div", { class: "sk-body-head" }, el("span", { class: "sk-row-name" }, skill.title || skill.name || skill.id), el("code", { class: "sk-body-id" }, skill.id), ...badges(skill, data), ...pills(skill), el("span", { class: "sk-row-pkg" }, skill.package ?? "your skills/"));
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

/** Which groups the reader folded, from the browser's storage; nothing outside a browser. */
function loadFolds() {
  try {
    return new Map(Object.entries(JSON.parse(globalThis.localStorage?.getItem(FOLDS) || "{}")));
  } catch {
    return new Map();
  }
}

function saveFolds(folds) {
  try {
    globalThis.localStorage?.setItem(FOLDS, JSON.stringify(Object.fromEntries(folds)));
  } catch {
    /* no storage: the folds last the page */
  }
}

const strings = (list) => (Array.isArray(list) ? list.filter((x) => typeof x === "string") : []);

/** The `skills` answer with every field present, so drawing never tests for one. */
function normalize(data) {
  const d = data && typeof data === "object" ? data : {};
  const skills = (Array.isArray(d.skills) ? d.skills : []).filter((s) => s && typeof s.id === "string").map((s) => ({ ...s, tags: strings(s.tags), children: strings(s.children), resources: strings(s.resources), related: strings(s.related), problems: Array.isArray(s.problems) ? s.problems.filter((p) => p && typeof p.message === "string") : [], version: typeof s.version === "string" ? s.version : "" }));
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
