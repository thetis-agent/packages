/* The Skills panel for a catalogue, not a ranking.
 *
 * `retriever-local` answers the question "which skills did the retriever pick, and how confident was
 * it"; this stage never picks and never scores, so a panel drawn the same way would be a column of
 * empty bars. The question here is the one the Agent Skills standard actually poses: every skill's
 * name and description is in the prompt, and the model chooses — so the panel shows the whole
 * catalogue the model is reading from, and marks the entries it has since asked to have loaded.
 *
 * It folds frames the surface already receives (`retrieve`, and the `load_skill` calls tracked in
 * rows.js). It opens no socket and asks for nothing.
 */

import { registerPanel, onEvent, conversation, el, section, icon } from "/lib/surface.js";
import { loadedIn, watchLoads } from "/surface/skills-l1/rows.js";

/** The newest catalogue per conversation, so switching tabs shows that tab's own prompt. */
const answers = new Map();

function entryCard(entry, isLoaded) {
  const state = isLoaded ? "loaded" : entry.universal ? "always in prompt" : "level 1";
  // The heading is the entry's id rather than its `name`, because the id is the string the model
  // must put in `load_skill`: for a nested skill the two differ, and only one of them works.
  return el("div", { class: `sl-card${isLoaded ? " is-loaded" : ""}` },
    el("div", { class: "sl-head" },
      el("div", {},
        el("h4", { class: "sl-id" }, entry.id),
        el("p", { class: "sl-pack" }, `${entry.pack}@${entry.version}`)),
      el("span", { class: `sl-pill${isLoaded || entry.universal ? " is-on" : ""}` }, state)),
    el("p", { class: "sl-desc" }, entry.description || ""));
}

function draw(current) {
  const answer = answers.get(current);
  if (!answer) return { title: "Skills", items: [], empty: "No catalogue yet — send a message to see what the model can reach for." };
  const entries = answer.entries ?? [];
  const dropped = answer.dropped ?? [];
  const marked = loadedIn(current);
  const blocks = [];
  if (entries.length) {
    blocks.push(section({
      title: "Catalogue", count: entries.length,
      note: "Every installed skill's name and description is in the prompt. The instructions are not: the model calls load_skill for those.",
    }));
    // Loaded first: a reader scanning the tab wants to know what this conversation is actually
    // working from before they want the list of everything it could work from.
    const order = [...entries].sort((one, other) => Number(marked.has(other.id)) - Number(marked.has(one.id)));
    blocks.push(...order.map(entry => entryCard(entry, marked.has(entry.id))));
  }
  if (dropped.length) {
    blocks.push(section({ title: "Dropped for budget", count: dropped.length, note: "Installed, but the catalogue would not fit the retrieval budget, so the model cannot name them." }));
    blocks.push(...dropped.map(id => el("div", { class: "sl-card is-dropped" }, el("h4", { class: "sl-id" }, id))));
  }
  return { title: "Skills", subtitle: `${String(marked.size)} of ${String(entries.length)} catalogued skills loaded`, blocks };
}

const BOOK = ["M4 4.5h5a2 2 0 0 1 2 2V16a1.6 1.6 0 0 0-1.6-1.4H4V4.5Z", "M16 4.5h-5a2 2 0 0 0-2 2V16a1.6 1.6 0 0 1 1.6-1.4H16V4.5Z"];

const panel = registerPanel({
  id: "skills",
  label: "Skills",
  hint: "Skills — the catalog this conversation carries, and what the model has loaded",
  icon: () => icon(BOOK, { size: 17 }),
  draw: () => draw(conversation.current),
});

// A tab switch shows that conversation's own catalogue, not whichever arrived last.
conversation.watch(() => { panel.redraw(); });

onEvent("retrieve", (frame) => {
  answers.set(frame.session, frame);
  if (frame.session === conversation.current) panel.redraw();
});

watchLoads((session) => { if (session === conversation.current) panel.redraw(); });
