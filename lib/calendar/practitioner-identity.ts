import { resolvePractitionerColor } from "@/lib/practitioner-colors";

// HON-48: on a multi-practitioner (team) calendar, every appointment card names
// its practitioner and carries that practitioner's configured colour
// (practitioners.color, set in Settings → Profile). The card FILL stays
// service-coloured (lib/calendar/service-colors.ts); the practitioner colour is
// an additional swatch, and the NAME is always printed beside it, so colour is
// never the only way to tell two practitioners apart.
//
// Display only. It reads the practitioner already joined onto each appointment
// by getAppointmentsForRange and runs no query, so it cannot widen which
// appointments a viewer sees (that policy is HON-44's, not this file's).

export type CalendarPractitionerIdentity = {
  name: string;
  swatchClass: string;
  colorLabel: string;
};

export function calendarPractitionerIdentity(
  practitioner:
    | { color?: string | null; display_name?: string | null }
    | null
    | undefined,
): CalendarPractitionerIdentity | null {
  const name = practitioner?.display_name?.trim();
  // No name, no identity line: a bare swatch would be colour-only meaning.
  if (!name) return null;
  const color = resolvePractitionerColor(practitioner?.color);
  return { name, swatchClass: color.bg, colorLabel: color.label };
}
