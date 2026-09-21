/* The browser side of @thetis/ui-admin: seven entries of the control panel, one module each, registered
 * through the seam under the ids the manifest declares. Six are sections; `configuration` hangs under the
 * shell's Packages section instead, one page per package with configuration, so it also answers `children`. The shell lists a section only when `api/ui`
 * listed it for the person's role, so a user never sees these; an admin does. Every section reads and
 * writes through the package's own commands (`ext.request`), which the gateway runs as the person and
 * the kernel answers only for an admin. The module defines `install` and does nothing else at import. */

import { mountActivity } from "./activity.js";
import { configurationChildren, mountConfiguration } from "./configuration.js";
import { mountModels } from "./models.js";
import { mountMounts } from "./mounts.js";
import { mountOverview } from "./overview.js";
import { mountPeople } from "./people.js";
import { mountWorkspaces } from "./workspaces.js";

const SECTIONS = [
  ["people", mountPeople],
  ["models", mountModels],
  ["configuration", mountConfiguration],
  ["mounts", mountMounts],
  ["activity", mountActivity],
  ["workspaces", mountWorkspaces],
  ["overview", mountOverview],
];

export default function install(ext) {
  for (const [id, mount] of SECTIONS) {
    const impl = { mount: (root, who) => mount(ext, root, who) };
    if (id === "configuration") impl.children = () => configurationChildren(ext);
    ext.panel(id, impl);
  }
}
