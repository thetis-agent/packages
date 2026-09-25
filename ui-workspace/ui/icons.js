/* The glyphs every module of @thetis/ui-workspace draws with: 20x20 stroke paths for the shell's
 * `ext.dom.icon(paths, { size, width })`, which strokes each path in `currentColor` with round caps. One
 * table, so the explorer, the dock, the tabs, the menu and the chat links show the same folder, the same
 * lock and the same ⋯. Nothing here touches the DOM: the values are arrays of path data. */

export const ICONS = Object.freeze({
  file: ["M6 2.5h6l4 4v11H6z", "M12 2.5v4h4"],
  folder: ["M2.5 5.5h5l2 2h8v9h-15z"],
  folderOpen: ["M2.5 5.5h5l2 2h8v2", "M2.5 16.5l2-7h14l-2 7z"],
  home: ["M3 9.5 10 3.5l7 6v7h-4.5v-4h-5v4H3z"],
  shared: ["M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z", "M13.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z", "M2 16.5c0-3 2-4.5 4.5-4.5s4.5 1.5 4.5 4.5", "M11 12c2.5 0 7 .5 7 4.5"],
  project: ["M10 2.5l7 4v7l-7 4-7-4v-7z", "M3 6.5l7 4 7-4", "M10 10.5v7"],
  upload: ["M10 13V4", "M6 8l4-4 4 4", "M3.5 14.5v2h13v-2"],
  download: ["M10 4v9", "M6 9l4 4 4-4", "M3.5 14.5v2h13v-2"],
  trash: ["M3.5 5.5h13", "M8 5.5V3.5h4v2", "M5 5.5l.8 11h8.4l.8-11", "M8.5 8.5v5", "M11.5 8.5v5"],
  refresh: ["M16.5 10a6.5 6.5 0 1 1-1.9-4.6", "M16.5 3.5v4h-4"],
  collapse: ["M5 8.5 10 3.5l5 5", "M5 16.5l5-5 5 5"],
  newfile: ["M6 2.5h6l4 4v11H6z", "M12 2.5v4h4", "M10 9v5", "M7.5 11.5h5"],
  newfolder: ["M2.5 5.5h5l2 2h8v9h-15z", "M10 9.5v5", "M7.5 12h5"],
  lock: ["M5 9h10v8H5z", "M7 9V6.5a3 3 0 0 1 6 0V9"],
  more: ["M4.5 10h.5", "M9.75 10h.5", "M15 10h.5"],
  open: ["M8 4H4v12h12v-4", "M11 3.5h5.5V9", "M16.5 3.5 9 11"],
  back: ["M12.5 4 6.5 10l6 6"],
  warn: ["M10 3 2.5 16.5h15z", "M10 8v4", "M10 14.3v.4"],
  image: ["M3.5 4.5h13v11h-13z", "M3.5 13l4-4 3 3 2-2 4 4", "M12.5 8.5a.75.75 0 1 0 1.5 0a.75.75 0 1 0-1.5 0"],
  link: ["M8.5 11.5a3 3 0 0 0 4.2 0l2.5-2.5a3 3 0 0 0-4.2-4.2L9.8 6", "M11.5 8.5a3 3 0 0 0-4.2 0L4.8 11a3 3 0 0 0 4.2 4.2l1.2-1.2"],
  reveal: ["M2.5 10s3-5 7.5-5 7.5 5 7.5 5-3 5-7.5 5-7.5-5-7.5-5z", "M10 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4z"],
  chevron: ["M7.5 5.5 12 10l-4.5 4.5"],
  x: ["M5 5l10 10", "M15 5l-10 10"],
  save: ["M4 4h9l3 3v9H4z", "M7 4v4h5V4", "M7 16v-4h6v4"],
  copy: ["M7 7h9v9H7z", "M4 13V4h9"],
  search: ["M9 14a5 5 0 1 0 0-10 5 5 0 0 0 0 10z", "M12.5 12.5 17 17"],
  check: ["M4 10.5l4 4 8-8"],
  undo: ["M7.5 6.5h5a3.5 3.5 0 0 1 0 7H6", "M7.5 6.5 10 4", "M7.5 6.5 10 9"],
  edit: ["M4 16h3l8.5-8.5-3-3L4 13z", "M11.5 5.5l3 3"],
  files: ["M4 3.5h7l3 3v10H4z", "M11 3.5v3h3", "M7 8.5h5", "M7 11.5h5", "M7 14.5h3"],
});

/** The glyph for a listing entry: a folder (open or closed), a picture, or the plain file. */
export function iconFor(entry, { open = false } = {}) {
  if (!entry) return ICONS.file;
  if (entry.kind === "dir") return open ? ICONS.folderOpen : ICONS.folder;
  if (/\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(entry.name ?? "")) return ICONS.image;
  return ICONS.file;
}
