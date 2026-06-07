// PR #163. Booking attribution. Chloe asked for a "How did you hear
// about us?" question on the public booking flow so the studio can
// see whether bookings come from Google, Instagram, referrals, the
// studio website, etc.
//
// This module is the single source of truth for the option list +
// label-lookup that the public booking form (PublicBookForm.tsx),
// the booking action (actions.ts), the practitioner notification
// email (lib/email/templates/appointment.ts), and the calendar
// appointment detail page (app/(app)/calendar/[id]/page.tsx) all
// consume. One module means an option added or relabelled later
// reaches every surface at once and the validation array cannot
// drift from the dropdown the user sees.
//
// Internal values are lowercase snake_case strings written into
// the appointments.referral_source nullable text column added by
// migration 0069. Labels are practitioner / client-facing wording.
// A future PR can promote any of these to a client-level first-
// touch attribution model without changing the per-appointment
// shape here.

export type ReferralSourceValue =
  | "google"
  | "instagram"
  | "friend_or_referral"
  | "existing_client"
  | "studio_website"
  | "other"
  | "prefer_not_to_say";

export const REFERRAL_SOURCE_OPTIONS: ReadonlyArray<{
  value: ReferralSourceValue;
  label: string;
}> = [
  { value: "google", label: "Google" },
  { value: "instagram", label: "Instagram" },
  { value: "friend_or_referral", label: "Friend or referral" },
  { value: "existing_client", label: "Existing client" },
  { value: "studio_website", label: "Studio website" },
  { value: "other", label: "Other" },
  { value: "prefer_not_to_say", label: "Prefer not to say" },
];

const VALUE_SET = new Set<string>(
  REFERRAL_SOURCE_OPTIONS.map((o) => o.value),
);

// Validate a raw form value. Returns the canonical value on success,
// or null if the input was blank / undefined (the field is optional).
// Throws on a non-empty unknown value so the action layer can surface
// a generic validation error to the public form. The error message
// is intentionally generic; the public booking flow already collapses
// every server-side reject into a single visitor-safe banner so we
// do not reveal the canonical value set to a probing caller.
export function parseReferralSource(
  raw: unknown,
): ReferralSourceValue | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== "string") {
    throw new Error("Invalid referral source.");
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return null;
  if (!VALUE_SET.has(trimmed)) {
    throw new Error("Invalid referral source.");
  }
  return trimmed as ReferralSourceValue;
}

// Map a stored value back to the practitioner-facing label.
// Returns null when the value is null/undefined so the caller can
// decide whether to render anything. A stored value not present in
// the option list (e.g. a future value that has been removed) falls
// through and renders as the raw string so the operator can still
// see what was captured.
export function referralSourceLabel(
  value: string | null | undefined,
): string | null {
  if (!value) return null;
  const option = REFERRAL_SOURCE_OPTIONS.find((o) => o.value === value);
  return option ? option.label : value;
}
