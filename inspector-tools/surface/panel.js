/* The Tools inspector: everything the agent can call here, and what this mode is holding back.
 *
 * Registers one tab and folds the `offer` frames the surface hands it. It contributes no
 * transcript renderer: `tool-call` and `tool-result` rows belong to whoever claims those kinds, and
 * gateway-web's own built-in tool card draws them when nobody does (gateway-web/panels.ts refuses a
 * second contributor of one kind, by name). It opens no socket and imports nothing from the surface
 * but `/lib/surface.js` — the seam contract/surface describes.
 */

import { registerPanel, onEvent, conversation, el, icon, section, collapsibleSection } from "/lib/surface.js";
import { apply, blank, describe, forConversation, KINDS } from "./fold.js";
import { blocks, subtitle } from "./view.js";

/** A spanner: the thing that is offered, rather than the thing that is done with it. */
const SPANNER = ["M12.4 3.4a3.9 3.9 0 0 0-4.7 4.9l-4.1 4.1a1.6 1.6 0 0 0 2.2 2.2l4.1-4.1a3.9 3.9 0 0 0 4.9-4.7l-2.3 2.3-2-.4-.4-2 2.3-2.3Z"];

const states = new Map();
const dom = { el, section, collapsibleSection };
/** Source groups the person has opened, kept across redraws so a live turn does not fold them shut. */
const open = new Set();

/** The package's own stylesheet, added once. Same origin, so `default-src 'self'` permits it. */
function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

function draw() {
  const state = states.get(conversation.current);
  const described = describe(state ?? blank());
  return { title: "Tools", subtitle: subtitle(described), blocks: blocks(described, dom, open) };
}

link("/surface/inspector-tools/panel.css");

const panel = registerPanel({
  id: "tools",
  label: "Tools",
  hint: "Tools — everything the agent can call here, and what is withheld",
  wide: true,
  icon: () => icon(SPANNER, { size: 17, width: 1.5 }),
  draw,
});

// A tab switch shows that conversation's own offer, not whichever arrived last.
conversation.watch(() => { panel.redraw(); });

for (const kind of KINDS) {
  onEvent(kind, (frame) => {
    apply(forConversation(states, frame.session), frame);
    if (frame.session === conversation.current) panel.redraw();
  });
}
