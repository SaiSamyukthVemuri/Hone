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

// Stronger-but-calm fills (calendar card refresh). Bumped from the prior
// ultra-pale `-50` bg + `-400` accent to a `-100` bg + a saturated `-500`
// left accent so appointment blocks read as clear, scannable blocks (Fresha
// used only as a readability benchmark, never copied) while staying clinical,
// not salon-bright. The rose/red family is STILL excluded — Hone reserves it
// for allergy / EpiPen / clinical-caution banners.
const SERVICE_PALETTE: ReadonlyArray<string> = [
  // amber
  "bg-amber-100 text-amber-900 border-l-amber-500 dark:bg-amber-950/50 dark:text-amber-100 dark:border-l-amber-500",
  // emerald
  "bg-emerald-100 text-emerald-900 border-l-emerald-500 dark:bg-emerald-950/50 dark:text-emerald-100 dark:border-l-emerald-500",
  // teal
  "bg-teal-100 text-teal-900 border-l-teal-500 dark:bg-teal-950/50 dark:text-teal-100 dark:border-l-teal-500",
  // sky
  "bg-sky-100 text-sky-900 border-l-sky-500 dark:bg-sky-950/50 dark:text-sky-100 dark:border-l-sky-500",
  // indigo
  "bg-indigo-100 text-indigo-900 border-l-indigo-500 dark:bg-indigo-950/50 dark:text-indigo-100 dark:border-l-indigo-500",
  // violet
  "bg-violet-100 text-violet-900 border-l-violet-500 dark:bg-violet-950/50 dark:text-violet-100 dark:border-l-violet-500",
];

// Neutral fallback for an appointment whose service row has been
// deleted or whose id we can't resolve. Same neutral the prior code
// used as its default, so the visual fallback is unchanged.
const NEUTRAL_FALLBACK =
  "bg-neutral-100 text-neutral-800 border-l-neutral-400 dark:bg-neutral-800/60 dark:text-neutral-100 dark:border-l-neutral-500";

// The SIX allowed service color keys — must match the 0153 DB CHECK constraint
// exactly. Rose/red is intentionally absent (reserved for allergy / clinical
// warnings). This is the trusted allowlist for server-side validation too.
export const SERVICE_COLOR_KEYS = [
  "amber",
  "emerald",
  "teal",
  "sky",
  "indigo",
  "violet",
] as const;
export type ServiceColorKey = (typeof SERVICE_COLOR_KEYS)[number];

// Canonical mapping: a persisted color KEY -> its trusted Tailwind class bundle.
// This is the ONLY place a service color turns into CSS. Derived from the palette
// above by name, so the two never drift. Never accepts arbitrary class strings.
const SERVICE_COLOR_CLASSES: Record<ServiceColorKey, string> = Object.fromEntries(
  SERVICE_COLOR_KEYS.map((key, i) => [key, SERVICE_PALETTE[i]]),
) as Record<ServiceColorKey, string>;

export function isServiceColorKey(value: unknown): value is ServiceColorKey {
  return (
    typeof value === "string" &&
    (SERVICE_COLOR_KEYS as readonly string[]).includes(value)
  );
}

// The NORMAL authority: render an appointment card from its service's PERSISTED
// calendar_color. A valid key -> its bundle; a missing / deleted service or
// invalid legacy value -> the neutral fallback (never the hash, never rose).
export function serviceColorClasses(
  colorKey: string | null | undefined,
): string {
  return isServiceColorKey(colorKey)
    ? SERVICE_COLOR_CLASSES[colorKey]
    : NEUTRAL_FALLBACK;
}

// The single entry point the calendar views use. Persisted calendar_color is the
// authority: present + valid -> its bundle; present + invalid (legacy) -> neutral;
// a missing / deleted service -> neutral. ONLY when calendar_color is absent
// (undefined/null — the pre-0153 embed) does it TEMPORARILY fall back to the
// legacy id hash so cards keep their look during the migration window; that path
// disappears the moment the persisted value is available.
export function appointmentCardClasses(
  service:
    | { id?: string | null; name?: string | null; calendar_color?: string | null }
    | null
    | undefined,
): string {
  if (!service) return NEUTRAL_FALLBACK;
  if (service.calendar_color === undefined || service.calendar_color === null) {
    return serviceCardClasses(service.id ?? null, service.name ?? null);
  }
  return serviceColorClasses(service.calendar_color);
}

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
