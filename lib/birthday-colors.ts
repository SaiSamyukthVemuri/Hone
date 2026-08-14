import type { BirthdayReminderColor } from "@/lib/types/database";

// Birthday reminder accent palette (migration 0040).
//
// Five safe presets only. This is an accent preference, not a theming
// system, and deliberately excludes red/rose (reserved for allergies /
// cautions per the dashboard color convention). Class strings are written
// out in full literal form so Tailwind's content scanner keeps them; never
// build a color class by string-concatenating the preset name.
//
// resolveBirthdayColor() is total: any unknown / null / legacy value falls
// back to purple (the studios column default), so callers never need to
// branch on a missing setting.

export const BIRTHDAY_REMINDER_COLORS: ReadonlyArray<{
  value: BirthdayReminderColor;
  label: string;
}> = [
  { value: "purple", label: "Purple" },
  { value: "orange", label: "Orange" },
  { value: "blue", label: "Blue" },
  { value: "green", label: "Green" },
  { value: "neutral", label: "Neutral" },
];

export type BirthdayColorClasses = {
  // Card / callout container.
  card: string;
  // Muted secondary text (e.g. the "March 14" date).
  mutedText: string;
  // Emphasis text used on tinted callouts (client profile).
  strongText: string;
  // "Today" badge.
  badge: string;
  // Small filled swatch for the settings picker.
  swatch: string;
};

const PURPLE: BirthdayColorClasses = {
  card: "border-purple-200 bg-purple-50 dark:border-purple-900/60 dark:bg-purple-950/20",
  mutedText: "text-purple-700/80 dark:text-purple-300/80",
  strongText: "text-purple-900 dark:text-purple-100",
  badge: "bg-purple-600 text-white dark:bg-purple-500",
  swatch: "bg-purple-500",
};

const ORANGE: BirthdayColorClasses = {
  card: "border-orange-200 bg-orange-50 dark:border-orange-900/60 dark:bg-orange-950/20",
  mutedText: "text-orange-700/80 dark:text-orange-300/80",
  strongText: "text-orange-900 dark:text-orange-100",
  badge: "bg-orange-600 text-white dark:bg-orange-500",
  swatch: "bg-orange-500",
};

const BLUE: BirthdayColorClasses = {
  card: "border-sky-200 bg-sky-50 dark:border-sky-900/60 dark:bg-sky-950/20",
  mutedText: "text-sky-700/80 dark:text-sky-300/80",
  strongText: "text-sky-900 dark:text-sky-100",
  badge: "bg-sky-600 text-white dark:bg-sky-500",
  swatch: "bg-sky-500",
};

const GREEN: BirthdayColorClasses = {
  card: "border-emerald-200 bg-emerald-50 dark:border-emerald-900/60 dark:bg-emerald-950/20",
  mutedText: "text-emerald-700/80 dark:text-emerald-300/80",
  strongText: "text-emerald-900 dark:text-emerald-100",
  badge: "bg-emerald-600 text-white dark:bg-emerald-500",
  swatch: "bg-emerald-500",
};

const NEUTRAL: BirthdayColorClasses = {
  card: "border-neutral-200 bg-neutral-50 dark:border-neutral-800 dark:bg-neutral-900/50",
  mutedText: "text-neutral-600 dark:text-neutral-400",
  strongText: "text-neutral-800 dark:text-neutral-200",
  badge: "bg-neutral-600 text-white dark:bg-neutral-500",
  swatch: "bg-neutral-400",
};

const BY_COLOR: Record<BirthdayReminderColor, BirthdayColorClasses> = {
  purple: PURPLE,
  orange: ORANGE,
  blue: BLUE,
  green: GREEN,
  neutral: NEUTRAL,
};

function isBirthdayReminderColor(
  value: string | null | undefined,
): value is BirthdayReminderColor {
  return (
    value === "purple" ||
    value === "orange" ||
    value === "blue" ||
    value === "green" ||
    value === "neutral"
  );
}

// Total resolver: falls back to purple for any unknown/missing value.
export function resolveBirthdayColor(
  value: string | null | undefined,
): BirthdayColorClasses {
  if (isBirthdayReminderColor(value)) return BY_COLOR[value];
  return PURPLE;
}
