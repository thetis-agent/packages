// One real trial, end to end: `start` against a scratch THETIS_HOME, the real outer runner, a real inner one
// in its own namespaces, the real kernel and fences. The model is the echo provider fixture, and the env
// file is empty: the checkout's .env holds a real key, and no kernel this test starts may read it. Skipped
// where unprivileged user namespaces or bubblewrap are missing (CI on Ubuntu 24.04 restricts the first).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { start, status } from "../index.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const FIXTURES = resolve(ROOT, "test/host/fixtures");
const runs = (cmd, args) => spawnSync(cmd, args, { stdio: "ignore" }).status === 0;
const why = !runs("unshare", ["--user", "--map-root-user", "--mount", "--", "true"])
  ? "unprivileged user namespaces are not available here"
  : !runs("bwrap", ["--ro-bind", "/", "/", "--unshare-pid", "--", "true"])
    ? "bubblewrap is not available here"
    : !existsSync(resolve(ROOT, "dist/src/index.js")) || !existsSync(resolve(ROOT, "packages/store-toml/dist/src/index.js"))
      ? "the runtime is not built"
      : null;

/** Every file under `dir` with its size and mtime, and every directory, keyed by path relative to `dir`. */
function tree(dir, skip = () => false) {
  const out = new Map();
  const walk = (d) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name);
      const rel = relative(dir, p);
      if (skip(rel)) continue;
      const st = lstatSync(p);
      if (st.isDirectory()) {
        out.set(rel + "/", "dir");
        walk(p);
      } else {
        out.set(rel, `${st.size}:${st.mtimeMs}`);
      }
    }
  };
  walk(dir);
  return out;
}

