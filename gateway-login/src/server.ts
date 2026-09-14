// The login target: the one place a password becomes a token. It runs in the system userspace, the
// only fence the kernel lets log people in. It sets the cookie every person's gateway reads and sends
// the browser to that person's prefix. It never serves a conversation.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelClient } from "@thetis/contracts";

export interface LoginOptions {
  /** Directory of the static assets. Defaults to the package's `assets/`. */
  assets?: string;
  /** Adds `Secure` to the cookie. Set it when TLS terminates in front of the door. Config key `secure`. */
  secure?: boolean;
  log?: (line: string) => void;
}

export const COOKIE = "thetis_web";
const COOKIE_MAX_AGE = 30 * 24 * 60 * 60;
const BODY_LIMIT = 64 * 1024;
const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const TYPES: Record<string, string> = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml" };

class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function createLogin(kernel: KernelClient, opts: LoginOptions = {}): Server {
  const log = opts.log ?? ((line) => process.stderr.write(line + "\n"));
  const assets = opts.assets ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../assets");
  const secure = opts.secure === true;

  const server = createServer((req, res) => {
    handle(req, res).catch((err) => {
      const status = err instanceof HttpError ? err.status : 500;
      if (status >= 500) log(`[gateway-login] ${req.method} ${req.url}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`);
      if (res.headersSent) return res.end();
      res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
      res.end(err instanceof Error ? err.message : String(err));
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    if (path.startsWith("/login/assets/")) return serveAsset(res, assets, path.slice("/login/assets/".length));
    if (path === "/login" && method === "GET") return serveAsset(res, assets, "login.html", { "Cache-Control": "no-store" });
    if (path === "/login" && method === "POST") return login(req, res, url);
    if (path === "/logout" && method === "POST") return logout(req, res);
    if (path === "/" && method === "GET") {
      const who = await authenticate(req);
      return redirect(res, who ? `/${who.id}/` : "/login");
    }
    throw new HttpError(404, "not found");
  }

  async function authenticate(req: IncomingMessage): Promise<{ id: string } | undefined> {
    const token = cookies(req)[COOKIE];
    if (!token || !/^[a-f0-9]{64}$/.test(token)) return undefined;
    return (await kernel.auth.authenticate(token)) ?? undefined;
  }

  async function login(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    const body = await readForm(req);
    const id = String(body.id ?? "").trim();
    const password = String(body.password ?? "");
    const result = USER_ID.test(id) && password ? await kernel.auth.login(id, password) : null;
    if (!result) {
      log(`[gateway-login] refused login for ${JSON.stringify(id)} from ${req.socket.remoteAddress}`);
      if (wantsJson(req)) throw new HttpError(401, "the id or password was refused");
      return redirect(res, `/login?error=refused&next=${encodeURIComponent(String(body.next ?? url.searchParams.get("next") ?? ""))}`);
    }
    res.setHeader("Set-Cookie", cookie(result.token, COOKIE_MAX_AGE, secure));
    const next = safeNext(String(body.next ?? url.searchParams.get("next") ?? ""), id);
    if (wantsJson(req)) return json(res, 200, { user: id, next });
    return redirect(res, next);
  }

  async function logout(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const token = cookies(req)[COOKIE];
    if (token) await kernel.auth.logout(token);
    res.setHeader("Set-Cookie", cookie("", 0, secure));
    if (wantsJson(req)) return json(res, 200, { ok: true });
    return redirect(res, "/login");
  }

  async function readForm(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      size += (chunk as Buffer).length;
      if (size > BODY_LIMIT) throw new HttpError(413, "body too large");
      chunks.push(chunk as Buffer);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (wantsJson(req)) {
      try {
        const value = text.trim() ? JSON.parse(text) : {};
        return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
      } catch {
        throw new HttpError(400, "invalid JSON body");
      }
    }
    return Object.fromEntries(new URLSearchParams(text));
  }

  return server;
}

/** Where to go after sign-in: the requested path when it is one of the person's own, else their home. */
function safeNext(next: string, id: string): string {
  const own = `/${id}/`;
  return next === own || next.startsWith(own) ? next : own;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function redirect(res: ServerResponse, to: string): void {
  res.writeHead(303, { Location: to });
  res.end();
}

function cookie(value: string, maxAge: number, secure: boolean): string {
  const parts = [`${COOKIE}=${value}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAge}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

function cookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function wantsJson(req: IncomingMessage): boolean {
  return (req.headers["content-type"] ?? "").startsWith("application/json") || (req.headers.accept ?? "").includes("application/json");
}

function serveAsset(res: ServerResponse, root: string, name: string, extra: Record<string, string> = {}): void {
  const file = resolve(root, name);
  if (!file.startsWith(root + sep) || !existsSync(file) || !statSync(file).isFile()) throw new HttpError(404, "not found");
  const type = TYPES[extname(file)];
  if (!type) throw new HttpError(404, "not found");
  if (type.startsWith("text/html")) res.setHeader("Content-Security-Policy", "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; form-action 'self'; frame-ancestors 'none'");
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "no-cache", ...extra });
  res.end(readFileSync(file));
}
