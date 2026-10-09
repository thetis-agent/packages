// A fake fence environment over a temporary home: readFile and writeFile relative to it, as the userspace
// agent gives them, a session, and optionally the files `@thetis/projects` would have written, so the
// project rules can be exercised without that package. Also a way to leave an edit by the person in a
// sheet's log, dated some minutes back, as a save from the page would.
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { inflateRawSync } from "node:zlib";
import { dirname, resolve } from "node:path";
import { mutate } from "../lib/store.js";
import { applyOps } from "../ui/core/workbook.js";

export async function makeEnv({ session = "s_1", projects = [], assignments = {} } = {}) {
  const home = await mkdtemp(resolve(tmpdir(), "sheets-home-"));
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

/** The sheet id in a tool's answer. */
export const idIn = (text) => /sh_[0-9a-f]{8}/.exec(text)?.[0];

/** Cells set by the person through `mutate`, as a save from the page does, the Change dated `minutesAgo` back. */
export async function personEdit(env, id, cells, { tab = "t1", minutesAgo = 1 } = {}) {
  const written = await mutate(env, id, (wb) => applyOps(wb, [{ op: "set", tab, cells }]), { by: "person", session: "page" });
  if (minutesAgo) {
    const file = resolve(env.cwd, "sheets", id, "sheet.json");
    const record = JSON.parse(await readFile(file, "utf8"));
    record.changes[record.changes.length - 1].at = new Date(Date.now() - minutesAgo * 60_000).toISOString();
    await writeFile(file, JSON.stringify(record, null, 2));
  }
  return written;
}

/** The entries of a zip archive (stored or deflated) as a Map name → text, read through its central directory. */
export function unzipText(buf) {
  const out = new Map();
  let end = buf.length - 22;
  while (end >= 0 && buf.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < 0) throw new Error("not a zip: no end of central directory");
  let at = buf.readUInt32LE(end + 16);
  for (let n = buf.readUInt16LE(end + 10); n > 0; n--) {
    if (buf.readUInt32LE(at) !== 0x02014b50) throw new Error("bad central directory entry");
    const method = buf.readUInt16LE(at + 10);
    const size = buf.readUInt32LE(at + 20);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLen).toString("utf8");
    if (buf.readUInt32LE(local) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const body = buf.subarray(start, start + size);
    out.set(name, (method === 8 ? inflateRawSync(body) : body).toString("utf8"));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}
