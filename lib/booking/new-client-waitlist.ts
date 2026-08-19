import "server-only";

// ===========================================================================
// P0 EMERGENCY — NEW-CLIENT WAITLIST (ADMISSION CONTROL)
// ===========================================================================
//
// A studio can reach a state where its EXISTING treatment clients cannot be
// served on a clinically useful cadence, while its public booking page keeps
// accepting brand-new consultations. Every extra new client consumes future
// treatment capacity that is already spoken for.
//
// This module is the SERVER-ONLY switch that stops incremental NEW-client
// bookings for named studios and routes that demand to a waitlist instead.
// It is deliberately:
//
//   * DEFAULT OFF. An unset / empty / whitespace-only env is OFF for every
//     studio, so deploying this code changes nothing until an operator opts a
//     studio in. That is the rollback property: clearing the env restores the
//     previous public booking behaviour with no database work of any kind.
//   * EXACT-MATCH ONLY. Membership is exact slug equality after trimming and
//     lowercasing. A substring, prefix or suffix NEVER matches, so
//     "willow-electrolysis-archive" cannot be silenced by enabling
//     "willow-electrolysis".
//   * SERVER-ONLY. `import "server-only"` keeps the configured slug list out
//     of any client bundle. The browser may receive a DERIVED boolean for
//     presentation, never the list, and never as booking authority.
//   * UNCACHED. `process.env` is read on every call so an operator's env
//     change takes effect with the next server render / action invocation
//     rather than at the next cold start.
//
// This is ADMISSION CONTROL, not slot legality. Nothing here participates in
// slot generation, buffers, practitioner capacity or availability validation;
// those systems are untouched.
// ===========================================================================

/** Server-only env var naming the studios whose NEW-client intake is waitlisted. */
export const NEW_CLIENT_WAITLIST_SLUGS_ENV = "NEW_CLIENT_WAITLIST_STUDIO_SLUGS";

/**
 * Stable machine-readable refusal code returned by the public booking action
 * when a new-client submission is refused by the waitlist gate. Mirrors the
 * existing `slot_taken` code convention on the same result type.
 */
export const NEW_CLIENT_WAITLIST_REFUSAL_CODE = "new_client_waitlist" as const;

/** Public copy for a refused NEW-client booking submission. */
export const NEW_CLIENT_WAITLIST_BOOKING_REFUSAL =
  "New-client booking is currently by waitlist. Please join the waitlist.";

/**
 * Single generic refusal for the waitlist submit action. Deliberately
 * identical for "no such studio", "studio is not in waitlist mode", "no
 * operational recipient on file" and "the email provider refused", so a
 * probing caller cannot use this action to enumerate studios or read the
 * feature configuration. It never exposes an env value or a database error.
 */
export const NEW_CLIENT_WAITLIST_SUBMIT_FAILED =
  "We couldn't record your waitlist request. Please try again in a moment.";

// Bounded input. Public, unauthenticated surface: everything is length-capped
// before it reaches a rate limiter, a database lookup or an email template.
export const WAITLIST_NAME_MAX = 120;
export const WAITLIST_EMAIL_MAX = 254; // RFC 5321 practical address ceiling
export const WAITLIST_PHONE_MAX = 40;

// Same conservative shape the rest of the project uses for public email input
// (public booking, portal login, marketing forms). Intentionally permissive
// about the local part and strict about "something@something.something".
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const EMPTY_SLUGS: ReadonlySet<string> = new Set<string>();

/**
 * Parse the comma-separated allowlist. Entries are trimmed and lowercased;
 * blank entries are dropped, so "a,,  ,b" is exactly {a, b} and "   " is empty.
 */
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
 * The caller MUST pass a SERVER-RESOLVED studio slug (i.e. the slug read back
 * off the studios row), never a browser-supplied string, so a forged form
 * cannot select which studio's configuration is consulted.
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
  /** Trimmed + lowercased. The only representation this feature ever stores or sends. */
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
  const phone = phoneRaw.length === 0 ? null : phoneRaw;

  return { ok: true, value: { name, email, phone } };
}
