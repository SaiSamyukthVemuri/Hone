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

// Charting unification (Chloe): "Client / skin response" is merged into the ONE
// "Treatment observations & skin response" multi-select box. The reaction values
// become canonical observation chips (stored in observation_chips going forward),
// so these are their display labels in chip order, and the reverse map lets us
// read a legacy reaction_type back as its chip label + recognize a chip as a
// reaction. The DB reaction_type column + its data are preserved; new charting
// simply represents the reaction as a chip in observation_chips.
export const REACTION_CHIP_LABELS: ReadonlyArray<string> = REACTION_TYPES.map(
  (t) => REACTION_LABELS[t],
);

const LABEL_TO_REACTION = new Map<string, ReactionType>(
  REACTION_TYPES.map((t) => [REACTION_LABELS[t].toLowerCase(), t]),
);

// True iff a chip label is one of the merged reaction labels.
export function isReactionChipLabel(label: string): boolean {
  return LABEL_TO_REACTION.has(label.trim().toLowerCase());
}

// Map a reaction chip label back to its enum value (for legacy interop), or null.
export function reactionTypeForLabel(label: string): ReactionType | null {
  return LABEL_TO_REACTION.get(label.trim().toLowerCase()) ?? null;
}

// ---------------------------------------------------------------------------
// SAFETY-RELEVANT RESPONSE LABELS (Chloe Session 1A)
// ---------------------------------------------------------------------------
//
// THE DEFECT THIS CLOSES. Charting unification merged "Treatment observations"
// and "Client / skin response" into ONE box, and everything now lands in
// electrolysis_entries.observation_chips. But the CLASSIFIER
// (isReactionChipLabel, below) still recognises only the seven coded
// REACTION_TYPES labels. Three chips in that same box describe a real skin
// response and were silently classified as ordinary observations:
//
//     Redness (erythema)   ·   Slight swelling (edema)   ·   Sensitive skin
//
// They therefore never reached "Clients needing attention", the prior-visit
// response line, treatment intelligence, or the onboarding completeness check.
// Measured in production at the time of writing: 12 live entries carry one of
// the three, and 10 of those carry NO coded reaction chip at all — so for a
// large share of chip-bearing clinical records the recorded skin response
// reached the chart and no safety surface. The practitioner had no way to know:
// the three render as visually identical pills beside the coded ones.
//
// WHY A SECOND SET RATHER THAN NEW ENUM VALUES. `session_blocks.reaction_type`
// is constrained by session_blocks_reaction_type_check (migration 0082). Adding
// enum members would need a migration and would imply these three are storable
// in that legacy column — they are not, and never will be: new charting stores
// findings as chips. This layer is a pure classification of chip LABELS, needs
// no schema change, and rewrites no row.
//
// EXACT-TOKEN, NEVER SUBSTRING. Membership is by canonical label identity, the
// same discipline lib/observation-chips.ts uses for its alias map. The laser
// list's clinically distinct "Follicular erythema" / "Follicular edema" are NOT
// members and must never be folded in by a `includes("erythema")`-style test.
// Legacy spellings ("Erythema", "Slight edema", …) already resolve to these
// canonical labels through OBSERVATION_CHIP_ALIASES before classification runs,
// so they are covered without a second alias table.
export const SAFETY_RESPONSE_LABELS: ReadonlyArray<string> = [
  "Redness (erythema)",
  "Slight swelling (edema)",
  "Sensitive skin",
];

const SAFETY_RESPONSE_SET = new Set(
  SAFETY_RESPONSE_LABELS.map((l) => l.toLowerCase()),
);

// True iff a chip label is one of the safety-relevant response labels above.
// Exact canonical-label match, casing/whitespace-insensitive. Never substring.
export function isSafetyResponseLabel(label: string): boolean {
  return SAFETY_RESPONSE_SET.has(label.trim().toLowerCase());
}

// True iff a chip label carries CLINICAL RESPONSE meaning at all — either a
// coded reaction label or one of the safety-relevant response labels. This is
// the single predicate every response-driven surface should ask.
export function isClinicalResponseLabel(label: string): boolean {
  return isReactionChipLabel(label) || isSafetyResponseLabel(label);
}

