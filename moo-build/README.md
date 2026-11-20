# @bitmuse/moo-build

Author Torchship areas on a grid. Eight tools, over `@thetis/moo`'s client.

An agent designing an area should think about places and how they connect, not
about `$recycler`, exit twins, long direction names or route caches. Here it
works in cells and compass directions, and the package turns that into exactly
what `@dig` would have made.

## The model

**A build is an area the character may author**: an `$area` in its `.builds`
list, the same list the Shaper Feature's `@dig` checks. `moo_build_create`
makes one and adds it there. Every tool that changes anything takes `build`,
the way a terminal tool takes `session`, and every MOO task re-checks it, so a
room can be set, created or deleted only when it belongs to that build. Any
area can be *read*.

**Coordinates are the MOO's own**: x grows east, y grows south, z grows down
(0 is ground, -1 one floor up). It's the convention of
`$building_utils:calc_relative_coordinates`, `lmap` and the website's mapper, so
a number the tools report is the number everything else uses.

**Exits are directions.** `e` from (2,3,0) goes to (3,3,0). A room's `exits`
list in `moo_build_set_rooms` is its complete set of exits to neighbours in the
build. Missing pairs are made, unlisted ones are removed, and leaving `exits`
out leaves them alone. Exits that leave the build, and `in`/`out`, are never
touched by a declaration; `moo_build_link` and `moo_build_unlink` handle those.

| Tool | |
|---|---|
| `moo_build_list` | The character's builds; `all` adds every other area with rooms. |
| `moo_build_create` | A new build, optionally with its first room. |
| `moo_build_get` | A build as a map per level, plus one line per room. |
| `moo_build_render` | A build as images, one per populated level, in the website editor's style. |
| `moo_build_set_rooms` | Create or update rooms by cell or id, with their exits. |
| `moo_build_delete_rooms` | Delete rooms; their exits, twins and edges go too. |
| `moo_build_link` | One pair: to a neighbour, or anywhere, including out of the build. |
| `moo_build_unlink` | Remove one pair, by direction or exit id. |

A map looks like this (`<..>` has an up/down exit, `+` a door, `:` a hidden pair):

```
level z=0 (ground)
  x→ -1    0    1    2
y-1      [02]-<03>
          |  X
 y0 [04]:<05>-[06]+[07]
          |
 y1      [08]

02 #2 "North Arch" (0,-1,0)  exits: s e se
03 #3 "Tower Foot" (1,-1,0)  exits: w sw up[climb]
05 #1 "Plaza" (0,0,0)  exits: n e s w[hidden] down ne
...
```

## Pictures

`moo_build_render` draws each populated level (up to six a call, or the one
`z` names) as a PNG, the way the website's map editor draws it: its cell and
room sizes, palette and room squares, and exit lines coloured by type:

- open is grey and a door is orange with a crossbar; climb is green and swim
  blue
- hidden exits are dashed
- up/down exits are triangles in the room's corner, ringed when they leave
  the build
- exits into other areas end in dashed tags with the area's name
- jump edges are pink arcs with a ↓ marking the failure landing
- the grid is dotted, and the level below shows as a dashed ghost

Two things are added for a reader who can't hover: each room carries its
legend label in the corner, and the margins are numbered with x and y.

The answer is a tool result with the text and one image asset per level. The
provider hands the images to the model, and the web UI shows them under the
tool call, where a click opens them full size, so they stay in the
conversation. The SVG is rasterised by `@resvg/resvg-js` (the package's one
dependency, installed by `npm install` on install) with a bundled DejaVu Sans
Mono (`fonts/`, its licence beside it), so the picture doesn't depend on the
fonts a fence can see. Images are at most 1600 px on the long side.

## What it does in the MOO

Every step mirrors the Shaper Feature, so a room made here is
indistinguishable from one dug by hand:

- **Rooms** come from `#272.default_room_type` (what `@dig` uses), from the
  area's `build_pool` when it has one, are named with `:set_name`, placed with
  `.x/.y/.z`, joined with `area:add_room`, and get `:refresh_icon`.
- **Builds** come from the character's `.default_build_area` (what `@build`
  uses) and are appended to `.builds`.
- **Exit pairs** get the type `$building_utils:make_exit_pair` would choose:
  the area's `default_exit_type`, or `$door`, `$climbing_exit` or
  `$swim_exit`, with the type's `otherside_type` for the far half. They're named,
  directed and aliased as `@dig` does (`east`, with `exit_aka` aliases) and
  twinned. A pair across areas registers the same peek links `@dig` does.
- **Deletes** go through `$recycler`, so `$room:recycle` takes the exits and
  their twins. Jump edges in the build that start or land in the room are
  recycled first, because room teardown doesn't sweep them. A room with a
  player in it is refused.
- **After a call**, the route cache of every touched area is rebuilt once
  (`recompute_next_hops`) and the area's cached maps are cleared.

The pair is made inline rather than by calling `make_exit_pair`, so the task
holds both halves from the start. If any step fails, both are recycled and the
error is raised again: a failed link leaves no orphan exit behind.

## What a call promises

- **Checked before it runs.** A `set_rooms` or `delete_rooms` request is planned
  in full against the build as it is, and any problem refuses the whole call
  with every reason listed. `dry_run` shows the plan.
- **One task per operation, in a fixed order**: unlinks, creates, updates,
  links, hides. Every room in a call exists before any exit is made, so a whole
  area can be laid out at once. The first failure stops the run, and the reply
  says what ran, what failed and in the MOO's words why, and what did not run.
- **A timeout is not a rollback.** It is reported as possibly committed; read
  the build back before retrying.
- **The reply ends with the build as it now is**, read back from the MOO.

## Connection

This package has no client and no credentials of its own. It finds `@thetis/moo`
(else `@bitmuse/moo`) installed in the same space, imports its `client.js`
and gives it that package's configuration, so it logs in as the same character
over the same web host. Configure the moo package and this one works.

| Key | |
|---|---|
| `moo_package` | Another package to connect through. |
| `room_parent` | Parent of new rooms. Default `#272.default_room_type`. |
| `area_parent` | Parent of new builds. Default the character's `.default_build_area`. |

The character needs a `.builds` list (Generic Builder #4 and Generic Shaper
#268 give one) and enough authority to create objects and write to rooms in
its builds. A wizard has both.

## Why not the website's mapper API

The torchsite map editor speaks the "mudmap" v4 format and its docs describe
POST/PATCH/DELETE routes under `/webhooks/api/mapper`. Only
`GET mapper/state` exists in the MOO; the write routes are in the docs and the
mock server alone. So this package writes through `/v1/eval` with the Shaper
Feature's own verbs. Its coordinates, direction codes and exit types match
mudmap's, so moving to those routes later would change the transport, not the
model.

## Tests

```
node --test test/*.test.mjs   # planner, map, pictures, injection boundary, tools over a fake moo package
node test/sandbox.mjs         # every generated program against a real Torchship database, offline
```

The sandbox needs the mooR checkout at `/tank/data/Dev/games/moor`. `moorc`
imports `recovery2.moo` into a throwaway database and plays a moot script
against it as a wizard: create, update, link (open, door, hidden, out of the
build), unlink, delete, the authority refusals, and one planned
`moo_build_set_rooms` of nine rooms on three levels whose geometry the MOO
then checks exit by exit. No server is started and nothing live is touched. It
takes about a minute, most of it the import.

It doesn't use `recovery-export-20260828`. That export writes builtins under
the wrong names: 1,727 calls to `value_hash()` where the code means `length()`,
and `fromliteral()` where it means `toliteral()`. Imported, `@dig` itself fails.
