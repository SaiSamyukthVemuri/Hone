import "server-only";

// ===========================================================================
// P0 EMERGENCY — NEW-CLIENT WAITLIST (ADMISSION CONTROL)
// ===========================================================================
//
// A studio can reach a state where its EXISTING treatment clients cannot be
// served on a clinically useful cadence while its public booking page keeps
// accepting brand-new consultations. Every additional new client consumes
// future treatment capacity that is already spoken for.
//
// This module is the SERVER-ONLY switch that stops incremental NEW-client
// bookings for named studios and routes that demand to a waitlist, plus the
// bounded validation the submit path depends on.
//
// Deliberately:
//   * DEFAULT OFF — unset / empty / whitespace-only is OFF for every studio,
//     so deploying this changes nothing until an operator opts a studio in.
//     Clearing the env is the entire kill switch: no database work at all.
//   * EXACT-MATCH ONLY — exact slug equality after trim + lowercase. A
//     substring, prefix or suffix NEVER matches, so enabling
//     "willow-electrolysis" cannot silence "willow-electrolysis-archive".
//   * SERVER-ONLY — keeps the configured list out of every client bundle. The
//     browser receives a DERIVED boolean for presentation, never the list, and
//     never as booking authority.
//   * UNCACHED — process.env is read per call so an operator's change takes
//     effect on the next render/action rather than the next cold start.
//
// This is ADMISSION CONTROL, not slot legality. Nothing here participates in
// slot generation, buffers, practitioner capacity or availability validation.
//
// NOTE ON WHAT IS *NOT* HERE. Provider idempotency-key derivation lives beside
// the send path (lib/email/new-client-waitlist-send.ts), not here. Deriving a
// key anywhere other than where the payload is built is what allowed a key and
// its payload to drift apart in an earlier attempt.
//
// NOR IS THE DUPLICATE RULE. WAIT-02's "one waiting entry per normalized email
// per studio" is defined and enforced by migration 0185 — a generated column
// plus a studio-scoped partial unique index. A TypeScript re-implementation of
// it here would be a second copy of the same law, free to drift from the one
// that actually decides.
// ===========================================================================

/** Server-only env var naming the studios whose NEW-client intake is waitlisted. */
export const NEW_CLIENT_WAITLIST_SLUGS_ENV = "NEW_CLIENT_WAITLIST_STUDIO_SLUGS";

/**
 * Server-only env var naming the studios whose waitlist submissions are
 * COMMITTED TO THE DATABASE (WAIT-02) rather than delivered as an email
 * (WAIT-01).
 *
 * This is a STAGED-ROLLOUT switch, not a second admission-control authority.
 * `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` above remains the single answer to "is
 * this studio's new-client intake waitlisted?"; this one answers only "has the
 * durable record been turned on for it yet?", and is consulted exclusively on
 * paths the gate has already opened.
 *
 * It exists because WAIT-01 is ALREADY LIVE. Shipping the durable path on the
 * existing flag alone would mean the deploy itself activates a new commit point
 * for a studio currently relying on the old one, with no operator GO in
 * between and no way back except a revert. The only alternative — clearing the
 * gate list to keep the code dark — would reopen new-client booking, which is
 * the exact failure the gate exists to prevent.
 *
 * DEFAULT OFF, exactly like the gate: unset / empty / whitespace-only is OFF
 * for every studio, so deploying this changes nothing anywhere until an
 * operator opts a studio in, and clearing it is the whole kill switch.
 *
 * WAIT-02B STAGE B: THIS IS NOW THE ACTIVATION CONTROL, AND IT IS THE ONLY ONE.
 * Stage A additionally forbade production from naming ANY studio here, enforced
 * at deploy time by scripts/check-production-env-gates.mjs, because the public
 * privacy notice did not yet cover a waitlist prospect. Stage B1 ships that
 * disclosure, so the prohibition is gone and a correctly named studio is now
 * permitted.
 *
 * WHAT REPLACED IT IS REPORT-ONLY. Gate 4 is report-only. It does not fail the
 * build solely because of NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS.
 * Runtime exact-membership is the activation control.
 * That control is slugIsListed() below, and it runs in EVERY environment —
 * including the local and CI builds where the report never runs at all. It has no database access, so it can
 * prove neither that an entry identifies a studio nor that anything is
 * activated; it reports the NORMALISED CONFIGURED ENTRIES it would parse, and
 * WARNS on a value outside the shape current writers give a slug. That warning
 * does NOT block: `studios.slug` carries a UNIQUE constraint and no shape or
 * length check, so a legacy or directly-created row can sit outside that shape
 * and still be matched exactly HERE — refusing such a value would make the
 * build gate stricter than this module, and would block a legitimate
 * activation. The one thing an empty value does prove is that nothing is
 * enabled. DO NOT RELY ON THE GATE TO CATCH A MISTYPED SLUG: nothing does, and
 * only the product can confirm an activation.
 *
 * No second flag system was added for activation, and none
 * should be — the answer to "is this studio's durable waitlist on?" must stay
 * this one set-membership question.
 *
 * THERE IS NO GLOBAL ENABLE, BY CONSTRUCTION. slugIsListed() below asks only
 * whether one server-resolved slug is a MEMBER of the parsed set. No value —
 * "*", "all", "true" — is interpreted as "every studio", because nothing here
 * interprets values at all. Enabling N studios costs N typed slugs.
 */
