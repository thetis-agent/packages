---
name: moo-maps
description: "How to build MOO areas with the person on a shared map: the map_* tools, the Map tab they edit at the same time, the grid and exit model, publishing to the MOO and keeping the link, and Torchship's conventions for rooms, exits, areas and descriptions. Read before any map_* call."
metadata:
  title: MOO maps
  tags: [moo, torchship, map, maps, cartographer, building, rooms, exits, areas, publish, import, pull]
---
# MOO maps

A map is a draft of one or more MOO areas kept in Thetis, under `maps/<id>/map.json` in the person's home.
You edit it with the `map_*` tools; the person edits the same map in the **Map** tab, opened from **Maps**
in the sidebar. Both write through one lock and every change is a revision, so neither loses the other's
work. The MOO is not touched until `map_publish`. From then on the map stays **linked**: it remembers
the MOO object of every area, room, exit and edge, and the next publish updates those objects instead of
making new ones.

## The loop

1. **Find or start the map.** `map_list` shows the maps in progress. `map_create` starts a draft.
   `map_import` brings in areas that are already in the MOO (`map_world_areas` lists them).
2. **Read before you change.** `map_get` gives the grid, the recent changes with who made them, and
   **what the person has selected in the tab right now** ("selected: room r12 …"). When the person says
   "this room" or "here", the selection is what they mean. Every reply ends with the map after the change.
3. **Edit** with `map_set_rooms` (most work), `map_link` / `map_unlink`, `map_move_rooms`,
   `map_delete_rooms`, `map_replace`, `map_edge`, `map_blocks`, `map_areas`. All of them take `dry_run`.
   Each call is checked in full before it writes anything: an error means nothing changed.
4. **Look** with `map_render` when the layout matters: it draws what the tab draws.
5. **Publish.** `map_publish dry_run: true` first, show the person the plan in a few lines, then publish
   when they agree. Report the counts and any failures from the reply, not from the plan.
6. **Keep in sync.** `map_status` compares the map with the world. If someone built in the game since,
   `map_pull` brings it in before you publish again.

The person sees your edits land in the tab within a second, and you see theirs on your next read. Do not
re-read after every call: the reply already holds the result.

## The grid

- `x` grows **east**, `y` grows **south**, `z` grows **down**: 0 is ground, `-1` one floor up, `1` one
  floor down. North is `y - 1`; up is `z - 1`. This is Torchship's own convention
  (`$building_utils:calc_relative_coordinates`), so map coordinates are the rooms' `.x .y .z`.
- Each area is its own coordinate space. One room per cell per area: the MOO's `$area:get_room_at`
  returns one occupant, and the cartographer refuses a second.
- **Blocks** (`map_blocks`) mark solid cells no room may take: rock, a hull, a building's walls. They are
  `$area.mapper_blocks`, sketch markers for the cartographer with no in-game presence.
- Rooms are named `r12`, areas `a1`, exits `e7`, edges `j3`. Once published, a MOO id (`#1234`) also
  names a room or exit. A cell `{x, y, z, area}` names a room too.

## Exits

- An exit is one **pair**: both directions at once. The MOO makes them as twins
  (`$building_utils:make_exit_pair`) and recycling one recycles the other.
- Between grid neighbours in one area the direction is the grid's: `map_set_rooms` with `exits: ["n","e"]`
  makes them. That list is the room's **whole** set of neighbour exits: a neighbour exit you leave out is
  removed. Exits to other areas, and exits to rooms that are not neighbours, are left alone by it.
- Directions: `n ne e se s sw w nw up down`, and the sixteen **vertical diagonals**: `nu neu eu seu su swu
  wu nwu` (one floor up and one step that way) and `nd ned ed sed sd swd wd nwd` (one floor down). In the MOO
  they are real cardinals: the exit is named `northup`, `southwestdown` …, players walk it by typing that
  or the short alias (`nu`, `swd`), its twin is the opposite on both axes (`nu` ↔ `sd`), and
  `$building_utils:direction_delta` gives each one's (dx, dy, dz). Neighbour cells one floor apart and one
  step across join by one: `map_set_rooms` with `exits: ["nu"]` from (0,0,0) reaches (0,-1,-1). Use them for
  a ramp, a stair climbing out of a pit, a slope; use plain `up`/`down` for a ladder or a lift. One exit
  per direction per room.
