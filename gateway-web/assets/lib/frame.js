/* The frame seam of one package: documents served into a sandboxed iframe. A document there has an opaque
 * origin, so nothing it loads carries the login cookie; instead the page mints a token for the verb and its
 * arguments (`url`), and the browser fetches under `f/<token>/` with no cookie at all. `mount` builds the
 * iframe itself — `sandbox="allow-scripts"` and nothing more, no referrer — and stands between the page and
 * the frame's messages: the frame's origin reads as "null", so `postMessage` cannot check origins, and a nonce
 * in the URL's fragment (never sent to the server) plus the frame's own window are what stand in for one. */

import { api } from "./api.js";

const READY_MS = 10_000;

const nonceOf = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID().replace(/-/g, "") : Math.random().toString(16).slice(2) + Math.random().toString(16).slice(2));

export function frameSeam(pkg, frames) {
  /** Mints a token for `verb` and `args` and answers the relative base the frame's files are under: `f/<token>/`. */
  const url = async (verb, args) => {
    if (!frames.has(verb)) throw new Error(`${pkg} declares no frame "${verb}".`);
    const out = await api(`/api/ext/${pkg}/${verb}/frame`, { method: "POST", body: { args: args ?? {} } });
    if (typeof out?.token !== "string") throw new Error(`${pkg}: the frame "${verb}" could not be minted.`);
    return `f/${out.token}/`;
  };

  /**
   * An iframe on `verb` with `args`, at `path` under the minted base (the root when omitted). `onMessage(data)`
   * gets each message the frame posts with this frame's nonce, the nonce stripped; `post(data)` sends one
   * back with it. `onReady(true)` when the frame said `ready`, `onReady(false)` when it did not within ten
   * seconds or the iframe errored — the token may have expired, and the caller mints again. `reload(path?)`
   * loads the same or another path with a fresh `v`, so a file changed under the same name is fetched again.
   */
  const mount = async (verb, args, { path = "", title = "", className = "", onMessage, onReady } = {}) => {
    const base = await url(verb, args);
    const nonce = nonceOf();
    const node = document.createElement("iframe");
    node.setAttribute("sandbox", "allow-scripts");
    node.setAttribute("referrerpolicy", "no-referrer");
    node.setAttribute("loading", "eager");
    if (title) node.setAttribute("title", title);
    if (className) node.className = className;
    let ready = false;
    let timer = null;
    let version = 0;
    const listener = (event) => {
      if (event.source !== node.contentWindow || !event.data || typeof event.data !== "object" || event.data.nonce !== nonce) return;
      const { nonce: _nonce, ...data } = event.data;
      if (data.type === "ready" && !ready) {
        ready = true;
        clearTimeout(timer);
        onReady?.(true);
      }
      onMessage?.(data);
    };
    window.addEventListener("message", listener);
    const load = (at) => {
      ready = false;
      clearTimeout(timer);
      timer = setTimeout(() => { if (!ready) onReady?.(false); }, READY_MS);
      version += 1;
      node.setAttribute("src", `${base}${at}${at.includes("?") ? "&" : "?"}v=${version}#${nonce}`);
    };
    node.addEventListener("error", () => { clearTimeout(timer); onReady?.(false); });
    load(path);
    return {
      node,
      base,
      nonce,
      post: (data) => { node.contentWindow?.postMessage({ ...data, nonce }, "*"); },
      reload: (at = path) => load(at),
      destroy: () => {
        clearTimeout(timer);
        window.removeEventListener("message", listener);
        node.remove();
      },
    };
  };

  return Object.freeze({ url, mount });
}
