// Fixtures for the tests: a temporary home, a skill directory written from parts, and a fake fence environment.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";

export function makeHome(prefix = "skills-") {
  const home = mkdtempSync(resolve(tmpdir(), prefix));
  return { home, rm: () => rmSync(home, { recursive: true, force: true }) };
}

/** A fake StepEnv/ToolEnv over `home`: readFile and writeFile relative to it, the way the agent does it. */
export function fakeEnv(home, extra = {}) {
  return {
    cwd: home,
    root: home,
    async readFile(p) {
      try {
        return readFileSync(resolve(home, p), "utf8");
      } catch (e) {
        throw Object.assign(new Error(`ENOENT: ${p}`), { code: e.code ?? "ENOENT" });
      }
    },
    async writeFile(p, content) {
      const file = resolve(home, p);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, content);
    },
    ...extra,
  };
}

/** SKILL.md text from parts. `meta` lines go under `metadata:` as given. */
export function skillText({ name, description, meta = [], body = "The body.\n" }) {
  const lines = ["---", `name: ${name}`, `description: ${description}`];
  if (meta.length) lines.push("metadata:", ...meta.map((l) => `  ${l}`));
  lines.push("---", body);
  return lines.join("\n");
}

/** Writes `<root>/<id>/SKILL.md` and any extra files `{ "references/a.md": "text" }`. */
export function writeSkill(root, id, text, files = {}) {
  const dir = resolve(root, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(resolve(dir, "SKILL.md"), text);
  for (const [name, content] of Object.entries(files)) {
    mkdirSync(dirname(resolve(dir, name)), { recursive: true });
    writeFileSync(resolve(dir, name), content);
  }
  return dir;
}

/** A PackageInfo-shaped record for a pack at `root` with `thetis.skills` set. */
export function packInfo(name, root, dir = "skills") {
  return { name, version: "0.0.1", type: "skill", description: "", root, thetis: { type: "skill", skills: dir } };
}

/** A small corpus of the bench's shape: every record carries a canary in its body, after its own frontmatter. */
export function smallCorpus() {
  const record = (id, name, description, tags, extraFm = "") => ({
    id,
    name,
    description,
    tags,
    canary: `⟦c:${id.replace(/\W/g, "").slice(-8)}⟧`,
    body: `---\nname: ${name}\ndescription: ${description}\n${extraFm}---\n⟦c:${id.replace(/\W/g, "").slice(-8)}⟧\n\n# ${name}\n\nBody of ${name}.\n`,
  });
  const records = [
    record("cap.a.alpha", "alpha", "Alpha does the first thing. Use when the request mentions alpha.", ["First Group", "alpha"]),
    record("cap.a.beta", "beta", "Beta does the second thing. Use when the request mentions beta.", ["First Group"], "allowed-tools:\n  - Read\nversion: 2\n"),
    record("cap.b.Gamma Ray", "Gamma Ray", "Gamma handles rays. Use for gamma.", ["Second Group"]),
  ];
  return { id: "caps@test", version: "1.0.0", sha256: "sha256:test0001", records };
}
