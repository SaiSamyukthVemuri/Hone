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
import { resendLedgerPath } from "./resend-ledger-config";
import { twilioEgressLogPath, withTwilioEgressFake } from "./twilio-egress-config";

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

// Query parameters a PostgreSQL client gives PRECEDENCE over the URL authority
// (pg-connection-string, libpq). With one present, the authority this guard

// RE-EXPORTED, NOT REIMPLEMENTED. The implementation moved to
// `lib/net/loopback.ts` so production code can use it too: the synthetic
// profile gate was asking the same question with a substring test
// (Codex, #860 4298457391). Everything that imported it from here still
// does, and there is one definition rather than two that can drift.
// A RELATIVE PATH, NOT THE `@/` ALIAS. `vitest.db.config.ts` imports this
// module to run #879's paired-target guard at CONFIG LOAD, which Node
// resolves before any vite alias exists — `@/lib/net/loopback` fails there
// with "Cannot find module" and takes the whole DB suite down at startup.
export { isLoopbackUrl } from "../../lib/net/loopback";
import { isLoopbackUrl } from "../../lib/net/loopback";

/** Refuse a half-moved stack: the API and the database must leave the default together or not at all. */
export function assertSameStackPair(supabaseUrl: string, dbUrl: string): void {
  // By PORT, so `localhost:54322` and `127.0.0.1:54322` are the same default stack.
  const port = (u: string) => new URL(u).port;
  const apiMoved = port(supabaseUrl) !== port(LOCAL_SUPABASE_URL);
  const dbMoved = port(dbUrl) !== port(LOCAL_DB_URL);
  if (apiMoved !== dbMoved) {
    throw new Error(
      `e2e refuses to run: ${apiMoved ? "E2E_SUPABASE_URL" : "HONE_LOCAL_DB_URL"} selects another local stack ` +
        `but ${apiMoved ? "HONE_LOCAL_DB_URL" : "E2E_SUPABASE_URL"} does not. Set both to the same stack, or neither.`,
    );
  }
  // Both moved: they must name the SAME stack, or this is the original defect
  // between two isolated stacks (API on one, fixtures seeding another). A CONVENTION,
  // not a law: the Supabase CLI allocates each stack a contiguous port block with the
  // database one above the API (54321/54322, 63321/63322, ...), the same assumption
  // the two defaults above encode. A stack laid out otherwise is refused, fail-closed.
  const offset = (api: string, db: string) => Number(port(db)) - Number(port(api));
  if (apiMoved && offset(supabaseUrl, dbUrl) !== offset(LOCAL_SUPABASE_URL, LOCAL_DB_URL)) {
    throw new Error(
      `e2e refuses to run: E2E_SUPABASE_URL (port ${port(supabaseUrl)}) and HONE_LOCAL_DB_URL (port ${port(dbUrl)}) ` +
        `are not one stack (expected the database on the API port + ${offset(LOCAL_SUPABASE_URL, LOCAL_DB_URL)}).`,
    );
  }
}

/** The Mailpit of the stack whose API is `supabaseUrl`: same loopback host, API port + the default offset (3). */
export function mailpitFor(supabaseUrl: string): string {
  const port = (u: string) => Number(new URL(u).port);
  const api = new URL(supabaseUrl);
  return `http://${api.hostname}:${port(supabaseUrl) + port(LOCAL_MAILPIT_URL) - port(LOCAL_SUPABASE_URL)}`;
}

