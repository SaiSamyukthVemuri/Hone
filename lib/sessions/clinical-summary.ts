import type { SessionBlock } from "@/lib/types/database";
import { sessionBlockSideLabel } from "@/lib/sessions/side-labels";
import { apilusModalityLabel } from "@/lib/constants";
import {
  isReactionType,
  reactionTypeLabel,
  toleranceLabel,
} from "@/lib/sessions/clinical-response";

// PR #190 introduced this helper; PR #191 reshaped it after Chloe's
// practitioner smoke: a first-area-only compact line made multi-area
// sessions useless at a glance. The summary is now PER TREATMENT
// AREA: each area carries its own settings/probe/tolerance/response
// mini-summary, and the per-area cautions plus the session-level
// next-session note are lifted into ONE combined "From last visit,
// for today" block (watchLines + nextSessionNote) so the UI never
// renders two competing warning boxes. Pure formatter, no I/O;
// shared by the appointment detail card and the new-session panel.
// Every line is null when its data is absent so old records render
// without empty labels.

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

// One treatment area's at-a-glance memory. Practitioner-facing
// naming: this is a "treatment area", never a "block".
export type AreaSummary = {
  // "Upper lip (Left)", legacy block_name, or "Treatment area N".
  name: string;
  // "Thermolysis - Synchro - EL 14 - 30 min"
  settingsLine: string | null;
  probeLine: string | null;
  // "3/5 - Okay"
  toleranceLine: string | null;
  // "Mild redness. Settled within an hour."
  reactionLine: string | null;
};

export type LastSessionSummary = {
  areas: AreaSummary[];
  // One line per caution raised, prefixed with its area: "Upper lip:
  // start lower and check sensitivity." A flag without a note becomes
  // "<area>: flagged to watch." Rendered inside the single combined
  // "From last visit, for today" box, never as a second warning box.
  watchLines: string[];
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

function areaName(block: ClinicalSummaryBlock, index: number): string {
  const area = trimmedOrNull(block.primary_area);
  if (area) {
    const side = block.side ? sessionBlockSideLabel(block.side) : null;
    return side ? `${area} (${side})` : area;
  }
  const legacyName = trimmedOrNull(block.block_name);
  if (legacyName) return legacyName;
  return `Treatment area ${index + 1}`;
}

function settingsLine(block: ClinicalSummaryBlock): string | null {
  const parts: string[] = [];
  if (block.mode && MODE_LABELS[block.mode]) parts.push(MODE_LABELS[block.mode]);
  if (block.apilus_modality) parts.push(apilusModalityLabel(block.apilus_modality));
  if (block.energy_level !== null && block.energy_level !== undefined) {
    parts.push(`EL ${block.energy_level}`);
  }
  if (block.minutes_performed !== null && block.minutes_performed !== undefined) {
    parts.push(`${block.minutes_performed} min`);
  }
  return parts.length > 0 ? parts.join(" - ") : null;
}

function reactionLine(block: ClinicalSummaryBlock): string | null {
  if (!isReactionType(block.reaction_type)) {
    // A note without a coded reaction still carries memory.
    const noteOnly = trimmedOrNull(block.reaction_notes);
    return noteOnly && noteOnly.length <= 140 ? noteOnly : null;
  }
  const label = reactionTypeLabel(block.reaction_type);
  const note = trimmedOrNull(block.reaction_notes);
  if (note && note.length <= 140) return `${label}. ${note}`;
  return label;
}

export function buildLastSessionSummary(input: {
  blocks: ClinicalSummaryBlock[];
  nextSessionNote: string | null;
}): LastSessionSummary {
  const blocks = [...input.blocks].sort(
    (a, b) => a.sort_order - b.sort_order,
  );

  const areas: AreaSummary[] = blocks.map((b, i) => ({
    name: areaName(b, i),
    settingsLine: settingsLine(b),
    probeLine: trimmedOrNull(b.probe_label),
    toleranceLine:
      typeof b.tolerance_rating === "number"
        ? `${b.tolerance_rating}/5 - ${toleranceLabel(b.tolerance_rating)}`
        : null,
    reactionLine: reactionLine(b),
  }));

  const watchLines: string[] = [];
  blocks.forEach((b, i) => {
    const note = trimmedOrNull(b.caution_note);
    if (!b.caution_for_next_session && !note) return;
    const name = areaName(b, i);
    watchLines.push(note ? `${name}: ${note}` : `${name}: flagged to watch.`);
  });

  return {
    areas,
    watchLines,
    nextSessionNote: trimmedOrNull(input.nextSessionNote),
  };
}

// PR #199 (Chloe iPad retest): the "Last session" card used to show
// sessions[0] even when that session had no treatment details, so the
// pre-appointment card could read as empty while a useful charted
// treatment sat one row below. This picks the most recent session
// that actually has treatment details: charted areas (session_blocks)
// or, for laser/legacy sessions, raw entries. Sessions must already
// be ordered newest-first (the profile loader's order). Pure; no I/O.
export type LastTreatmentCandidate = {
  id: string;
  electrolysis_entries: ReadonlyArray<unknown>;
  laser_entries: ReadonlyArray<unknown>;
};

export function pickLastTreatment<T extends LastTreatmentCandidate>(
  sessionsNewestFirst: ReadonlyArray<T>,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<unknown>>,
): T | null {
  return (
    sessionsNewestFirst.find(
      (s) =>
        (blocksBySession.get(s.id)?.length ?? 0) > 0 ||
        s.electrolysis_entries.length > 0 ||
        s.laser_entries.length > 0,
    ) ?? null
  );
}

// PR #203 (Chloe iPad feedback): the Sessions-tab Last treatment card
// is the PRE-CLIENT view, so its "From last visit, for today" band
// must show the same context the charting page shows, not only the
// last charted session's own note. The charting page surfaces the
// most recent prior guidance; this picks the same thing: the newest
// session that carries ANY watch/plan content, i.e. a non-empty
// next_session_note or a treatment area flagged with caution data.
// In particular, a newer charted session WITHOUT notes no longer
// hides the previous session's still-relevant guidance. Sessions
// must be ordered newest-first. Pure; no I/O.
export type WatchPlanCandidate = {
  id: string;
  next_session_note?: string | null;
};

export function pickPreClientWatchPlanSource<T extends WatchPlanCandidate>(
  sessionsNewestFirst: ReadonlyArray<T>,
  blocksBySession: ReadonlyMap<
    string,
    ReadonlyArray<
      Pick<ClinicalSummaryBlock, "caution_for_next_session" | "caution_note">
    >
  >,
): T | null {
  return (
    sessionsNewestFirst.find((s) => {
      if (s.next_session_note?.trim()) return true;
      const blocks = blocksBySession.get(s.id) ?? [];
      return blocks.some(
        (b) =>
          b.caution_for_next_session === true || !!b.caution_note?.trim(),
      );
    }) ?? null
  );
}
