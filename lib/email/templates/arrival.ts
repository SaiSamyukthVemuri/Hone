// HON-50. The arrival/parking section shared by the appointment emails
// (confirmation, 24h and 2h reminders, appointment-update). Blank or
// whitespace-only instructions render NOTHING, not an empty heading, so a
// studio without instructions gets byte-identical output to before.
//
// It sits in the body after the appointment details, never in the subject or
// the opening lead, so the preview window still names only the studio
// (#828 / #1049).

import { escapeHtml } from "@/lib/email/markdown-lite";

export const ARRIVAL_HEADING = "Arrival and parking";

function clean(value: string | null | undefined): string | null {
  return typeof value === "string" ? value.trim() || null : null;
}

export function arrivalSectionHtml(value: string | null | undefined): string {
  const v = clean(value);
  if (!v) return "";
  return `<br/><br/><strong>${ARRIVAL_HEADING}</strong><br/><span style="white-space:pre-wrap;">${escapeHtml(v)}</span>`;
}

export function arrivalSectionText(value: string | null | undefined): string {
  const v = clean(value);
  if (!v) return "";
  return `\n${ARRIVAL_HEADING}:\n${v}\n`;
}
