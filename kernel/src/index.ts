// The kernel's public surface. Authority only: who may do what. The vocabulary is in @thetis/contracts,
// the mechanism in @thetis/lib and @thetis/sandbox, and the wiring in @thetis/host.
export { CodedError as KernelError } from "@thetis/lib/error";
export { defaultConfig, loadConfig, saveConfig, configPath, packagesLayer, type KernelConfig } from "./config.js";
export { UserStore } from "./users.js";
export { AuthService, type Credential, type TokenRecord } from "./auth.js";
export { ServiceSupervisor } from "./services.js";
export { ConfigService, type Affected, type ConfigChange, type ConfigTarget, type Settings } from "./settings.js";
export { createRpcHandler, type RpcServices } from "./rpc.js";
export { createControlHandler, redact } from "./control.js";
export { PackageRegistry } from "./packages/registry.js";
export { PackageManager, type PackageListener } from "./packages/manager.js";
export { readManifest, validateManifest } from "./packages/manifest.js";
export { ProviderRegistry, type ResolvedProvider } from "./providers.js";
export { SessionApi, SESSION_ID, type SessionRef, type TurnInput } from "./sessions/api.js";
export { Enumerator, BUILTIN_CALL, isBuiltin } from "./pipeline/enumerator.js";
export { ProviderCallStep } from "./pipeline/provider-call.js";
export { PipelineRunner } from "./pipeline/runner.js";
export type { KernelServices } from "./kernel.js";