// SEVERITY, expressed in the EXISTING vocabulary and ordering.
//
// The severity model already in use is `REACTION_TYPES.indexOf(...)` — the enum
// declaration order, low to high:
//     none(0) · mild_redness(1) · moderate_redness(2) · swelling(3) ·
//     sensitivity(4) · irritation(5)          ("other" is ranked -1, not notable)
//
// Each of the three is mapped to the EXISTING coded peer that describes the
// same clinical finding at the same intensity. No new severity vocabulary, no
// new ordering, and deliberately no medical advice or diagnosis:
//
//   Redness (erythema)      -> mild_redness (rank 1)
//       Plain redness with no qualifier. The coded vocabulary already
//       distinguishes mild from moderate redness; an unqualified chip must take
//       the LOWER of the two, because promoting it to moderate would assert an
//       intensity the practitioner did not record. Consequence: it is a
//       response (it reaches the prior-visit line, treatment intelligence and
//       the onboarding check) but it is NOT "notable", so it does not raise a
//       dashboard alert — matching how the coded "Mild redness" chip already
//       behaves. This is the conservative reading and it is deliberate.
//
//   Slight swelling (edema) -> swelling (rank 3)
//       Swelling is swelling. The coded vocabulary has exactly one swelling
//       member and it IS notable, so this chip raises attention. "Slight" is a
//       qualifier the coded set cannot express; down-ranking on the strength of
//       an adjective would suppress a real oedema signal, which is the wrong
//       direction to err for a tissue response.
//
//   Sensitive skin          -> sensitivity (rank 4)
//       Direct one-to-one with the coded `sensitivity` member, which is
//       notable. Surfacing it is a factual restatement of what the practitioner
//       recorded; nothing here advises on treatment.
//
// Net effect on the dashboard: swelling and sensitivity become notable (they
// describe tissue response and were being dropped); plain redness stays
// non-notable but becomes VISIBLE on the response surfaces it was missing from.
const SAFETY_RESPONSE_SEVERITY_PEER: Readonly<Record<string, ReactionType>> = {
  "redness (erythema)": "mild_redness",
  "slight swelling (edema)": "swelling",
  "sensitive skin": "sensitivity",
};

// The coded reaction whose severity a safety-response label inherits, or null
// when the label is not a safety-response label.
export function safetyResponseSeverityPeer(label: string): ReactionType | null {
  return SAFETY_RESPONSE_SEVERITY_PEER[label.trim().toLowerCase()] ?? null;
}

// The clinically NOTABLE responses, as chip LABELS — the set that drives
// "Clients needing attention".
//
// Coded members: "none"/"mild_redness"/"other" are intentionally not notable.
// Safety-response members are included when their severity PEER is notable, so
// the two halves cannot drift: "Slight swelling (edema)" and "Sensitive skin"
// qualify (peers `swelling`/`sensitivity`), "Redness (erythema)" does not (peer
// `mild_redness`), exactly as the mapping above documents.
// The coded reaction ENUM members that are notable. Exported so no consumer has
// to re-declare it: lib/dashboard/clients-needing-attention.ts used to carry its
// own hard-coded copy, which is exactly how the notable set and the response set
// would drift apart again.
export const NOTABLE_CODED_REACTION_TYPES: ReadonlyArray<ReactionType> = [
  "moderate_redness",
  "swelling",
  "sensitivity",
  "irritation",
];

const NOTABLE_CODED_TYPES = NOTABLE_CODED_REACTION_TYPES;

const NOTABLE_CODED_SET = new Set<ReactionType>(NOTABLE_CODED_TYPES);

export const NOTABLE_REACTION_LABELS: ReadonlyArray<string> = [
  ...NOTABLE_CODED_TYPES.map((t) => REACTION_LABELS[t]),
  ...SAFETY_RESPONSE_LABELS.filter((l) => {
    const peer = safetyResponseSeverityPeer(l);
    return peer !== null && NOTABLE_CODED_SET.has(peer);
  }),
];

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

// 0156: pure normalization for the optional numbing note (server contract).
// The note is preserved ONLY when numbing was actually used; it is trimmed and a
// blank/whitespace-only value becomes NULL. Any non-'used' status (including
// 'none', not-recorded/NULL, or an invalid value) yields NULL — a note is never
// stored without "used", never fabricated, and never used to infer the status.
export function normalizeNumbingNotes(
  status: unknown,
  notes: string | null | undefined,
): string | null {
  if (status !== "used") return null;
  return (notes ?? "").trim() || null;
}

// 0156: single shared presenter for the numbing line on every read surface
// (treatment-area card, and any future session/last-visit/print surface) so the
// status label + optional note can never drift between them. Returns null when
// there is nothing to show (status not recorded). The note is shown ONLY when
// the status is 'used' AND a non-empty note exists — never for 'none' or a
// legacy/not-recorded row, and a note is never displayed without "used".
export function numbingDisplay(
  status: unknown,
  notes: string | null | undefined,
): { label: string; note: string | null } | null {
  if (!isNumbingStatus(status)) return null;
  const trimmed = (notes ?? "").trim();
  return {
    label: numbingStatusLabel(status),
    note: status === "used" && trimmed !== "" ? trimmed : null,
  };
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
