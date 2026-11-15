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

// Short cards are overflow-hidden at a fixed height, so a separate practitioner
// row that does not fit would clip itself and push the service row out of view.
// The card gives the practitioner its own row only when EVERY row it renders
// fits; otherwise the swatch and name move onto the time row, which already
// exists, so no existing detail is displaced. Rendered line boxes are
// leading-tight (1.25) of each row's font size; the card pads 4px top and bottom.
export const CARD_LINE_PX = {
  small: 12.5, // text-[10px]: time, practitioner and service rows
  desktopBody: 13.75, // text-[11px]: the desktop client row
  mobileBody: 15, // text-[12px]: the mobile client row
} as const;
const CARD_VERTICAL_PADDING_PX = 8;

export function practitionerRowFits(
  heightPx: number,
  opts: { bodyLinePx: number; serviceRow: boolean },
): boolean {
  const needed =
    CARD_VERTICAL_PADDING_PX +
    CARD_LINE_PX.small + // time
    opts.bodyLinePx + // client
    CARD_LINE_PX.small + // practitioner
    (opts.serviceRow ? CARD_LINE_PX.small : 0);
  return heightPx >= needed;
}

// Initials for the Day column header's avatar chip (decorative: the full name is always printed).
export function practitionerInitials(name: string | null | undefined): string {
  // Words that start with a letter or digit only: "(synthetic)" or "-" never becomes an initial.
  const words = (name ?? "").trim().split(/\s+/).filter((w) => /^[\p{L}\p{N}]/u.test(w));
  if (words.length === 0) return "?";
  const first = [...words[0]][0] ?? "";
  const last = words.length > 1 ? ([...words[words.length - 1]][0] ?? "") : "";
  return (first + last).toUpperCase();
}
