// UNIFIED reaction derivation (Chloe charting unification) — the ONE canonical
// contract every reaction-driven surface reads, so old (session_blocks.
// reaction_type) and new (reaction chips in electrolysis_entries.observation_
// chips) records behave identically.
//
// Reactions are classified ONLY by the explicit merged reaction-chip definitions
// (isReactionChipLabel over REACTION_CHIP_LABELS) — never by string-guessing an
// ordinary observation chip. Severity for attention prioritization uses the
// EXISTING explicit reaction enum ordering (REACTION_TYPES), never inferred from
// wording. Pure + client-safe (no I/O).

import { normalizeChips } from "@/lib/observation-chips";
import {
  REACTION_TYPES,
  isReactionChipLabel,
  isReactionType,
  reactionTypeForLabel,
  reactionTypeLabel,
  NOTABLE_REACTION_LABELS,
  type ReactionType,
} from "@/lib/sessions/clinical-response";

// Explicit severity rank from the reaction enum order (higher = more severe).
// "other" is treated as least-notable (not in the attention set).
function severityRank(label: string): number {
  const t = reactionTypeForLabel(label);
  if (!t || t === "other") return -1;
  return REACTION_TYPES.indexOf(t);
}

// The reaction chip LABELS present in a stored observation_chips value (ordinary
// observation chips are ignored). Canonical casing, order-preserved.
export function reactionLabelsFromChips(observationChips: unknown): string[] {
  return normalizeChips(observationChips).filter((c) => isReactionChipLabel(c));
}

// ALL reaction labels for a block under the unified model — the union of the
// legacy reaction_type's label and every reaction chip across the block's live
// entries, deduped case-insensitively (reaction_type first, then chip order).
// Retains every real reaction (never collapsed to one).
export function unifiedReactionLabels(
  reactionType: string | null | undefined,
  observationChipsList: ReadonlyArray<unknown>,
): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (label: string) => {
    const k = label.toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(label);
    }
  };
  if (reactionType && isReactionType(reactionType)) {
    add(reactionTypeLabel(reactionType as ReactionType));
  }
  for (const chips of observationChipsList) {
    for (const label of reactionLabelsFromChips(chips)) add(label);
  }
  return out;
}

// The single EFFECTIVE reaction label (legacy single-reaction shape): the
// reaction_type's label if set, else the first reaction chip. null when none.
export function effectiveReactionLabel(
  reactionType: string | null | undefined,
  observationChipsList: ReadonlyArray<unknown>,
): string | null {
  return unifiedReactionLabels(reactionType, observationChipsList)[0] ?? null;
}

// The NOTABLE reaction that drives "Clients needing attention": the
// highest-severity notable reaction present (by the explicit enum order), from
// EITHER reaction_type or the entries' reaction chips. "No visible reaction"
// (none) is never notable and never suppresses a real reaction. null when none.
export function notableReactionLabel(
  reactionType: string | null | undefined,
  observationChipsList: ReadonlyArray<unknown>,
): string | null {
  const notable = new Set(NOTABLE_REACTION_LABELS.map((l) => l.toLowerCase()));
  let best: string | null = null;
  let bestRank = -1;
  for (const label of unifiedReactionLabels(reactionType, observationChipsList)) {
    if (!notable.has(label.toLowerCase())) continue;
    const rank = severityRank(label);
    if (rank > bestRank) {
      bestRank = rank;
      best = label;
    }
  }
  return best;
}

// True iff the block records ANY reaction (including "No visible reaction"), for
// onboarding-style "a response was recorded" completeness checks.
export function hasAnyReaction(
  reactionType: string | null | undefined,
  observationChipsList: ReadonlyArray<unknown>,
): boolean {
  return unifiedReactionLabels(reactionType, observationChipsList).length > 0;
}
