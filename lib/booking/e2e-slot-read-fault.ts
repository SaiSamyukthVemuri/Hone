import "server-only";

// SCH-002: a deterministic slot-loader READ failure for E2E / unit tests ONLY.
//
// The public booking page must never turn "I could not read availability" into
// "No availability". Proving that in a browser needs a server whose slot read
// really fails, for ONE studio, while every other spec on the same server keeps
// working. Same fail-closed posture as lib/reliability/e2e-route-fault.ts:
//
//   * OFF unless the server-only marker HONE_E2E_SLOT_READ_FAULT=1 is set,
//     never NEXT_PUBLIC_*, never derived from request input.
//   * Even then it fires only for a studio whose slug starts with
//     E2E_SLOT_FAULT_SLUG_PREFIX, so no other studio on the lane can see it.
//   * REFUSED in any deployed runtime (the guard below throws), and a Vercel
//     production build is failed by scripts/check-production-env-gates.mjs
//     when the marker is present at all.

export const E2E_SLOT_FAULT_SLUG_PREFIX = "e2e-slot-fault-";

function deployedEnvironmentSignal(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

/** True only for the marked studio, with the marker set, off every deployed runtime. */
export function shouldFailSlotReadForSlug(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.HONE_E2E_SLOT_READ_FAULT !== "1") return false;
  if (deployedEnvironmentSignal(env) !== null) return false;
  return slug.startsWith(E2E_SLOT_FAULT_SLUG_PREFIX);
}

/** Fail loudly if the marker is requested in a deployed runtime. */
export function assertSlotReadFaultNotRequestedInDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.HONE_E2E_SLOT_READ_FAULT !== "1") return;
  const signal = deployedEnvironmentSignal(env);
  if (signal) {
    throw new Error(
      `HONE_E2E_SLOT_READ_FAULT must never be set in a deployed environment (${signal}).`,
    );
  }
}

/**
 * Throws the SAME error shape a failed availability read raises
 * (`availability_read_failed:`), so the action's real catch path is exercised.
 */
export function throwIfSlotReadFaulted(
  slug: string,
  env: NodeJS.ProcessEnv = process.env,
): void {
  assertSlotReadFaultNotRequestedInDeployment(env);
  if (shouldFailSlotReadForSlug(slug, env)) {
    throw new Error("availability_read_failed: e2e slot read fault");
  }
}
