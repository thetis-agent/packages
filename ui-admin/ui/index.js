/* The browser side of @thetis/ui-admin: nine entries of the control panel, one module each, registered
 * through the seam under the ids the manifest declares. Eight are sections; `configuration` hangs under the
 * shell's Packages section instead, one page per package with configuration, so it also answers `children`.
 * The shell lists a section only when `api/ui` listed it for the person's role. A user sees five of them --
 * Account, Models, Mounts, SSH keys and Activity -- each scoped to themselves: the modules branch on
 * `who.role` to draw a person's own view, but the kernel is the authority, answering a user's fence only
 * about that user. An admin sees all of them. Every section reads and writes through the package's own
 * commands (`ext.request`), which the gateway runs as the person. The module defines `install` and does
 * nothing else at import. */

import { mountAccount } from "./account.js";
import { mountActivity } from "./activity.js";
import { configurationChildren, mountConfiguration } from "./configuration.js";
import { mountModels } from "./models.js";
import { mountMounts } from "./mounts.js";
import { mountOverview } from "./overview.js";
import { mountPeople } from "./people.js";
import { mountSsh } from "./ssh.js";
import { mountWorkspaces } from "./workspaces.js";

const SECTIONS = [
  ["account", mountAccount],
  ["people", mountPeople],
  ["models", mountModels],
  ["configuration", mountConfiguration],
  ["mounts", mountMounts],
  ["ssh", mountSsh],
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
