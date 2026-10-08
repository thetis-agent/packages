/* The colour popover of the toolbar's text and fill buttons: a grid of swatches in the spreadsheet colours
 * people expect (the cell's colours are the person's data, stored as #rrggbb, so they are fixed values here
 * rather than theme tokens) and a Reset that removes the colour. One open at a time; Escape, a choice or a
 * click elsewhere closes it. */

export const SWATCHES = [
  "#000000", "#434343", "#666666", "#999999", "#cccccc", "#efefef", "#f3f3f3", "#ffffff",
  "#980000", "#ff0000", "#ff9900", "#ffff00", "#00ff00", "#00ffff", "#4a86e8", "#9900ff",
  "#e6b8af", "#f4cccc", "#fce5cd", "#fff2cc", "#d9ead3", "#d0e0e3", "#c9daf8", "#d9d2e9",
  "#dd7e6b", "#ea9999", "#f9cb9c", "#ffe599", "#b6d7a8", "#a2c4c9", "#a4c2f4", "#b4a7d6",
  "#a61c00", "#cc0000", "#e69138", "#f1c232", "#6aa84f", "#45818e", "#3c78d8", "#674ea7",
];

let closeOpen = null;

/** Opens the palette under `anchor` inside `host`; `pick(hex | null)` gets the choice. */
export function openPalette(ext, host, anchor, { title, current, pick }) {
  closeOpen?.();
  const { el } = ext.dom;
  const swatches = SWATCHES.map((hex) => {
    const b = el("button", { type: "button", class: `sht-swatch${current === hex ? " is-on" : ""}`, title: hex, "aria-label": hex, "data-color": hex, onClick: () => { close(); pick(hex); } });
    b.style.backgroundColor = hex;
    return b;
  });
  const pop = el("div", { class: "sht-palette", role: "dialog", "aria-label": title },
    el("div", { class: "sht-palette-head" }, el("span", {}, title), el("button", { type: "button", class: "sht-palette-reset", onClick: () => { close(); pick(null); } }, "Reset")),
    el("div", { class: "sht-palette-grid" }, ...swatches));
  host.append(pop);
  const a = anchor.getBoundingClientRect();
  const h = host.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(a.left - h.left, h.width - 232))}px`;
  pop.style.top = `${a.bottom - h.top + 4}px`;
  const onDown = (event) => {
    if (!pop.contains(event.target) && event.target !== anchor && !anchor.contains(event.target)) close();
  };
  const onKey = (event) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      close();
    }
  };
  function close() {
    pop.remove();
    document.removeEventListener("pointerdown", onDown, true);
    document.removeEventListener("keydown", onKey, true);
    if (closeOpen === close) closeOpen = null;
  }
  document.addEventListener("pointerdown", onDown, true);
  document.addEventListener("keydown", onKey, true);
  closeOpen = close;
  return close;
}
