#!/usr/bin/env node
/*
 * Production env gates (PR #262 public-rate-limit; PR #291 ops-alert delivery).
 *
 * This script runs the deploy-time env checks that must hold on a real Vercel
 * production build. Each gate prints one PASS/FAIL line; the script exits
 * non-zero (aborting `npm run build`, hence the production deploy) if ANY gate
 * fails. Off-production (local / CI / preview) the whole script is a no-op SKIP.
 *
 * Gate 1, public rate-limit Upstash vars (PR #262):
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
 * No emergency bypass: by design
 * -------------------------------
 * A presence check does not depend on Upstash being reachable, so an
 * Upstash OUTAGE never trips it (the vars stay set; the outage is handled
 * at runtime by the deliberate, logged fail-open path). The only thing a
 * bypass flag could do is re-enable the silent production fail-open this
 * gate exists to prevent, and "temporary" prod fail-open flags rot into
 * permanently-on. So there is intentionally no bypass.
 *
 * Gate 2, critical ops-alert delivery (PR #291):
 * Critical ops alerts (payment / storage / cron / webhook failures) email the
 * recipients in OPS_ALERT_EMAILS via lib/ops/alert-email.ts, AFTER the durable
 * ops_alerts row. When OPS_ALERT_EMAILS is unset/empty the email is a silent
 * no-op (once-per-instance warning log) and a critical alert exists only as a
 * DB row + the /admin/ops-alerts page: operators may not see a payment/cron/
 * webhook failure in time. In production that proactive channel must be wired,
 * so this gate fails the production build when OPS_ALERT_EMAILS does not parse
 * to >=1 recipient. This is operations reliability hardening before live
 * payments. It does NOT send any email or read alert content.
 *
 * Gate 4, WAIT-02B STAGE-A DURABLE WAITLIST KILL SWITCH:
 * This one is the OPPOSITE SHAPE to the others. They fail when required config
 * is MISSING; this fails when optional config is PRESENT.
 *
 * Stage A ships the durable new-client waitlist DARK. The table stores personal
 * information for prospects whom the current public privacy notice does not
 * cover: it scopes itself to practitioners and to clients whose details a
 * practitioner enters, and a waitlist prospect is neither. Collecting it before
 * Stage B ships that disclosure would put personal data outside every disclosed
 * category, so "the flag is empty" is a SECURITY property, not a preference.
 *
 * Until this gate existed that property rested entirely on documentation plus
 * repository tests, and neither can see the Vercel Production environment. One
 * mistyped dashboard entry would have activated prospect collection with
 * nothing failing. This gate makes it structural: a production build ABORTS
 * while the allowlist names any studio.
 *
 * Normalisation mirrors parseWaitlistSlugs() in lib/booking/new-client-waitlist.ts
 * (split "," / trim / drop empties), so unset, empty, whitespace-only and
 * comma-only all mean "no studio configured" and all PASS — exactly the values
 * the runtime treats as OFF. Anything that can actually name a studio FAILS.
 *
 * Off-production is untouched: local, CI and preview still set the reserved e2e
 * slug so the browser lane can exercise the feature.
 *
 * No bypass, and no exception for any named studio. Stage B removes or changes
 * this gate in the SAME authorized release that ships the public disclosure,
 * its dates, the notice evidence and the explicit activation GO. Stage A must
 * not contain an activation path.
 *
 * Secrets: this script reads only the PRESENCE (and, for OPS_ALERT_EMAILS and
 * the durable waitlist allowlist, a COUNT) of the env vars. It prints variable
 * NAMES only, never their values (no Upstash secrets, no configured alert email
 * addresses, no studio slugs).
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
// empties) so a whitespace-only or comma-only value, which would deliver to
// nobody at runtime: correctly counts as zero. Reads the count only, never
// prints an address.
function opsAlertRecipientCount() {
  const raw = process.env[OPS_ALERT_DELIVERY_ENV_VAR];
  if (!raw) return 0;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;
}

// WAIT-02B Stage A: the durable new-client waitlist allowlist. Read at runtime
// by isNewClientWaitlistDurableEnabled() in lib/booking/new-client-waitlist.ts.
// During Stage A this MUST name no studio in production.
const DURABLE_WAITLIST_ENV_VAR = "NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS";

// How many studios the durable allowlist actually enables. Mirrors
// parseWaitlistSlugs() in lib/booking/new-client-waitlist.ts (split "," / trim
// / drop empties) so a whitespace-only or comma-only value, which enables
// nobody at runtime, correctly counts as zero. Reads the count only, never
// prints a slug.
function durableWaitlistStudioCount() {
  const raw = process.env[DURABLE_WAITLIST_ENV_VAR];
  if (!raw) return 0;
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0).length;
}

// Google Calendar OAuth/crypto env (Phase A). NAMES only, never values.
const GOOGLE_CALENDAR_ENV = {
  key: "GOOGLE_TOKEN_ENCRYPTION_KEY",
  keyVersion: "GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION",
  clientId: "GOOGLE_OAUTH_CLIENT_ID",
  clientSecret: "GOOGLE_OAUTH_CLIENT_SECRET",
};

function decodedKeyLength(raw) {
  try {
    const t = String(raw).trim();
    const buf = /^[0-9a-fA-F]{64}$/.test(t)
      ? Buffer.from(t, "hex")
      : Buffer.from(t, "base64");
    return buf.length;
  } catch {
    return -1;
  }
}

// { pass, dormant, problems }. Absence of ALL vars = pass+dormant (non-breaking);
// any partial/malformed config = fail with shape problems (names only).
function googleCalendarConfigGate() {
  const names = Object.values(GOOGLE_CALENDAR_ENV);
  const anySet = names.some((n) => !isMissing(n));
  if (!anySet) return { pass: true, dormant: true, problems: [] };

  const problems = [];
  for (const n of names) {
    if (isMissing(n)) problems.push(`${n} (missing while other Google vars are set)`);
  }
  if (!isMissing(GOOGLE_CALENDAR_ENV.key)) {
    const len = decodedKeyLength(process.env[GOOGLE_CALENDAR_ENV.key]);
    if (len !== 32) {
      problems.push(
        `${GOOGLE_CALENDAR_ENV.key} (must decode to exactly 32 bytes; got ${len < 0 ? "unparseable" : len})`,
      );
    }
  }
  if (!isMissing(GOOGLE_CALENDAR_ENV.keyVersion)) {
    const v = Number(String(process.env[GOOGLE_CALENDAR_ENV.keyVersion]).trim());
    if (!Number.isInteger(v) || v <= 0) {
      problems.push(`${GOOGLE_CALENDAR_ENV.keyVersion} (must be a positive integer)`);
    }
  }
  return { pass: problems.length === 0, dormant: false, problems };
}

function main() {
  if (!isProductionDeploy()) {
    process.stdout.write(
      `SKIP public-rate-limit-env: not a production deploy ` +
        `(VERCEL_ENV=${process.env.VERCEL_ENV ?? "unset"}). ` +
        `Required production env vars (Upstash rate-limit + ${OPS_ALERT_DELIVERY_ENV_VAR} ` +
        `critical-alert delivery) and the Stage-A ${DURABLE_WAITLIST_ENV_VAR} kill switch ` +
        `are enforced only on Vercel production builds.\n`,
    );
    process.exit(0);
  }

  // Run every gate, print one PASS/FAIL line each, then exit non-zero if ANY
  // failed (so one fix-and-redeploy surfaces all missing config at once).
  let failed = false;

  // Gate 3, Google Calendar OAuth/crypto config SHAPE (Phase A).
  // Validate-if-present, NON-BREAKING: total absence (Google Calendar
  // unprovisioned) PASSES so the current production deploy is unaffected and
  // the connection flag stays OFF; a PARTIAL/MALFORMED config FAILS the build
  // (truncated encryption key, missing key version, only some vars set) before
  // any studio can enable the flag.
  const gcal = googleCalendarConfigGate();
  if (gcal.pass) {
    process.stdout.write(
      gcal.dormant
        ? `PASS google-calendar-env: Google Calendar is unprovisioned (all vars absent), ` +
            `dormant; the connection flag must stay OFF until GOOGLE_TOKEN_ENCRYPTION_KEY ` +
            `(+ _VERSION), GOOGLE_OAUTH_CLIENT_ID/SECRET are set.\n`
        : `PASS google-calendar-env: Google Calendar OAuth/crypto config present and well-formed.\n`,
    );
  } else {
    failed = true;
    // NAMES + shape problems only, never any value.
    process.stderr.write(
      `FAIL google-calendar-env: Google Calendar config is partially set or malformed in production: ` +
        `${gcal.problems.join("; ")}.\n` +
        `A half-configured or malformed Google integration must not ship: a truncated ` +
        `GOOGLE_TOKEN_ENCRYPTION_KEY fails closed at runtime and a missing key version breaks ` +
        `rotation. Fix: set ALL of ${Object.values(GOOGLE_CALENDAR_ENV).join(", ")} correctly, ` +
        `or unset them all to keep the feature dormant.\n`,
    );
  }

  // Gate 1, public rate-limit Upstash vars (PR #262).
  const missing = REQUIRED_PUBLIC_RATELIMIT_ENV.filter(isMissing);
  if (missing.length === 0) {
    process.stdout.write(
      `PASS public-rate-limit-env: all required Upstash vars present in production ` +
        `(${REQUIRED_PUBLIC_RATELIMIT_ENV.join(", ")}).\n`,
    );
  } else {
    failed = true;
    // NAMES only, never values.
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

  // Gate 2, critical ops-alert delivery recipients (PR #291).
  if (opsAlertRecipientCount() > 0) {
    process.stdout.write(
      `PASS ops-alert-delivery-env: ${OPS_ALERT_DELIVERY_ENV_VAR} configured in production ` +
        `(>=1 critical-alert recipient).\n`,
    );
  } else {
    failed = true;
    // NAMES only, never the configured addresses.
    process.stderr.write(
      `FAIL ops-alert-delivery-env: ${OPS_ALERT_DELIVERY_ENV_VAR} is required in production ` +
        `and must list at least one recipient (comma-separated; a whitespace-only or comma-only value counts as none).\n` +
        `Critical ops alerts (payment / storage / cron / webhook failures) email these recipients via ` +
        `lib/ops/alert-email.ts; when unset they exist only as a durable ops_alerts row + the /admin/ops-alerts ` +
        `page, so operators may not see a critical failure in time.\n` +
        `Fix: set ${OPS_ALERT_DELIVERY_ENV_VAR} in the Vercel Production environment, then redeploy.\n`,
    );
  }

  // Gate 4, WAIT-02B Stage-A durable waitlist kill switch.
  // INVERTED: fails when the allowlist is POPULATED. See the header.
  const enabledStudios = durableWaitlistStudioCount();
  if (enabledStudios === 0) {
    process.stdout.write(
      `PASS stage-a-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} enables no studio ` +
        `in production; the durable new-client waitlist stays dark.\n`,
    );
  } else {
    failed = true;
    // NAME and COUNT only, never the configured slug(s).
    process.stderr.write(
      `FAIL stage-a-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} is set in production ` +
        `and enables ${enabledStudios} studio(s). During WAIT-02B Stage A it must enable NONE.\n` +
        `Stage A deploys the durable new-client waitlist DARK. Its table stores personal ` +
        `information for prospects that the current public privacy notice does not cover, so ` +
        `enabling a studio now would collect personal data outside every disclosed category.\n` +
        `Fix: clear ${DURABLE_WAITLIST_ENV_VAR} in the Vercel Production environment, then redeploy.\n` +
        `This gate has no bypass and no per-studio exception. Enabling a studio is Stage B's ` +
        `job, in the same authorized release that ships the public disclosure, its effective ` +
        `date, the notice evidence that policy requires, and the explicit activation GO.\n`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
