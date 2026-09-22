// EMERG-PORTAL-REBOOK-01 — the refusal vocabulary for portal-authenticated
// rebooking, as data rather than as string literals scattered through a
// "use server" module.
//
// WHY A MODULE. Every export of a `"use server"` file must be an async server
// action, so the action file cannot export its own copy. Lifting the strings
// here lets the tests assert the CONTRACT ("an archived client and a DB read
// failure return the same sentence") instead of re-typing the prose and
// agreeing with themselves.
//
// THE RULE THESE STRINGS ENCODE. A returning client is authenticated, so there
// is no email-enumeration channel to protect here the way the unauthenticated
// public surface must. What still must not leak is the COMMAND'S REFUSAL
// VOCABULARY: `invalid_client`, `invalid_service`, `studio_not_found` and
// `not_eligible` each name a tenancy or eligibility fact about someone else's
// data, and a client who could tell them apart could probe the studio's
// records. So every non-actionable refusal collapses to ONE sentence, and only
// the two a client can genuinely act on — pick another time, pick another
// service — say anything specific.

/**
 * Why a portal rebooking attempt did not produce an appointment.
 *
 * The UI branches on the CODE, never on the sentence, so copy can change
 * without changing behaviour.
 */
export type PortalRebookRefusalCode =
  /** No live portal session. The surface must send the client to /portal/login. */
  | "session_expired"
  /**
   * Anything that is not the client's to fix: a DB read that failed, an
   * archived client, a studio row that would not load, a command refusal
   * naming tenancy or eligibility. Deliberately ONE code for all of them.
   */
  | "unavailable"
  /** The chosen service is no longer active, or is not this studio's. */
  | "service_unavailable"
  /** The chosen time is gone, in the past, or was never an offered slot. */
  | "slot_taken"
  /** The chosen date lies outside the studio's public booking horizon. */
  | "outside_window";

/**
 * Shown when the portal session is absent, expired or revoked.
 *
 * FAIL CLOSED. This is returned INSTEAD of a booking, never alongside one.
 */
export const PORTAL_REBOOK_SESSION_EXPIRED =
  "Your session has ended. Please sign in again to book.";

/**
 * The single sentence for every refusal the client cannot act on.
 *
 * A DB READ FAILURE MUST LAND HERE, NOT ON "no availability". Telling a client
 * that a studio has nothing free, on the strength of a query that never
 * answered, is a false statement about the studio's calendar.
 */
export const PORTAL_REBOOK_GENERIC_REFUSAL =
  "We couldn't complete that booking. Please try again in a moment, or contact the studio.";

/** The service was archived, deactivated, or belongs to another studio. */
export const PORTAL_REBOOK_SERVICE_UNAVAILABLE =
  "That service is no longer available. Please choose another.";

/**
 * The slot was taken, has passed, or is not an offered start time.
 *
 * Identical wording to the public booking surface, deliberately: the two
 * surfaces share one availability authority, so they should not describe the
 * same outcome in two different voices.
 */
export const PORTAL_REBOOK_SLOT_TAKEN =
  "That time is no longer available. Please choose another time.";

/** The date is beyond the studio's configured public booking horizon. */
export const PORTAL_REBOOK_OUTSIDE_WINDOW =
  "That date is outside the booking window.";

/** Every refusal sentence, for tests that assert none of them leaks a code. */
export const PORTAL_REBOOK_REFUSALS: Readonly<
  Record<PortalRebookRefusalCode, string>
> = Object.freeze({
  session_expired: PORTAL_REBOOK_SESSION_EXPIRED,
  unavailable: PORTAL_REBOOK_GENERIC_REFUSAL,
  service_unavailable: PORTAL_REBOOK_SERVICE_UNAVAILABLE,
  slot_taken: PORTAL_REBOOK_SLOT_TAKEN,
  outside_window: PORTAL_REBOOK_OUTSIDE_WINDOW,
});
