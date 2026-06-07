// PR #165. Practitioner-facing formatter for a duration stored as a
// number of seconds. Used by the entry-row display for the
// thermolysis duration field after migration 0071 widened the
// underlying column to numeric.
//
// Behavior:
//   * null / undefined / non-finite -> null (the caller decides
//     whether to render anything).
//   * Rounded to 2 decimal places, trailing zeros trimmed. This
//     avoids the 0.150000000... float-formatting surprise and the
//     0.20-vs-0.2 inconsistency Chloe would otherwise see.
//   * Singular "second" only when the value rounds to exactly 1.
//     Everything else (0, 0.15, 1.5, 2, 2.5) uses "seconds".
//
// Examples:
//   formatSeconds(0.15) -> "0.15 seconds"
//   formatSeconds(0.2)  -> "0.2 seconds"
//   formatSeconds(1)    -> "1 second"
//   formatSeconds(1.5)  -> "1.5 seconds"
//   formatSeconds(2)    -> "2 seconds"
//   formatSeconds(0)    -> "0 seconds"
//   formatSeconds(null) -> null

export function formatSeconds(
  value: number | null | undefined,
): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  // Math.round + /100 trims float-precision noise like
  // 0.15 * 100 = 14.999999999999998 back to 0.15 cleanly.
  const rounded = Math.round(value * 100) / 100;
  const display = String(rounded);
  const unit = rounded === 1 ? "second" : "seconds";
  return `${display} ${unit}`;
}
