import "server-only";

// Deterministic route-failure injection for E2E / unit tests ONLY.
//
// An error boundary that has never caught a real thrown route error is an
// assertion about JSX, not about behaviour. Proving app/(app)/error.tsx
// actually contains a failure needs a route that really throws, inside the real
// authenticated route group, behind the real middleware and the real app shell.
//
// Same fail-closed posture as the existing fake-Google / fake-Stripe /
// fake-Resend guards (lib/google-calendar/e2e/fake-google-guard.ts,
// lib/stripe/e2e-fake-guard.ts, lib/email/e2e-fake-resend.ts):
//
//   * OFF unless the explicit server-only marker HONE_E2E_ROUTE_FAULT=1 is set.
//     Server-only, never NEXT_PUBLIC_*, so a browser can neither read nor set
//     it, and it is not derived from any request input (no header, cookie,
//     query or form value can turn it on).
//   * REFUSED outright in any deployed runtime. Vercel / AWS / Kubernetes
//     signals are always present in a deployed environment and never on the
//     local E2E server, so the combination required here cannot exist in
//     production.
//   * The consuming page calls notFound() when the guard fails, so in every
//     deployed build the fault route is a 404 and not a reachable "crash" URL.
//
// NODE_ENV is intentionally NOT the gate: the local E2E lane runs `next start`,
// which sets NODE_ENV=production, so gating on it would disable the only
// environment this exists for.

// Environment signals that prove a HOSTED/deployed runtime.
function deployedEnvironmentSignal(env: NodeJS.ProcessEnv): string | null {
  if (env.VERCEL === "1") return "VERCEL";
  if (env.VERCEL_ENV) return `VERCEL_ENV=${env.VERCEL_ENV}`;
  if (env.AWS_REGION || env.AWS_EXECUTION_ENV) return "AWS";
  if (env.KUBERNETES_SERVICE_HOST) return "KUBERNETES";
  return null;
}

/** True only when fault injection is explicitly and safely enabled. */
export function isE2eRouteFaultEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.HONE_E2E_ROUTE_FAULT !== "1") return false;
  return deployedEnvironmentSignal(env) === null;
}

/**
 * FAIL-LOUD deployment guard: if the marker is REQUESTED in a deployed runtime,
 * throw rather than quietly ignoring it, so a misconfiguration or an attempted
 * bypass surfaces immediately. A no-op when the flag is absent, i.e. always, in
 * production.
 */
export function assertRouteFaultNotRequestedInDeployment(
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (env.HONE_E2E_ROUTE_FAULT !== "1") return;
  const signal = deployedEnvironmentSignal(env);
  if (signal) {
    throw new Error(
      `HONE_E2E_ROUTE_FAULT must never be set in a deployed environment (${signal}).`,
    );
  }
}

// The injectable cases. Each one exists to prove a specific boundary property;
// see e2e/authenticated-route-error-containment.spec.ts.
//
//   ok           negative control: same route, same guard, no throw. Proves the
//                error UI appears because of the THROW, not because this route
//                is special.
//   server-throw a Server Component loader throws. The contained case.
//   client-throw a client component throws AFTER hydration, so the browser
//                holds the real message and there is no digest. This is the
//                non-vacuous leak test: in a production build a server error's
//                message is already elided by React, so only this case can
//                prove the boundary itself withholds it.
//   once         throws the FIRST time a given token is rendered, then renders
//                normally. Proves Try again actually recovers.
//   redirect     calls redirect(). Must NOT be converted into an error screen.
//   not-found    calls notFound(). Must stay a 404, distinct from an error.
export const E2E_ROUTE_FAULT_CASES = [
  "ok",
  "server-throw",
  "client-throw",
  "once",
  "redirect",
  "not-found",
] as const;

export type E2eRouteFaultCase = (typeof E2E_ROUTE_FAULT_CASES)[number];

export function asRouteFaultCase(value: string): E2eRouteFaultCase | null {
  return (E2E_ROUTE_FAULT_CASES as ReadonlyArray<string>).includes(value)
    ? (value as E2eRouteFaultCase)
    : null;
}

// A string that looks exactly like the sensitive text a real loader throws
// (lib/**: `Failed to load clients: ${error.message}`). The specs assert it
// never reaches the DOM. Defined here so the page and the specs cannot drift.
export const E2E_ROUTE_FAULT_CANARY =
  'relation "clients" does not exist [HONE-LEAK-CANARY-9f3c1d]';

// Per-token bookkeeping for the `once` case, so Try again has something real to
// recover from. Module-scoped, exactly like failedOnceRecipients in
// lib/email/e2e-fake-resend.ts: the single local E2E server process keeps it
// across requests within a run. Keyed by a per-visit token from the query
// string rather than by a global flag, so a Playwright retry (which re-runs the
// whole test with a fresh token) is not silently served the already-recovered
// state and cannot pass vacuously. Holds only opaque harness tokens.
const failedOnceTokens = new Set<string>();

/** True the FIRST time a token is seen, false afterwards. */
export function shouldFailOnceForToken(token: string): boolean {
  if (failedOnceTokens.has(token)) return false;
  failedOnceTokens.add(token);
  return true;
}
