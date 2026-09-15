// What the fence has mounted, from THETIS_MOUNTS: a JSON list of { path, mode } the kernel sets when it
// opens the fence (03-fence.md section 3.5). This package reads it the way tools-files does, so the two
// agree on which project directory the file tools can reach. A directory is "mounted" when it is a mount
// or lies under one; the mode is the mount's. A directory under the home is reachable without a mount,
// but this package does not know the home's real path inside every sandbox mode, so it reports only what
// the variable says; the file tools are the authority on reach.
import { isAbsolute, relative } from "node:path";

/** Parses the variable's value. Absent or malformed means no mounts. */
export function mountsFromEnv(value) {
  try {
    const list = JSON.parse(value ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter((m) => m && typeof m.path === "string" && isAbsolute(m.path) && (m.mode === "rw" || m.mode === "ro"))
      .map((m) => ({ path: m.path, mode: m.mode }));
  } catch {
    return [];
  }
}

/** The mounts of this fence, read when asked so a test can set the variable. */
export const currentMounts = () => mountsFromEnv(process.env.THETIS_MOUNTS);

function isWithin(p, root) {
  if (p === root) return true;
  const rel = relative(root, p);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

/** "rw", "ro", or null when no mount covers the directory. The first covering mount wins. */
export function mountModeOf(directory, mounts) {
  for (const m of mounts) if (isWithin(directory, m.path)) return m.mode;
  return null;
}

/** One line for the system prompt: the path and whether the file tools can reach it. */
export function describeDirectory(directory, mounts, user) {
  const mode = mountModeOf(directory, mounts);
  if (mode) return `${directory} (mounted ${mode})`;
  return `${directory} (not mounted — ask an admin: thetis mounts add ${user} ${directory})`;
}
