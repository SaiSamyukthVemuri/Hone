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

// The codes and the copy live in a non-server-only sibling so the CLIENT
// component `app/cancel/[token]/CancelForm.tsx` can share them instead of
// re-typing the sentences as literals. Re-exported here so server-side callers
// have one import, and so this module remains the single name to reach for.
export {
  CLIENT_CANCELLATION_DISABLED_CODE,
  CLIENT_CANCELLATION_DISABLED_EYEBROW,
  CLIENT_CANCELLATION_DISABLED_HEADLINE,
  CLIENT_CANCELLATION_DISABLED_BODY,
  CLIENT_CANCELLATION_DISABLED_ERROR,
  CLIENT_RESCHEDULE_DISABLED_CODE,
  CLIENT_RESCHEDULE_DISABLED_EYEBROW,
  CLIENT_RESCHEDULE_DISABLED_HEADLINE,
  CLIENT_RESCHEDULE_DISABLED_BODY,
  CLIENT_RESCHEDULE_DISABLED_ERROR,
  type ClientSelfServiceDisabledCode,
} from "./client-self-service-copy";

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
