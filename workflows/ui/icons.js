/* Inline stroke icons on a 24-unit grid. Each is a list of path data; circles and rounded rectangles are
 * written as paths so one builder draws them all. Always aria-hidden: a control that shows only an icon
 * carries its own aria-label. */

const circle = (cx, cy, r) => `M${cx - r} ${cy}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
const rect = (x, y, w, h, r) => `M${x + r} ${y}h${w - 2 * r}a${r} ${r} 0 0 1 ${r} ${r}v${h - 2 * r}a${r} ${r} 0 0 1 ${-r} ${r}h${-(w - 2 * r)}a${r} ${r} 0 0 1 ${-r} ${-r}v${-(h - 2 * r)}a${r} ${r} 0 0 1 ${r} ${-r}z`;

export const ICONS = {
  prompt: ["M4 5h16v11h-9l-5 4v-4H4z", "M8 9.5h8M8 12.5h5"],
  tool: ["M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-1-1-2.5z"],
  parse: ["M8 4H5v16h3", "M16 4h3v16h-3", "M9 10h6M9 14h4"],
  branch: [circle(6, 5, 2), circle(6, 19, 2), circle(18, 8, 2), "M6 7v10", "M18 10c0 5-12 3-12 7"],
  loop: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
  approval: [circle(9, 8, 3.5), "M3 20c0-3.3 2.7-6 6-6s6 2.7 6 6", "M15.5 11.5l2 2 4-4"],
  done: [circle(12, 12, 9), "M8 12.5l2.7 2.7L16 9.8"],
  needs: ["M12 3.5l9 16H3z", "M12 10v4.5", "M12 17.3v.2"],
  workflow: [rect(3, 4, 7, 6, 1.5), rect(14, 14, 7, 6, 1.5), "M6.5 10v4a3 3 0 0 0 3 3H14"],
  chevron: ["M9 6l6 6-6 6"],
  back: ["M15 6l-6 6 6 6"],
  plus: ["M12 5v14M5 12h14"],
  minus: ["M5 12h14"],
  fit: ["M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"],
  shield: ["M12 3l8 3v6c0 4.5-3.4 8-8 9-4.6-1-8-4.5-8-9V6z", "M8.5 12l2.5 2.5 4.5-5"],
  play: ["M7 5l12 7-12 7z"],
  pause: ["M8 5v14M16 5v14"],
  trash: ["M4 7h16", "M9 7V4.5h6V7", "M6.5 7l1 13h9l1-13"],
  x: ["M6 6l12 12", "M18 6L6 18"],
  search: [circle(11, 11, 6.5), "M20 20l-4.3-4.3"],
  external: ["M14 4h6v6", "M20 4l-9 9", "M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"],
  flag: ["M5 21V4", "M5 4h12l-2 4 2 4H5"],
  tidy: ["M4 6h7M4 12h10M4 18h16", "M17 4v6"],
  warn: ["M12 3.5l9 16H3z", "M12 10v4.5", "M12 17.3v.2"],
  error: [circle(12, 12, 9), "M12 7.5v5.5", "M12 16.3v.2"],
  panel: [rect(3, 4, 18, 16, 2), "M15 4v16"],
  copy: [rect(8, 8, 12, 12, 2), "M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"],
  retry: ["M20 12a8 8 0 1 1-2.3-5.7", "M20 4v5h-5"],
  check: ["M5 12.5l4.5 4.5L19 7.5"],
  terminal: ["M5 8l4 4-4 4", "M12 17h7"],
};

/** An <svg> for `name` (a key of ICONS) or a list of path data. */
export function svgIcon(name, { size = 16, width = 1.7, className } = {}) {
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", size);
  svg.setAttribute("height", size);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  if (className) svg.setAttribute("class", className);
  for (const d of Array.isArray(name) ? name : ICONS[name] ?? []) {
    const path = document.createElementNS(NS, "path");
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
