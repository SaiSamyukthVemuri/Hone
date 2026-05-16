// Appends a chip-style preset to a comma-separated comment string,
// avoiding back-to-back duplicates so accidental double-taps are absorbed.
export function appendComment(existing: string, chip: string): string {
  if (!existing.trim()) return chip;
  const lastToken = existing.split(/,\s*/).pop()?.trim().toLowerCase();
  if (lastToken === chip.toLowerCase()) return existing;
  return `${existing.replace(/\s*,?\s*$/, "")}, ${chip}`;
}
