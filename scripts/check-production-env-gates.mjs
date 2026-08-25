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
 * ---------------------------------------------------------------------------
 * GATE 4 CONTRACT
 * ---------------------------------------------------------------------------
 * The authoritative statement of what this gate is. Pinned VERBATIM by
 * tests/scripts/check-production-env-gates.test.ts. Editing a line here fails
 * that test, which is the point: these eight sentences are what an operator
 * relies on, and six review rounds showed they drift silently otherwise.
 *
 *   1. Gate 4 is report-only.
 *   2. It does not fail the build solely because of
 *      NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS.
 *   3. The report does not prove a configured entry names an existing studio.
 *   4. The report does not prove that a studio is activated.
 *   5. Runtime exact-membership is the activation control.
 *   6. Configured values are literal; there is no wildcard or global-enable
 *      interpretation.
 *   7. An empty normalized durable allowlist leaves every studio on the
 *      non-durable path.
 *   8. The production-only configuration report is skipped outside production,
 *      while runtime membership still applies.
 * ---------------------------------------------------------------------------
 *
 * Gate 4, WAIT-02B STAGE-B DURABLE WAITLIST CONFIGURATION REPORT:
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
 * WHAT REPLACES IT REPORTS CONFIG, AND BLOCKS NOTHING. Activation stays
 * EXPLICIT and PER STUDIO. This gate describes what the allowlist is CONFIGURED
 * to say, using the runtime's own normalisation, and it does not fail a build
 * over the durable allowlist at all.
 *
 * WHAT THIS GATE CANNOT DECIDE, AND THEREFORE MUST NOT REPORT. It is a
 * dependency-free build-time script with NO DATABASE ACCESS and no module
 * graph. Three facts are out of its reach, and each stands between a configured
 * entry and an actually-activated studio:
 *
 *   1. EXISTENCE. Only a query against `studios.slug` could say whether an
 *      entry identifies a studio, and this script issues none.
 *   2. ADMISSION. The durable allowlist is SUBORDINATE to
 *      NEW_CLIENT_WAITLIST_STUDIO_SLUGS: submit only consults it for a studio
 *      the gate has ALREADY waitlisted, so naming a real studio here whose
 *      intake gate is off activates nothing.
 *   3. THE DATABASE'S SLUG DOMAIN. See the next block — this one cost a real
 *      defect.
 *
 * THE APP-WRITER CONVENTION IS NOT THE DATABASE INVARIANT. An earlier Stage-B1
 * draft treated the 1–64 lowercase-alnum-hyphen shape as the set of slugs a
 * studio can have, and FAILED a production build on anything outside it. That
 * is the shape TODAY'S WRITERS enforce, not the shape the column permits.
 * Migration 0010 adds `slug text` plus a UNIQUE constraint and NO check on
 * shape or length, and its name-based backfill concatenates a 7-character id
 * suffix without truncating — so a legacy, backfilled or directly-created row
 * can hold a 65-character slug that `slugIsListed()` matches exactly. The gate
 * would have aborted the deploy of a perfectly legitimate activation while
 * telling the operator the entry could identify no studio. A build gate must never
 * be STRICTER than the runtime it guards, least of all while claiming to speak
 * for the database.
 *
 * So the convention check survives only as a NON-BLOCKING WARNING, and it says
 * what it actually knows: this entry is outside the convention current writers
 * use, legacy rows may differ, verify in the product. It asserts nothing about
 * whether a studio exists.
 *
 * The count this gate prints is CONFIGURED NORMALISED ENTRIES — an UPPER BOUND
 * on what could activate, never a count of studios activated. Saying "enables N
 * studios" would assert facts 1 and 2 on evidence the script does not have,
 * which is the same over-claim, one layer down, that Stage B1 exists to remove
 * from the privacy notice. What proves activation is the product, not this
 * script.
 *
 * THERE IS NO GLOBAL ENABLE TO GUARD AGAINST, BY CONSTRUCTION. Nothing in the
 * runtime turns any value into "all studios": the only question it asks is
 * set-membership of one server-resolved slug. Enabling N studios costs N typed
 * slugs. This gate cannot loosen that, and it no longer tightens it either:
 * it describes the list and lets the deploy proceed.
 *
 * UNSET IS STILL DARK, AND THAT IS STILL THE SHIPPING STATE. Normalisation
 * mirrors parseWaitlistSlugs() (split "," / trim / lowercase / drop empties), so
 * unset, empty, whitespace-only and comma-only all mean "no studio configured",
 * all PASS, and all leave every studio on the WAIT-01 commit point. Stage B1
 * ships with production holding exactly that. Turning a studio on is a separate,
 * explicit operator action against a build that already carries the disclosure.
 *
 * NO PER-STUDIO EXCEPTION, AND NOTHING TO BYPASS. There is no flag that alters
 * how this variable is handled, and no studio is named anywhere in this file.
 * Note there is no longer a block to bypass either: the convention check WARNS
 * and does not fail, so the only thing an operator could "get past" is a
 * message. The gates that DO fail a build (Upstash, ops-alert delivery, Google
 * Calendar) keep their no-bypass property in the ordinary sense.
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

