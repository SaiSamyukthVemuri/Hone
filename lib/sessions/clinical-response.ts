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

// PR #279 (Chloe charting feedback): the raw 1-5 scale was not intuitive. The
// CONTROL is now label-based, but the stored value stays the same 1-5 smallint
// (tolerance_rating) so all existing records map cleanly: 5 = most comfortable,
// 1 = least. Order here is best -> hardest, the order the buttons render.
// Labels are factual comfort descriptions, no medical judgment.
export const TOLERANCE_OPTIONS: ReadonlyArray<{ value: number; label: string }> = [
  { value: 5, label: "Comfortable" },
  { value: 4, label: "Mild discomfort" },
  { value: 3, label: "Moderate discomfort" },
  { value: 2, label: "High discomfort" },
  { value: 1, label: "Needed pause / stopped early" },
];

// Label for a stored 1-5 rating (used by the control + the saved-record
// history). Maps every legacy numeric value to a clear label.
export function toleranceLabel(rating: number): string {
  const opt = TOLERANCE_OPTIONS.find((o) => o.value === rating);
  if (opt) return opt.label;
  // Defensive: clamp out-of-range legacy values to the nearest end.
  return rating <= 1 ? "Needed pause / stopped early" : "Comfortable";
}

// PR #279: numbing vocabulary. Whether the client used numbing before the
// treatment — a factual record, not advice/dosing/product guidance. The stored
// value is NULL for "Not recorded" (every legacy row); 'none' / 'used'
// otherwise. Mirrors the session_blocks_numbing_status_check in migration 0095.
export const NUMBING_STATUSES = ["none", "used"] as const;

export type NumbingStatus = (typeof NUMBING_STATUSES)[number];

export function isNumbingStatus(value: unknown): value is NumbingStatus {
  return (
    typeof value === "string" &&
    (NUMBING_STATUSES as readonly string[]).includes(value)
  );
}

const NUMBING_LABELS: Record<NumbingStatus, string> = {
  none: "No numbing used",
  used: "Numbing used",
};

export function numbingStatusLabel(value: NumbingStatus): string {
  return NUMBING_LABELS[value];
}

// The three charting choices (NULL stored as the "Not recorded" default).
export const NUMBING_OPTIONS: ReadonlyArray<{
  value: NumbingStatus | "";
  label: string;
}> = [
  { value: "", label: "Not recorded" },
  { value: "none", label: "No numbing used" },
  { value: "used", label: "Numbing used" },
];
