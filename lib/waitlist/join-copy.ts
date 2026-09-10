// ===========================================================================
// WAIT-04A — WHAT A PROSPECT IS TOLD
// ===========================================================================
//
// Every sentence this feature says to a member of the public lives here, so a
// test can assert the promises directly and a reviewer can read them all at
// once without reconstructing them from JSX.
//
// THREE THINGS THIS COPY MAY NEVER DO:
//
//   1. NAME A QUEUE POSITION. Not "you are 14th", not "about 12 people ahead",
//      not "you're near the front". The queue is reordered by admission policy,
//      entries are removed and returned, and a studio's capacity moves — so a
//      number is a promise that stops being true without anyone editing it.
//      `WaitTimeEstimatorInput` in `join-profile.ts` exists so an estimate can
//      one day be computed for an OPERATOR; none of it reaches this file.
//
//   2. ESTIMATE A DATE. "Usually two to three weeks" is the same promise with
//      softer edges, and it is the one people plan around.
//
//   3. ASK HOW URGENT IT IS. A free-text urgency box invites someone to write
//      why they need this, which on an electrolysis waitlist means unsolicited
//      medical and gender-identity disclosure, arriving unbounded, into an
//      operator's queue, from an unauthenticated form. Worse, it implies the
//      answer changes their position — and it does not, because admission order
//      is policy, not sentiment. There is no urgency field and no notes field
//      anywhere in this slice, and the submission model has no limb one could
//      be added to without a type change.
//
// WHAT IS PROMISED IS EXACTLY WHAT THE PRODUCT DOES: when a consultation time
// that matches the availability they gave becomes available, they are
// contacted. That is true on the day they join and stays true.
// ===========================================================================

/** The core promise. Ties contact to the availability they just stated. */
export const WAITLIST_CONTACT_PROMISE =
  "We'll contact you when consultation times that match your availability become available.";

/** Unchanged from the shipped form: joining is not a booking. */
export const NOT_A_RESERVATION =
  "Joining the waitlist does not reserve an appointment.";

export const JOIN_HEADING = "Join the new-client waitlist";

/** Why the extra questions are being asked. Says what each answer is FOR. */
export const JOIN_INTRO =
  "Tell us what you'd like treated and when you can usually come in. We use both to match you to a consultation time.";

export const AREAS_LEGEND = "What would you like treated?";
export const AREAS_HELP =
  "Choose all that apply. You can talk through the details at your consultation.";

export const AVAILABILITY_LEGEND = "When are you generally available?";
export const AVAILABILITY_HELP =
  "A general answer is enough — we'll confirm exact times when we contact you.";

/** Confirmation. Says what happens next and nothing about when. */
export const JOINED_HEADING = "You're on the waitlist.";

// --- Completing a legacy profile -------------------------------------------

export const COMPLETE_HEADING = "Complete your waitlist details";

/**
 * Why they are being asked again.
 *
 * Names Hone's change as the reason, because it is. Anything that implied they
 * had left something out would be untrue — the questions did not exist when
 * they joined.
 */
export const COMPLETE_INTRO =
  "We've added a couple of questions so we can match you to the right consultation time. Your place on the waitlist doesn't change.";

/**
 * The reassurance that matters most, stated plainly and early.
 *
 * `ProfileCompletionPatch` has no `joinedAt` limb, so this sentence is
 * structurally true rather than merely intended.
 */
export const COMPLETE_POSITION_UNCHANGED =
  "Answering these does not move you up or down the waitlist.";

export const COMPLETE_SUBMIT = "Save my details";
export const COMPLETE_DONE_HEADING = "Thanks — that's everything we need.";

/** What an operator-facing surface says about a blocked invitation. */
export const INVITE_BLOCKED_INCOMPLETE =
  "This person joined before we asked for treatment areas and availability. They keep their place in the queue, and can be invited once those details are complete.";

// --- The mobile, and what we can honestly say about it ----------------------

/**
 * Shown beside a mobile the entry already holds, which the completion surface
 * renders as text with no control.
 *
 * Same reasoning as the email: it is a DESTINATION, and a page reachable by
 * possession of a link must not be able to repoint one.
 */
export const MOBILE_ON_FILE_NOTE =
  "Contact the studio if this number needs to change.";

/**
 * Shown beside a mobile a legacy prospect is supplying for the first time.
 *
 * SAYS THE UNVERIFIED PART OUT LOUD. A number someone types is not yet a number
 * we can text — it may have a typo, or belong to someone else. Promising texts
 * against it would be a promise the system cannot keep, so the copy commits only
 * to what is true: we will confirm it first.
 */
export const MOBILE_CANDIDATE_NOTE =
  "We'll confirm this number before sending any texts to it.";

/**
 * Shown when the mobile ALREADY ON FILE cannot be used — it is present, so a
 * bearer completion may not replace it, but it fails validation, so the profile
 * cannot be completed either.
 *
 * A DISTINCT STRING FROM `MOBILE_ON_FILE_NOTE`, deliberately. That note
 * describes a normal, healthy condition. This one describes a BLOCKED SUBMIT,
 * which is a different event and needs its own words — reusing the calm note as
 * an error would leave the person pressing Save against a form that never
 * explains why it will not move.
 *
 * IT PROMISES NO REMEDIATION, BECAUSE THERE IS NONE TO PROMISE.
 *
 * An earlier revision said "Contact the studio to update it, then come back here
 * to finish your details", which asserted two things the product cannot do. The
 * operator queue (`app/(app)/settings/waitlist/`) exposes six actions — remove,
 * claim, release, expire, requeue, claim-next — and NONE writes a phone; the
 * page reads `phone` and renders it, with no input and no form. No migration
 * provides an RPC that updates one either. So the studio can SEE the bad number
 * and can remove the person from the queue; it cannot correct the number, and
 * "come back here to finish" describes a return trip that would hit the same
 * refusal.
 *
 * That is the label-promise rule applied to copy: a message may only promise
 * what the system delivers. So every clause below is checkable —
 *
 *   * the number cannot be used            -> it fails validation
 *   * it cannot be changed from this page  -> there is no control, by design
 *   * the details cannot be completed      -> assessProfileCompleteness says so
 *   * contact the studio                   -> reaching a human is always
 *                                             possible, and this claims nothing
 *                                             about what they can then do
 *
 * DELIBERATELY NOT SAID: that the studio will email them instead. An entry with
 * an unusable mobile is PROFILE_INCOMPLETE, so `invitationEligibility` refuses
 * it on every channel — an email reassurance would be as false as the update
 * promise it replaced.
 */
export const MOBILE_ON_FILE_UNUSABLE =
  "We can't use the mobile number on file, and it can't be changed from this page — so your details can't be completed yet. Please contact the studio.";
