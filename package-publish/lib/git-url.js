// Are these two git urls the same repository? The whole checkout case turns on this question. The
// maintainer's remote is written `git@github.com:thetis-agent/packages.git`, the configured target may be
// written `https://github.com/thetis-agent/packages`, and a test's target is `file:///tmp/reg.git`. Git
// itself has no "same repo" test to borrow, so the comparison is a normal form: the host, then the path,
// with the transport, the user, the port, a trailing `.git` and a trailing slash all taken off, because
// none of them changes which repository is on the other end.
//
// Getting this wrong in the safe direction costs a redundant clone and a copy; getting it wrong in the
// other direction would commit into a checkout that is not the registry, so the normal form is deliberately
// conservative: anything it cannot parse comes back as itself and matches nothing but itself.
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * A local path, as canonical as the filesystem will say. The symlinks are resolved before the `.git`
 * suffix is taken off and not after, because a bare repository is the directory that ends in `.git`: the
 * path with the suffix is the one that exists and can be resolved, and `/srv/reg` never will be.
 */
function localKey(path) {
  const abs = resolve(path);
  let real = abs;
  try {
    real = realpathSync(abs);
  } catch {
    try {
      real = realpathSync(trimRepo(abs));
    } catch {
      real = abs;
    }
  }
  return trimRepo(real);
}

/**
 * The normal form of a git url: `host/path` for a hosted repository, an absolute filesystem path for a
 * local one. The host is lowercased because DNS is case-insensitive; the path of a hosted repository is
 * lowercased too, because every git host this is pointed at treats `Thetis-Agent/packages` and
 * `thetis-agent/packages` as one repository and a case difference here would silently take the wrong
 * branch. A local path keeps its case, because the filesystem under it does.
 */
export function repoKey(raw) {
  let s = String(raw ?? "").trim();
  if (!s) return "";
  s = s.replace(/\/+$/, "");
  const scheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(s);
  if (scheme) {
    const proto = scheme[1].toLowerCase();
    let rest = scheme[2];
    if (proto === "file") {
      // `file://host/path` is legal and the host is always local or empty; the path is what matters.
      return localKey(rest.replace(/^[^/]*/, ""));
    }
    const at = rest.indexOf("@");
    const firstSlash = rest.indexOf("/");
    if (at !== -1 && (firstSlash === -1 || at < firstSlash)) rest = rest.slice(at + 1);
    const cut = rest.indexOf("/");
    const host = (cut === -1 ? rest : rest.slice(0, cut)).replace(/:\d+$/, "");
    const path = cut === -1 ? "" : rest.slice(cut);
    return `${host.toLowerCase()}${trimRepo(path).toLowerCase()}`;
  }
  // The scp-like form git accepts without a scheme: `[user@]host:path`. A leading `/` or `.` means a plain
  // path, and a Windows-style `C:` is not something this installation deals in.
  const scp = /^(?:[^@/]+@)?([^:/]+):(.+)$/.exec(s);
  if (scp && !s.startsWith("/") && !s.startsWith(".")) {
    return `${scp[1].toLowerCase()}${trimRepo(`/${scp[2].replace(/^\/+/, "")}`).toLowerCase()}`;
  }
  return localKey(s);
}

function trimRepo(path) {
  return path.replace(/\.git$/, "").replace(/\/+$/, "");
}

export function sameRepository(a, b) {
  const x = repoKey(a);
  const y = repoKey(b);
  return Boolean(x) && x === y;
}

/** The name a url suggests for a target with none: the last path segment, without `.git`. */
export function slugOfUrl(url) {
  const key = repoKey(url);
  const last = key.split("/").filter(Boolean).at(-1) ?? "";
  return last || "registry";
}
