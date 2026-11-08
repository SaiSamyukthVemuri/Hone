/**
 * INVITATION CAPACITY copy.
 *
 * The owner never enters or sees an admission-round number: a send opens a round at the maximum
 * allowance when none is open (lib/waitlist/auto-round.ts) and the limit that applies is 0324's
 * guard (consultations that fit minus live competing invitations, under the studio lock).
 *
 * Only the refusal sentences live here, so the contract and its tests cannot drift.
 */

/** The round could not be rotated when it filled. Rare: the plumbing round holds 100 invitations. */
export const CAPACITY_EXHAUSTED_COPY =
  "We couldn't open a new batch of invitations just now. Please try again.";

/** Shown when the consultation times in the offered dates are already covered by invitations still out (0324). */
export const NO_CAPACITY_COPY =
  "No invitation was created: the consultation times in these dates are already covered by invitations that are still out. Availability can change; invitations don't reserve appointments.";

/** Shown while the database has not yet been given the send command this release needs. Nothing was sent. */
export const NOT_YET_AVAILABLE_COPY =
  "No invitation was created: inviting is not available yet. Nothing was sent, and nothing needs to be undone.";
