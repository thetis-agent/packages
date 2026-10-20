// What runs inside the file jail (jail.js): reads `{root, ops}` on stdin, applies each op with the checks
// of safe-fs.js, and writes one result per op as a JSON array on stdout. Imported in-process too, when
// there is no bubblewrap to jail it with.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { safeAppend, safeList, safeRead, safeRemove, safeWrite } from "./safe-fs.js";

export function applyOps(root, ops) {
  return ops.map((o) => {
    try {
      switch (o?.op) {
        case "read":
          return { ok: true, value: safeRead(root, o.path) };
        case "write":
          safeWrite(root, o.path, o.content);
          return { ok: true };
        case "append":
          safeAppend(root, o.path, o.content);
          return { ok: true };
        case "list":
          return { ok: true, value: safeList(root, o.path) };
        case "remove":
          safeRemove(root, o.path);
          return { ok: true };
        default:
          return { ok: false, error: `unknown file op: ${String(o?.op)}`, code: "invalid" };
      }
    } catch (e) {
      return { ok: false, error: e?.message ?? String(e), code: e?.code ?? "io" };
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { root, ops } = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify(applyOps(root, ops)));
}
