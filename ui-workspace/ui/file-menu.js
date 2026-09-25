/* The one context menu for a file or folder, wherever it is met: an explorer row, a Files dock row, a
 * link in the chat. `fileMenu(entry, host, actions)` answers the items for `openMenu`, and nothing else:
 * no DOM, no requests, so the item sets can be checked in Node. What varies is the host (the chat and
 * the dock first offer the way into the Workspace) and the mode (a read-only entry has no Rename and no
 * Delete). An action the host did not supply leaves its item out, and the separators are tidied after.
 *
 * `entry` is `{ path, name, kind: "dir"|"file", mode: "rw"|"ro", root }`; `host` is `"explorer"`, `"dock"`
 * or `"chat"`; `actions` is `{ open, reveal, newFile, newFolder, upload, download, copyPath, rename,
 * remove, count? }`, each called with the entry. `count(entry)` (a promise of `{ files, bytes, capped }`)
 * fills the zip item's hint asynchronously through `hintLater`, which `openMenu` runs after drawing. */

import { ICONS } from "./icons.js";
import { formatBytes } from "./model.js";

export { formatBytes };

/** The hint under "Download as zip": how much is going to be packed, with the skips named. */
export function zipHint(count) {
  if (!count) return "";
  const files = Number(count.files ?? 0);
  const size = formatBytes(Number(count.bytes ?? 0));
  const n = `${files} file${files === 1 ? "" : "s"}${size ? `, ${size}` : ""}`;
  return count.capped ? `over ${n}; .git and node_modules are skipped` : `${n}; .git and node_modules are skipped`;
}

export function fileMenu(entry, host, actions = {}) {
  const isDir = entry?.kind === "dir";
  const rw = entry?.mode === "rw";
  const has = (name) => typeof actions[name] === "function";
  const run = (name) => () => actions[name](entry);
  const items = [];

  if (host === "chat" || host === "dock") {
    if (has("open")) items.push({ id: "open", label: "Open in Workspace", icon: ICONS.open, run: run("open") });
    if (host === "chat" && has("reveal")) items.push({ id: "reveal", label: "Reveal in Files", icon: ICONS.reveal, run: run("reveal") });
    items.push("-");
  }

  if (isDir && (host === "explorer" || host === "dock")) {
    if (rw && has("newFile")) items.push({ id: "newFile", label: "New file", key: "n", icon: ICONS.newfile, run: run("newFile") });
    if (rw && has("newFolder")) items.push({ id: "newFolder", label: "New folder", icon: ICONS.newfolder, run: run("newFolder") });
    if (rw && has("upload")) items.push({ id: "upload", label: "Upload files here…", icon: ICONS.upload, run: run("upload") });
    items.push("-");
  }

  if (has("download")) {
    const item = { id: "download", label: isDir ? "Download as zip" : "Download", icon: ICONS.download, run: run("download") };
    if (isDir && has("count")) {
      item.hint = "counting…";
      item.hintLater = () => Promise.resolve(actions.count(entry)).then(zipHint, () => "");
    }
    items.push(item);
  }
  if (has("copyPath")) items.push({ id: "copyPath", label: "Copy path", icon: ICONS.copy, run: run("copyPath") });

  if (rw) {
    if (has("rename")) items.push({ id: "rename", label: "Rename", key: "F2", icon: ICONS.edit, run: run("rename") });
    items.push("-");
    if (has("remove")) items.push({ id: "remove", label: "Delete…", key: "Del", icon: ICONS.trash, danger: true, run: run("remove") });
  }

  return tidy(items);
}

/** Drops leading, trailing and doubled separators, so a host that supplies few actions gets a clean list. */
export function tidy(items) {
  const out = [];
  for (const item of items) {
    if (item === "-") {
      if (!out.length || out[out.length - 1] === "-") continue;
      out.push(item);
    } else if (item) out.push(item);
  }
  while (out.length && out[out.length - 1] === "-") out.pop();
  return out;
}
