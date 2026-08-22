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

// TEST-PORT-01. The app PORT is a deterministic CANDIDATE derived per worktree,
// and local server reuse is off by default, so a candidate collision fails
// loudly instead of testing another worktree's server. Global uniqueness is not
// promised. Only the port varies: the host is a literal, so nothing here can be
// pointed off the local machine. See scripts/worktree-resources.mjs.
// @ts-expect-error - .mjs utility ships without type declarations
import { resolveResources } from "../../scripts/worktree-resources.mjs";

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

// Derived only AFTER the hostile-environment guard above has run, so the order
// reads the way the safety model works: refuse anything pointing off this
// machine first, then decide which local port this worktree owns.
const RESOURCES: {
  port: number;
  origin: string;
  host: string;
  worktree: string;
  reuseExistingServer: boolean;
} = resolveResources();

// localhost, NOT 127.0.0.1: the auth callback redirects to the
// request origin as the browser presents it, and the session cookie
// must live on the SAME host string end to end. The host is a literal
// in scripts/worktree-resources.mjs for that reason; only the PORT is
// derived per worktree.
//
// The local GoTrue accepts this origin without any config change: it
// treats every LOOPBACK redirect target as valid regardless of port
// (verified against the running stack — localhost/127.0.0.1/[::1] on
// any port are kept, while example.com and localhost.evil.com fall
// back to site_url). So supabase/config.toml stays untouched.
export const E2E_APP_ORIGIN: string = RESOURCES.origin;
export const E2E_APP_PORT: number = RESOURCES.port;
export const E2E_WORKTREE: string = RESOURCES.worktree;

// Reusing an already-running server is the exact mechanism that let a run in
// one worktree attach to another's. It is OFF unless deliberately requested.
export const E2E_REUSE_EXISTING_SERVER: boolean = RESOURCES.reuseExistingServer;
export const E2E_SUPABASE_URL = LOCAL_SUPABASE_URL;
export const E2E_DB_URL = LOCAL_DB_URL;
export const E2E_MAILPIT_URL = LOCAL_MAILPIT_URL;
export const E2E_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

// Environment for the Next dev server under test. Mirrors the fast
// CI lane's dummy/test-safe values, with Supabase pointed at the
// LOCAL stack. Nothing here is a real secret.
export const E2E_WEB_SERVER_ENV: Record<string, string> = {
  // Explicitly propagate the fake-Resend marker to the Next server when the
  // browser-e2e job requests it (the webServer.env replaces process.env, so it
  // must be listed here — same pattern as the fake-Stripe lane). Only the
  // welcome/invitation path reads getResendTransport, so other emails are
  // unaffected. Server-only marker; the module's own guard refuses it in any
  // deployed runtime.
  ...(process.env.HONE_E2E_FAKE_RESEND === "1"
    ? { HONE_E2E_FAKE_RESEND: "1" }
    : {}),
  // REL-001 route fault injection. Server-only marker; the module's own guard
  // (lib/reliability/e2e-route-fault.ts) refuses it in any deployed runtime and
  // the fault page 404s without it, so it is safe to arm unconditionally for
  // this hardcoded-to-127.0.0.1 lane. Set here rather than passed through from
  // the outer process because webServer.env REPLACES process.env.
  HONE_E2E_ROUTE_FAULT: "1",
  // `next start` reads PORT when no -p flag is given (commander `.env("PORT")`),
  // so the derived port reaches the server without any shell interpolation in
  // package.json — which also keeps the npm script portable.
  PORT: String(E2E_APP_PORT),
  NEXT_PUBLIC_APP_ORIGIN: E2E_APP_ORIGIN,
  NEXT_PUBLIC_SUPABASE_URL: LOCAL_SUPABASE_URL,
  NEXT_PUBLIC_SUPABASE_ANON_KEY: LOCAL_ANON_KEY,
  SUPABASE_SERVICE_ROLE_KEY: LOCAL_SERVICE_ROLE_KEY,
  RESEND_API_KEY: "re_dummy_resend_key",
  // P0 new-client waitlist. Exactly ONE reserved slug is enabled for this lane,
  // and e2e/new-client-waitlist.spec.ts is the only spec that claims it. Every
  // other seeded studio uses a random `e2e-studio-<runId>` slug, so the whole
  // rest of the browser suite runs with the feature OFF — which is what makes
  // the extended run itself the flag-OFF regression proof.
  NEW_CLIENT_WAITLIST_STUDIO_SLUGS: "e2e-waitlist-p0",
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
  // e2e-operator@harness.local is the dedicated New Studio Wizard operator
  // (PR #254). isAdmin matches exactly, lowercased; keep it in this allowlist
  // so the operator e2e can reach /admin without colliding with other seeds.
  ADMIN_EMAILS: "e2e@harness.local,e2e-operator@harness.local",
};
