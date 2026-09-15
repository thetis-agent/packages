// A fake fence environment over a temporary home: readFile and writeFile relative to it, as the
// userspace agent gives them, plus a kernel whose package list is what the test says.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export async function makeEnv({ session, packages = [] } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "projects-home-"));
  const env = {
    cwd: home,
    root: home,
    store: home,
    shared: home,
    user: "alice",
    role: "user",
    session,
    readFile: (p) => readFile(resolve(home, p), "utf8"),
    writeFile: async (p, content) => {
      const file = resolve(home, p);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, content);
    },
    kernel: { packages: { list: async () => packages } },
  };
  return { home, env, done: () => rm(home, { recursive: true, force: true }) };
}

export const PACKAGES = [
  { name: "@thetis/tools-files", version: "0.3.0", thetis: { tools: [{ name: "read_path", description: "Read" }, { name: "write_path", description: "Write" }] } },
  { name: "@thetis/tool-exec", version: "0.1.0", thetis: { tools: [{ name: "exec", description: "Run" }] } },
  { name: "@thetis/harness-core", version: "0.1.0", thetis: { steps: [{ id: "x", phase: "prompt", export: "y" }] } },
];