- **Across areas** use `map_link` with `to` and give `adir` (the way out of `from`) and `bdir` (the way back).
  The two areas' coordinates do not relate, so the direction cannot be inferred; pick what a player
  would expect ("the door north out of the shop comes back south"). Torchship records a cross-area link in
  both areas' adjacency (`:add_area_link`, `:recompute_next_hops`); publishing does that for you.
- A non-adjacent exit in one area (a long corridor drawn short, a lift between distant floors) also goes
  through `map_link` with `to`.
- **Types:** `open`, `door` (an openable `$door`), `locked` (made as a `$door`; the lock itself is an
  object installed later, so until then the world reads it back as `door`), `climb`, `swim`, `special`
  (made as open; scripted exits are wired in the game). The map keeps `locked` and `special` as you set
  them even though the world reports the coarser type.
- `hidden: true` makes an exit players have to discover.

## Edges

A jump edge (`map_edge`) is a one-way leap in a planar direction: success lands in `success`, a failed
roll in `fail`. Torchship's `$room_edge`: `jump <dir> edge` / `descend <dir> edge`. Fall damage is
the height difference between the source and the failure room (`fall_height * 300` blunt, centred), so a
fall of three floors hurts. Keep the failure room *below* the source. One edge per room per direction,
separate from exits: a room can have both an exit and an edge to the north.

## Elevators

An elevator (`map_elevator`, id `v…`) is one carriage that lives off the grid, with an ordered stop list,
**top floor first**: each stop is a button label (free text, e.g. `R`, `2`, `G`, `B1`, at most 16
characters, unique in the elevator) and a lobby room anywhere on the map, in any area. A room can be the
lobby of one elevator only: the MOO gives it a single `in`, and publish refuses a second. Do not draw the shaft or the carriage as rooms.

- Make one: `map_elevator {name, stops:[{label, room}, …]}`. Change it with `elevator: "v3"`: `add`
  (one stop, or a list; it goes in by floor unless `at` is given), `drop` (a label or a room),
  `stops` (the whole list again), `name`, `description`, `door` (seconds the doors stay open, default 8)
  and `travel` (seconds per floor, default 3). `remove: true` deletes it.
- In the game a lobby's `in` opens on the carriage, with aliases `e`, `ele`, `elevator` and `lift`. A real
  east exit wins: in a lobby with an east exit, `e` still goes east. Players `press <label>` inside.
- Deleting a room drops its stops. An elevator needs two stops or more to be any use.
- `map_get` lists the elevators at the end, and each lobby shows `in → elevator vN stop L`. The tab draws
  a teal `⇕L` badge on each lobby. The person edits elevators there too.
- Publishing writes elevators last, through the MOO's elevator system (`$elevator`, with
  `:mapper_create/mapper_set/mapper_get/mapper_destroy`). Until that exists the publish makes everything
  else and says the elevators wait: publish again once it does. The contract is in `plans/elevators-app.md`.

## Publishing

What `map_publish` does, in order: makes or renames areas; removes what the map deleted (edges, exits,
blocks, then rooms); moves rooms (in an order that never needs a taken cell); makes and updates rooms;
makes and retypes exits, edges and blocks. Then it reads the world back and records that as the
published state.

- **New rooms** are made like `@dig` and the website cartographer make them
  (`$netsat:_mapper_new_room`): `$shaper_feature.default_room_type`, or the area's `.build_pool`. The
  room's parent (shop, restaurant, rentable unit …) is set in the game with `@setup`, not here.
- **Updates** are name, description, cell and area. A room's colour and notes stay in the map: the MOO
  does not store them. Use `notes` for builder's notes, not the description.
- **Deleted rooms** are recycled through `$netsat:_mapper_recycle_room` (their exits, twins, edges, and
  edges elsewhere landing in them). A room with a player in it is refused unless `force: true`, which
  sends them home. Ask before forcing.
- **Removing an area** from the map only unlinks it: the area and whatever rooms you did not delete stay
  in the world.
- **Foreign objects**, rooms or exits in the linked areas that the map never had, are left alone and
  listed. `map_pull` brings them in. A map room on a cell a foreign room holds takes that room over
  (the plan says so) instead of failing.
