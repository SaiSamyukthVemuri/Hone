// The ONE definition of when an appointment may still be cancelled or moved.
//
// This rule previously lived in two places that had already drifted:
//
//   * app/(app)/calendar/[id]/page.tsx  `isCancelable`
//       typedStatus === "confirmed" && Number.isFinite(startsAtMs)
//       && startsAtMs > Date.now()
//     — one variable gating BOTH the Cancel form and the Reschedule section.
//
//   * app/(app)/calendar/AppointmentPreviewDrawer.tsx  `canMove`
//       a.status === "confirmed" && new Date(a.starts_at).getTime() > Date.now()
//     — the same rule minus the Number.isFinite guard.
//
// The divergence was real: an appointment row whose starts_at does not parse
// yields NaN, and `NaN > Date.now()` is false, so the detail page hid the
// action while the drawer's copy reached the same answer only by accident of
// how NaN compares. Any future edit that flipped the comparison would have
// separated them. Both surfaces now call this function.
//
// Cancel and Move share ONE gate here exactly as they share one `isCancelable`
// on the detail page. They are deliberately not two names that can drift apart:
// the server refuses both from the same states (public.practitioner_cancel_
// appointment returns 'not_cancelable' once starts_at <= now(), and the move
// command applies the same confirmed+future rule), so a second predicate would
// be a second place to get it wrong, not a second rule.
//
// Pure and client-safe. `nowMs` is INJECTED rather than read from the clock in
// here, so a server render and a client render can be made to agree and a test
// can pin the boundary instant without faking time globally.
//
// This is a UI-visibility rule, never an authorization decision. It exists so
// the product does not offer a button the server will refuse. The authority is
// the SECURITY DEFINER command in the database; see
// supabase/migrations/0174_appointment_attribution_and_audit_integrity.sql.

export type AppointmentActionabilityInput = {
  // The appointment's CURRENT status. Callers that hold a possibly stale copy
  // (for example a week-grid payload rendered minutes ago) should re-read it
  // before trusting the answer.
  status: string | null | undefined;
  startsAt: string | null | undefined;
  nowMs: number;
};

// Confirmed and still in the future. Anything else — cancelled, completed,
// no_show, already started, or an unparseable timestamp — is false.
export function isAppointmentCancelable(
  input: AppointmentActionabilityInput,
): boolean {
  if (input.status !== "confirmed") return false;
  if (typeof input.startsAt !== "string") return false;
  const startsAtMs = new Date(input.startsAt).getTime();
  return Number.isFinite(startsAtMs) && startsAtMs > input.nowMs;
}
