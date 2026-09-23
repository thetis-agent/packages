import { el } from "./dom.js";
import { renderMarkdown } from "./markdown.js";

/** Browser projection of the runtime content envelope, including legacy saved text. */
export function contentText(content) {
  if (typeof content === "string") return content;
  return Array.isArray(content) ? content.filter((p) => p?.type === "text" && typeof p.data?.text === "string").map((p) => p.data.text).join("") : "";
}

export function hasMedia(content) {
  return Array.isArray(content) && content.some((p) => p?.type !== "text" || typeof p.data?.text !== "string");
}

/** Keeps part order; unknown kinds remain visible and inspectable. */
export function renderContent(content, { markdown = true, strip } = {}) {
  const parts = typeof content === "string" ? [{ type: "text", data: { text: content } }] : content ?? [];
  const nodes = [];
  let text = "";
  const flush = () => {
    const value = strip ? text.replace(strip, "") : text;
    if (value) nodes.push(...(markdown ? renderMarkdown(value) : [document.createTextNode(value)]));
    text = "";
  };
  for (const part of parts) {
    if (part.type === "text" && typeof part.data?.text === "string") { text += part.data.text; continue; }
    flush();
    const data = part.data;
    if (part.type === "asset" && typeof data?.id === "string") {
      const url = `api/media/${encodeURIComponent(data.id)}`;
      const label = data.name || data.mediaType || "Attachment";
      if (/^image\/(png|jpeg|webp|gif)$/.test(data.mediaType)) nodes.push(el("img", { class: "content-media", src: url, alt: label, loading: "lazy" }));
      else if (/^(audio|video)\//.test(data.mediaType)) nodes.push(el(data.mediaType.split("/")[0], { class: "content-media", src: url, controls: "", preload: "none" }));
      nodes.push(el("a", { class: "content-attachment", href: url, download: data.name || "attachment" }, label));
    } else {
      nodes.push(el("details", { class: "content-unknown" }, el("summary", {}, `Content: ${part.type}`), el("pre", {}, JSON.stringify(part.data, null, 2))));
    }
  }
  flush();
  return nodes;
}
