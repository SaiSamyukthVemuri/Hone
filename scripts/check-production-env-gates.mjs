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
 * Gate 4, WAIT-02B STAGE-B DURABLE WAITLIST ACTIVATION GUARD:
 * This one is a different SHAPE to the others. They fail when required config
 * is MISSING. This one validates OPTIONAL config that, when present, turns on a
 * personal-data collection point.
 *
 * WHAT STAGE A DID, AND WHY IT IS GONE. Stage A shipped the durable new-client
 * waitlist DARK behind a BLANKET PROHIBITION: a production build aborted while
 * this variable named ANY studio. That was correct then for exactly one reason,
 * and it was not "flags should default off" (the runtime already does that).
 * It was that the public privacy notice scoped itself to practitioners and to
 * clients whose details a practitioner enters, so a waitlist prospect fell
 * outside every disclosed category and collecting their details would have put
 * personal data outside the notice entirely.
 *
 * Stage B1 removes that specific defect: app/privacy/page.tsx now covers a
 * prospective client who has not booked, the public waitlist form carries a
 * collection notice next to its submit control, and both are pinned by
 * tests/app/privacy/waitlist-prospect-disclosure.test.ts. The blanket
 * prohibition therefore has nothing left to protect and would only stop the
 * activation it was holding open a place for.
 *
 * WHAT REPLACES IT IS NOT "NOTHING". Activation stays EXPLICIT and PER STUDIO,
 * and this gate now enforces the one property the runtime cannot report at
 * deploy time: that every entry CAN NAME A REAL STUDIO. Membership is exact
 * equality against `studios.slug` after trim + lowercase
 * (parseWaitlistSlugs / slugIsListed in lib/booking/new-client-waitlist.ts), so
 * an entry that is not slug-shaped matches nothing. A wildcard is therefore
 * already inert at runtime — but SILENTLY inert, which is the failure mode this
 * gate exists to convert into a loud one. An operator who sets "*" believing it
 * enables every studio would otherwise deploy green and see no waitlist, and an
 * operator who mistypes one real slug would enable nobody with nothing failing.
 *
 * THERE IS NO GLOBAL ENABLE TO GUARD AGAINST, BY CONSTRUCTION. Nothing in the
 * runtime turns any value into "all studios": the only question it asks is
 * set-membership of one server-resolved slug. Enabling N studios costs N typed
 * slugs. This gate cannot loosen that; it only refuses to ship a list that
 * cannot mean what it appears to mean.
 *
 * UNSET IS STILL DARK, AND THAT IS STILL THE SHIPPING STATE. Normalisation
 * mirrors parseWaitlistSlugs() (split "," / trim / lowercase / drop empties), so
 * unset, empty, whitespace-only and comma-only all mean "no studio configured",
 * all PASS, and all leave every studio on the WAIT-01 commit point. Stage B1
 * ships with production holding exactly that. Turning a studio on is a separate,
 * explicit operator action against a build that already carries the disclosure.
 *
 * NO BYPASS, AND NO PER-STUDIO EXCEPTION, IN EITHER DIRECTION. No studio is
 * carved out of the shape check by name, and there is no flag that skips it.
 *
 * Off-production is untouched: local, CI and preview still set the reserved e2e
 * slug so the browser lane can exercise the feature.
 *
 * Secrets: this script reads only the PRESENCE (and, for OPS_ALERT_EMAILS and
 * the durable waitlist allowlist, COUNTS) of the env vars. It prints variable
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

// WAIT-02B: the durable new-client waitlist allowlist. Read at runtime by
// isNewClientWaitlistDurableEnabled() in lib/booking/new-client-waitlist.ts.
// Under Stage B this is the ACTIVATION control: naming a studio here turns on
// its durable prospect record. Unset means every studio stays dark.
const DURABLE_WAITLIST_ENV_VAR = "NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS";

// The shape a `studios.slug` can actually have. MIRRORS the SLUG_RE that
// app/(app)/settings/booking/actions.ts and lib/studios/new-studio.ts both
// enforce when a slug is written, and the mirror is pinned by
// tests/scripts/check-production-env-gates.test.ts, which reads the literal out
// of all three files and compares them. Duplicated rather than shared because
// this script is a dependency-free build-time check with no module graph.
//
// Lowercase-only is not a restriction here: entries are lowercased first,
// exactly as parseWaitlistSlugs() does, so "Studio-One" normalises and passes.
// What cannot pass is anything a slug can never be: "*", "%", an embedded
// space, a leading or trailing hyphen, or more than 64 characters.
const STUDIO_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// What the durable allowlist actually asks production to do.
//
// Normalisation mirrors parseWaitlistSlugs() in
// lib/booking/new-client-waitlist.ts (split "," / trim / lowercase / drop
// empties) so a whitespace-only or comma-only value, which enables nobody at
// runtime, correctly reports zero. Reads COUNTS only, never a slug.
//
//   enabled   how many studios the list asks to activate
//   unusable  how many of those entries cannot be a studio slug, and so would
//             silently match nothing
function durableWaitlistActivation() {
  const raw = process.env[DURABLE_WAITLIST_ENV_VAR];
  const entries = !raw
    ? []
    : raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);
  let unusable = 0;
  for (const entry of entries) {
    if (!STUDIO_SLUG_RE.test(entry)) unusable += 1;
  }
  return { enabled: entries.length, unusable };
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
        `critical-alert delivery) and the ${DURABLE_WAITLIST_ENV_VAR} activation guard ` +
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

  // Gate 4, WAIT-02B Stage-B durable waitlist activation guard.
  // VALIDATE-IF-PRESENT: an empty list is the dark shipping state and PASSES;
  // a populated list PASSES only when every entry can name a real studio. See
  // the header for why the Stage-A blanket prohibition is gone.
  const durable = durableWaitlistActivation();
  if (durable.unusable === 0) {
    process.stdout.write(
      durable.enabled === 0
        ? `PASS stage-b-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} names no studio ` +
            `in production; the durable new-client waitlist stays dark and every studio ` +
            `remains on the WAIT-01 commit point.\n`
        : `PASS stage-b-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} explicitly enables ` +
            `${durable.enabled} studio(s) in production, each named in full and matched by exact ` +
            `slug equality; every studio not named stays dark.\n`,
    );
  } else {
    failed = true;
    // NAME and COUNTS only, never the configured slug(s) — not even the
    // rejected ones, which are just as much a studio identifier as the valid.
    process.stderr.write(
      `FAIL stage-b-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} has ${durable.unusable} ` +
        `of ${durable.enabled} entr${durable.enabled === 1 ? "y" : "ies"} that cannot be a studio ` +
        `slug in production.\n` +
        `Membership is EXACT equality against studios.slug after trim + lowercase, so an entry ` +
        `of the wrong shape — a wildcard, an embedded space, a leading/trailing hyphen, over 64 ` +
        `characters — matches no studio and activates nothing. Shipping it would look like an ` +
        `activation and behave like an empty list.\n` +
        `There is no wildcard: enabling N studios means naming N slugs, each exactly as it ` +
        `appears in studios.slug.\n` +
        `Fix: correct or clear ${DURABLE_WAITLIST_ENV_VAR} in the Vercel Production environment, ` +
        `then redeploy. This gate has no bypass and no per-studio exception.\n`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
