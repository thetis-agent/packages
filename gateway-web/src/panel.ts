// The control panel's API: the packages of the person this gateway serves, as the built-in Packages
// section reads them. That section is the bootstrap: with nothing else installed a person must still be
// able to install from the browser. Everything else the panel once did lives in packages now: people,
// models, the journal, the configuration and mounts in `@thetis/ui-admin`; the registries, the package
// pages and the admin verbs over packages in `@thetis/ui-marketplace`. The gateway imports no domain
// package at all.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KernelClient, PackageInfo, UserRole } from "@thetis/contracts";
import { field, HttpError, json, readJson } from "./http.js";

export interface Who {
  id: string;
  role: UserRole;
}

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
  /** Set on a fork: the same origin, plus what that origin is at on disk now, whether this copy differs from it at all, and whether it is what everyone else gets. */
  fork?: { name: string; version: string; shipped?: string; identical?: boolean; everyone?: boolean };
  replaced?: string;
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
    ...(p.fork ? { fork: { name: p.fork.name, version: p.fork.version, ...(p.fork.shipped ? { shipped: p.fork.shipped } : {}), ...(p.fork.identical ? { identical: true } : {}), ...(p.fork.everyone ? { everyone: true } : {}) } } : {}),
    ...(p.replaced ? { replaced: p.replaced } : {}),
  };
}

/** Handles `/api/panel` and `/api/packages`. Returns false when the path is not one of them. */
export async function handlePanel(kernel: KernelClient, req: IncomingMessage, res: ServerResponse, who: Who, seg: string[], method: string, url: URL): Promise<boolean> {
  // The built-in sections only. A package's sections come from `api/ui`, already filtered by role.
  if (seg[1] === "panel" && method === "GET") return json(res, 200, { user: who.id, role: who.role, sections: ["packages"] }), true;
  if (seg[1] !== "packages") return false;

  if (seg.length === 2 && method === "GET") return json(res, 200, (await kernel.packages.list()).map(toRow)), true;
  if (seg.length === 2 && method === "POST") {
    const source = field(await readJson(req), "source");
    const installed = await kernel.packages.list();
    const info = await kernel.packages.install(source);
    if (installed.some((p) => p.name === info.name)) return json(res, 200, { ...toRow(info), reinstalled: true }), true;
    return json(res, 201, toRow(info)), true;
  }
  if (seg.length === 3 && method === "DELETE") {
    // `?unfork=1` is a removal that names what takes the package's place rather than hoping something does.
    // A plain removal puts back whatever the registry recorded this package as having displaced, and a fork
    // installed where its origin was not has no such record: the person loses the package and gets nothing,
    // which for a gateway means losing the browser. An un-fork reads the origin off the fork's own manifest
    // and refuses before it removes anything when that origin is not on disk here.
    if (url.searchParams.get("unfork") === "1") return json(res, 200, toRow(await kernel.packages.unfork(packageName(seg[2])))), true;
    // `?files=1` deletes the directory too; the kernel allows that only for the person's own scope under their home.
    if (url.searchParams.get("files") === "1") return json(res, 200, await kernel.packages.delete(packageName(seg[2]))), true;
    await kernel.packages.uninstall(packageName(seg[2]));
    return json(res, 200, { name: packageName(seg[2]) }), true;
  }
  return false;
}

function packageName(segment: string): string {
  const name = decodeURIComponent(segment);
  if (!PACKAGE_NAME.test(name)) throw new HttpError(404, "unknown package");
  return name;
}
