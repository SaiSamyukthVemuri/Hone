import { CLOCK_FALLBACK_NOTICE, isUsableTimeZone } from "@/lib/desk/time";

// Privacy D-1: when the studio's zone is missing or unusable the formatters show UTC. Say so, visibly, rather than
// presenting a wrong clock as the studio's own.
export function ClockFallbackNotice({ timezones }: { timezones: ReadonlyArray<string | null | undefined> }) {
  if (timezones.every((tz) => isUsableTimeZone(tz))) return null;
  return (
    <p role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-100">
      {CLOCK_FALLBACK_NOTICE}
    </p>
  );
}
