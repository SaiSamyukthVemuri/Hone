"use client";

import { formatClinicalDate } from "@/lib/clinical-notes/clinical-date";

// Renders a clinical event's CALENDAR DATE.
//
// Unlike <FormattedDateTime>, this component renders identically on the server
// and the client, because a calendar date does not depend on where the viewer
// is: `timeZone: "UTC"` pins the day and only the month NAME follows locale.
// So there is no empty-then-filled hydration dance and no
// suppressHydrationWarning — the date is correct in the first paint.
//
// Use for: client_clinical_notes.occurred_at.
// NEVER for: session started_at, appointment times, created_at — those are real
// instants and belong in the viewer's zone via <FormattedDateTime>.
export function ClinicalDate({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  return <span className={className}>{formatClinicalDate(iso)}</span>;
}
