#!/usr/bin/env node
/*
 * Production env gates (PR #262 public-rate-limit; PR #291 ops-alert delivery).
 *
 * This script runs the deploy-time env checks that must hold on a real Vercel
 * production build. Each gate prints one PASS/FAIL line; the script exits
 * non-zero (aborting `npm run build`, hence the production deploy) if ANY gate
 * fails. Off-production (local / CI / preview) the whole script is a no-op SKIP.
 *
 * Gate 1 — public rate-limit Upstash vars (PR #262):
 *
 * Public unauthenticated rate limiting (lib/rate-limit/public.ts) FAILS
 * OPEN: when UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN are unset,
 * getRedis() returns null and every limiter returns { allowed: true }.
 * That is the correct posture for a transient backend OUTAGE (a limiter
 * outage must never block a real booking), but a MISSING CONFIG in
 * production silently removes abuse protection from every public surface
 * (booking, portal-login, cancel/reschedule/intake token routes,
 * marketing forms) with only a once-per-cold-start log line.
 *
 * This gate is the DEPLOY-TIME complement to that runtime fail-open: it
 * fails the production build/deploy when the required Upstash env vars
 * are missing, so a misconfigured production deploy cannot ship with
 * public rate limiting silently disabled.
 *
 * Production signal
 * ----------------
 * We key ONLY on VERCEL_ENV === "production". We deliberately do NOT key
 * on NODE_ENV: `next build` sets NODE_ENV=production for EVERY build
 * (local + CI), which would make this gate fail local/CI builds that
 * legitimately run without Upstash configured. VERCEL_ENV === "production"
 * is true only on a real Vercel production build/deploy. This mirrors
 * isProduction() in lib/rate-limit/public.ts.
 *
 * Wiring: invoked by `npm run build` (so it runs on the Vercel production
 * build AND in CI/local builds, where it is a no-op SKIP). Also runnable
 * standalone via `npm run check:prod-env-gates`.
 *
 * No emergency bypass — by design
 * -------------------------------
 * A presence check does not depend on Upstash being reachable, so an
 * Upstash OUTAGE never trips it (the vars stay set; the outage is handled
 * at runtime by the deliberate, logged fail-open path). The only thing a
 * bypass flag could do is re-enable the silent production fail-open this
 * gate exists to prevent, and "temporary" prod fail-open flags rot into
 * permanently-on. So there is intentionally no bypass.
 *
 * Gate 2 — critical ops-alert delivery (PR #291):
 * Critical ops alerts (payment / storage / cron / webhook failures) email the
 * recipients in OPS_ALERT_EMAILS via lib/ops/alert-email.ts, AFTER the durable
 * ops_alerts row. When OPS_ALERT_EMAILS is unset/empty the email is a silent
 * no-op (once-per-instance warning log) and a critical alert exists only as a
 * DB row + the /admin/ops-alerts page — operators may not see a payment/cron/
 * webhook failure in time. In production that proactive channel must be wired,
 * so this gate fails the production build when OPS_ALERT_EMAILS does not parse
 * to >=1 recipient. This is operations reliability hardening before live
 * payments. It does NOT send any email or read alert content.
 *
 * Secrets: this script reads only the PRESENCE (and, for OPS_ALERT_EMAILS, the
 * recipient COUNT) of the env vars. It prints variable NAMES only — never their
 * values (no Upstash secrets, no configured alert email addresses).
 */

// Required for public rate limiting in production. Names must match the
// vars read by getRedis() in lib/rate-limit/public.ts.
const REQUIRED_PUBLIC_RATELIMIT_ENV = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

// Required for proactive critical ops-alert delivery in production. Read by
// parseOpsAlertEmails() in lib/ops/alert-email.ts.
const OPS_ALERT_DELIVERY_ENV_VAR = "OPS_ALERT_EMAILS";

// Production = a real Vercel production build/deploy. NOT NODE_ENV (next
// build sets that to "production" everywhere, including local + CI).
function isProductionDeploy() {
  return process.env.VERCEL_ENV === "production";
}

function isMissing(name) {
  const value = process.env[name];
  return value === undefined || value === null || value.length === 0;
}

// Count of deliverable recipients in OPS_ALERT_EMAILS. Mirrors
// parseOpsAlertEmails() in lib/ops/alert-email.ts (split "," / trim / drop
// empties) so a whitespace-only or comma-only value — which would deliver to
// nobody at runtime — correctly counts as zero. Reads the count only, never
// prints an address.
function opsAlertRecipientCount() {
  const raw = process.env[OPS_ALERT_DELIVERY_ENV_VAR];
  if (!raw) return 0;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;
}

function main() {
  if (!isProductionDeploy()) {
    process.stdout.write(
      `SKIP public-rate-limit-env: not a production deploy ` +
        `(VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}). ` +
        `Required production env vars (Upstash rate-limit + ${OPS_ALERT_DELIVERY_ENV_VAR} ` +
        `critical-alert delivery) are enforced only on Vercel production builds.\n`,
    );
    process.exit(0);
  }

  // Run every gate, print one PASS/FAIL line each, then exit non-zero if ANY
  // failed (so one fix-and-redeploy surfaces all missing config at once).
  let failed = false;

  // Gate 1 — public rate-limit Upstash vars (PR #262).
  const missing = REQUIRED_PUBLIC_RATELIMIT_ENV.filter(isMissing);
  if (missing.length === 0) {
    process.stdout.write(
      `PASS public-rate-limit-env: all required Upstash vars present in production ` +
        `(${REQUIRED_PUBLIC_RATELIMIT_ENV.join(", ")}).\n`,
    );
  } else {
    failed = true;
    // NAMES only — never values.
    process.stderr.write(
      `FAIL public-rate-limit-env: missing required Upstash env var(s) in production: ` +
        `${missing.join(", ")}.\n` +
        `Public unauthenticated rate limiting (lib/rate-limit/public.ts) FAILS OPEN when these are unset, ` +
        `silently removing abuse protection from public booking / portal-login / token / marketing routes in production.\n` +
        `Fix: set the missing var(s) in the Vercel Production environment, then redeploy.\n` +
        `This gate has no bypass: a missing-config fail-open must not ship to production. ` +
        `A transient Upstash OUTAGE does not trip this gate (the vars stay set) and is handled at runtime by the deliberate, logged fail-open path.\n`,
    );
  }

  // Gate 2 — critical ops-alert delivery recipients (PR #291).
  if (opsAlertRecipientCount() > 0) {
    process.stdout.write(
      `PASS ops-alert-delivery-env: ${OPS_ALERT_DELIVERY_ENV_VAR} configured in production ` +
        `(>=1 critical-alert recipient).\n`,
    );
  } else {
    failed = true;
    // NAMES only — never the configured addresses.
    process.stderr.write(
      `FAIL ops-alert-delivery-env: ${OPS_ALERT_DELIVERY_ENV_VAR} is required in production ` +
        `and must list at least one recipient (comma-separated; a whitespace-only or comma-only value counts as none).\n` +
        `Critical ops alerts (payment / storage / cron / webhook failures) email these recipients via ` +
        `lib/ops/alert-email.ts; when unset they exist only as a durable ops_alerts row + the /admin/ops-alerts ` +
        `page, so operators may not see a critical failure in time.\n` +
        `Fix: set ${OPS_ALERT_DELIVERY_ENV_VAR} in the Vercel Production environment, then redeploy.\n`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
