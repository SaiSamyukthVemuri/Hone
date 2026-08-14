// PR #165. Practitioner-facing formatter for a duration stored as a
// number of seconds. Used by the entry-row display for the
// thermolysis duration field after migration 0071 widened the
// underlying column to numeric.
//
// Behavior:
//   * null / undefined / non-finite -> null (the caller decides
//     whether to render anything).
//   * Preserved to 3 decimal places (the clinically supported
//     thermolysis precision: e.g. PicoBlend 0.733s), trailing zeros
//     trimmed. Rounding at the 3rd decimal both avoids the
//     0.150000000... float-formatting surprise and the 0.20-vs-0.2
//     inconsistency AND shows the exact stored value the practitioner
//     entered, never a lossily rounded 0.73 for a stored 0.733.
//   * Singular "second" only when the value rounds to exactly 1.
//     Everything else (0, 0.15, 1.5, 2, 2.5) uses "seconds".
//
// Examples:
//   formatSeconds(0.733) -> "0.733 seconds"
//   formatSeconds(0.15)  -> "0.15 seconds"
//   formatSeconds(0.2)   -> "0.2 seconds"
//   formatSeconds(1)     -> "1 second"
//   formatSeconds(1.5)   -> "1.5 seconds"
//   formatSeconds(2)     -> "2 seconds"
//   formatSeconds(0)     -> "0 seconds"
//   formatSeconds(null)  -> null

export function formatSeconds(
  value: number | null | undefined,
): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  // Math.round + /1000 trims float-precision noise like
  // 0.733 * 1000 = 733.0000000000001 back to 0.733 cleanly, while
  // preserving the exact clinically supported 3-decimal value (so a
  // stored 0.733 is never displayed as a lossy 0.73). String() then
  // drops any trailing zeros (0.730 -> "0.73", 0.700 -> "0.7").
  const rounded = Math.round(value * 1000) / 1000;
  const display = String(rounded);
  const unit = rounded === 1 ? "second" : "seconds";
  return `${display} ${unit}`;
}
