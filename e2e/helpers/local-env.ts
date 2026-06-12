// ===========================================================================
// Browser E2E local-only environment (PR #227)
// ===========================================================================
//
// The E2E lane runs EXCLUSIVELY against the local Supabase stack
// (`supabase start`) and a local Next dev server. The two JWTs below
// are the PUBLIC, well-known supabase-demo keys that every local
// Supabase install ships with (issuer "supabase-demo"); they are not
// secrets and do not work against any hosted project.
//
// Safety model (pinned by tests/scripts/e2e-guardrails.test.ts):
//   * Every URL is hardcoded to 127.0.0.1. Env vars can NOT redirect
//     this lane at a hosted project: overrides are refused below.
//   * No production credential is read. Stripe/Resend/Twilio values
//     are the same dummy shapes the fast CI lane uses, so no real
//     email, SMS, or charge can ever leave this lane.
//   * Live payments stay structurally disabled (sk_test_ dummy key;
//     STRIPE_ALLOW_LIVE_MODE unset).

const LOCAL_SUPABASE_URL = "http://127.0.0.1:54321";
const LOCAL_DB_URL = "postgresql://postgres:postgres@127.0.0.1:54322/postgres";
const LOCAL_MAILPIT_URL = "http://127.0.0.1:54324";

// Public supabase-demo JWTs (local-only, same on every machine).
const LOCAL_ANON_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0";
const LOCAL_SERVICE_ROLE_KEY =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU";

const BANNED_URL_PATTERNS =
  /supabase\.co|supabase\.com|supabase\.in|pooler\.|amazonaws\.com|rds\.|azure|neon\.tech/i;

function refuseHostedOverrides() {
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_DB_URL",
    "HONE_LOCAL_DB_URL",
    "E2E_SUPABASE_URL",
  ]) {
    const value = process.env[name];
    if (!value) continue;
    if (BANNED_URL_PATTERNS.test(value) || !/127\.0\.0\.1|localhost/.test(value)) {
      throw new Error(
        `e2e refuses to run: ${name} points away from the local Supabase stack. This lane is local-only.`,
      );
    }
  }
  if (process.env.STRIPE_SECRET_KEY?.startsWith("sk_live_")) {
    throw new Error("e2e refuses to run: live Stripe key in environment.");
  }
  if (process.env.STRIPE_ALLOW_LIVE_MODE === "true") {
    throw new Error("e2e refuses to run: STRIPE_ALLOW_LIVE_MODE is set.");
  }
}

refuseHostedOverrides();

// localhost, NOT 127.0.0.1: the auth callback redirects to the
// request origin as the browser presents it, and the session cookie
// must live on the SAME host string end to end.
export const E2E_APP_ORIGIN = "http://localhost:3111";
export const E2E_SUPABASE_URL = LOCAL_SUPABASE_URL;
export const E2E_DB_URL = LOCAL_DB_URL;
export const E2E_MAILPIT_URL = LOCAL_MAILPIT_URL;
export const E2E_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

// Environment for the Next dev server under test. Mirrors the fast
// CI lane's dummy/test-safe values, with Supabase pointed at the
// LOCAL stack. Nothing here is a real secret.
export const E2E_WEB_SERVER_ENV: Record<string, string> = {
  NEXT_PUBLIC_APP_ORIGIN: E2E_APP_ORIGIN,
  NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: LOCAL_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY,
  RESEND_API_KEY: "re_dummy_resend_key",
  TWILIO_ACCOUNT_SID: "AC00000000000000000000000000000000",
  TWILIO_AUTH_TOKEN: "dummy-twilio-token",
  TWILIO_FROM_NUMBER: "+15555550100",
  STRIPE_SECRET_KEY: "sk_test_dummy",
  NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY: "pk_test_dummy",
  STRIPE_WEBHOOK_SECRET: "whsec_dummy",
  STRIPE_ALLOW_LIVE_MODE: "false",
  CRON_SECRET: "dummy-cron-secret",
  APPOINTMENT_SIGNING_SECRET: "dummy-appointment-signing-secret",
  INTAKE_SIGNING_SECRET: "dummy-intake-signing-secret",
  PORTAL_FINGERPRINT_SALT: "dummy-portal-fingerprint-salt-for-e2e",
  ADMIN_EMAILS: "e2e@harness.local",
};
