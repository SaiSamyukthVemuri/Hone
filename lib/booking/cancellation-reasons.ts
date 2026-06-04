// Single source of truth for the public cancel form's reason dropdown.
//
// Layout
// ------
// Each entry has:
//   * value: the stable machine identifier persisted to
//            appointment_audit.details.reason. Never renamed. Adding a
//            new entry is fine; removing one will leave historical
//            rows pointing to a value that no longer maps to a label.
//   * label: the human phrase that appeared in the dropdown when the
//            client clicked it. Snapshotted into the same audit row
//            (details.reason_label) and into appointments.cancellation_reason
//            so a future label rewording does not retroactively change
//            what a historical client saw.
//
// Two consumers MUST share this constant:
//   1. app/cancel/[token]/CancelForm.tsx — renders the <option> list
//      and decides whether to show the reschedule nudge.
//   2. app/cancel/[token]/actions.ts — validates the submitted machine
//      value against this allowed set and derives the label snapshot
//      server-side. The label is NEVER trusted from client form input.
//
// Why nudge-on-reason
// -------------------
// Two of the seven reasons strongly imply "I want a different time,
// not no time at all": SCHEDULE_CHANGED and PREFER_RESCHEDULE. When
// the client picks either, the form surfaces a small reschedule
// callout above the destructive cancel button so they have an
// obvious way out before they commit. Cancellation is never blocked
// by the nudge; the client can still click Cancel.

export const CANCELLATION_REASONS = [
  { value: "schedule_changed", label: "Schedule changed" },
  { value: "booked_by_mistake", label: "Booked by mistake" },
  { value: "found_another_provider", label: "Found another provider" },
  { value: "not_ready", label: "Not ready yet" },
  { value: "price_concern", label: "Price concern" },
  { value: "prefer_reschedule", label: "Prefer to reschedule instead" },
  { value: "other", label: "Other" },
] as const;

export type CancellationReasonValue =
  (typeof CANCELLATION_REASONS)[number]["value"];

export const CANCELLATION_NOTE_MAX_LENGTH = 1000;

// Machine values whose semantics suggest "I want a different time, not
// no appointment". Consumed by CancelForm to toggle the reschedule
// callout. Lives next to the reason map so any future addition stays
// co-located.
export const RESCHEDULE_NUDGE_REASONS: ReadonlySet<CancellationReasonValue> =
  new Set(["schedule_changed", "prefer_reschedule"]);

export function isCancellationReasonValue(
  value: string | null | undefined,
): value is CancellationReasonValue {
  if (!value) return false;
  return CANCELLATION_REASONS.some((entry) => entry.value === value);
}

export function getCancellationReasonLabel(
  value: CancellationReasonValue,
): string {
  const entry = CANCELLATION_REASONS.find((r) => r.value === value);
  // The narrowed type guarantees a match, but the helper is defensive.
  return entry ? entry.label : "";
}