// NAMED HERE, DELIBERATELY NEVER READ. The admission-control allowlist that the
// durable one is subordinate to. It appears only inside the PASS message, as
// part of saying what this script has NOT checked: a studio named in the
// durable list activates nothing unless its intake is also waitlisted here.
// Reading it would turn a reporting-honesty fix into a new deploy-failure mode,
// which is not what this gate was asked to do — and it still could not prove
// the studio exists, so the upper-bound framing would stand either way.
const WAITLIST_GATE_ENV_VAR = "NEW_CLIENT_WAITLIST_STUDIO_SLUGS";

// The shape CURRENT APPLICATION WRITERS give a new slug — NOT the domain of
// `studios.slug`, which carries a UNIQUE constraint and no shape or length
// CHECK (see the header). MIRRORS the SLUG_RE that
// app/(app)/settings/booking/actions.ts and lib/studios/new-studio.ts both
// enforce on write, and the mirror is pinned by
// tests/scripts/check-production-env-gates.test.ts, which reads the literal out
// of all three files and compares them. Duplicated rather than shared because
// this script is a dependency-free build-time check with no module graph.
//
// USED ONLY TO WARN. An entry outside this shape is unusual enough to mention
// — it may be the "*" of an operator who believed one value enables everything
// — but it is NOT evidence that no studio matches, so it must never fail a
// build. Lowercase-only is not a restriction: entries are lowercased first,
// exactly as parseWaitlistSlugs() does, so "Studio-One" normalises inside it.
const MODERN_WRITER_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;

