/* Who the agent is on this page: the name an admin gave it in the Control panel (harness-core's `agentName`,
 * "Thetis" when nobody chose one) and its picture (`agentAvatar`, a data: URL, or null). The name is in the
 * page as it was served (`<meta name="agent-name">`), so it is right before anything is fetched; `/api/me`
 * brings the picture, and `refreshAgent()` asks `/api/agent` again: after an admin changes either, and when
 * the tab comes back into view, so a page left open catches up without a reload.
 *
 * Every sentence the page says about the agent reads `agentName()` when it is said, never a copy taken at
 * import, and a view that shows it once watches the store's `agentIdentity` key. Packages read the same through
 * `ext.agent`. */

import { api } from "./api.js";
import { store } from "./store.js";

export const DEFAULT_AGENT_NAME = "Thetis";

function served() {
  const meta = typeof document === "undefined" || typeof document.querySelector !== "function" ? null : document.querySelector("meta[name='agent-name']")?.getAttribute("content")?.trim();
  // An unfilled placeholder means the page came from somewhere that does not fill it: say the default.
  return meta && !meta.includes("{{") ? meta : DEFAULT_AGENT_NAME;
}

/** Takes an answer of `/api/agent` (or `/api/me`'s `agent`) into the store; anything malformed keeps what is there. */
export function setAgent(agent) {
  if (!agent || typeof agent !== "object") return;
  const name = typeof agent.name === "string" && agent.name.trim() ? agent.name.trim() : DEFAULT_AGENT_NAME;
  const avatar = typeof agent.avatar === "string" && agent.avatar.startsWith("data:image/") ? agent.avatar : null;
  const was = store.get("agentIdentity");
  if (was && was.name === name && was.avatar === avatar) return;
  store.set({ agentIdentity: Object.freeze({ name, avatar }) });
}

/** The agent's name, as it is now. */
export function agentName() {
  return store.get("agentIdentity")?.name || served();
}

/** The agent's picture as a data: URL, or null when it has none. */
export function agentAvatar() {
  return store.get("agentIdentity")?.avatar ?? null;
}

/** `fn({ name, avatar })` each time either changes. Answers the function that stops it. */
export function watchAgent(fn) {
  return store.watch("agentIdentity", (agent) => fn(agent ?? { name: agentName(), avatar: null }));
}

/** Asks the server again. A failure keeps what the page has: an old name is better than none. */
export async function refreshAgent() {
  try {
    setAgent(await api("/api/agent"));
  } catch {
    /* kept */
  }
  return store.get("agentIdentity") ?? { name: agentName(), avatar: null };
}

store.set({ agentIdentity: Object.freeze({ name: served(), avatar: null }) });
