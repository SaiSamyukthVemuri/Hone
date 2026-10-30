// HON-48 — a studio's breaks, lunch and working-time blocks all drew as the same
// tan striped card, told apart only by the wording of their label. The calendar
// needs them understandable at a glance AND without relying on colour, so each
// stored purpose gets a text glyph (read by a screen reader as nothing, shown to
// everyone else) and a left-edge accent, in three groups:
//   rest  — lunch, break (and a recurring break with any other label)
//   work  — admin, meeting, training: the practitioner is busy, not away
//   away  — personal, emergency, other, and anything unrecognised
// Existing categories only. A separate cleaning/charting purpose would be a new
// stored category, which is a schema decision this file does not make.

export const BLOCK_PURPOSE_GROUPS = ["rest", "work", "away"] as const;
export type BlockPurposeGroup = (typeof BLOCK_PURPOSE_GROUPS)[number];

export type BlockPurpose = { group: BlockPurposeGroup; glyph: string; accent: string };

const REST: BlockPurpose = { group: "rest", glyph: "☕", accent: "#6B8F71" };
const WORK: BlockPurpose = { group: "work", glyph: "✎", accent: "#5B7FA6" };
const AWAY: BlockPurpose = { group: "away", glyph: "⊘", accent: "#8C8579" };

const BY_NAME: Record<string, BlockPurpose> = {
  lunch: REST,
  break: REST,
  admin: WORK,
  meeting: WORK,
  training: WORK,
  personal: AWAY,
  emergency: AWAY,
  other: AWAY,
};

/**
 * `name` is a stored timed-block category, or a recurring break's free-text
 * label. A recurring break with an unrecognised label is a break (rest): that is
 * what the rule is.
 */
export function blockPurpose(name: string | null | undefined, opts: { recurring?: boolean } = {}): BlockPurpose {
  const key = (name ?? "").trim().toLowerCase();
  const known = BY_NAME[key];
  if (known) return key === "other" && opts.recurring ? REST : known;
  return opts.recurring ? REST : AWAY;
}