// What the durable allowlist is CONFIGURED to ask production to do.
//
// Normalisation mirrors parseWaitlistSlugs() in
// lib/booking/new-client-waitlist.ts (split "," / trim / lowercase / drop
// empties) so a whitespace-only or comma-only value, which enables nobody at
// runtime, correctly reports zero. Reads COUNTS only, never a slug.
//
// AND IT COLLAPSES DUPLICATES, BECAUSE THE RUNTIME DOES. parseWaitlistSlugs
// returns a SET, so "studio-a, Studio-A" normalises to ONE member and can
// activate at most ONE studio. Counting the split array reported TWO — the two
// normalisers agreeing on WHICH entries survive while disagreeing on how many,
// which is exactly the drift a duplicated parser exists to be suspected of. The
// count an operator reads at deploy time must be the count the runtime's own
// parser would produce for the same string.
//
//   supplied        non-empty entries the operator actually typed
//   configured      UNIQUE normalised entries — exactly the set
//                   parseWaitlistSlugs() would build for the same string, and
//                   the MOST studios this value could activate. NOT a count of
//                   activated studios: this script cannot prove an entry
//                   identifies a `studios.slug` row, and does not read
//                   NEW_CLIENT_WAITLIST_STUDIO_SLUGS, so it cannot tell whether
//                   that studio's intake is waitlisted at all. See the header.
//                   An UPPER BOUND is the strongest true statement available.
//   unconventional  how many SUPPLIED entries fall outside the shape current
//                   application writers enforce. A REPORTING signal only — the
//                   column permits shapes those writers no longer produce, so
//                   this is never evidence that no studio matches, and it never
//                   fails a build.
function durableWaitlistActivation() {
  const raw = process.env[DURABLE_WAITLIST_ENV_VAR];
  const supplied = !raw
    ? []
    : raw
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0);

  // EVERY non-empty entry is CONFIGURED, because the runtime puts every one of
  // them in its Set — including "*", which stays a LITERAL string there and
  // matches only a studio whose slug is literally "*". Filtering any of them
  // out here would make this count disagree with parseWaitlistSlugs(), which is
  // the one number it exists to mirror.
  //
  // The convention signal is counted over SUPPLIED entries, BEFORE collapsing,
  // so a repeated conventional slug cannot absorb an unconventional neighbour:
  // "studio-a, bad slug, studio-a" reports 1 of 3, not 0 of 1.
  const configured = new Set();
  let unconventional = 0;
  for (const entry of supplied) {
    configured.add(entry);
    if (!MODERN_WRITER_SLUG_RE.test(entry)) unconventional += 1;
  }

  return {
    supplied: supplied.length,
    configured: configured.size,
    unconventional,
  };
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
        `critical-alert delivery) are checked only on Vercel production builds.\n` +
        `SKIP stage-b-durable-waitlist-env: the production-only durable-waitlist ` +
        `configuration report does not run for this build. Runtime exact-membership ` +
        `remains the activation control.\n`,
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

  // Gate 4, WAIT-02B Stage-B durable waitlist activation REPORT.
  // REPORT-ONLY, BY DESIGN: it never sets `failed`. An empty list is the dark
  // shipping state; a populated list is described using the runtime's own
  // normalisation. See the header for the three facts this script cannot decide
  // — existence, admission, and the database's actual slug domain — which is
  // why it reports CONFIGURED ENTRIES and warns rather than blocking.
  const durable = durableWaitlistActivation();
  if (durable.configured === 0) {
    // PROVEN, not merely configured: an empty set makes slugIsListed() false
    // for every possible slug, so this one IS a statement about studios rather
    // than about entries.
    process.stdout.write(
      `PASS stage-b-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} names no studio ` +
        `in production; the durable new-client waitlist stays dark and every studio ` +
        `remains on the WAIT-01 commit point.\n`,
    );
  } else {
    // Duplicates are not an error — the runtime collapses them silently — but
    // the operator typed more entries than survive normalisation, so say so.
    // A COUNT, never a slug.
    const duplicates = durable.supplied - durable.configured;
    process.stdout.write(
      `PASS stage-b-durable-waitlist-env: ${DURABLE_WAITLIST_ENV_VAR} carries ` +
        `${durable.configured} distinct normalised configuration ` +
        `entr${durable.configured === 1 ? "y" : "ies"} in production.` +
        (duplicates > 0
          ? ` (${durable.supplied} entries supplied; ${duplicates} duplicate normalised away, ` +
            `exactly as the runtime does.)`
          : "") +
        ` CONFIG SHAPE ONLY: this build-time check has no database access, so it does not ` +
        `prove any entry identifies a studio, and it does not read ${WAITLIST_GATE_ENV_VAR}, ` +
        `so it cannot tell whether a named studio's new-client intake is waitlisted at all. ` +
        `Treat ${durable.configured} as the MOST studios this value could activate, not as a ` +
        `count of studios activated; verify activation in the product. Every studio not ` +
        `named here stays dark.\n`,
    );
  }

  // NON-BLOCKING WARNING. Worth saying, not worth refusing a deploy over. The
  // operator who sets "*" believing one value enables everything sees this —
  // and so does the operator activating a legacy studio whose slug predates the
  // current writer convention, who must still be able to ship. It asserts
  // NOTHING about whether a studio exists. COUNTS only, never a slug.
  if (durable.unconventional > 0) {
    process.stdout.write(
      `WARN stage-b-durable-waitlist-env: ${durable.unconventional} of ${durable.supplied} ` +
        `configured entr${durable.supplied === 1 ? "y" : "ies"} ` +
        `${durable.unconventional === 1 ? "falls" : "fall"} outside the slug ` +
        `convention used by current application writers (1-64 characters; lowercase letters, ` +
        `digits and hyphens; no leading or trailing hyphen).\n` +
        `That convention is what today's writers ENFORCE, not what the column PERMITS: ` +
        `studios.slug carries a UNIQUE constraint and no shape or length check, so a legacy, ` +
        `backfilled or directly-created row may sit outside it and still be matched exactly by ` +
        `the runtime. This is NOT evidence either way about whether a studio matches, and it ` +
        `does NOT fail the build.\n` +
        `No value is ever interpreted as a pattern: a wildcard character is compared ` +
        `literally and never expanded, so enabling N studios still means naming N slugs. ` +
        `Verify activation in the product.\n`,
    );
  }

  process.exit(failed ? 1 : 0);
}

main();
