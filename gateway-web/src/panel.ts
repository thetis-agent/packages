// The control panel's API: packages of the person this gateway serves, the marketplace, and for admins
// the operator methods (people, packages of anyone, promotion, models, configuration, the journal). The
// gateway checks the role first so a refusal is a plain sentence; the kernel checks it again on every
// operator call, against the fence's own user.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { resolve } from "node:path";
import type { KernelClient, PackageInfo, UserRole } from "@thetis/contracts";
import { behind, readIndex, search, shortCommit, type Behind, type MirrorEnv } from "@thetis/marketplace";
import { field, HttpError, json, readJson } from "./http.js";

export interface Who {
  id: string;
  role: UserRole;
}

export interface PanelDeps {
  kernel: KernelClient;
  /** The userspace environment the marketplace index lives in. Without it the marketplace section is absent. */
  env?: MirrorEnv;
}

const USER_ID = /^[a-z][a-z0-9-]{0,31}$/;
const PACKAGE_NAME = /^@[a-z0-9-]+\/[a-z0-9._-]+$/;

/** One row of the packages table. Read by field name in the browser. */
export interface PackageRow {
  name: string;
  version: string;
  type: string;
  description: string;
  scope: "me" | "everyone";
  steps: { id: string; phase: string }[];
  tools: string[];
  service: boolean;
  /** Set on a fork: what it was copied from, and what it displaced in this person's setup. */
  forkedFrom?: { name: string; version: string };
  replaced?: string;
  /** Benchmark suites the package opts into, and what its last run found. */
  bench?: { suites: string[]; peerGroup?: string; reports?: BenchSummary[] };
  /** Set when the registry this was installed from now holds a newer commit. */
  update?: { version: string; from: string; to: string; source: string; registry: string };
}

/** Folds "there is a newer one" onto a row, in the short form a person reads rather than a full object name. */
export function withUpdate(row: PackageRow, found: Behind | undefined): PackageRow {
  if (!found) return row;
  return {
    ...row,
    update: { version: found.version, from: shortCommit(found.installed), to: shortCommit(found.available), source: found.source, registry: found.registry },
  };
}

export interface BenchSummary {
  suite: string;
  digest: string;
  generatedAt: string;
  arms: number;
  /** False when the arm claimed reach the assembled prompt did not show. */
  passed: boolean;
}

