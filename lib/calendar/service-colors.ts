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

// TEN colour keys, chosen for SEPARABILITY on a phone (Chloe: "teal/emerald and
// sky/indigo/violet are difficult to tell apart"; "I want more colour choices").
//
// Two rules make them separable, not just different:
//   1. HUE SPACING. The set walks the wheel and deliberately SKIPS the crowded
//      blue band (no `blue`, no `cyan`), adding a hue between sky and indigo
//      would make the exact reported problem worse.
//   2. LIGHTNESS ALTERNATION. Where two families are hue-adjacent, one is a
//      LIGHT tone (-100 bg / -500 accent) and the other a DEEP tone
//      (-200 bg / -600 accent), so they differ on a second axis too:
//        amber (light)  vs orange (deep)
//        teal  (light)  vs emerald (deep)
//        sky   (light)  vs indigo  (deep)
//        violet(light)  vs fuchsia (deep)
//
// RESERVED, PERMANENTLY: red and rose. Hone uses them for allergies, EpiPen and
// clinical cautions across the app; a service card must never compete with that
// signal. `pink` is excluded too: at a glance on a phone it reads as rose.
//
// Colour is never the only identifier: every surface that tints by service also
// prints the service NAME (calendar cards, settings rows, booking list).
const SERVICE_PALETTE: ReadonlyArray<string> = [
  // amber: light warm
  "bg-amber-100 text-amber-900 border-l-amber-500 dark:bg-amber-950/50 dark:text-amber-100 dark:border-l-amber-500",
  // emerald: DEEP green (separates from teal by lightness as well as hue)
  "bg-emerald-200 text-emerald-900 border-l-emerald-600 dark:bg-emerald-950/60 dark:text-emerald-100 dark:border-l-emerald-400",
  // teal: light blue-green
  "bg-teal-100 text-teal-900 border-l-teal-500 dark:bg-teal-950/50 dark:text-teal-100 dark:border-l-teal-500",
  // sky: light blue
  "bg-sky-100 text-sky-900 border-l-sky-500 dark:bg-sky-950/50 dark:text-sky-100 dark:border-l-sky-500",
  // indigo: DEEP blue-violet (separates from sky and violet by lightness)
  "bg-indigo-200 text-indigo-900 border-l-indigo-600 dark:bg-indigo-950/60 dark:text-indigo-100 dark:border-l-indigo-400",
  // violet: light purple
  "bg-violet-100 text-violet-900 border-l-violet-500 dark:bg-violet-950/50 dark:text-violet-100 dark:border-l-violet-500",
  // orange: DEEP warm (0161)
  "bg-orange-200 text-orange-900 border-l-orange-600 dark:bg-orange-950/60 dark:text-orange-100 dark:border-l-orange-400",
  // lime: yellow-green (0161)
  "bg-lime-100 text-lime-900 border-l-lime-600 dark:bg-lime-950/50 dark:text-lime-100 dark:border-l-lime-400",
  // fuchsia: DEEP magenta (0161); a distinct hue from violet, never red
  "bg-fuchsia-200 text-fuchsia-900 border-l-fuchsia-600 dark:bg-fuchsia-950/60 dark:text-fuchsia-100 dark:border-l-fuchsia-400",
  // slate: neutral (0161); for admin/consultation services
  "bg-slate-200 text-slate-900 border-l-slate-600 dark:bg-slate-800/70 dark:text-slate-100 dark:border-l-slate-400",
];

// Neutral fallback for an appointment whose service row has been
// deleted or whose id we can't resolve. Same neutral the prior code
// used as its default, so the visual fallback is unchanged.
const NEUTRAL_FALLBACK =
  "bg-neutral-100 text-neutral-800 border-l-neutral-400 dark:bg-neutral-800/60 dark:text-neutral-100 dark:border-l-neutral-500";

// The TEN allowed service color keys: must match the migration-0161 DB CHECK
// constraint EXACTLY (which is 0153's six, widened by four; every previously
// persisted key is preserved). Rose/red/pink are intentionally absent (reserved
// for allergy / clinical warnings). This is the trusted allowlist for
// server-side validation too. ORDER IS LOAD-BEARING: it indexes SERVICE_PALETTE.
export const SERVICE_COLOR_KEYS = [
  // 0153 originals: order unchanged so no stored key changes meaning.
  "amber",
  "emerald",
  "teal",
  "sky",
  "indigo",
  "violet",
  // 0161 additions.
  "orange",
  "lime",
  "fuchsia",
  "slate",
] as const;
export type ServiceColorKey = (typeof SERVICE_COLOR_KEYS)[number];

// The keys that existed before migration 0161. A service saved with one of
// these must keep rendering identically in meaning (its key is untouched); the
// TONE of emerald/indigo was deepened deliberately so they separate from teal
// and sky, which is the readability fix Chloe asked for.
export const SERVICE_COLOR_KEYS_0153 = [
  "amber",
  "emerald",
  "teal",
  "sky",
  "indigo",
  "violet",
] as const;

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
// (undefined/null, the pre-0153 embed) does it TEMPORARILY fall back to the
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

// The legacy id-hash fallback is bounded to the ORIGINAL six palette entries,
// NOT to the widened list. Widening the palette must not silently repaint
// pre-0153 embeds that never had a persisted key.
const LEGACY_HASH_PALETTE_LENGTH = SERVICE_COLOR_KEYS_0153.length;

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
  const idx = hashStringToIndex(key, LEGACY_HASH_PALETTE_LENGTH);
  return SERVICE_PALETTE[idx] ?? NEUTRAL_FALLBACK;
}
