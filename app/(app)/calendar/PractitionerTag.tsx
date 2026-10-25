import type { CalendarPractitionerIdentity } from "@/lib/calendar/practitioner-identity";

// The practitioner colour swatch + name shown on a team-calendar appointment
// card (HON-48). The swatch is aria-hidden: the printed name carries the
// meaning, the colour only speeds up scanning.
export function PractitionerTag({
  identity,
  className = "",
}: {
  identity: CalendarPractitionerIdentity;
  className?: string;
}) {
  return (
    <span
      data-practitioner-tag=""
      className={`flex min-w-0 items-center gap-1 ${className}`}
    >
      <span
        aria-hidden="true"
        className={`inline-block h-2 w-2 shrink-0 rounded-full ring-1 ring-white/70 dark:ring-neutral-900/70 ${identity.swatchClass}`}
      />
      <span className="truncate">{identity.name}</span>
    </span>
  );
}
