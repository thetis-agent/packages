// Applying an arm's change inside the trial kernel, before the run: always to the namespace's copy of the
// person's home and configuration, never to the real ones. Files are written with the checks of
// safe-fs.js, because the home is the person's and a link in it could otherwise lead the write out of the
// overlay.
import { safeList, safeRead, safeRemove, safeWrite } from "./safe-fs.js";

const ACTOR = "trial";
const HARNESS = "@thetis/harness-core";

/** The value of one key as the person's effective configuration has it, or undefined. */
async function current(kernel, user, name, key) {
  const report = await kernel.settings.show({ user, name });
  return report.keys.find((k) => k.key === key)?.value;
}

/**
 * Writes `change` into the trial's world. `home` is the person's home directory as the namespace sees it.
 * Answers a one-line description for the log.
 */
export async function applyChange(kernel, user, home, change) {
  if (!change) return "no change";
  switch (change.kind) {
    case "skill": {
      if (change.content !== null) {
        safeWrite(home, change.path, change.content);
        return `skill ${change.id} written to ${change.path}`;
      }
      safeRemove(home, change.path);
      // Its directory goes too when nothing is left in it (never `skills/` itself).
      const dir = change.path.split("/").slice(0, -1).join("/");
      try {
        if (dir !== "skills" && safeList(home, dir).length === 0) safeRemove(home, dir);
      } catch {
        // a directory that is a link, or gone: the file is what had to go
      }
      return `${change.path} removed`;
    }
    case "project-instructions":
      if (safeRead(home, `projects/${change.project}.json`) === null) throw new Error(`project ${change.project} does not exist`);
      if (change.content === null) {
        safeRemove(home, `projects/${change.project}.md`);
        return `instructions of ${change.project} removed`;
      }
      safeWrite(home, `projects/${change.project}.md`, change.content);
      return `instructions of ${change.project} replaced`;
    case "guide-note": {
      const notes = await current(kernel, user, HARNESS, "guideNotes");
      await kernel.settings.set({ user, name: HARNESS }, "guideNotes", [...(Array.isArray(notes) ? notes : []), change.note], ACTOR);
      return "guide note appended";
    }
    case "config":
      if (change.value === null) {
        await kernel.settings.unset({ user, name: change.package }, change.key, ACTOR);
        return `${change.package} ${change.key} unset`;
      }
      await kernel.settings.set({ user, name: change.package }, change.key, change.value, ACTOR);
      return `${change.package} ${change.key} set`;
    default:
      throw new Error(`unknown change kind: ${String(change?.kind)}`);
  }
}

/** Assigns `session` to `project`, the way @thetis/workflows does: one entry in `projects/sessions.json`. */
export function assignProject(home, session, project) {
  if (safeRead(home, `projects/${project}.json`) === null) throw new Error(`project ${project} does not exist`);
  let map = {};
  try {
    const parsed = JSON.parse(safeRead(home, "projects/sessions.json") ?? "{}");
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) map = parsed;
  } catch {
    // an unreadable map is an empty one
  }
  map[session] = project;
  safeWrite(home, "projects/sessions.json", JSON.stringify(map, null, 2) + "\n");
}
