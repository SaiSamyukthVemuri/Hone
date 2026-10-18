import "server-only";

// ===========================================================================
// HON-47 — a studio may disable CLIENT self-service cancellation and
// rescheduling.
// ===========================================================================
//
// Sabrina asked for client self-service cancellation and rescheduling to be
// switchable off. Before migration 0234 there was no control at all: with a
// valid token, both were unconditional.
//
// THE RULE IS ENFORCED IN THE DATABASE, not here. `0234` gates
// `public_cancel_appointment_with_token` and `reschedule_appointment_v2` — the
// two client-only commands — so no caller can bypass it and a future entry
// point inherits the refusal. This module is the PRESENTATION half: the codes
// those commands return, the copy every surface shows, and the predicate the
// pages use to withdraw a CTA they know will be refused.
//
// Modelled on lib/booking/free-consult-reschedule-policy.ts (EMERG-01), whose
// header states the reason the copy is centralised: several surfaces say a
// version of the same thing, and sharing the constants means "a later edit
// cannot leave one surface promising something another refuses". The surfaces
// here are /cancel, /reschedule and /manage.
//
// WHICH actions a studio disables is NOT decided here. Both flags default TRUE
// in 0234, so this module changes nothing until an owner turns one off.
//
// NEVER DERIVED FROM `new_client_admission_mode`. EMERG-01 reads that to refuse
// rescheduling a free consultation at a waitlisted studio; this is a separate,
// broader control. A studio with rescheduling ENABLED still gets EMERG-01's
// narrower rule, and disabling client cancellation must not touch Willow's
// admission behaviour.

/** The command's refusal word when cancellation is switched off. */
export const CLIENT_CANCELLATION_DISABLED_CODE = "cancellation_disabled" as const;

/** The command's refusal word when rescheduling is switched off. */
export const CLIENT_RESCHEDULE_DISABLED_CODE = "reschedule_disabled" as const;

export type ClientSelfServiceDisabledCode =
  | typeof CLIENT_CANCELLATION_DISABLED_CODE
  | typeof CLIENT_RESCHEDULE_DISABLED_CODE;

// --- public copy, defined once ---------------------------------------------
//
// Deliberately NOT interpolating the studio's name: these strings are shown on
// surfaces that already name the studio, and a template that silently renders
// an empty name is worse than a sentence that never needed one.
//
// Each pair says the same two things, in the order a worried client needs
// them: your appointment has NOT changed, and here is who can change it.

/** Eyebrow above the cancellation refusal. */
export const CLIENT_CANCELLATION_DISABLED_EYEBROW = "Cancel appointment";

/** The single sentence every surface uses to name the cancellation rule. */
export const CLIENT_CANCELLATION_DISABLED_HEADLINE =
  "This studio handles cancellations directly";

/** What is true right now, and what the client can do about it. */
export const CLIENT_CANCELLATION_DISABLED_BODY =
  "Your appointment is still booked and has not been changed. To cancel it, please contact the studio and they'll take care of it.";

/**
 * The server action's refusal string. Distinct from the page copy because this
 * outcome is NOT "we can't tell you anything": the appointment is real,
 * confirmed, and staying exactly where it is.
 */
export const CLIENT_CANCELLATION_DISABLED_ERROR =
  "This studio handles cancellations directly. Your appointment hasn't changed — please contact the studio to cancel it.";

/** Eyebrow above the reschedule refusal. */
export const CLIENT_RESCHEDULE_DISABLED_EYEBROW = "Reschedule appointment";

/** The single sentence every surface uses to name the reschedule rule. */
export const CLIENT_RESCHEDULE_DISABLED_HEADLINE =
  "This studio handles date changes directly";

/** What is true right now, and what the client can do about it. */
export const CLIENT_RESCHEDULE_DISABLED_BODY =
  "Your appointment is still booked at its original time. To move it, please contact the studio and they'll find you a new time.";

/** The server actions' refusal string. */
export const CLIENT_RESCHEDULE_DISABLED_ERROR =
  "This studio handles date changes directly. Your appointment hasn't changed — please contact the studio to move it.";

/**
 * The studio fields this decision reads, and the only ones it may read.
 *
 * Both are `not null default true` in 0234. `?? true` is a belt-and-braces
 * default for a row selected by an older query that did not ask for the
 * column — absence must never read as "disabled", or a missing projection
 * would silently switch a studio's self-service off.
 */
export type ClientSelfServicePolicyStudio = {
  client_cancellation_enabled?: boolean | null;
  client_reschedule_enabled?: boolean | null;
};

/** May a CLIENT cancel their own appointment at this studio? */
export function clientCancellationAllowed(
  studio: ClientSelfServicePolicyStudio | null | undefined,
): boolean {
  return studio?.client_cancellation_enabled ?? true;
}

/** May a CLIENT reschedule their own appointment at this studio? */
export function clientRescheduleAllowed(
  studio: ClientSelfServicePolicyStudio | null | undefined,
): boolean {
  return studio?.client_reschedule_enabled ?? true;
}
