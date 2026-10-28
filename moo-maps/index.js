// @bitmuse/moo-maps: maps of MOO areas kept as files in Thetis (maps/<id>/map.json), edited by the person in
// the map tab and by the agent with the map_* tools, and written to the MOO with map_publish.
//
// The tools run in the person's fence (lib/tools.js); the commands behind the sidebar and the tab run in
// the gateway (lib/commands.js). Both change a map only through lib/store.js `mutate`, under its lock.
export {
  mapList, mapCreate, mapDelete, mapGet, mapRooms, mapSearch, mapReplace, mapSetRooms, mapDeleteRooms, mapMoveRooms,
  mapLink, mapUnlink, mapEdge, mapBlocks, mapAreas, mapRender, mapWorldAreas, mapImport, mapPull, mapPublish, mapStatus,
} from "./lib/tools.js";
export { uiList, uiDoc, uiSave, uiCreate, uiRename, uiRemove, uiFocus, uiWatch, uiEditor } from "./lib/commands.js";
