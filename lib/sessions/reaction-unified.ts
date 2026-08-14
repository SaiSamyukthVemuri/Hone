// UNIFIED reaction derivation (Chloe charting unification), the ONE canonical
// contract every reaction-driven surface reads, so old (session_blocks.
// reaction_type) and new (reaction chips in electrolysis_entries.observation_
// chips) records behave identically.
//
// Reactions are classified ONLY by the explicit merged reaction-chip definitions
// (isReactionChipLabel over REACTION_CHIP_LABELS), never by string-guessing an
// ordinary observation chip. Severity for attention prioritization uses the
// EXISTING explicit reaction enum ordering (REACTION_TYPES), never inferred from
// wording. Pure + client-safe (no I/O).

import { normalizeChips } from "@/lib/observation-chips";
import {
  REACTION_TYPES,
  isClinicalResponseLabel,
  isReactionType,
  reactionTypeForLabel,
  reactionTypeLabel,
  safetyResponseSeverityPeer,
  NOTABLE_REACTION_LABELS,
  type ReactionType,
} from "@/lib/sessions/clinical-response";

// Explicit severity rank from the reaction enum order (higher = more severe).
// "other" is treated as least-notable (not in the attention set).
//
// A SAFETY-RESPONSE label (Redness (erythema) / Slight swelling (edema) /
// Sensitive skin) has no enum member of its own, so it ranks through the coded
// PEER declared in clinical-response.ts. That keeps ONE severity vocabulary and
// ONE ordering: this function never invents a rank.
function severityRank(label: string): number {
  const t = reactionTypeForLabel(label) ?? safetyResponseSeverityPeer(label);
  if (!t || t === "other") return -1;
  return REACTION_TYPES.indexOf(t);
}

// The CLINICAL RESPONSE chip labels present in a stored observation_chips value
// coded reaction labels AND the safety-relevant response labels. Ordinary
// observation chips (Coarse hair, Lots of anagen, …) are ignored. Canonical
// casing, order-preserved.
//
// Widened from reaction-only in Chloe Session 1A: the three safety-relevant
// labels live in the same merged box and describe a real skin response, so a
// classifier that ignored them left them invisible to every surface below.
export function reactionLabelsFromChips(observationChips: unknown): string[] {
  return normalizeChips(observationChips).filter((c) =>
    isClinicalResponseLabel(c),
  );
}

// ALL clinical-response labels for a block under the unified model: the union
// of the legacy reaction_type's label and every response chip across the block's
// live entries, deduped case-insensitively (reaction_type first, then chip
// order). Retains every real response (never collapsed to one).
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

// The single EFFECTIVE response label (legacy single-reaction shape).
//
// A REAL response always wins over "No visible reaction". Historical rows can be
// internally contradictory: `reaction_type = 'none'` on the block while an
// entry chip records "Redness (erythema)", because the two were captured by
// different UIs at different times, and `unifiedReactionLabels` deliberately
// lists reaction_type FIRST to preserve provenance order. Taking element [0]
// blindly would let a stale "none" mask a real recorded response on any surface
// that renders a single label.
//
// The forward path can no longer create that contradiction (toggleFindingChip in
// lib/observation-chips.ts makes "No visible reaction" mutually exclusive with
// every real response chip), so this rule exists purely for historical data,
// which is exactly where it matters, because nothing is being backfilled.
export function effectiveReactionLabel(
  reactionType: string | null | undefined,
  observationChipsList: ReadonlyArray<unknown>,
): string | null {
  const labels = unifiedReactionLabels(reactionType, observationChipsList);
  if (labels.length === 0) return null;
  const noneLabel = reactionTypeLabel("none").toLowerCase();
  const real = labels.find((l) => l.toLowerCase() !== noneLabel);
  return real ?? labels[0];
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
