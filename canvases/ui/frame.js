/* One artboard's iframe under the canvas's token. `load(version)` sets the source once per version (the
 * file's modification time), so a changed file is fetched again and an unchanged one is left alone; props
 * are posted once the frame said it is ready, and again on every change; `handle` takes the messages the
 * board's one listener routed here, already checked to be this frame's. The iframe is sandboxed to scripts
 * alone and sends no referrer: the token stays in the address bar of nothing. */

const MAX_SIDE = 16384;

export function createFrame({ base, file, nonce, title, onReady, onSize }) {
  const node = document.createElement("iframe");
  node.className = "cv-iframe";
  node.setAttribute("sandbox", "allow-scripts");
  node.setAttribute("referrerpolicy", "no-referrer");
  node.setAttribute("loading", "eager");
  node.setAttribute("title", title || file);
  let ready = false;
  let queued = null;
  let version = null;

  function load(next) {
    if (next === version) return;
    version = next;
    ready = false;
    node.setAttribute("src", `${base}${encodeURIComponent(file)}?v=${encodeURIComponent(String(next))}#${nonce}`);
  }

  function post(message) {
    node.contentWindow?.postMessage({ ...message, nonce }, "*");
  }

  function postProps(values) {
    queued = values ?? {};
    if (ready) post({ type: "props", values: queued });
  }

  /** A message from this frame, its nonce already checked: numbers are clamped, nothing is trusted further. */
  function handle(data) {
    if (data.type === "ready") {
      ready = true;
      if (queued) post({ type: "props", values: queued });
      onReady?.();
    } else if (data.type === "size") {
      const height = Number(data.height);
      const width = Number(data.width);
      if (Number.isFinite(height) && height > 0) onSize?.({ width: Number.isFinite(width) ? Math.min(MAX_SIDE, Math.max(0, Math.round(width))) : 0, height: Math.min(MAX_SIDE, Math.round(height)) });
    }
  }

  return {
    node,
    file,
    nonce,
    load,
    postProps,
    handle,
    measure: () => post({ type: "measure" }),
    get version() {
      return version;
    },
    dispose: () => node.remove(),
  };
}
