// Appends a chip-style preset to a comma-separated comment string,
// avoiding back-to-back duplicates so accidental double-taps are absorbed.
export function appendComment(existing: string, chip: string): string {
  if (!existing.trim()) return chip;
  const lastToken = existing.split(/,\s*/).pop()?.trim().toLowerCase();
  if (lastToken === chip.toLowerCase()) return existing;
  return `${existing.replace(/\s*,?\s*$/, "")}, ${chip}`;
}

// PR #279 (Chloe charting feedback): observation chips are now TOGGLES. Splits
// the comment string into comma-separated tokens, preserving manually typed text
// (a token that is not a chip is left untouched). Comparison is case-insensitive
// and trims surrounding whitespace.
function splitTokens(existing: string): string[] {
  return existing
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

// True when the chip is already present as a token in the comment string.
export function isCommentSelected(existing: string, chip: string): boolean {
  const target = chip.trim().toLowerCase();
  return splitTokens(existing).some((t) => t.toLowerCase() === target);
}

// Toggles a chip token in/out of the comma-separated comment string. Tapping an
// unselected chip appends it; tapping a selected chip removes it. Manually typed
// tokens are never dropped. Returns the rejoined string.
export function toggleComment(existing: string, chip: string): string {
  const target = chip.trim().toLowerCase();
  const tokens = splitTokens(existing);
  const next = tokens.some((t) => t.toLowerCase() === target)
    ? tokens.filter((t) => t.toLowerCase() !== target)
    : [...tokens, chip.trim()];
  return next.join(", ");
}
