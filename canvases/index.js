// Entry point: the eight tools the manifest declares, which run in the person's fence, and the commands
// its own page sends through `/api/ext/@thetis/canvases/<verb>`, which run in the gateway. Both sides
// keep a canvas as plain files under `canvases/<id>/` in the person's home (lib/store.js), because a tool
// and a UI command do not share `env.storage()` and the home is the one place both reach.
export { canvasAsset, canvasCreate, canvasDelete, canvasEditBoard, canvasLayout, canvasList, canvasRead, canvasWriteBoard } from "./lib/tools.js";
export { uiAsset, uiAssign, uiCreate, uiFrame, uiGet, uiList, uiRemove, uiSave } from "./lib/commands.js";
export { uiWatch } from "./lib/watch.js";
