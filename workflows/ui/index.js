/* The browser module of @thetis/workflows. The shell calls `install(ext)` once after the page has mounted;
 * it registers the one place the manifest declares. Opened with `{ workflow }` the place starts in that
 * workflow's editor, with `{ run }` on that run, and with nothing on the library. It also names the
 * conversations workflow runs opened (titles.js) and folds them into "Workflow runs" in the sidebar
 * (folder.js). Nothing runs at import. */

import { foldRunConversations } from "./folder.js";
import { openPlace } from "./place.js";
import { nameRunConversations } from "./titles.js";

export default function install(ext) {
  ext.place("workflows", { open: (root, params) => openPlace(ext, root, params ?? {}) });
  nameRunConversations(ext);
  foldRunConversations(ext);
}
