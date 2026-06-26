#!/usr/bin/env node
/*
 * Production public-rate-limit env gate (PR #262).
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
 * Secrets: this script reads only the PRESENCE of the env vars. It prints
 * variable NAMES only — never their values.
 */

// Required for public rate limiting in production. Names must match the
// vars read by getRedis() in lib/rate-limit/public.ts.
const REQUIRED_PUBLIC_RATELIMIT_ENV = [
  "UPSTASH_REDIS_REST_URL",
  "UPSTASH_REDIS_REST_TOKEN",
];

// Production = a real Vercel production build/deploy. NOT NODE_ENV (next
// build sets that to "production" everywhere, including local + CI).
function isProductionDeploy() {
  return process.env.VERCEL_ENV === "production";
}

function isMissing(name) {
  const value = process.env[name];
  return value === undefined || value === null || value.length === 0;
}

function main() {
  if (!isProductionDeploy()) {
    process.stdout.write(
      `SKIP public-rate-limit-env: not a production deploy ` +
        `(VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}). ` +
        `Required Upstash vars are enforced only on Vercel production builds.\n`,
    );
    process.exit(0);
  }

  const missing = REQUIRED_PUBLIC_RATELIMIT_ENV.filter(isMissing);

  if (missing.length === 0) {
    process.stdout.write(
      `PASS public-rate-limit-env: all required Upstash vars present in production ` +
        `(${REQUIRED_PUBLIC_RATELIMIT_ENV.join(", ")}).\n`,
    );
    process.exit(0);
  }

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
  process.exit(1);
}

main();
