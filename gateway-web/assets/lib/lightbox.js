/* The full-size view of an image in the transcript. A picture in a conversation is drawn as a preview, so a
 * screenshot does not take over the page; a click opens it here, as large as the window allows, and a
 * click anywhere, the ✕ or Escape puts it away. One native <dialog>, made the first time it is needed:
 * it sits above everything, keeps focus inside while open, and closes itself on Escape. Its class is in
 * layers.js's OWN_ESCAPE, so that same Escape does not also close the dock under it. */
import { el, icon } from "./dom.js";

let box = null;

function make() {
  const img = el("img", { class: "lightbox-img", alt: "" });
  const name = el("span", { class: "lightbox-name" });
  const open = el("a", { class: "lightbox-link", target: "_blank", rel: "noopener" }, "Open original");
  const save = el("a", { class: "lightbox-link" }, "Download");
  const shut = el("button", { type: "button", class: "icon-btn sm lightbox-close", title: "Close", "aria-label": "Close" }, icon(["M5 5l10 10", "M15 5L5 15"]));
  const node = el("dialog", { class: "lightbox", "aria-label": "Image" }, img, el("div", { class: "lightbox-bar" }, name, open, save, shut));
  // Anything but the two links closes it: the picture, the backdrop, the bar, the ✕.
  node.addEventListener("click", (event) => {
    if (!event.target.closest?.(".lightbox-link")) node.close();
  });
  node.addEventListener("close", () => img.removeAttribute("src"));
  document.body.append(node);
  return { node, img, name, open, save };
}

/**
 * Shows one image full size.
 * @param {string} src
 * @param {string} [label] its name, shown under it and used for the download
 */
export function openLightbox(src, label = "") {
  box ??= make();
  box.img.src = src;
  box.img.alt = label;
  box.name.textContent = label;
  box.open.href = src;
  box.save.href = src;
  box.save.setAttribute("download", label || "image");
  if (!box.node.open) box.node.showModal();
}
