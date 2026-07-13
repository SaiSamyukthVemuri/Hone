import "server-only";

// Server-only activation guard for the (future) E2E fake Stripe processor.
//
// This module decides NOTHING about payment business logic. It answers exactly
// one question — "may a fake Stripe processor activate in THIS runtime?" — and
// is FAIL-CLOSED: fake mode is OFF unless an explicit server-only marker is
// present AND no deployed-environment signal is present.
//
// Why the markers are safe:
//   * They are server-only env vars (HONE_E2E_*), NEVER NEXT_PUBLIC_*, so the
//     browser can never read or set them.
//   * They are not derived from any request input (no header/cookie/query/form).
//   * Any Vercel runtime (production/preview/development) is rejected outright —
//     VERCEL === "1" and VERCEL_ENV are always present on Vercel and never on the
//     local E2E server.
//
// Why NODE_ENV is intentionally NOT the gate:
//   The local E2E web server runs `next start` (NODE_ENV=production), so rejecting
//   on NODE_ENV=production would break the ONLY environment fake mode is meant
//   for. The real boundary is the positive HONE_E2E_* markers plus the Vercel
//   rejection — a combination that cannot exist in any deployed environment.

// A run id must be an explicit, well-formed, per-run token (the E2E harness
// generates one). Its presence is a second positive marker that cannot exist in
// a deployed environment.
export function isValidE2eRunId(runId: string | undefined | null): boolean {
  return typeof runId === "string" && /^[a-z0-9][a-z0-9-]{7,63}$/i.test(runId);
}

// The set of environment signals that prove a HOSTED/deployed runtime. If ANY is
// present, fake Stripe is refused unconditionally.
function deployedEnvironmentSignal(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

// Throws (fail-closed) unless fake Stripe is explicitly + safely enabled.
export function assertE2eFakeStripeAllowed(
  env: NodeJS.ProcessEnv = process.env,
): void {
  // 1) Explicit server-only opt-in (default OFF).
  if (env.HONE_E2E_FAKE_STRIPE !== "1") {
    throw new Error("Fake Stripe is not enabled (HONE_E2E_FAKE_STRIPE !== '1').");
  }
  // 2) A valid per-run marker that cannot exist in a deployed environment.
  if (!isValidE2eRunId(env.HONE_E2E_RUN_ID)) {
    throw new Error("Fake Stripe requires a valid HONE_E2E_RUN_ID.");
  }
  // 3) Reject ANY hosted/deployed runtime outright.
  const signal = deployedEnvironmentSignal(env);
  if (signal) {
    throw new Error(`Fake Stripe cannot run in a deployed environment (${signal}).`);
  }
}

// Non-throwing predicate for consumers: true only when the guard passes.
export function isE2eFakeStripeEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  try {
    assertE2eFakeStripeAllowed(env);
    return true;
  } catch {
    return false;
  }
}

// FAIL-LOUD deployment guard. If the fake flag is REQUESTED in a deployed
// environment, throw at construction rather than silently ignoring it — a
// misconfiguration or attempted bypass must surface immediately, never fall back
// quietly to the real client. A no-op when the flag is absent (i.e. always, in
// production), so the real Stripe path is behaviourally unchanged.
export function assertFakeStripeNotRequestedInDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.HONE_E2E_FAKE_STRIPE !== "1") return; // not requested → nothing to guard
  const signal = deployedEnvironmentSignal(env);
  if (signal) {
    throw new Error(
      `HONE_E2E_FAKE_STRIPE must never be set in a deployed environment (${signal}).`,
    );
  }
}
