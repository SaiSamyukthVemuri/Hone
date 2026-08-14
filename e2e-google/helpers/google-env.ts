import { randomUUID } from "node:crypto";
import { E2E_APP_ORIGIN, E2E_WEB_SERVER_ENV } from "../../e2e/helpers/local-env";

// Environment wiring for the dedicated synthetic-Google browser E2E lane. Mirrors
// e2e-payment/helpers/payment-env.ts.
//
// ONE validated run id is shared across all participants:
//   * the Next.js server process (via GOOGLE_WEB_SERVER_ENV → webServer.env),
//   * the Playwright runner + worker processes (via process.env, set below),
//   * the guarded fake-Google ledger (server + runner sides, keyed by run id).
//
// The CI job exports HONE_E2E_RUN_ID + HONE_E2E_FAKE_GOOGLE before launching
// Playwright; this module reuses the run id (or generates one) and pins BOTH
// markers on the runner's process.env so the guarded ledger helpers can read/write
// scenario + events. The run id matches the fake-Google guard regex.

function resolveRunId(): string {
  const existing = process.env.HONE_E2E_RUN_ID;
  if (existing && /^[a-z0-9][a-z0-9-]{7,63}$/i.test(existing)) return existing;
  const generated = `run-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  process.env.HONE_E2E_RUN_ID = generated;
  return generated;
}

export const GOOGLE_E2E_RUN_ID = resolveRunId();
// The runner process must also carry the fake marker so the guarded ledger helpers
// (fake-google-e2e.ts) may read/write the per-run scenario + events.
process.env.HONE_E2E_FAKE_GOOGLE = "1";
export const GOOGLE_E2E_APP_ORIGIN = E2E_APP_ORIGIN;

// The Next server env: the proven local E2E env PLUS the server-only fake-Google
// marker + FAKE Google OAuth client + a valid (test-only) token-encryption key.
// No NEXT_PUBLIC_* fake flag, no Vercel markers, so the fake-Google activation
// guard passes ONLY here and never in a deployed lane. No real Google request is
// possible (the network seam routes to the synthetic provider).
export const GOOGLE_WEB_SERVER_ENV: Record<string, string> = {
  ...E2E_WEB_SERVER_ENV,
  HONE_E2E_FAKE_GOOGLE: "1",
  HONE_E2E_RUN_ID: GOOGLE_E2E_RUN_ID,
  // Present so getGoogleOAuthClient() returns a client (fake values, the fake
  // token exchange never validates the secret; no real Google endpoint is called).
  GOOGLE_OAUTH_CLIENT_ID: "fake-client.apps.googleusercontent.com",
  GOOGLE_OAUTH_CLIENT_SECRET: "fake-client-secret-e2e",
  // A well-formed 32-byte (64-hex) key so encryptGoogleSecret works, test-only.
  GOOGLE_TOKEN_ENCRYPTION_KEY: "a".repeat(64),
  GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION: "1",
};
