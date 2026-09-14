import { KERNEL_PACKAGE, PROVIDER_CALL_STEP, type Fences, type PackageInfo, type SessionInfo, type StepRef, type Userspace } from "@thetis/contracts";
import { CodedError } from "@thetis/lib/error";
import type { KernelConfig } from "../config.js";
import { declaresStep } from "../packages/manifest.js";

export const BUILTIN_CALL: StepRef = { package: KERNEL_PACKAGE, export: PROVIDER_CALL_STEP, id: PROVIDER_CALL_STEP };

/**
 * enumerate(config, session) -> Step[]. The default walks the configured phases and schedules
 * every installed package step declared for each phase, placing the built-in provider call at
 * the end of the call phase. A package enumerator, if configured, replaces this; its output is
 * validated so it can only schedule steps that installed packages actually declare.
 */
export class Enumerator {
  constructor(
    private readonly config: KernelConfig,
    private readonly fences: Fences,
  ) {}

  async enumerate(us: Userspace, session: SessionInfo, packages: PackageInfo[]): Promise<StepRef[]> {
    const custom = this.config.enumerator;
    if (!custom) return this.defaultPlan(packages);
    const raw = await this.fences.request(us, "enumerate", { ...custom, ctx: { session, packages, phases: this.config.phases } });
    return this.validate(raw, packages);
  }

  defaultPlan(packages: PackageInfo[]): StepRef[] {
    const plan: StepRef[] = [];
    for (const phase of this.config.phases) {
      for (const pkg of packages) {
        for (const s of pkg.thetis.steps ?? []) {
          if (s.phase === phase) plan.push({ package: pkg.name, export: s.export, id: `${pkg.name}#${s.id}`, phase });
        }
      }
      if (phase === this.config.callPhase) plan.push({ ...BUILTIN_CALL, phase });
    }
    return plan;
  }

  validate(raw: unknown, packages: PackageInfo[]): StepRef[] {
    if (!Array.isArray(raw)) throw new CodedError("enumerator must return an array of steps", "enumerator");
    return raw.map((r: StepRef) => {
      if (isBuiltin(r)) return { ...BUILTIN_CALL, phase: r.phase };
      const pkg = packages.find((p) => p.name === r.package);
      if (!pkg || !declaresStep(pkg, r)) throw new CodedError(`enumerator scheduled undeclared step ${r.package}#${r.export}`, "enumerator");
      return { package: r.package, export: r.export, id: r.id ?? `${r.package}#${r.export}`, phase: r.phase };
    });
  }
}

export function isBuiltin(ref: StepRef): boolean {
  return ref.package === KERNEL_PACKAGE && ref.export === PROVIDER_CALL_STEP;
}
