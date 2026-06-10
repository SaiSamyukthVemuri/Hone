import type { SessionBlock } from "@/lib/types/database";
import { sessionBlockSideLabel } from "@/lib/sessions/side-labels";
import { apilusModalityLabel } from "@/lib/constants";
import {
  isReactionType,
  reactionTypeLabel,
  toleranceLabel,
} from "@/lib/sessions/clinical-response";

// PR #190 (clinical memory). Pure formatter that condenses the most
// recent session + its blocks into the compact lines shown at the
// point of care (appointment detail "Last session" card and the
// new-session "Previous session context" panel). Every line is null
// when its data is absent so old records render without empty labels;
// callers print only non-null lines. No I/O here: testable in
// isolation, shared by both surfaces.

export type ClinicalSummaryBlock = Pick<
  SessionBlock,
  | "sort_order"
  | "block_name"
  | "primary_area"
  | "side"
  | "custom_area_detail"
  | "mode"
  | "apilus_modality"
  | "energy_level"
  | "minutes_performed"
  | "probe_label"
  | "tolerance_rating"
  | "reaction_type"
  | "reaction_notes"
  | "caution_for_next_session"
  | "caution_note"
>;

export type LastSessionSummary = {
  // "Upper lip (Left side), Chin"
  areaLine: string | null;
  // "Thermolysis - Synchro - EL 14 - 30 min"
  settingsLine: string | null;
  // "Ballet Gold F3" (denormalized probe_label from 0041)
  probeLine: string | null;
  // "3/5 - Okay" (worst rating across blocks: the cautious summary)
  toleranceLine: string | null;
  // "Mild redness. Settled within an hour."
  reactionLine: string | null;
  // True when any block flagged caution; cautionLine may still be
  // null (flag without a note) and the caller shows generic copy.
  cautionFlagged: boolean;
  cautionLine: string | null;
  // sessions.next_session_note from the previous visit, trimmed.
  nextSessionNote: string | null;
};

const MODE_LABELS: Record<string, string> = {
  thermo: "Thermolysis",
  blend: "Blend",
  galv: "Galvanic",
};

function trimmedOrNull(value: string | null | undefined): string | null {
  const t = value?.trim();
  return t && t.length > 0 ? t : null;
}

function blockAreaLabel(block: ClinicalSummaryBlock): string | null {
  const area = trimmedOrNull(block.primary_area);
  if (!area) return trimmedOrNull(block.block_name);
  const side = block.side ? sessionBlockSideLabel(block.side) : null;
  return side ? `${area} (${side})` : area;
}

export function buildLastSessionSummary(input: {
  blocks: ClinicalSummaryBlock[];
  nextSessionNote: string | null;
}): LastSessionSummary {
  const blocks = [...input.blocks].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  // Areas: unique labels in block order.
  const areas: string[] = [];
  for (const b of blocks) {
    const label = blockAreaLabel(b);
    if (label && !areas.includes(label)) areas.push(label);
  }
  const areaLine = areas.length > 0 ? areas.join(", ") : null;

  // Settings: the first block that recorded any machine setting. One
  // block is the overwhelmingly common case; "first area's settings"
  // keeps the line short on multi-area sessions.
  let settingsLine: string | null = null;
  for (const b of blocks) {
    const parts: string[] = [];
    if (b.mode && MODE_LABELS[b.mode]) parts.push(MODE_LABELS[b.mode]);
    if (b.apilus_modality) parts.push(apilusModalityLabel(b.apilus_modality));
    if (b.energy_level !== null && b.energy_level !== undefined) {
      parts.push(`EL ${b.energy_level}`);
    }
    if (b.minutes_performed !== null && b.minutes_performed !== undefined) {
      parts.push(`${b.minutes_performed} min`);
    }
    if (parts.length > 0) {
      settingsLine = parts.join(" - ");
      break;
    }
  }

  const probeLine =
    blocks.map((b) => trimmedOrNull(b.probe_label)).find(Boolean) ?? null;

  // Tolerance: the WORST (lowest) rating across blocks. If the client
  // struggled anywhere, that is what the next visit needs to know.
  const ratings = blocks
    .map((b) => b.tolerance_rating)
    .filter((r): r is number => typeof r === "number");
  const worst = ratings.length > 0 ? Math.min(...ratings) : null;
  const toleranceLine =
    worst !== null ? `${worst}/5 - ${toleranceLabel(worst)}` : null;

  // Reaction: unique non-"none" reactions in block order; "none" only
  // surfaces when it is the sole recorded value (an explicit all-clear
  // is information; an absent value is not). Short notes ride along.
  const reactionLabels: string[] = [];
  let sawNone = false;
  for (const b of blocks) {
    if (!isReactionType(b.reaction_type)) continue;
    if (b.reaction_type === "none") {
      sawNone = true;
      continue;
    }
    const label = reactionTypeLabel(b.reaction_type);
    if (!reactionLabels.includes(label)) reactionLabels.push(label);
  }
  let reactionLine: string | null = null;
  if (reactionLabels.length > 0) {
    reactionLine = reactionLabels.join(", ");
    const note = blocks
      .map((b) => trimmedOrNull(b.reaction_notes))
      .find(Boolean);
    if (note && note.length <= 140) {
      reactionLine = `${reactionLine}. ${note}`;
    }
  } else if (sawNone) {
    reactionLine = reactionTypeLabel("none");
  }

  // Caution: flagged when ANY block raised it; distinct notes joined.
  const cautionFlagged = blocks.some((b) => b.caution_for_next_session);
  const cautionNotes: string[] = [];
  for (const b of blocks) {
    const note = trimmedOrNull(b.caution_note);
    if (note && !cautionNotes.includes(note)) cautionNotes.push(note);
  }
  const cautionLine = cautionNotes.length > 0 ? cautionNotes.join(" ") : null;

  return {
    areaLine,
    settingsLine,
    probeLine,
    toleranceLine,
    reactionLine,
    cautionFlagged,
    cautionLine,
    nextSessionNote: trimmedOrNull(input.nextSessionNote),
  };
}
