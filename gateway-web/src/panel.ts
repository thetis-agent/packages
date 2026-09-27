// The control panel's API: the packages of the person this gateway serves, as the built-in Packages
// section reads them. That section is the bootstrap: with nothing else installed a person must still be
// able to install from the browser. Everything else the panel once did lives in packages now: people,
// models, the journal, the configuration and mounts in `@thetis/ui-admin`; the registries, the package
// pages and the admin verbs over packages in `@thetis/ui-marketplace`. The gateway imports no domain
// package at all.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { KernelClient, PackageInfo, UserRole } from "@thetis/runtime/contracts";
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
  /** The manifest's human name (`thetis.label`), when it has one. */
  label?: string;
  scope: "me" | "everyone";
  /** Whether every person gets it; `everyoneBy` says whose decision that was. */
  everyone: boolean;
  steps: { id: string; phase: string }[];
  tools: string[];
  service: boolean;
  /** Set on a fork: what it was copied from, and what it displaced in this person's setup. */
  forkedFrom?: { name: string; version: string };
  /** Set on a fork: the same origin, plus what that origin is at on disk now, whether this copy differs from it at all, and whether it is what everyone else gets. */
  fork?: { name: string; version: string; shipped?: string; identical?: boolean; everyone?: boolean };
  replaced?: string;
  /** Why everyone gets it: the installation's settings file, a promotion of a person's extension, or an admin's mark. */
  everyoneBy?: "config" | "promoted" | "marked";
  /** The manifest's `thetis.audience`: `"admin"` for an extension only an admin is offered. */
  audience?: string;
  /** Where its files came from: shipped with Thetis (or promoted into it), a directory under a home, or a registry's git source. */
  source?: "system" | "local" | "git";
  /** Whether it brings skills, and how many places, docks and panels it adds: the publisher line's kinds. */
  hasSkills: boolean;
  pages: number;
  /** The version this person's workspace loaded, when it is not the one on disk: an update ready to apply. */
  loaded?: string;
  /** This person's own configuration report when something is missing: the summary and the missing keys, never a value. */
  config?: { broken: true; summary: string; keys: MissingKey[] };
}

/** One missing configuration key, as the one state reads it: whose it is to fix, never its value. */
export interface MissingKey {
  key: string;
  state: "missing";
  scope?: "system" | "user";
  missing?: string[];
  source?: string;
  help?: string;
  secret: boolean;
}

/** How many places, docks and panels a manifest adds to the page. */
function pageCount(ui: unknown): number {
  if (!ui || typeof ui !== "object") return 0;
  const slots = ui as Record<string, unknown>;
  return ["places", "dock", "panel", "sidebar", "shelf"].reduce((n, slot) => n + (Array.isArray(slots[slot]) ? (slots[slot] as unknown[]).length : 0), 0);
}

export function toRow(p: PackageInfo): PackageRow {
  return {
    name: p.name,
    version: p.version,
    type: p.type,
    description: p.description,
    ...(typeof p.thetis.label === "string" ? { label: p.thetis.label } : {}),
    scope: p.everyone ? "everyone" : "me",
    everyone: Boolean(p.everyone),
    steps: (p.thetis.steps ?? []).map((s) => ({ id: s.id, phase: s.phase })),
    tools: (p.thetis.tools ?? []).map((t) => t.name),
    service: !!p.thetis.service,
    ...(p.forkedFrom ? { forkedFrom: { name: p.forkedFrom.name, version: p.forkedFrom.version } } : {}),
    ...(p.fork ? { fork: { name: p.fork.name, version: p.fork.version, ...(p.fork.shipped ? { shipped: p.fork.shipped } : {}), ...(p.fork.identical ? { identical: true } : {}), ...(p.fork.everyone ? { everyone: true } : {}) } } : {}),
    ...(p.replaced ? { replaced: p.replaced } : {}),
    ...(p.everyoneBy ? { everyoneBy: p.everyoneBy } : {}),
    ...(typeof p.thetis.audience === "string" ? { audience: p.thetis.audience } : {}),
    ...(p.source ? { source: p.source.kind } : {}),
    hasSkills: typeof p.thetis.skills === "string" && p.thetis.skills.length > 0,
    pages: pageCount(p.thetis.ui),
    ...(p.loadedVersion && p.loadedVersion !== p.version ? { loaded: p.loadedVersion } : {}),
  };
}

/**
 * The person's own configuration state, folded onto the rows of the packages that declare settings: a row
 * whose report is broken carries its summary and missing keys, so the list can say Needs setup, or "Waiting
 * for your admin" when only an admin can set what is missing. A report that cannot be read says nothing.
 */
export async function withSetup(kernel: KernelClient, list: PackageInfo[], rows: PackageRow[]): Promise<PackageRow[]> {
  await Promise.all(
    list.map(async (p, i) => {
      if (!p.thetis.config || !Object.keys(p.thetis.config).length) return;
      try {
        const report = await kernel.config.show(p.name);
        if (!report.broken) return;
        const keys: MissingKey[] = report.keys
          .filter((k) => k.state === "missing")
          .map((k) => ({ key: k.key, state: "missing", ...(k.scope ? { scope: k.scope } : {}), ...(k.missing?.length ? { missing: k.missing } : {}), ...(k.source ? { source: k.source } : {}), ...(k.help ? { help: k.help } : {}), secret: Boolean(k.secret) }));
        rows[i] = { ...rows[i], config: { broken: true, summary: report.summary, keys } };
      } catch {
        /* not read: the row says nothing about its settings */
      }
    })
  );
  return rows;
}

/** Handles `/api/panel` and `/api/packages`. Returns false when the path is not one of them. */
export async function handlePanel(kernel: KernelClient, req: IncomingMessage, res: ServerResponse, who: Who, seg: string[], method: string, url: URL): Promise<boolean> {
  // The built-in sections only. A package's sections come from `api/ui`, already filtered by role.
  if (seg[1] === "panel" && method === "GET") return json(res, 200, { user: who.id, role: who.role, sections: ["packages"] }), true;
  if (seg[1] !== "packages") return false;

  if (seg.length === 2 && method === "GET") {
    const list = await kernel.packages.list();
    return json(res, 200, await withSetup(kernel, list, list.map(toRow))), true;
  }
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
