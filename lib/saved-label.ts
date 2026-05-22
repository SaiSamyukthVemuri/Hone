// Returns the label shown after a successful chart-entry save. 80% of the
// time the practitioner sees "Saved.". The other 20% surfaces a quieter
// brand line. Rare-by-design: the variant should feel like a small
// punctuation, not a default.
export function pickSavedLabel(): string {
  return Math.random() < 0.2 ? "Practice memory updated." : "Saved.";
}