test("a skill trial runs both arms in RAM and leaves the real home alone", { skip: why ?? false, timeout: 300_000 }, async () => {
  const scratch = mkdtempSync(join(tmpdir(), "tt-"));
  try {
    const home = join(scratch, "h");
    const sys = join(scratch, "sys");
    const work = join(scratch, "work");
    mkdirSync(home);
    mkdirSync(sys);
    mkdirSync(work);
    writeFileSync(join(work, "keep.txt"), "real\n");
    for (const name of ["harness-core", "tool-exec", "prompt-cache", "terminal", "store-toml"]) symlinkSync(resolve(ROOT, "packages", name), join(sys, name));
    symlinkSync(join(FIXTURES, "provider-echo"), join(sys, "provider-echo"));
    writeFileSync(join(home, "empty.env"), "");
    const rt = await import(pathToFileURL(resolve(ROOT, "dist/src/index.js")).href);
    const defaults = rt.defaultConfig(home, ROOT);
    writeFileSync(join(home, "thetis.config.json"), JSON.stringify({
      systemPackagesDir: sys,
      model: "echo",
      envFile: "empty.env",
      systemPackages: { "*": ["@thetis/harness-core", "@thetis/tool-exec", "@thetis/prompt-cache", "@thetis/terminal"], _system: ["@thetis/provider-echo"] },
      packages: { "@thetis/provider-echo": { tag: "trial" }, "@thetis/harness-core": { turnContext: false } },
      // What production has: the host's network and docker on. The trial must take both away from the person.
      fence: { sandbox: "bwrap", network: "host", docker: "auto", readOnly: [...defaults.fence.readOnly, sys, FIXTURES] },
      requestTimeoutMs: 60_000,
    }));

    // The person, their userspace, and a read-write mount, made by a kernel of the scratch home.
    const kernel = await rt.createKernel(rt.loadConfig(home, ROOT, {}), (c) => c.bind(rt.T.log, () => () => {}));
    kernel.users.create("ann");
    kernel.mounts.set("ann", [{ path: work, mode: "rw" }]);
    kernel.sessions.userspaceFor(kernel.users.authorize("ann"));
    await kernel.shutdown();

    const isTrialPath = (rel) => rel === "trials" || rel.startsWith("trials/") || rel === "userspaces/ann/home/trials" || rel.startsWith("userspaces/ann/home/trials/");
    const before = tree(home, isTrialPath);
    const workBefore = tree(work);

    const journal = [];
    const env = {
      home,
      root: ROOT,
      users: { get: (id) => (id === "ann" ? { id: "ann", role: "user", status: "active" } : undefined), list: () => [] },
      records: { mounts: { get: (u) => (u === "ann" ? [{ path: work, mode: "rw" }] : []) }, ssh: { get: () => [] } },
      journal: (row) => journal.push(row),
      log: () => {},
    };
    const skill = "---\nname: trial-probe\ndescription: A probe for the trial test.\n---\nPROBE-CONTENT-7f3a\n";
    const cmd = `cat skills/trial-probe/SKILL.md 2>/dev/null || echo MISSING-SKILL; echo leaked > ${work}/written.txt; echo leaked > ${work}/keep.txt; tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' ' | tr '\\n' ' '; echo; echo NETS-END`;
    const { trial } = await start({
      user: "ann",
      session: "s_0123abcd",
      request: { text: `run: ${cmd}` },
      model: "echo",
      arms: [{ id: "base", change: null }, { id: "change", change: { kind: "skill", id: "trial-probe", path: "skills/trial-probe/SKILL.md", content: skill } }],
      runs: 1,
      costUsd: 1,
      minutes: 3,
      scratchMb: 256,
    }, env);
    assert.match(trial, /^t_[0-9a-f]{8}$/);
    assert.equal(journal[0]?.kind, "trial.start");

    let t;
    for (let i = 0; i < 1200; i++) {
      t = await status({ trial, user: "ann" }, env);
      if (["done", "failed", "cancelled"].includes(t.state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const dir = join(home, "userspaces/ann/home/trials", trial);
    const logText = existsSync(join(dir, "log.txt")) ? readFileSync(join(dir, "log.txt"), "utf8") : "(no log)";
    assert.equal(t.state, "done", `trial ${t.state}: ${t.error ?? ""}\n${logText}`);
    assert.deepEqual(t.runs.map((r) => [r.arm, r.n, r.state]), [["base", 1, "done"], ["change", 1, "done"]], logText);

    const said = (arm) => {
      const record = JSON.parse(readFileSync(join(dir, `${arm}-1/record.json`), "utf8"));
      return JSON.stringify(record.conversation);
    };
    // The change arm's home had the skill; the base arm's did not.
    assert.match(said("change"), /PROBE-CONTENT-7f3a/);
    assert.doesNotMatch(said("base"), /PROBE-CONTENT-7f3a/);
    assert.match(said("base"), /MISSING-SKILL/);
    // The person's fence had no network: only the loopback interface.
    for (const arm of ["base", "change"]) assert.match(said(arm), /tool said: [^"]*\\nlo \\nNETS-END/, said(arm));

    // The docker socket was blocked, where there is one, and every overlay was checked.
    for (const arm of ["base", "change"]) {
      const iso = JSON.parse(readFileSync(join(dir, `${arm}-1/isolation.json`), "utf8"));
      assert.ok(iso.overlays.includes(home) || iso.overlays.some((o) => home.startsWith(o + "/")), `THETIS_HOME overlaid: ${iso.overlays}`);
      assert.ok(iso.overlays.includes(work), `the rw mount overlaid: ${iso.overlays}`);
      if (existsSync("/run/docker.sock")) assert.ok(iso.docker.length && iso.docker.every((d) => d.blocked), JSON.stringify(iso.docker));
      assert.ok(iso.sentinels >= 2);
    }

    // Nothing reached the real home outside trials/, nor the real mount.
    assert.deepEqual([...tree(home, isTrialPath)].filter(([k, v]) => before.get(k) !== v), []);
    assert.deepEqual([...before.keys()].filter((k) => !tree(home, isTrialPath).has(k)), []);
    assert.deepEqual(tree(work), workBefore);
    assert.equal(readFileSync(join(work, "keep.txt"), "utf8"), "real\n");
    assert.ok(!existsSync(join(home, "userspaces/ann/home/skills")));

    // A re-trial of an adopted skill: the real home has it, and the base arm removes it.
    const adopted = join(home, "userspaces/ann/home/skills/trial-probe/SKILL.md");
    mkdirSync(dirname(adopted), { recursive: true });
    writeFileSync(adopted, skill);
    const again = (await start({
      user: "ann",
      session: "s_0123abcd",
      request: { text: "run: cat skills/trial-probe/SKILL.md 2>/dev/null || echo MISSING-SKILL" },
      model: "echo",
      arms: [{ id: "base", change: { kind: "skill", path: "skills/trial-probe/SKILL.md", content: null } }, { id: "change", change: null }],
      runs: 1,
      costUsd: 1,
      minutes: 3,
      scratchMb: 256,
    }, env)).trial;
    let t2;
    for (let i = 0; i < 1200; i++) {
      t2 = await status({ trial: again, user: "ann" }, env);
      if (["done", "failed", "cancelled"].includes(t2.state)) break;
      await new Promise((r) => setTimeout(r, 200));
    }
    const dir2 = join(home, "userspaces/ann/home/trials", again);
    assert.equal(t2.state, "done", readFileSync(join(dir2, "log.txt"), "utf8"));
    const said2 = (arm) => JSON.stringify(JSON.parse(readFileSync(join(dir2, `${arm}-1/record.json`), "utf8")).conversation);
    assert.match(said2("base"), /MISSING-SKILL/);
    assert.match(said2("change"), /PROBE-CONTENT-7f3a/);
    assert.equal(readFileSync(adopted, "utf8"), skill, "the real skill is untouched");
  } finally {
    if (process.env.TRIALS_KEEP) console.error(`kept ${scratch}`);
    else rmSync(scratch, { recursive: true, force: true });
  }
});
