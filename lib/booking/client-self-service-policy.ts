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

// ===========================================================================
// THE LINKS — slice 3. Suppression at the point of MINTING.
// ===========================================================================
//
// 0234 refuses the command and the surfaces withdraw their CTAs, so a client
// who follows a stale link is told the truth rather than shown a form that
// cannot work. This closes the remaining gap: a studio that has switched an
// action off should not be SENDING the link in the first place, in any email or
// SMS, because the link itself is a promise.
//
// WHY ONE HELPER AND NOT A CHECK AT EACH SITE. The same three URLs were built
// by hand at six places — the public booking confirmation, the portal rebook,
// the reschedule successor, the shared notification builder, the moved-notice
// email and the reminder cron. Six copies of a policy decision is six chances
// for one to be missed, and the one that is missed is invisible: the email
// simply goes out with a link that refuses.
//
// /manage IS ALWAYS RETURNED, deliberately. It is the honest fallback: it
// mutates nothing, it names only the actions it can actually offer, and when
// both switches are off it explains and points at the studio. Withholding it
// would leave a client with no link at all.
//
// THE FLAGS MUST BE READ SERVER-SIDE AT MINT TIME, from the same studio row the
// commands lock. This module is `server-only`, so that is structural rather
// than a convention: a browser cannot reach this function, and no caller can
// pass a flag that did not come from the database.

/**
 * The three client links for one appointment, with the suppressed ones null.
 *
 * `null` means DO NOT SEND and do not render a label for it — not "render an
 * empty href", which is how a suppressed link becomes a dead button.
 */
export type ClientSelfServiceLinks = {
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  /** Never null: see the header. */
  manageUrl: string;
};

export function clientSelfServiceLinks(input: {
  /** Absolute origin, no trailing slash — as every mint site already derives. */
  origin: string;
  /** The RAW token that belongs in the URL, never its hash. */
  token: string;
  studio: ClientSelfServicePolicyStudio | null | undefined;
}): ClientSelfServiceLinks {
  const { origin, token, studio } = input;
  // NOT encodeURIComponent, matching every call site this replaces: appointment
  // tokens are hex, so encoding is a no-op for every token the app mints, and
  // changing it here would silently alter URLs rather than only suppress them.
  // Suppression is the whole change; nothing else about these strings moves.
  return {
    cancelUrl: clientCancellationAllowed(studio)
      ? `${origin}/cancel/${token}`
      : null,
    rescheduleUrl: clientRescheduleAllowed(studio)
      ? `${origin}/reschedule/${token}`
      : null,
    manageUrl: `${origin}/manage/${token}`,
  };
}
