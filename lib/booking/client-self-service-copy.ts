// ===========================================================================
// HON-47 — the refusal codes and the client-facing copy, defined ONCE.
// ===========================================================================
//
// SPLIT OUT OF `client-self-service-policy.ts`, DELIBERATELY, and this is the
// whole reason the file exists: `app/cancel/[token]/CancelForm.tsx` is a CLIENT
// component, and the policy module is `server-only` because it reads studio
// rows. A client component cannot import a server-only module at all — the
// build fails — so without this split the form would have to re-type the same
// sentences as literals.
//
// That is exactly what EMERG-01 does today: its policy module is server-only,
// and `CancelForm` carries its own copy of "Free consultations can't be
// rescheduled..." as a literal. Two copies of one sentence, which is the
// failure the shared-constants pattern exists to prevent — a later edit to one
// leaves the other promising something the product no longer does.
//
// So: NO "server-only" here. There is nothing to protect. These are strings
// shown to the visitor and machine words the database already returns to the
// browser's own fetch; the DECISION — which studio may do what — stays in the
// server-only module next door, which re-exports all of this so existing
// server-side import sites are unchanged.

/** The command's refusal word when cancellation is switched off. */
export const CLIENT_CANCELLATION_DISABLED_CODE =
  "cancellation_disabled" as const;

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