function refuseHostedOverrides() {
  for (const name of [
    "NEXT_PUBLIC_SUPABASE_URL",
    "SUPABASE_DB_URL",
    "HONE_LOCAL_DB_URL",
    "E2E_SUPABASE_URL",
  ]) {
    const value = process.env[name];
    if (!value) continue;
    // The HOST must be loopback, not merely MENTION it: a substring test let
    // `http://127.0.0.1.attacker.example` or `https://x.example/?127.0.0.1` through.
    if (BANNED_URL_PATTERNS.test(value) || !isLoopbackUrl(value)) {
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
// An isolated stack is selected as a PAIR: E2E_SUPABASE_URL (API + GoTrue) and
// HONE_LOCAL_DB_URL (Postgres), both already proven loopback by
// refuseHostedOverrides(). Honouring only one half is the defect this replaces:
// tests/db's PostgREST/GoTrue clients reached the shared 54321 stack while its pg
// pool followed HONE_LOCAL_DB_URL, and wrote auth users into the wrong stack. The
// mirror image -- app on the isolated stack, e2e fixtures seeding the shared 54322
// -- would be a green run against the wrong database. So a half-moved pair is
// REFUSED below, never silently half-honoured. Neither set: byte-for-byte unchanged.
// The APP SERVER (E2E_WEB_SERVER_ENV) and MAILPIT follow the same stack, so the
// browser, the fixtures and GoTrue's mail all reach ONE stack (Codex P2 4265873832).
// Mailpit takes no variable of its own: it is DERIVED from the validated API URL by
// the same contiguous-port convention the pair check relies on (API, DB = API+1,
// Mailpit = API+3), so it cannot name a different stack or leave this machine.
export const E2E_SUPABASE_URL = process.env.E2E_SUPABASE_URL || LOCAL_SUPABASE_URL;
export const E2E_DB_URL = process.env.HONE_LOCAL_DB_URL || LOCAL_DB_URL;
assertSameStackPair(E2E_SUPABASE_URL, E2E_DB_URL);
export const E2E_MAILPIT_URL = mailpitFor(E2E_SUPABASE_URL);
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
  // AND THE DEFAULT IS REFUSAL, because that is what this lane already did.
  //
  // Every send here used to go through the real SDK with the dummy key above
  // and be refused. Arming the fake with `success` as the fallback silently
  // converted every documented degraded-path scenario in the suite into an
  // accepted send -- portal-rebook's degraded acknowledgement, the dashboard
  // card's safe-failure copy, the waitlist spec's refused notifications -- and
  // all of them kept PASSING, because each asserts what is absent on a refusal,
  // which is also absent on success. Three separate specs lost their scenario
  // without a single red test.
  //
  // So the lane default reproduces the old behaviour exactly, and a spec that
  // needs ACCEPTANCE opts in with a `success+` recipient. New coverage is
  // explicit; existing coverage is untouched.
  HONE_E2E_FAKE_RESEND_DEFAULT_MODE: "reject",
  // SCH-001: the fake transport appends {to, subject, mode} for every send it
  // receives to this file (outside the repo, under the OS temp dir). A spec
  // reads it through e2e/helpers/resend-ledger.ts to prove who was emailed.
  HONE_E2E_FAKE_RESEND_LEDGER: resendLedgerPath(E2E_WORKTREE, E2E_APP_PORT),
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
  // MPX-03's synthetic machine profile, forwarded on EXACTLY the same terms as
  // HONE_PERF_TIMING above and for the same reason: webServer.env REPLACES
  // process.env, so a variable the Next server must see has to be listed here.
  //
  // WHY THE SPREAD IS CONDITIONAL, and must stay that way. Every real machine
  // model in lib/machines/catalogue.ts is evidence-gated and blocked, so the
  // machine picker is empty by design and the workflow is undemonstrable
  // without one active profile. The synthetic demo profile supplies one, and
  // lib/machines/synthetic-profile.ts gates it three ways: `server-only`, this
  // flag must equal exactly "1", and production is refused outright even if the
  // flag leaks there.
  //
  // An UNCONDITIONAL entry here would arm it for every run of this lane, which
  // is precisely what the gate exists to prevent: the ordinary extended run is
  // itself the flag-OFF regression proof that no real model is ever offered.
  // Forwarded only when the outer process asks, so one dedicated run can
  // exercise selection/save/retrieval while every other run stays gate-closed.
  //
  // Agreed with the ops01 lane rather than taken unilaterally: the alternative
  // was a run wrapper mutating this file at run time, which is worse, because a
  // crash mid-run would leave a six-claimant tracked file modified in a
  // worktree other lanes share.
  //
  // tests/ci/e2e-web-server-env.test.ts pins that this stays conditional.
  ...(process.env.HONE_SYNTHETIC_MACHINE_PROFILE === "1"
    ? { HONE_SYNTHETIC_MACHINE_PROFILE: "1" }
    : {}),
  // REL-001 route fault injection. Server-only marker; the module's own guard
  // (lib/reliability/e2e-route-fault.ts) refuses it in any deployed runtime and
  // the fault page 404s without it, so it is safe to arm unconditionally for
  // this hardcoded-to-127.0.0.1 lane. Set here rather than passed through from
  // the outer process because webServer.env REPLACES process.env.
  HONE_E2E_ROUTE_FAULT: "1",
  // SCH-002. Fires only for a studio slug starting "e2e-slot-fault-"; the module
  // refuses to run in any deployed runtime.
  HONE_E2E_SLOT_READ_FAULT: "1",
  // SENTRY-E2E-NOISE-02. Nothing this lane's server sends may reach the
  // operational Sentry project: not the deliberate faults above, not a real
  // failure raised during a run, not the browser envelopes the /monitoring
  // tunnel forwards. The guard is a NODE_OPTIONS preload rather than an app
  // setting so that the Sentry runtime wiring stays byte-identical and no
  // NEXT_PUBLIC_* input is involved. An inherited deployed-runtime signal
  // (AWS_REGION, VERCEL_ENV, ...) makes it refuse to start, failing the lane
  // before any spec runs rather than letting it send.
  // TWILIO-EGRESS-FAKE (MSG-006): no SMS send reaches the real Twilio API.
  NODE_OPTIONS: withTwilioEgressFake(withSentryEgressGuard(process.env.NODE_OPTIONS)),
  HONE_E2E_SENTRY_EGRESS_LOG: E2E_SENTRY_EGRESS_LOG,
  HONE_E2E_TWILIO_EGRESS_LOG: twilioEgressLogPath(E2E_WORKTREE, E2E_APP_PORT),
  // `next start` reads PORT when no -p flag is given (commander `.env("PORT")`),
  // so the derived port reaches the server without any shell interpolation in
  // package.json - which also keeps the npm script portable.
  PORT: String(E2E_APP_PORT),
  NEXT_PUBLIC_APP_ORIGIN: E2E_APP_ORIGIN,
  NEXT_PUBLIC_SUPABASE_URL: E2E_SUPABASE_URL,
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
