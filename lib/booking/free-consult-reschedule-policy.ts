import "server-only";

import type { Service } from "@/lib/types/database";
import { isConsultationService } from "@/lib/booking/consultation";
import { isNewClientWaitlistEnabled } from "@/lib/booking/new-client-waitlist";

// ===========================================================================
// EMERG-01 — WAITLIST-ONLY REBOOKING OF A FREE CONSULTATION
// ===========================================================================
//
// THE PROBLEM. A studio whose NEW-client intake is already in Hone's closed /
// waitlist mode is rationing its scarcest resource: consultation slots. Its
// free consultation is the front door. Self-service rescheduling lets one
// holder of that door move it around the calendar indefinitely, which both
// keeps the slot out of the queue and defeats the admission control the studio
// deliberately turned on. Cancelling returns the slot to the queue; moving it
// does not.
//
// THE RULE, and it is a CONJUNCTION of three facts, never fewer:
//
//     the studio's new-client intake is WAITLISTED   (the existing gate)
//   & the service is a CONSULTATION                  (the existing classifier)
//   & the service is FREE                            (price_cents === 0)
//   ------------------------------------------------------------------------
//   = this appointment may be CANCELLED but not self-service RESCHEDULED
//
// WHAT THIS MODULE DELIBERATELY IS NOT.
//
//   * NOT A SECOND GATE. Studio scope is answered by
//     `isNewClientWaitlistEnabled` and nothing else — same server-only env
//     allowlist, same exact-match semantics, same DEFAULT OFF, same one-line
//     kill switch. No new environment variable was added, because the existing
//     gate already expresses "this studio's new-client intake is closed", which
//     is exactly the condition this policy needs.
//   * NOT A SECOND CONSULTATION CLASSIFIER. `isConsultationService` is the
//     canonical answer, name fallback included. A private re-derivation here
//     could classify the same row differently from the public booking menu.
//   * NOT PRICE-ONLY. A studio's complimentary patch test is free and is NOT a
//     consultation; taking rescheduling away from it would be a silent product
//     change for a service this emergency never touched. `price_cents` is
//     `number | null`, and NULL is UNKNOWN, not zero: an unpriced service does
//     not match.
//   * NOT A STUDIO IDENTITY. No slug, id or name is written down anywhere in
//     this file. Which studios are in scope is a runtime configuration answer,
//     and only ever that.
//
// SERVER-ONLY, AND EVERY INPUT SERVER-RESOLVED. The caller must pass the slug
// read back off the `studios` row and the service read back off the `services`
// row for the resolved appointment. Nothing here may be fed from a form field,
// a query string or a client component's props: those are the browser's claims
// about the world, and the browser is not the authority for admission control.
// The `server-only` marker above is what makes an accidental client import a
// BUILD failure rather than a leak of the configured allowlist.
// ===========================================================================

/**
 * Machine-readable outcome for a refused public reschedule.
 *
 * BOUNDED ON PURPOSE. It is attached ONLY after the token has genuinely
 * resolved to a CONFIRMED, FUTURE appointment whose service and studio prove
 * the policy. Every earlier failure — unknown token, expired token, cancelled /
 * completed / no-show appointment, past start — keeps the existing public
 * collapse and carries NO code at all, so this value can never be used to probe
 * which studios have the policy or whether a token is real.
 */
export const FREE_CONSULT_WAITLIST_ONLY_CODE =
  "free_consultation_waitlist_only" as const;

export type FreeConsultWaitlistOnlyCode =
  typeof FREE_CONSULT_WAITLIST_ONLY_CODE;

// --- public copy, defined once ---------------------------------------------
//
// Four surfaces say a version of the same thing: the reschedule page, the three
// reschedule server actions, the manage page, and the cancel page's warning.
// They share these constants so a later edit cannot leave one surface promising
// something another refuses.

/** Eyebrow above the reschedule refusal. */
export const FREE_CONSULT_WAITLIST_ONLY_EYEBROW = "Reschedule consultation";

/** The single sentence every surface uses to name the rule. */
export const FREE_CONSULT_WAITLIST_ONLY_HEADLINE =
  "Free consultations can't be rescheduled";

/** What is true right now, and what the visitor can do about it. */
export const FREE_CONSULT_WAITLIST_ONLY_BODY =
  "Your current consultation is still booked. If you need a different date, cancel this appointment first. After cancelling, you can join the waitlist for the next available consultation.";

/**
 * The server actions' refusal string. Distinct from the collapse copy, because
 * this outcome is NOT "we can't tell you anything": the appointment is real,
 * confirmed, and staying exactly where it is.
 */
export const FREE_CONSULT_WAITLIST_ONLY_ERROR =
  "Free consultations can't be rescheduled. Cancel this appointment if you need a different date, then join the waitlist for the next available consultation.";

/** Heading of the pre-cancellation warning. */
export const FREE_CONSULT_WAITLIST_ONLY_CANCEL_HEADING = "Before you cancel";

/**
 * The warning itself, shown ABOVE the destructive action. A warning, not a
 * consent contract: it adds no checkbox and blocks no cancellation.
 */
export const FREE_CONSULT_WAITLIST_ONLY_CANCEL_WARNING =
  "This free consultation can't be rescheduled. If you cancel this appointment, you'll lose this time and will need to join the waitlist before booking another free consultation.";

/** The service fields this decision reads, and the only ones it may read. */
export type FreeConsultPolicyService = Pick<
  Service,
  "modality" | "name" | "price_cents"
>;

/**
 * Is this appointment's rebooking WAITLIST-ONLY?
 *
 * @param studioSlug SERVER-RESOLVED `studios.slug` for the appointment's own
 *   studio. Never a browser-supplied string — that would let a forged request
 *   choose which studio's configuration is consulted.
 * @param service SERVER-RESOLVED `services` row for the appointment. `null`
 *   (no service on the appointment, or an unresolvable join) is NOT a match:
 *   the policy protects free CONSULTATIONS, and an appointment without a
 *   resolvable service is not one, so it keeps its existing behaviour.
 */
export function isFreeConsultWaitlistOnlyReschedule(input: {
  studioSlug: string | null | undefined;
  service: FreeConsultPolicyService | null | undefined;
}): boolean {
  const { studioSlug, service } = input;
  // Studio scope first: outside a waitlisted studio nothing else is even asked,
  // and DEFAULT OFF means an unconfigured deployment answers `false` here for
  // every studio in the world.
  if (!isNewClientWaitlistEnabled(studioSlug)) return false;
  if (!service) return false;
  if (!isConsultationService(service)) return false;
  // STRICT zero. `price_cents` is nullable and null means "no price recorded",
  // which is unknown rather than free.
  return service.price_cents === 0;
}
