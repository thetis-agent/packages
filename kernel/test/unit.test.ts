import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Fences, Mount, PackageInfo, Userspace } from "@thetis/contracts";
import { Journal } from "@thetis/lib/journal";
import { MountStore } from "@thetis/lib/mounts";
import { RestartLatch, type ArmResult, type FireReport, type RestartState } from "@thetis/lib/restart";
import { UserspaceLayout } from "@thetis/lib/userspace-layout";
import { UserStore } from "../src/users.js";
import { AuthService } from "../src/auth.js";
import { ProviderRegistry } from "../src/providers.js";
import { ServiceSupervisor } from "../src/services.js";
import type { PackageManager } from "../src/packages/manager.js";
import { validateManifest } from "../src/packages/manifest.js";
import { Enumerator, BUILTIN_CALL } from "../src/pipeline/enumerator.js";
import { defaultConfig, saveConfig, loadConfig, MARKETPLACE_URL } from "../src/config.js";
import { createControlHandler, redact } from "../src/control.js";
import type { KernelServices } from "../src/kernel.js";

const tmp = () => mkdtempSync(join(tmpdir(), "thetis-unit-"));

test("user store: create, moderate, authorize", () => {
  const home = tmp();
  try {
    const users = new UserStore(home);
    assert.ok(users.get("_system"));
    users.create("alice");
    assert.throws(() => users.create("Alice"), /invalid user id/);
    assert.throws(() => users.create("alice"), /already exists/);
    users.setStatus("alice", "suspended");
    assert.throws(() => users.authorize("alice"), /suspended/);
    users.setStatus("alice", "active");
    assert.equal(users.setRole("alice", "admin").role, "admin");
    assert.throws(() => users.remove("_system"), /system user/);
    assert.equal(new UserStore(home).get("alice")?.role, "admin", "persists across instances");
    users.remove("alice");
    assert.equal(users.get("alice"), undefined);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("manifest validation rejects unscoped names and missing thetis field", () => {
  assert.throws(() => validateManifest({ name: "foo", version: "1", thetis: { type: "tool" } }), /scoped/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1" } as never), /thetis/);
  assert.throws(() => validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x" } as never] } }), /phase/);
  assert.ok(validateManifest({ name: "@a/foo", version: "1", thetis: { type: "loader", steps: [{ id: "x", phase: "prompt", export: "x" }] } }));
});

const pkgs: PackageInfo[] = [
  { name: "@a/mem", version: "1", type: "memory", description: "", root: "/x", thetis: { type: "memory", steps: [{ id: "load", phase: "prompt", export: "load" }, { id: "save", phase: "after", export: "save" }] } },
  { name: "@a/hist", version: "1", type: "loader", description: "", root: "/y", thetis: { type: "loader", steps: [{ id: "trim", phase: "history", export: "trim" }] } },
];

test("default enumerator orders steps by phase and places the built-in call last in its phase", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  const plan = e.defaultPlan(pkgs).map((s) => `${s.phase}:${s.export}`);
  assert.deepEqual(plan, ["history:trim", "prompt:load", "call:provider-call", "after:save"]);
});

test("enumerator output is validated against declared package steps", () => {
  const e = new Enumerator(defaultConfig("/tmp/h", "/tmp/p"), undefined as never);
  assert.throws(() => e.validate([{ package: "@a/mem", export: "nope" }], pkgs), /undeclared/);
  assert.throws(() => e.validate({} as never, pkgs), /array/);
  const ok = e.validate([{ package: "@a/hist", export: "trim" }, BUILTIN_CALL], pkgs);
  assert.equal(ok.length, 2);
  assert.equal(ok[1].package, "@thetis/kernel");
});

test("auth: passwords, tokens, expiry, and revocation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "thetis-auth-"));
  try {
    const users = new UserStore(dir);
    users.create("alice");
    const auth = new AuthService(dir, users, 200);
    await assert.rejects(auth.setPassword("nobody", "x"), /unknown user/);
    await assert.rejects(auth.setPassword("_system", "x"), /cannot sign in/);
    await assert.rejects(auth.setPassword("alice", ""), /empty/);
    assert.equal(await auth.login("alice", "secret"), undefined, "no password yet");
    await auth.setPassword("alice", "secret");
    assert.equal(await auth.login("alice", "wrong"), undefined);
    assert.equal(await auth.login("nobody", "secret"), undefined);
    const login = await auth.login("alice", "secret");
    assert.ok(login && /^[a-f0-9]{64}$/.test(login.token));
    assert.equal(auth.authenticate(login!.token)?.id, "alice");
    assert.equal(new AuthService(dir, users).authenticate(login!.token)?.id, "alice", "tokens persist");
    users.setStatus("alice", "suspended");
    assert.equal(auth.authenticate(login!.token), undefined, "a suspended user's token is refused");
    assert.equal(await auth.login("alice", "secret"), undefined);
    users.setStatus("alice", "active");
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(auth.authenticate(login!.token), undefined, "expired");
    const again = (await auth.login("alice", "secret"))!;
    await auth.setPassword("alice", "other");
    assert.equal(auth.authenticate(again.token), undefined, "a new password revokes tokens");
    const last = (await auth.login("alice", "other"))!;
    auth.logout(last.token);
    assert.equal(auth.authenticate(last.token), undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config: the promoted packages directory is derived and secrets are redacted for display", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    assert.equal(cfg.promotedPackagesDir, join(home, "packages"));
    assert.ok(cfg.fence.readOnly.includes(join(home, "packages")));
    cfg.packages["@thetis/provider-openrouter"] = { apiKey: "sk-live", baseUrl: "https://x", headers: { Authorization: "Bearer t" } };
    saveConfig(cfg);
    const raw = JSON.parse(readFileSync(join(home, "thetis.config.json"), "utf8"));
    assert.equal(raw.promotedPackagesDir, undefined);
    assert.equal(loadConfig(home, "/other").promotedPackagesDir, join(home, "packages"));
    const shown = redact(cfg);
    assert.equal(shown.packages["@thetis/provider-openrouter"].apiKey, "•••");
    assert.equal(shown.packages["@thetis/provider-openrouter"].baseUrl, "https://x");
    assert.equal(shown.model, cfg.model);
    assert.deepEqual(shown.phases, cfg.phases);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("config: the approved extensions are a registry a fresh install already has", () => {
  const cfg = defaultConfig("/tmp/h", "/tmp/p");
  assert.ok(cfg.systemPackages._system?.includes("@thetis/marketplace"), "the service runs in the system userspace");
  const registries = (cfg.packages["@thetis/marketplace"] as { registries: { name: string; url: string }[] }).registries;
  assert.deepEqual(registries, [{ name: "thetis", url: MARKETPLACE_URL }]);
  assert.match(MARKETPLACE_URL, /^https:\/\/github\.com\/thetis-agent\/packages\.git$/);
});

test("config: a registry url survives being saved and read back, so an operator can replace it", () => {
  const home = tmp();
  try {
    const cfg = defaultConfig(home, "/proj");
    cfg.packages["@thetis/marketplace"] = { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] };
    saveConfig(cfg);
    const back = loadConfig(home, "/proj");
    assert.deepEqual(back.packages["@thetis/marketplace"], { registries: [{ name: "mine", url: "https://git.example.com/pkgs.git" }] });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("services.reload closes the fence first, then opens a new one and starts the services on it", async () => {
  const home = tmp();
  try {
    const order: string[] = [];
    const pkg = { name: "@x/svc", version: "1", type: "service", description: "", root: "/x", thetis: { type: "service", service: { export: "startService" } } } as PackageInfo;
    const packages = { installed: () => [pkg], seedSystem: () => order.push("seed") } as unknown as PackageManager;
    const handle = { request: async (op: string) => (order.push(`${op}:${pkg.name}`), "started"), close: async () => {} };
    const fences = {
      close: async (id?: string) => void order.push(`close:${String(id)}`),
      handle: async (us: Userspace) => (order.push(`open:${us.id}`), handle),
      request: async () => "started",
    } as unknown as Fences;
    const userspaces = new UserspaceLayout(home);
    userspaces.ensure("alice");
    const sup = new ServiceSupervisor(defaultConfig(home, "/proj"), new UserStore(home), userspaces, packages, fences, () => {}, new Journal(home));
    await sup.boot();
    order.length = 0;
    await sup.reload("alice");
    assert.deepEqual(order, ["close:alice", "open:alice", "service.start:@x/svc"], "the old process is gone before the new one starts");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

/**
 * The restart methods, against a real latch on an injected clock. The clock never moves on its own, the
 * handler records instead of exiting, and something is always in flight, so no latch here can ever come due:
 * a test that let one fire would end the test process, which is the one failure this feature cannot have.
 */
test("restart.request: an admin arms the latch, nobody else does, and every answer is a row", async () => {
  const home = tmp();
  try {
    const users = new UserStore(home);
    users.create("alice", "admin");
    users.create("bob");
    let clock = Date.now();
    const fired: FireReport[] = [];
    const latch = new RestartLatch({
      // The kernel's own `control` block is what the host hands the latch, so the test uses it as the daemon does.
      config: defaultConfig(home, "/proj").control,
      inFlight: () => ["bob/s_1"],
      policy: () => "always",
      env: { INVOCATION_ID: "test" },
      now: () => clock,
    });
    latch.onFire((r) => void fired.push(r));
    const k = { users, journal: new Journal(home), restart: latch, restartPolicy: () => "always" } as unknown as KernelServices;
    const control = createControlHandler(k);
    const request = (actor: string | undefined, reason?: string) => control("restart.request", { actor, reason }) as Promise<ArmResult>;
    const rows = (kind: string) => k.journal.tail(50, { kind });

    await assert.rejects(request("alice"), /needs a reason/, "a restart with no stated reason cannot be asked for");
    // Refused for being young: the refusal is the latch's own sentence, and the row says which guard spoke.
    const young = await request("alice", "trying it out");
    assert.equal(young.state, "refused");
    assert.equal(young.why, "young");
    assert.match(young.message, /Nothing was armed and nothing is going to happen/);
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.refused")[0].data, { reason: "trying it out", why: "young" });
    assert.equal(rows("restart.refused")[0].actor, "alice");

    clock += 61_000;
    // A user and the system userspace are both refused here, not by `rpc.ts`, which admits any non-user.
    await assert.rejects(request("bob", "new code"), (e: { code: string }) => e.code === "unauthorized");
    await assert.rejects(request("_system", "new code"), (e: { code: string }) => e.code === "unauthorized");
    assert.equal(latch.status().pending, undefined, "a refused caller arms nothing");
    assert.equal(rows("restart.armed").length, 0, "and leaves no row saying it did");

    const armed = await request("alice", "new kernel code");
    assert.equal(armed.state, "armed");
    assert.equal(armed.pending?.reason, "new kernel code");
    assert.match(armed.message, /A restart is armed: new kernel code \(asked by alice\)/);
    const row = rows("restart.armed")[0];
    assert.equal(row.actor, "alice");
    assert.equal(row.target, "daemon");
    assert.deepEqual(row.data, { reason: "new kernel code" });

    // Asking again is two requests meeting, not a fault: it arms nothing further and says so.
    const again = await request("alice", "new kernel code");
    assert.equal(again.state, "again");
    assert.equal(rows("restart.again").length, 1);
    assert.equal(latch.status().pending?.at, armed.pending?.at, "still the first one");

    const shown = (await control("restart.status", {})) as RestartState & { policy: string | null };
    assert.equal(shown.pending?.by, "alice");
    assert.equal(shown.policy, "always", "and what the deployed unit says, which decides whether it would come back");

    assert.deepEqual(await control("restart.cancel", { actor: "alice" }), { cancelled: true, was: armed.pending });
    assert.equal(latch.status().pending, undefined);
    assert.deepEqual(rows("restart.cancel")[0].data, { reason: "new kernel code", by: "alice" });
    assert.deepEqual(await control("restart.cancel", {}), { cancelled: false, was: null }, "cancelling nothing is not an event");
    assert.equal(rows("restart.cancel").length, 1);
    assert.deepEqual(fired, [], "no latch fires in this process");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("providers.forget drops one userspace's cached model list, so a reloaded provider is asked again", async () => {
  let asked = 0;
  const pkg = { name: "@x/prov", version: "1", type: "provider", description: "", root: "/x", thetis: { type: "provider" } } as PackageInfo;
  const packages = { installed: () => [pkg] } as unknown as PackageManager;
  const userspaces = { exists: () => true, pathFor: (id: string) => ({ id }) } as unknown as UserspaceLayout;
  const fences = { request: async () => (asked++, [{ id: "m1" }]) } as unknown as Fences;
  const providers = new ProviderRegistry(defaultConfig("/tmp/h", "/tmp/p"), packages, userspaces, fences);
  const alice = { id: "alice" } as Userspace;
  assert.deepEqual(await providers.listModels(alice), [{ id: "m1", provider: "@x/prov" }]);
  await providers.listModels(alice);
  assert.equal(asked, 1, "the list is memoized in this process for five minutes");
  providers.forget("bob");
  await providers.listModels(alice);
  assert.equal(asked, 1, "another workspace's reload leaves it alone");
  providers.forget("alice");
  await providers.listModels(alice);
  assert.equal(asked, 2, "after a reload the provider is asked what it serves now");
});

test("mounts.set: validates the list, writes the store, journals the change, and reopens the fence", async () => {
  const home = tmp();
  try {
    const users = new UserStore(home);
    users.create("alice");
    const closed: string[] = [];
    const ensured: string[] = [];
    const k = {
      users,
      journal: new Journal(home),
      mounts: new MountStore(home),
      fences: { close: async (id: string) => void closed.push(id) },
      // `mounts.set` reaches the fence through `services.reload`, which is the pair below; the supervisor's
      // own reload is tested for being that pair, so the double here keeps this test about mounts.
      services: { ensure: async (id: string) => void ensured.push(id), reload: async (id: string) => { await k.fences.close(id); await k.services.ensure(id); } },
    } as unknown as KernelServices;
    const control = createControlHandler(k);
    const set = (user: string, mounts: unknown) => control("mounts.set", { user, mounts });
    await assert.rejects(set("nobody", []), (e: { code: string }) => e.code === "not-found");
    await assert.rejects(set("_system", []), /takes no mounts/);
    await assert.rejects(set("alice", "nope"), /list of at most 32/);
    await assert.rejects(set("alice", Array.from({ length: 33 }, () => ({ path: "/x", mode: "ro" }))), /at most 32/);
    for (const path of ["relative", "/a/../b", "/a/", "/a//b", "/", ""]) {
      await assert.rejects(set("alice", [{ path, mode: "rw" }]), (e: { code: string; message: string }) => e.code === "invalid" && /invalid mount path/.test(e.message), path);
    }
    await assert.rejects(set("alice", [{ path: "/srv/x", mode: "rwx" }]), /invalid mount mode/);
    await assert.rejects(set("alice", [null]), /invalid mount path/);
    assert.deepEqual(closed, [], "nothing changed until the list is valid");
    const mounts: Mount[] = [{ path: "/srv/x", mode: "ro" }, { path: home, mode: "rw" }];
    // The answer and the list say what the host holds now: the temporary home is there, /srv/x is not.
    const state = [{ path: "/srv/x", mode: "ro", present: false, kind: "none" }, { path: home, mode: "rw", present: true, kind: "dir" }];
    assert.deepEqual(await set("alice", mounts), state);
    assert.deepEqual(new MountStore(home).get("alice"), mounts, "persisted");
    assert.deepEqual(closed, ["alice"], "the fence is closed so it reopens with the binds");
    assert.deepEqual(ensured, ["alice"], "the supervisor reopens it and restarts the services");
    const row = k.journal.tail(1, { kind: "mounts" })[0];
    assert.equal(row.target, "alice");
    assert.equal(row.actor, "operator");
    assert.deepEqual(row.data, { mounts });
    assert.deepEqual(await control("mounts.list", { user: "alice" }), { alice: state });
    assert.deepEqual(await control("mounts.list", {}), { alice: state });
    await set("alice", []);
    assert.deepEqual(await control("mounts.list", {}), {}, "an empty list removes the entry");
    // browse: the operator sees the host filesystem, and learns what a path is when it is not a directory.
    mkdirSync(join(home, "repos"));
    mkdirSync(join(home, ".hidden"));
    const listing = (await control("mounts.browse", { path: home })) as { entries: { name: string; path: string }[]; readable: boolean; parent: string | null };
    assert.equal(listing.readable, true);
    assert.deepEqual(listing.entries, [{ name: "repos", path: join(home, "repos") }], "directories only, and no hidden names");
    assert.equal(listing.parent, dirname(home));
    assert.equal((await control("mounts.browse", { path: "/srv/x" }) as { kind: string }).kind, "none");
    assert.equal((await control("mounts.browse", { path: join(home, "users.json") }) as { kind: string }).kind, "file");
    await assert.rejects(control("mounts.browse", { path: "relative" }), /absolute and normalized/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
