// @bitmuse/moo-maps: maps of MOO areas kept as files in Thetis (maps/<id>/map.json), edited by the person in
// the map tab and by the agent with the map_* tools, and written to the MOO with map_publish.
//
// The tools run in the person's fence (lib/tools.js); the commands behind the sidebar and the tab run in
// the gateway (lib/commands.js). Both change a map only through lib/store.js `mutate`, under its lock.
// Tool arguments are coerced to their schema's types first (lib/coerce.js): some hosts send them as text.
import { readFileSync } from "node:fs";
import * as t from "./lib/tools.js";
import { wrapTools } from "./lib/coerce.js";

const manifest = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf8"));
const w = wrapTools(t, manifest.thetis?.tools ?? []);

export const {
  mapList, mapCreate, mapDelete, mapGet, mapRooms, mapSearch, mapReplace, mapSetRooms, mapDeleteRooms, mapMoveRooms,
  mapLink, mapUnlink, mapEdge, mapElevator, mapBlocks, mapAreas, mapRender, mapWorldAreas, mapImport, mapPull, mapPublish, mapStatus,
} = w;
export { uiList, uiDoc, uiSave, uiCreate, uiRename, uiRemove, uiFocus, uiWatch, uiEditor } from "./lib/commands.js";
