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
// bounded validation and the provider idempotency-key derivation the waitlist
// submit path depends on.
//
// Deliberately:
//   * DEFAULT OFF — unset / empty / whitespace-only is OFF for every studio,
//     so deploying this changes nothing until an operator opts a studio in.
//     Clearing the env is the entire kill switch: no database work at all.
//   * EXACT-MATCH ONLY — exact slug equality after trim + lowercase. A
//     substring, prefix or suffix NEVER matches, so enabling
//     "willow-electrolysis" cannot silence "willow-electrolysis-archive".
//   * SERVER-ONLY — `import "server-only"` keeps the configured list out of
//     every client bundle. The browser receives a DERIVED boolean for
//     presentation, never the list, and never as booking authority.
//   * UNCACHED — process.env is read per call so an operator's change takes
//     effect on the next render/action rather than the next cold start.
//
// This is ADMISSION CONTROL, not slot legality. Nothing here participates in
// slot generation, buffers, practitioner capacity or availability validation.
// ===========================================================================

/** Server-only env var naming the studios whose NEW-client intake is waitlisted. */
export const NEW_CLIENT_WAITLIST_SLUGS_ENV = "NEW_CLIENT_WAITLIST_STUDIO_SLUGS";

/** Machine-readable refusal code on the public booking result. */
export const NEW_CLIENT_WAITLIST_REFUSAL_CODE = "new_client_waitlist" as const;

/** Public copy for a refused NEW-client booking submission. */
export const NEW_CLIENT_WAITLIST_BOOKING_REFUSAL =
  "New-client booking is currently by waitlist. Please join the waitlist.";

/**
 * Generic refusal for a waitlist submission that could not be recorded and is
 * KNOWN not to have reached the studio. Identical for "no such studio",
 * "studio is not in waitlist mode", "no operational recipient" and "the
 * provider refused", so a probing caller cannot enumerate studios or read the
 * feature configuration from the response.
 */
export const NEW_CLIENT_WAITLIST_SUBMIT_FAILED =
  "We couldn't record your waitlist request. Please try again in a moment.";

/**
 * DISTINCT copy for the AMBIGUOUS case: the provider neither clearly accepted
 * nor clearly refused (timeout, or a concurrent request already in flight
 * under the same idempotency key). The studio may or may not have received the
 * request, so telling the visitor to "try again" would be actively wrong —
 * a blind resubmit could duplicate a request that did land. We direct them to
 * a human instead, and never claim they joined.
 */
export const NEW_CLIENT_WAITLIST_SUBMIT_UNCONFIRMED =
  "We couldn't confirm your waitlist request. Please contact the studio before submitting again.";

// Bounded input. Public, unauthenticated surface: everything is length-capped
// before it reaches a database lookup, a rate limiter or an email template.
export const WAITLIST_NAME_MAX = 120;
export const WAITLIST_EMAIL_MAX = 254; // RFC 5321 practical address ceiling
export const WAITLIST_PHONE_MAX = 40;
// The slug arrives from the browser as a lookup pointer only. Bounding it
// keeps an arbitrarily long attacker-supplied string out of the studio query
// and out of any diagnostic log line.
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
  const slug = typeof studioSlug === "string" ? studioSlug.trim().toLowerCase() : "";
  if (slug.length === 0) return false;
  return parseWaitlistSlugs(process.env[NEW_CLIENT_WAITLIST_SLUGS_ENV]).has(slug);
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
