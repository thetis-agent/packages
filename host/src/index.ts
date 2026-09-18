// What a process that runs Thetis needs: a kernel wired to the sandbox, and the control socket for the CLI.
// The config surface is re-exported here so a host process — the command line, the bench runner — can build
// a kernel without importing @thetis/kernel itself.
export { createKernel, T, type Kernel } from "./kernel.js";
export { controlSocketPath } from "./control.js";
export { loadStoreDriver, openRecords, type Records } from "./store.js";
export { migrateStore, assertMigrated, LEGACY_FILES, type MigrationReport } from "./migrate.js";
export { RpcSocketServer as ControlServer } from "@thetis/lib/ndjson-socket";
export { defaultConfig, configPath, loadConfig, type KernelConfig } from "@thetis/kernel";
