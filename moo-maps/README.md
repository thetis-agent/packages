# @bitmuse/moo-maps

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

Tests: `npm test`. The manifest's tool schemas are written by `node tools/manifest.mjs`.
