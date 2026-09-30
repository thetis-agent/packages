/* The browser side of @thetis/ui-admin: the control panel's sections, one module each, registered through the
 * seam under the ids the manifest declares, and the admin's update notice.
 *
 * An admin's tree reads: Overview, Agent, People, Extensions (the shell's own section, with All extensions and the
 * extensions that ask for something hung under it by `configuration`), Models, Access, Activity, Account,
 * Advanced (Workspaces, Extensions by person and Server settings hung under it by `advanced-pages`). A user
 * sees Models, Access, Activity and Account, each about themselves: the modules branch on `who.role`, and the
 * kernel is the authority, answering a user's fence only about that user. The shell lists a section only
 * when `api/ui` listed it for the person's role.
 *
 * The update flow is made once per page, for an admin only (the gateway lists `update-check` to nobody
 * else), and shared by the notice and the Overview, so both draw the same card. The module defines
 * `install` and does nothing else at import. */

import { mountAccess } from "./access.js";
import { mountAccount } from "./account.js";
import { mountAgent } from "./agent.js";
import { mountActivity } from "./activity.js";
import { advancedChildren, mountAdvanced, mountAdvancedPage } from "./advanced.js";
import { configurationChildren, mountConfiguration } from "./configuration.js";
import { mountModels } from "./models.js";
import { mountOverview } from "./overview.js";
import { mountPeople } from "./people.js";
import { createUpdateFlow } from "./update-flow.js";
import { installUpdateNotice } from "./update-notice.js";
import { useAgentName } from "./state.js";

export default function install(ext) {
  // Every sentence that names the agent or the server reads the name the page has now (an older gateway has no `ext.agent`).
  useAgentName(() => ext.agent?.name || "Thetis");
  const flow = typeof ext.can === "function" && ext.can("update-check") ? createUpdateFlow(ext) : null;
  const sections = [
    ["overview", (root, who) => mountOverview(ext, root, { ...who, flow })],
    ["agent", (root, who) => mountAgent(ext, root, who)],
    ["people", (root, who) => mountPeople(ext, root, who)],
    ["configuration", (root, who) => mountConfiguration(ext, root, who), () => configurationChildren(ext)],
    ["models", (root, who) => mountModels(ext, root, who)],
    ["access", (root, who) => mountAccess(ext, root, who)],
    ["activity", (root, who) => mountActivity(ext, root, who)],
    ["account", (root, who) => mountAccount(ext, root, who)],
    ["advanced", (root, who) => mountAdvanced(ext, root, who)],
    ["advanced-pages", (root, who) => mountAdvancedPage(ext, root, who), () => advancedChildren()],
  ];
  for (const [id, mount, children] of sections) ext.panel(id, children ? { mount, children } : { mount });
  if (flow) installUpdateNotice(ext, flow);
}
