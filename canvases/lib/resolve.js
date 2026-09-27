// Which canvas a tool means: an id, or a title when exactly one canvas has it. The create answer always
// gives the id, and the model keeps it; the title is for the person's own words ("the onboarding canvas").
import { isCanvasId, listCanvases, readIndex } from "./store.js";

const fail = (message) => {
  throw new Error(message);
};

export async function resolveCanvas(env, ref) {
  if (typeof ref !== "string" || !ref.trim()) fail("canvas is required: a canvas id like c_1a2b3c4d, or a canvas's exact title.");
  const wanted = ref.trim();
  if (isCanvasId(wanted)) {
    const index = await readIndex(env, wanted);
    if (!index) fail(`No canvas ${wanted}. canvas_list shows the ones there are.`);
    return index;
  }
  const all = await listCanvases(env);
  const matches = all.filter((c) => c.title.toLowerCase() === wanted.toLowerCase());
  if (matches.length === 1) return matches[0];
  if (!matches.length) fail(`No canvas named ${JSON.stringify(wanted)}. canvas_list shows the ones there are; a canvas id like c_1a2b3c4d works too.`);
  fail(`${matches.length} canvases are named ${JSON.stringify(wanted)}: ${matches.map((c) => c.id).join(", ")}. Name one by its id.`);
}
