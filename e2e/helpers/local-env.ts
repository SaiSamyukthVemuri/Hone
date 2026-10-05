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

// TEST-PORT-01. The app PORT is a deterministic CANDIDATE derived per worktree.
// Playwright never reuses an already-running server, so an occupied candidate
// fails loudly rather than testing another worktree's server. Global uniqueness
// is not promised and is not needed. Only the port varies: the host is a
// literal, so nothing here can be pointed off the local machine.
// See scripts/worktree-resources.mjs.
// @ts-expect-error - .mjs utility ships without type declarations
import { resolveResources } from "../../scripts/worktree-resources.mjs";
import os from "node:os";
import path from "node:path";

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
const RESOURCES: { port: number; origin: string; host: string; worktree: string } =
  resolveResources();

// localhost, NOT 127.0.0.1: the auth callback redirects to the
// request origin as the browser presents it, and the session cookie
// must live on the SAME host string end to end. The host is a literal
// in scripts/worktree-resources.mjs for that reason; only the PORT is
// derived per worktree.
//
// The local GoTrue accepts this origin without any config change: it
// treats every LOOPBACK redirect target as valid regardless of port
// (verified against the running stack - localhost/127.0.0.1/[::1] on
// any port are kept, while example.com and localhost.evil.com fall
// back to site_url). So supabase/config.toml stays untouched.
export const E2E_APP_ORIGIN: string = RESOURCES.origin;
export const E2E_APP_PORT: number = RESOURCES.port;
export const E2E_WORKTREE: string = RESOURCES.worktree;
export const E2E_SUPABASE_URL = LOCAL_SUPABASE_URL;
export const E2E_DB_URL = LOCAL_DB_URL;
export const E2E_MAILPIT_URL = LOCAL_MAILPIT_URL;
export const E2E_SERVICE_ROLE_KEY = LOCAL_SERVICE_ROLE_KEY;

// SENTRY-E2E-NOISE-02. The preload that keeps every browser lane out of the
// operational Sentry project, and the file it records to. The guard answers
// each request bound for *.sentry.io from a loopback sink and writes what would
// have been sent here, so a spec can assert on the real runtime path. Keyed by
// worktree and port so two worktrees never read each other's records; a spec
// filters by time, so records from earlier runs are inert.
// See e2e/helpers/sentry-egress-guard.cjs.
export const E2E_SENTRY_EGRESS_GUARD = path.join(__dirname, "sentry-egress-guard.cjs");
export const E2E_SENTRY_EGRESS_LOG = path.join(
  os.tmpdir(),
  "hone-e2e-sentry-egress",
  `${path.basename(E2E_WORKTREE)}-${E2E_APP_PORT}.jsonl`,
);

/**
 * NODE_OPTIONS carrying the guard, COMPOSED with whatever the caller already
 * set. This environment is applied over the inherited one, so assigning the
 * guard alone would silently discard an operator's or CI's own options.
 * Idempotent, and quoted only when the path needs it (NODE_OPTIONS splits on
 * spaces outside double quotes).
 */
export function withSentryEgressGuard(existing: string | undefined): string {
  const current = (existing ?? "").trim();
  if (current.includes(E2E_SENTRY_EGRESS_GUARD)) return current;
  const target = /[\s"\\]/.test(E2E_SENTRY_EGRESS_GUARD)
    ? `"${E2E_SENTRY_EGRESS_GUARD.replace(/(["\\])/g, "\\$1")}"`
    : E2E_SENTRY_EGRESS_GUARD;
  return [current, `--require ${target}`].filter(Boolean).join(" ");
}

// Environment for the Next dev server under test. Mirrors the fast
// CI lane's dummy/test-safe values, with Supabase pointed at the
// LOCAL stack. Nothing here is a real secret.
export const E2E_WEB_SERVER_ENV: Record<string, string> = {
  // RESCHEDULE-E2E-01: THE FAKE EMAIL TRANSPORT IS ARMED FOR EVERY RUN OF THIS
  // LANE, not only when the outer job opts in.
  //
  // It used to be conditional, so an ordinary lane run sent appointment mail
  // through the REAL Resend SDK carrying `RESEND_API_KEY: re_dummy_resend_key`
  // below. The public-reschedule spec then asserted the failure copy and was
  // correct only for as long as api.resend.com kept rejecting that key
  // promptly: the same tree passed, then failed repeatedly, with no code
  // change. A test whose verdict is decided by a third party is not a test.
  //
  // Armed unconditionally for the same reason HONE_E2E_ROUTE_FAULT is below:
  // this lane is hardcoded to 127.0.0.1, the marker is server-only and never
  // NEXT_PUBLIC_*, and the module's own guard (lib/email/e2e-fake-resend.ts)
  // REFUSES to exist in any deployed runtime — so it cannot reach production.
  // Default mode is `success`; a spec drives a refusal per-recipient with a
  // `reject+`/`throw+` local-part, needing no restart and no global switch.
  HONE_E2E_FAKE_RESEND: "1",
  // A global MODE override, when the outer process sets one, forces every
  // recipient. Specs do NOT rely on it (it would apply to the whole server);
  // it exists for a deliberate whole-run refusal sweep.
  ...(process.env.HONE_E2E_FAKE_RESEND_MODE
    ? { HONE_E2E_FAKE_RESEND_MODE: process.env.HONE_E2E_FAKE_RESEND_MODE }
    : {}),
  // SESSION-START-01 slice 2 measurement. webServer.env REPLACES process.env,
  // so the timing switch has to be listed here to reach the server — same
  // pattern as the fake-Resend and fake-Stripe markers above. Forwarded ONLY
  // when the outer process asks for it, so ordinary e2e runs are unmeasured
  // and unaffected.
  ...(process.env.HONE_PERF_TIMING === "1" ? { HONE_PERF_TIMING: "1" } : {}),
  // REL-001 route fault injection. Server-only marker; the module's own guard
  // (lib/reliability/e2e-route-fault.ts) refuses it in any deployed runtime and
  // the fault page 404s without it, so it is safe to arm unconditionally for
  // this hardcoded-to-127.0.0.1 lane. Set here rather than passed through from
  // the outer process because webServer.env REPLACES process.env.
  HONE_E2E_ROUTE_FAULT: "1",
  // SENTRY-E2E-NOISE-02. Nothing this lane's server sends may reach the
  // operational Sentry project: not the deliberate faults above, not a real
  // failure raised during a run, not the browser envelopes the /monitoring
  // tunnel forwards. The guard is a NODE_OPTIONS preload rather than an app
  // setting so that the Sentry runtime wiring stays byte-identical and no
  // NEXT_PUBLIC_* input is involved. An inherited deployed-runtime signal
  // (AWS_REGION, VERCEL_ENV, ...) makes it refuse to start, failing the lane
  // before any spec runs rather than letting it send.
  NODE_OPTIONS: withSentryEgressGuard(process.env.NODE_OPTIONS),
  HONE_E2E_SENTRY_EGRESS_LOG: E2E_SENTRY_EGRESS_LOG,
  // `next start` reads PORT when no -p flag is given (commander `.env("PORT")`),
  // so the derived port reaches the server without any shell interpolation in
  // package.json - which also keeps the npm script portable.
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
  // WAIT-02 durable persistence, enabled for that SAME single reserved slug so
  // the browser lane exercises the database commit point rather than the
  // superseded email one. Same containment argument: no other seeded studio
  // holds this slug, so every other spec still runs with both flags OFF.
  NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS: "e2e-waitlist-p0",
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
