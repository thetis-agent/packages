/* Who this surface is for, as the page was served.
 *
 * The name and the colour are configuration. They reach the browser twice, on
 * purpose and from one source: filled into the served page (so the window
 * title, the tab icon and the sidebar are right on the first paint, before any
 * connection exists), and again in the `user` frame (so anything a script
 * builds afterwards — the composer's prompt, an avatar's letter — reads one
 * live value rather than carrying its own copy of the word).
 *
 * This module is the first half: it reads what the page was served with, and
 * lib/store.js starts `agent` from it. app.js replaces that the moment the
 * frame lands. If the two ever disagree the frame wins, because it came from
 * the same process that filled the page and is simply the later answer.
 */

/** The default, for a page opened without the fill-in — a stale cached copy, a
 *  file opened straight off disk during development. Never blank: an empty
 *  brand shows as a hole in the sidebar rather than as a missing setting. */
const FALLBACK = { name: "Thetis", accent: "#7c9cff" };

/** What the served page says the agent is called, and the colour it is drawn in. */
export function pageAgent() {
  const data = document.documentElement.dataset;
  const name = (data.agentName || "").trim();
  const accent = (data.agentAccent || "").trim();
  return {
    name: name && !name.startsWith("{") ? name : FALLBACK.name,
    accent: /^#[0-9a-fA-F]{6}$/.test(accent) ? accent : FALLBACK.accent,
  };
}