export function toRow(p: PackageInfo): PackageRow {
  return {
    name: p.name,
    version: p.version,
    type: p.type,
    description: p.description,
    scope: p.everyone ? "everyone" : "me",
    steps: (p.thetis.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (p.thetis.tools ?? []).map((t) => t.name),
    service: !!p.thetis.service,
    ...(p.forkedFrom ? { forkedFrom: { name: p.forkedFrom.name, version: p.forkedFrom.version } } : {}),
    ...(p.replaced ? { replaced: p.replaced } : {}),
    ...(p.thetis.bench
      ? {
          bench: {
            suites: p.thetis.bench.suites ?? [],
            ...(p.thetis.bench.peerGroup ? { peerGroup: p.thetis.bench.peerGroup } : {}),
            reports: benchReports(p.root, p.thetis.bench.report),
          },
        }
      : {}),
  };
}

/**
 * What a package's own bench directory says about it. Read from disk rather than recomputed: the report is
 * the artifact, and the panel shows what was actually written next to the code.
 */
function benchReports(root: string, reportDir = "bench"): BenchSummary[] {
  const at = resolve(root, reportDir);
  if (!existsSync(at)) return [];
  const out: BenchSummary[] = [];
  for (const entry of readdirSync(at)) {
    const file = resolve(at, entry, "report.json");
    if (!existsSync(file)) continue;
    try {
      const view = JSON.parse(readFileSync(file, "utf8")) as {
        suite?: string;
        suiteDigest?: string;
        generatedAt?: string;
        arms?: string[];
        report?: { conformance?: Record<string, { passed?: boolean }> };
      };
      if (!view.suite || !view.suiteDigest) continue;
      out.push({
        suite: view.suite,
        digest: view.suiteDigest,
        generatedAt: view.generatedAt ?? "",
        arms: view.arms?.length ?? 0,
        passed: Object.values(view.report?.conformance ?? {}).every((c) => c.passed !== false),
      });
    } catch {
      continue;
    }
  }
  return out.sort((a, b) => a.suite.localeCompare(b.suite));
}

/** Handles `/api/panel`, `/api/packages`, `/api/marketplace` and `/api/admin`. Returns false when the path is not one of them. */
export async function handlePanel(deps: PanelDeps, req: IncomingMessage, res: ServerResponse, who: Who, seg: string[], method: string, url: URL): Promise<boolean> {
  const { kernel, env } = deps;
  const admin = who.role !== "user";
  const requireAdmin = () => {
    if (!admin) throw new HttpError(403, "only an admin can do this");
  };
  const op = <T>(name: string, args: Record<string, unknown> = {}) => {
    requireAdmin();
    return kernel.operator.call<T>(name, args);
  };

  if (seg[1] === "panel" && method === "GET") {
    const sections = ["packages"];
    if (admin) sections.push("people", "models", "activity", "overview");
    return json(res, 200, { user: who.id, role: who.role, sections }), true;
  }

  if (seg[1] === "packages") {
    if (seg.length === 2 && method === "GET") {
      // Nothing updates on its own. The row says a newer commit exists and what to install to take it; a
      // person decides whether to.
      const installed = await kernel.packages.list();
      const available = env ? behind(installed, await readIndex(env)) : [];
      const byName = new Map(available.map((b) => [b.name, b]));
      return json(res, 200, installed.map((p) => withUpdate(toRow(p), byName.get(p.name)))), true;
    }
    if (seg.length === 2 && method === "POST") {
      const source = field(await readJson(req), "source");
      const installed = await kernel.packages.list();
      const info = await kernel.packages.install(source);
      if (installed.some((p) => p.name === info.name)) return json(res, 200, { ...toRow(info), reinstalled: true }), true;
      return json(res, 201, toRow(info)), true;
    }
    if (seg.length === 3 && method === "DELETE") {
      // `?files=1` deletes the directory too; the kernel allows that only for the person's own scope under their home.
      if (url.searchParams.get("files") === "1") return json(res, 200, await kernel.packages.delete(packageName(seg[2]))), true;
      await kernel.packages.uninstall(packageName(seg[2]));
      return json(res, 200, { name: packageName(seg[2]) }), true;
    }
    return false;
  }

  if (seg[1] === "marketplace") {
    if (!env) throw new HttpError(404, "no marketplace here");
    if (seg.length === 2 && method === "GET") {
      const index = await readIndex(env);
      if (!index) throw new HttpError(404, "The marketplace has no index yet. Install @thetis/marketplace in the system userspace and configure its registries.");
      const q = url.searchParams.get("q") ?? "";
      const type = url.searchParams.get("type") ?? undefined;
      const results = search(index, q, { type, limit: 200 });
      return json(res, 200, { updatedAt: index.updatedAt, registries: index.registries, total: index.packages.length, results }), true;
    }
    return false;
  }

  if (seg[1] !== "admin") return false;
  requireAdmin();

  if (seg[2] === "users") {
    if (seg.length === 3 && method === "GET") return json(res, 200, await op("users.list")), true;
    if (seg.length === 3 && method === "POST") {
      const body = await readJson(req);
      const id = field(body, "id", { pattern: USER_ID });
      const role = field(body, "role", { optional: true }) || "user";
      if (role !== "user" && role !== "admin") throw new HttpError(400, "role must be user or admin");
      const created = await op("users.create", { id, role });
      const password = field(body, "password", { optional: true });
      if (password) await op("users.passwd", { id, password });
      return json(res, 201, created), true;
    }
    const id = seg[3] ?? "";
    if (!USER_ID.test(id)) throw new HttpError(404, "unknown user");
    if (id === who.id && method !== "GET") throw new HttpError(400, "you cannot change your own account here");
    if (seg.length === 4 && method === "DELETE") return await op("users.remove", { id }), json(res, 200, { id }), true;
    if (seg[4] === "role" && method === "POST") {
      const role = field(await readJson(req), "role");
      if (role !== "user" && role !== "admin") throw new HttpError(400, "role must be user or admin");
      return json(res, 200, await op("users.setRole", { id, role })), true;
    }
    if (seg[4] === "status" && method === "POST") {
      const status = field(await readJson(req), "status");
      if (status !== "active" && status !== "suspended") throw new HttpError(400, "status must be active or suspended");
      return json(res, 200, await op("users.setStatus", { id, status })), true;
    }
    if (seg[4] === "password" && method === "POST") {
      const password = field(await readJson(req), "password");
      if (password.length < 8) throw new HttpError(400, "a password needs at least 8 characters");
      await op("users.passwd", { id, password });
      return json(res, 200, { id }), true;
    }
    return false;
  }

  if (seg[2] === "packages") {
    const user = (u: string | null) => {
      if (!u || !USER_ID.test(u)) throw new HttpError(400, "user is required");
      return u;
    };
    if (seg.length === 3 && method === "GET") {
      const rows = (await op<PackageInfo[]>("packages.list", { user: user(url.searchParams.get("user")) })).map(toRow);
      return json(res, 200, rows), true;
    }
    if (seg.length === 3 && method === "POST") {
      const body = await readJson(req);
      const info = await op<PackageInfo>("packages.install", { user: user(field(body, "user")), source: field(body, "source") });
      return json(res, 201, toRow(info)), true;
    }
    if (seg[3] === "everyone" && seg.length === 4 && method === "POST") {
      const result = await op<{ name: string; userspaces: string[] }>("packages.installEveryone", { source: field(await readJson(req), "source") });
      return json(res, 200, result), true;
    }
    const name = packageName(seg[3] ?? "");
    if (seg.length === 4 && method === "DELETE") {
      await op("packages.uninstall", { user: user(url.searchParams.get("user")), name });
      return json(res, 200, { name }), true;
    }
    if (seg[4] === "promote" && method === "POST") {
      const body = await readJson(req);
      const result = await op<{ name: string; userspaces: string[] }>("packages.promote", { user: user(field(body, "user")), name });
      return json(res, 200, result), true;
    }
    return false;
  }

  if (seg[2] === "models" && seg.length === 3 && method === "GET") {
    const [models, config] = await Promise.all([op<{ id: string; name?: string; provider?: string }[]>("models"), op<{ model: string }>("config.get")]);
    return json(res, 200, { model: config.model, models }), true;
  }

  if (seg[2] === "config" && seg.length === 3 && method === "GET") return json(res, 200, await op("config.get")), true;

  if (seg[2] === "journal" && seg.length === 3 && method === "GET") {
    const limit = Math.min(1000, Number(url.searchParams.get("limit") ?? 200) || 200);
    const kind = url.searchParams.get("kind") ?? undefined;
    return json(res, 200, await op("journal.tail", { limit, kind })), true;
  }

  return false;
}

function packageName(segment: string): string {
  const name = decodeURIComponent(segment);
  if (!PACKAGE_NAME.test(name)) throw new HttpError(404, "unknown package");
  return name;
}