- **Rooms already linked but gone from the world** are made again, with a note.
- It needs the MOO character to be a **Shaper** (`$wiz_utils:is_shaper`), as the website does.
- A publish that fails part-way records what it did: run `map_status`, fix what failed, publish again.
  A **timeout is not a rollback**: the reply says when an operation "may have run". Read the world back
  with `map_status` before you retry, never blindly.
- A new area is an **island** until an exit joins it to the world. The reply says so. Join it with
  `moo_build_link` (from `@bitmuse/moo-build`, `to` the street room's id) or `@dig`/`@open` in the game,
  then `map_pull` so the map knows the exit out. Exits leaving the map are remembered and shown, never
  drawn or changed.
- Two maps publishing the same area undo each other's work. `map_import` refuses an area that is
  already on a map unless `allow_shared`.

## The person's edits

The Map tab is the website cartographer's editor. Their saves reach the map as patches against what they
loaded, so an edit you made meanwhile survives: if both of you add a room, both stay (theirs is renumbered
when the ids clash); if both of you put a room on the same cell, the second is refused and they see a
message. When the person is editing, keep your changes small and say what you changed: they are watching
it happen. `map_get` shows their recent edits in the change list, marked "person".

## Torchship conventions

Writing rooms:

- **Names** are short place names in title case, no article, no full stop: "Forking Tunnel",
  "Hallway", "Luna Orbit". Up to about 40 characters; the map caps them at 200.
- **Descriptions** are present tense prose of what is always there: structure, light, sound, smell, the
  feel of the place. Two to five sentences; a room the player walks through often deserves the shorter
  end. Live examples: *"Rock worn away by the dripping fluorescent green water from above has widened the
  natural formation of rocks here. As the chamber widens it leads to one slightly ascending path and one
  descending path deeper into the caves."*
- Do **not** list exits in the prose ("exits lead north and east"): the room prints `[ Exits: … ]` on its
  own, and edges as `[ Edges: … ]`. Mention a way out only as scenery ("a ladder climbs into the dark").
- Do not describe people, NPCs or movable things: they render from the room's contents and change.
  Fixtures are installed objects that add their own line.
- Do not put OOC notes in descriptions (some old rooms have "// OOC NOTE"): use the room's `notes`.
- A description can be a list of paragraphs (`["…", "…"]`); the map stores it as lines separated by
  newlines and the MOO as a list, as many live rooms do.
- Neighbouring rooms should agree with each other: if the corridor says the hatch to the east is red,
  the room behind it has a red hatch to the west. `map_search` for the feature before writing its twin.
- Use `map_replace` for a consistent rename ("Deck 3" to "Deck C"); `dry_run` shows every hit first.

Laying out an area:

- Lay a whole area out in **one** `map_set_rooms` call, rooms and exits together, then `map_render` it.
- Keep the grid honest: if two rooms are one step apart in the story, put them in neighbouring cells. Use
  non-adjacent links sparingly; players read the in-game map.
- Stack floors on `z` with `up`/`down` exits, and keep the stairs in the same `x, y` on both floors.
- A building, ship or station that is its own place is usually its own **area** (its own weather, ambience,
  spawners, cleanup), joined to the street by a cross-area exit. An area is not a venue: one area may hold
  several shops and the street between them.
- Ships use `fore aft port starboard` in play, labelled by `$building_utils:label_exit`; on the map they
  are the compass directions the ship's layout draws (`n` is fore).

Before publishing into a live part of the world, check `map_status` for players in the rooms you will
change, and say so to the person.

## When a tool says no

- "not a Shaper": the MOO character in the `@thetis/moo` config lacks the Shaper feature. Tell the person;
  you cannot grant it.
- "cell is taken" or "blocked": pick another cell, or move or delete the room there first.
- "already has a north exit": unlink it, or give `adir`/`bdir`.
- `map_publish` failures name the operation and the MOO's error. The rest of the publish ran.

Related: `@bitmuse/moo-build` (`moo_build_*`) edits MOO areas directly with no draft; use it for a
quick one-off or to join a published map to the world, and `map_pull` afterwards. For the MOO side of
areas, exits and edges, the Torchship skills `torchship/world-simulation/area` and
`torchship/world-simulation/room-edges` have the detail.
