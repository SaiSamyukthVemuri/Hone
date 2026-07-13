import { randomUUID } from "node:crypto";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// Environment wiring for the dedicated payment browser E2E lane.
//
// ONE validated run id is shared across all four participants:
//   * the Next.js server process (via PAYMENT_WEB_SERVER_ENV → webServer.env),
//   * the Playwright runner + worker processes (via process.env, set below),
//   * the guarded server-side fake ledger (reads HONE_E2E_RUN_ID),
//   * the Playwright-side ledger helper (reads HONE_E2E_RUN_ID).
//
// The CI job exports HONE_E2E_RUN_ID before launching Playwright, so this module
// reuses it; locally (or if unset) it generates one and pins it on process.env so
// the value the webServer receives is the SAME value the worker processes inherit.
// The run id matches the fake-Stripe guard regex (lib/stripe/e2e-fake-guard.ts).

function resolveRunId(): string {
  const existing = process.env.HONE_E2E_RUN_ID;
  if (existing && /^[a-z0-9][a-z0-9-]{7,63}$/i.test(existing)) return existing;
  const generated = `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  process.env.HONE_E2E_RUN_ID = generated;
  return generated;
}

export const PAYMENT_E2E_RUN_ID = resolveRunId();
export const PAYMENT_E2E_APP_ORIGIN = E2E_APP_ORIGIN;

// The Next server env: the proven local E2E env PLUS the two server-only fake
// markers. No NEXT_PUBLIC_* fake flag, no Vercel markers, sk_test_dummy only, so
// the fake-Stripe activation guard passes ONLY here and never in a deployed lane.
export const PAYMENT_WEB_SERVER_ENV: Record<string, string> = {
  ...E2E_WEB_SERVER_ENV,
  HONE_E2E_FAKE_STRIPE: "1",
  HONE_E2E_RUN_ID: PAYMENT_E2E_RUN_ID,
};
