# @thetis/moo-maps

Maps of MOO areas that you and the agent build together.

- **Maps** in the sidebar lists the maps in progress; a map opens in a **Map** tab, the website
  cartographer's editor.
- The agent edits the same maps with `map_*` tools: read the grid, get rooms by cell, search and replace,
  set rooms and exits, move, link, block, render.
- `map_publish` writes a map to the MOO (dry run first), making what is missing and updating what is
  there, and keeps the map linked to those objects for later publishes. `map_import` and `map_pull` bring
  the world in.

- A map saves to Thetis as you edit it, whether you edit in the tab or the agent edits with tools. There is no
  file import or export.
- Directions: the 8 planar ones, `up`/`down`, and 16 vertical diagonals: `nu` (northup) … `nwd`
  (northwestdown). Torchship's `$building_utils.cardinals` knows these, so players walk them as real
  exits. In the tab, hold U or D and press an arrow, or use **Slope…** on the room panel.
- Elevators: one carriage off the grid with stops (button label + lobby room, top floor first) in any
  area. Make one in the tab from a room's **⇕ New elevator**, or with `map_elevator`. Lobbies get a teal
  `⇕L` badge; click it to edit the elevator. Publishing elevators needs the MOO's `$elevator`
  with `:mapper_create/set/get/destroy`. Until then publish skips them and says so.

Needs `@thetis/moo` (or the package named by the `moo_package` setting) for the MOO connection. The
skill `moo-maps` tells the agent how to work with it.

Maps are files in your home: `maps/<id>/map.json`.

## Projects

A map belongs to one project or none (`project` in `map.json`). **Maps** follows the shell's current
space (`ext.space`): in a project it lists that project's maps only; under No project, the maps with none
and those whose project was deleted. ＋ makes a map in the space, and a map's tab opens in its project's
space. The row menu moves a map to another project or out of one (the `assign` command). A map the agent
makes (`map_create`, or `map_import` without `map`) gets its conversation's project: `projects/sessions.json`,
or `projects/agents/<id>.json` for a subagent. The package reads those files directly, so without
`@thetis/projects` every map is in none. On a gateway without spaces the section lists every map.

Tests: `npm test`: the tools and the sync over a simulated world, the commands, the projects rules
(`test/projects.test.js`) and the sidebar over the shell's fake DOM (`test/sidebar.test.js`, which needs
`../gateway-web` next to this package). The manifest is written by `node tools/manifest.mjs`.
