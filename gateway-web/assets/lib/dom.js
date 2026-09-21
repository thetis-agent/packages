/* Tiny DOM helpers. No framework, no build step. */

export const $ = (id) => document.getElementById(id);

/** Creates an element. Children may be nodes or strings (inserted as text). */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key.startsWith("on")) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

/** Inline SVG from path specs, so icons stay markup rather than image loads. */
export function icon(paths, { size = 16, width = 1.7 } = {}) {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  for (const d of [].concat(paths)) {
    const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
    path.setAttribute("d", d);
    path.setAttribute("fill", "none");
    path.setAttribute("stroke", "currentColor");
    path.setAttribute("stroke-width", width);
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
    svg.append(path);
  }
  return svg;
}

export function clear(node) {
  node.replaceChildren();
  return node;
}

export function setHidden(node, hide) {
  if (!node) return;
  if (hide) node.setAttribute("hidden", "");
  else node.removeAttribute("hidden");
}

/** Closes a menu when the next click lands outside it. */
export function onClickOutside(node, handler) {
  // The path the event took, not `node.contains(target)`: a click inside that redraws part of the node
  // (a picker row that replaces the list, say) has detached its own target by the time this runs, and
  // `contains` would then call an inside click an outside one and close the node under the person.
  const listener = (event) => {
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    if (!path.includes(node) && !node.contains(event.target)) handler(event);
  };
  setTimeout(() => document.addEventListener("click", listener), 0);
  return () => document.removeEventListener("click", listener);
}
