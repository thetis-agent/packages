// Static files: the gateway's own assets and the browser files a package contributes. One table of the
// types the page may load, one containment check, one way to send a file. A path that leaves its root,
// names a directory, or has an extension outside the table is a plain 404, whoever asked.
import { existsSync, readFileSync, statSync } from "node:fs";
import type { ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { HttpError } from "./http.js";

export const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
};

/**
 * The page's policy. `style-src` carries a nonce because a terminal emulator writes its own stylesheet at
 * runtime: 55 KiB of palette, font metrics and cursor rules, generated per terminal from the theme, which
 * cannot be shipped as a file. The nonce is minted for each response and travels in a meta tag, so only
 * the code this response served can stamp it; CSS from anywhere else is still refused, which is what
 * `'unsafe-inline'` would have given up. A response with no nonce keeps the old policy exactly.
 * `img-src` allows `blob:` for the composer's thumbnails of the pictures a person has attached but not
 * yet sent: they are object URLs of files the page itself was handed, never anything fetched.
 */
const csp = (nonce: string): string =>
  `default-src 'self'; img-src 'self' data: blob:; style-src 'self'${nonce ? ` 'nonce-${nonce}'` : ""}; script-src 'self'; connect-src 'self'; form-action 'self'; frame-ancestors 'none'`;

/** True when `file` is strictly inside `root`, by path arithmetic; symlinks are not followed. */
export function within(root: string, file: string): boolean {
  return file.startsWith(root.replace(/[\\/]+$/, "") + sep);
}

/** Serves one file under `root`. `fill` substitutes placeholders in an HTML page, which is how the page learns its base path. */
export function serveFile(res: ServerResponse, root: string, name: string, extra: Record<string, string> = {}, fill: Record<string, string> = {}): void {
  const file = resolve(root, name);
  if (!within(root, file) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "not found");
  const type = TYPES[extname(file)];
  if (!type) throw new HttpError(404, "not found");
  // The policy and the page read the nonce from one place, so they can never disagree about it.
  if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", csp(fill["{{nonce}}"] ?? ""));
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...extra });
  let body: Buffer | string = readFileSync(file);
  if (Object.keys(fill).length) {
    body = body.toString("utf8");
    for (const [k, v] of Object.entries(fill)) body = body.split(k).join(v);
  }
  res.end(body);
}
