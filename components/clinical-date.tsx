"use client";

import { formatClinicalDate } from "@/lib/clinical-notes/clinical-date";

// Renders a clinical event's CALENDAR DATE.
//
// The date is formatted with Hone's explicit `en-CA` presentation locale and
// `UTC`, so server and browser output are deterministic.
//
// Both halves of that are load-bearing. `timeZone: "UTC"` alone pins the DAY
// but not the locale-dependent TEXT: a Client Component renders once in Node
// and again in the browser, and `toLocaleDateString(undefined, …)` would take
// each runtime's own default — en-US on the server emits "Jul 21, 2026" while
// an fr-CA browser emits "21 juill. 2026". Same day, mismatched markup. Pinning
// the locale explicitly is what removes that, which is why this component
// passes no locale of its own and must never read `navigator.language`.
//
// Because the output is genuinely identical in both runtimes, the date is
// correct in the FIRST paint — no useEffect, no empty-then-filled dance, no
// suppressHydrationWarning, no ssr:false. Those would hide or defer a mismatch
// rather than remove it.
//
// Use for: client_clinical_notes.occurred_at.
// NEVER for: session started_at, appointment times, created_at, payment or
// audit timestamps — those are real instants and belong in the viewer's zone
// via <FormattedDateTime>.
export function ClinicalDate({
  iso,
  className,
}: {
  iso: string | null | undefined;
  className?: string;
}) {
  return <span className={className}>{formatClinicalDate(iso)}</span>;
}
