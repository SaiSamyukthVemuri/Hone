// Deterministic service color palette for the INTERNAL calendar
// appointment cards. Not used by anything else; in particular the
// private iCal subscription feed (lib/booking/ical.ts +
// app/calendar-feed/[token]/route.ts) does not read these.
//
// Design rules:
//   - Same service id always maps to the same color (UUID-stable;
//     renaming the service preserves the color).
//   - Palette deliberately EXCLUDES the rose family. Hone reserves
//     red / rose for allergies, EpiPen, and clinical-caution banners
//     across the app. Mixing those colors into ordinary appointment
//     cards would dilute that signal.
//   - 6 soft pastels keeps the calendar legible on mobile without
//     reading as warning/error.
//   - Card body uses the same pastel-bg + dark-text pattern the
//     existing softCardClasses() in DayColumn used so legibility
//     (esp. dark mode) stays consistent with the prior look.

const SERVICE_PALETTE: ReadonlyArray<string> = [
  // amber
  "bg-amber-50 text-amber-900 border-l-amber-400 dark:bg-amber-950/40 dark:text-amber-100 dark:border-l-amber-500",
  // emerald
  "bg-emerald-50 text-emerald-900 border-l-emerald-400 dark:bg-emerald-950/40 dark:text-emerald-100 dark:border-l-emerald-500",
  // teal
  "bg-teal-50 text-teal-900 border-l-teal-400 dark:bg-teal-950/40 dark:text-teal-100 dark:border-l-teal-500",
  // sky
  "bg-sky-50 text-sky-900 border-l-sky-400 dark:bg-sky-950/40 dark:text-sky-100 dark:border-l-sky-500",
  // indigo
  "bg-indigo-50 text-indigo-900 border-l-indigo-400 dark:bg-indigo-950/40 dark:text-indigo-100 dark:border-l-indigo-500",
  // violet
  "bg-violet-50 text-violet-900 border-l-violet-400 dark:bg-violet-950/40 dark:text-violet-100 dark:border-l-violet-500",
];

// Neutral fallback for an appointment whose service row has been
// deleted or whose id we can't resolve. Same neutral the prior code
// used as its default, so the visual fallback is unchanged.
const NEUTRAL_FALLBACK =
  "bg-neutral-100 text-neutral-800 border-l-neutral-400 dark:bg-neutral-800/60 dark:text-neutral-100 dark:border-l-neutral-500";

function hashStringToIndex(input: string, modulo: number): number {
  // djb2 hash. Deterministic, stable across processes, no allocations.
  let h = 5381;
  for (let i = 0; i < input.length; i++) {
    h = (h * 33) ^ input.charCodeAt(i);
  }
  // Force unsigned + bounded to palette length.
  return Math.abs(h) % modulo;
}

// Pick a card-classes string for an appointment based on its
// service identity. Prefers service.id (UUID; stable across renames)
// and falls back to service.name. When neither is available, returns
// the neutral fallback.
export function serviceCardClasses(
  serviceId: string | null | undefined,
  serviceName: string | null | undefined,
): string {
  const key = (serviceId ?? serviceName ?? "").trim();
  if (key.length === 0) return NEUTRAL_FALLBACK;
  const idx = hashStringToIndex(key, SERVICE_PALETTE.length);
  return SERVICE_PALETTE[idx] ?? NEUTRAL_FALLBACK;
}
