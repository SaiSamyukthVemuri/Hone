// PR #190 (clinical memory). Structured client-response vocabulary
// for session blocks. Kept in sync with the
// session_blocks_reaction_type_check constraint in migration 0082.

export const REACTION_TYPES = [
  "none",
  "mild_redness",
  "moderate_redness",
  "swelling",
  "sensitivity",
  "irritation",
  "other",
] as const;

export type ReactionType = (typeof REACTION_TYPES)[number];

export function isReactionType(value: unknown): value is ReactionType {
  return (
    typeof value === "string" &&
    (REACTION_TYPES as readonly string[]).includes(value)
  );
}

const REACTION_LABELS: Record<ReactionType, string> = {
  none: "No visible reaction",
  mild_redness: "Mild redness",
  moderate_redness: "Moderate redness",
  swelling: "Swelling",
  sensitivity: "Sensitivity",
  irritation: "Irritation",
  other: "Other",
};

export function reactionTypeLabel(value: ReactionType): string {
  return REACTION_LABELS[value];
}

export const TOLERANCE_MIN = 1;
export const TOLERANCE_MAX = 5;

export function isToleranceRating(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isInteger(value) &&
    value >= TOLERANCE_MIN &&
    value <= TOLERANCE_MAX
  );
}

// Short practitioner-facing label for a 1-5 rating. Used beside the
// numeric scale so the scale direction is never ambiguous.
export function toleranceLabel(rating: number): string {
  if (rating <= 1) return "Struggled";
  if (rating === 2) return "Difficult";
  if (rating === 3) return "Okay";
  if (rating === 4) return "Comfortable";
  return "Very comfortable";
}