export const NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV =
  "NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS";

/** Machine-readable refusal code on the public booking result. */
export const NEW_CLIENT_WAITLIST_REFUSAL_CODE = "new_client_waitlist" as const;

/** Public copy for a refused NEW-client booking submission. */
export const NEW_CLIENT_WAITLIST_BOOKING_REFUSAL =
  "New-client booking is currently by waitlist. Please join the waitlist.";

/**
 * Generic refusal for a submission that could not be recorded and is KNOWN not
 * to have reached the studio. Identical for "no such studio", "studio is not in
 * waitlist mode", "no operational recipient" and "the provider refused", so a
 * probing caller cannot enumerate studios or read the feature configuration.
 */
export const NEW_CLIENT_WAITLIST_SUBMIT_FAILED =
  "We couldn't record your waitlist request. Please try again in a moment.";

/**
 * DISTINCT copy for the AMBIGUOUS case: the request neither clearly landed nor
 * clearly failed. Under WAIT-01 that meant a provider timeout or a concurrent
 * send under the same key; under WAIT-02 it means the database command threw in
 * transport, which cannot distinguish "never ran" from "committed and the
 * answer was lost". Either way "try again" would be actively wrong — a blind
 * resubmit could duplicate a request that did land. Point at a human, and never
 * claim they joined.
 */
export const NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED =
  "We couldn't confirm your waitlist request. Please contact the studio before submitting again.";

// NOTE. There is deliberately no constant here for a "you are already on this
// waitlist" message or a "we could not confirm the studio notification" one.
// Both existed and both were removed: each let an anonymous caller distinguish
// which database outcome occurred, which is the enumeration this surface must
// not permit. See NewClientWaitlistResult below.

// Bounded input. Public, unauthenticated surface: everything is length-capped
// before it reaches a database lookup, a rate limiter or an email template.
export const WAITLIST_NAME_MAX = 120;
export const WAITLIST_EMAIL_MAX = 254; // RFC 5321 practical address ceiling
export const WAITLIST_PHONE_MAX = 40;
// The slug arrives from the browser as a lookup pointer only. Bounding it keeps
// an arbitrarily long attacker-supplied string out of the studio query and out
// of any diagnostic log line.
export const WAITLIST_SLUG_MAX = 100;

// Same conservative shape the rest of the project uses for public email input.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_SLUGS: ReadonlySet<string> = new Set<string>();

/** Trimmed + lowercased entries; blanks dropped, so "a,, ,b" is exactly {a,b}. */
function parseWaitlistSlugs(raw: string | undefined): ReadonlySet<string> {
  if (!raw) return EMPTY_SLUGS;
  const slugs = new Set<string>();
  for (const entry of raw.split(",")) {
    const slug = entry.trim().toLowerCase();
    if (slug.length > 0) slugs.add(slug);
  }
  return slugs;
}

