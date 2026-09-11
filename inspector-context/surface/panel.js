/* The Context inspector: what the model actually received.
 *
 * Registers one tab and folds the frames the surface hands it. It opens no socket, asks for nothing,
 * and imports nothing from the surface but `/lib/surface.js` — the seam contract/surface describes.
 * Everything it can show is something the person's own conversation already told it.
 */

import { registerPanel, onEvent, conversation, el, icon, section } from "/lib/surface.js";
import { apply, blank, describe, forConversation, KINDS } from "./fold.js";
import { blocks, segmented, SEGMENTS } from "./view.js";

/** A stack of sheets: the prompt as layers laid one on the next. */
const LAYERS = ["M10 2.8 16.8 6.4 10 10 3.2 6.4 10 2.8Z", "M3.2 10 10 13.6 16.8 10", "M3.2 13.6 10 17.2 16.8 13.6"];

const states = new Map();
const dom = { el, section };
let segment = SEGMENTS[0].id;

/** The package's own stylesheet, added once. Same origin, so `default-src 'self'` permits it. */
function link(href) {
  if (document.querySelector(`link[href="${href}"]`)) return;
  document.head.append(el("link", { rel: "stylesheet", href }));
}

function draw() {
  const described = describe(states.get(conversation.current) ?? blank());
  return {
    title: "Context",
    subtitle: "what the model actually received",
    blocks: [segmented(segment, pick, dom), ...blocks(segment, described, dom)],
  };
}

function pick(id) {
  segment = id;
  panel.redraw();
}

link("/surface/inspector-context/panel.css");

const panel = registerPanel({
  id: "context",
  label: "Context",
  hint: "Context — what the model actually received",
  wide: true,
  icon: () => icon(LAYERS, { size: 17, width: 1.5 }),
  draw,
});

// A tab switch shows that conversation's own context, not whichever arrived last.
conversation.watch(() => { panel.redraw(); });

for (const kind of KINDS) {
  onEvent(kind, (frame) => {
    apply(forConversation(states, frame.session), frame);
    if (frame.session === conversation.current) panel.redraw();
  });
}
