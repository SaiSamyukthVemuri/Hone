// Curated palette for practitioner appointment pills on the calendar.
// Tokens persist in practitioners.color (text). Adding a new color later is
// a pure code change: append to the array, no migration needed.

export const PRACTITIONER_COLORS = [
  { token: "neutral", label: "Neutral", bg: "bg-neutral-900", text: "text-white" },
  { token: "rose", label: "Rose", bg: "bg-rose-700", text: "text-white" },
  { token: "amber", label: "Amber", bg: "bg-amber-700", text: "text-white" },
  { token: "emerald", label: "Emerald", bg: "bg-emerald-700", text: "text-white" },
  { token: "teal", label: "Teal", bg: "bg-teal-700", text: "text-white" },
  { token: "sky", label: "Sky", bg: "bg-sky-700", text: "text-white" },
  { token: "indigo", label: "Indigo", bg: "bg-indigo-700", text: "text-white" },
  { token: "violet", label: "Violet", bg: "bg-violet-700", text: "text-white" },
] as const;

export type PractitionerColor = (typeof PRACTITIONER_COLORS)[number]["token"];

export const PRACTITIONER_COLOR_TOKENS: ReadonlyArray<string> =
  PRACTITIONER_COLORS.map((c) => c.token);

export function isPractitionerColor(value: unknown): value is PractitionerColor {
  return typeof value === "string" && PRACTITIONER_COLOR_TOKENS.includes(value);
}

// Resolve a stored token (possibly stale or unknown) to a palette entry.
// Falls back to the first entry ("neutral") so the UI never breaks on a
// future palette removal or a corrupted value.
export function resolvePractitionerColor(
  token: string | null | undefined,
): (typeof PRACTITIONER_COLORS)[number] {
  const match = PRACTITIONER_COLORS.find((c) => c.token === token);
  return match ?? PRACTITIONER_COLORS[0];
}
