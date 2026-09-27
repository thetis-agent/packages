// A fake fence environment over a temporary home: readFile and writeFile relative to it, as the userspace
// agent gives them, a session, and optionally the files `@thetis/projects` would have written, so the
// project rules can be exercised without that package.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export async function makeEnv({ session = "s_1", projects = [], assignments = {} } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "canvases-home-"));
  const env = {
    cwd: home,
    root: home,
    store: home,
    shared: null,
    user: "alice",
    role: "user",
    session: { id: session, user: "alice" },
    config: {},
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    kernel: { packages: { list: async () => [] } },
  };
  for (const p of projects) await env.writeFile(`projects/${p.id}.json`, JSON.stringify({ id: p.id, name: p.name, directories: [], createdAt: "", updatedAt: "" }));
  if (Object.keys(assignments).length) await env.writeFile("projects/sessions.json", JSON.stringify(assignments));
  return { home, env, done: () => rm(home, { recursive: true, force: true }) };
}

/** An artboard with a props block, sized to `w`×`h`. */
export const page = (w = 1440, h = 900, extra = "") =>
  `<!doctype html><html><head><meta charset="utf-8"><title>T</title><script type="application/json" id="canvas-props">{"accent":{"editor":"color","default":"#123456","label":"Accent"},"dark":{"editor":"toggle","default":false}}</script><style>#board{width:${w}px;height:${h}px}</style></head><body><div id="board">hi${extra}</div></body></html>`;

/** The id in a tool's answer. */
export const idIn = (text) => /c_[0-9a-f]{8}/.exec(text)?.[0];