/** Exact-match membership of a studio slug in one server-only allowlist env var. */
function slugIsListed(envVar: string, studioSlug: string | null | undefined): boolean {
  const slug = typeof studioSlug === "string" ? studioSlug.trim().toLowerCase() : "";
  if (slug.length === 0) return false;
  return parseWaitlistSlugs(process.env[envVar]).has(slug);
}

/**
 * Is this studio's NEW-client intake currently waitlisted?
 *
 * Callers MUST pass a SERVER-RESOLVED slug (read back off the studios row),
 * never a browser-supplied string, so a forged form cannot choose which
 * studio's configuration is consulted.
 */
export function isNewClientWaitlistEnabled(
  studioSlug: string | null | undefined,
): boolean {
  return slugIsListed(NEW_CLIENT_WAITLIST_SLUGS_ENV, studioSlug);
}

/**
 * Is this studio's waitlist COMMITTED TO THE DATABASE yet (WAIT-02)?
 *
 * Same server-resolved-slug requirement as the gate above, and the same
 * exact-match semantics. SUBORDINATE to the gate: the submit path only reaches
 * this question after `isNewClientWaitlistEnabled` has already said yes, so
 * listing a studio here while its gate is off enables nothing.
 */
export function isNewClientWaitlistDurableEnabled(
  studioSlug: string | null | undefined,
): boolean {
  return slugIsListed(NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV, studioSlug);
}

export type WaitlistSubmission = {
  name: string;
  /** Trimmed + lowercased. The only representation this feature stores or sends. */
  email: string;
  phone: string | null;
};

export type WaitlistValidation =
  | { ok: true; value: WaitlistSubmission }
  | { ok: false; error: string };

/**
 * Bounded validation for the public waitlist form.
 *
 * Deliberately NOT a client-profile normaliser: the phone is a plain contact
 * string (no E.164 coercion, no dedupe, no match against `clients`), because
 * V1 creates no client record and claims no identity.
 */
export function validateWaitlistSubmission(raw: {
  name: string;
  email: string;
  phone: string | null;
}): WaitlistValidation {
  const name = raw.name.trim();
  if (name.length === 0) return { ok: false, error: "Your name is required." };
  if (name.length > WAITLIST_NAME_MAX) {
    return { ok: false, error: "Please shorten your name." };
  }

  const email = raw.email.trim().toLowerCase();
  if (email.length === 0 || email.length > WAITLIST_EMAIL_MAX || !EMAIL_RE.test(email)) {
    return { ok: false, error: "Enter a valid email address." };
  }

  const phoneRaw = (raw.phone ?? "").trim();
  if (phoneRaw.length > WAITLIST_PHONE_MAX) {
    return { ok: false, error: "Please shorten your phone number." };
  }

  return {
    ok: true,
    value: { name, email, phone: phoneRaw.length === 0 ? null : phoneRaw },
  };
}

/**
 * The outcome of a public waitlist submission, as the browser sees it.
 *
 * ONE SUCCESS SHAPE, DELIBERATELY. This type used to carry `state` ("joined"
 * vs "already_waiting") and `notification` ("sent" vs "unconfirmed"), and the
 * form rendered different copy for each. On an UNAUTHENTICATED endpoint that
 * is a MEMBERSHIP ORACLE: one request per address told an anonymous prober
 * whether that named person had asked this studio for treatment. The per-IP
 * and per-email limiters do not stop a single targeted probe, and for an
 * electrolysis studio the disclosure is exactly the sensitive fact.
 *
 * So there is now nothing to read. Success is success — a newly created entry
 * and an already-waiting duplicate return this identical value and render
 * identical copy.
 *
 * The distinction is NOT lost, only moved behind the boundary: the database
 * command still returns `created` / `already_waiting`, the action still uses
 * it to decide whether to notify, and both it and the notification outcome are
 * still recorded in the PII-free server logs where they were already kept.
 *
 * WHAT THIS DOES NOT CLOSE: a duplicate skips two provider calls and so
 * answers measurably faster. Equalising that would mean either sending a
 * second notification on every duplicate (rejected — it turns the form into a
 * mail amplifier aimed at whoever the prober names) or padding responses to a
 * constant time (disproportionate here). The timing residual is documented
 * rather than papered over.
 */
export type NewClientWaitlistResult =
  | { ok: true }
  | { ok: false; error: string };
