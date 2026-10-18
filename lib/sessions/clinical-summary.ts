import type { SessionBlock, SessionBlockArea } from "@/lib/types/database";
import { blockAreasLabel } from "@/lib/sessions/block-areas";
import { apilusModalityLabel } from "@/lib/constants";
import { toleranceLabel } from "@/lib/sessions/clinical-response";
import { unifiedReactionLabels } from "@/lib/sessions/reaction-unified";
import { orderByRecency } from "@/lib/sessions/charted-session";

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
> & {
  // Migration 0128: structured areas for this block. When present they are the
  // authoritative label ("Left Cheeks · Right Sideburns"); absent → legacy
  // primary_area + side. Optional so callers that have not been updated still
  // compile and fall back to legacy.
  structured_areas?: ReadonlyArray<SessionBlockArea> | null;
  // Charting unification: the block's live entries' observation_chips, so the
  // reaction line reads the unified representation. Optional; legacy-only when
  // absent.
  observation_chips_list?: ReadonlyArray<unknown>;
};

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
  // Migration 0128: every clinical surface shows EVERY treated area + laterality
  // via the shared resolver: structured rows win, legacy primary_area + side is
  // the fallback, and mixed laterality is never flattened to one block-level side.
  const label = blockAreasLabel(block.structured_areas, {
    primary_area: block.primary_area,
    side: block.side,
  });
  if (label) return label;
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
  // Charting unification: the reaction(s) come from the unified representation,
  // legacy reaction_type AND reaction chips in the block's live entries'
  // observation_chips. Retain ALL reactions, joined.
  const labels = unifiedReactionLabels(
    block.reaction_type,
    block.observation_chips_list ?? [],
  );
  const note = trimmedOrNull(block.reaction_notes);
  if (labels.length === 0) {
    // A note without a coded reaction still carries memory.
    return note && note.length <= 140 ? note : null;
  }
  const label = labels.join(", ");
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
// or, for laser/legacy sessions, raw entries. Pure; no I/O.
//
// F3. IT NO LONGER TRUSTS THE CALLER'S ORDER.
//
// It used to be documented as "sessions must already be ordered newest-first"
// and to `.find()` straight down whatever array it was handed. Both callers do
// order by `started_at desc` in SQL — but `ORDER BY started_at DESC` with no
// secondary key is not a total order, and Postgres does not specify which of
// two rows sharing an exact `started_at` comes back first. That ambiguity
// reached the screen: the Client Profile "Last treatment" card and the
// dashboard "Before today" lines could name a different session than the
// appointment-prep card, which sorts with an explicit tie-break, and could name
// a different one again between renders.
//
// The tie is reachable, not theoretical: the "Edit time" control writes a
// `datetime-local` value, so a corrected timestamp carries `:00.000` seconds
// and two sessions corrected to the same minute are byte-identical.
//
// It now applies `compareChartedRecency` itself — THE shared rule, the same one
// pickNewestChartedSession uses and the same one migration 0157 encodes in SQL.
// Callers may pass rows in any order; the answer is identical either way.
//
// HON-10 row 1. A VOID SESSION IS NEVER THE LAST TREATMENT.
//
// pickNewestChartedSession (prep card, /sessions/new) and 0157's SQL both skip
// `record_status = 'void'`; this selector did not, so a void newest session with
// a live block was "Last treatment" here and skipped everywhere else. 0159
// refuses every new transition into 'void', so this closes a parity gap rather
// than a live one. `record_status` is REQUIRED on the type so a caller cannot
// silently skip the filter by not selecting the column.
export type LastTreatmentCandidate = {
  id: string;
  // Required so this selector can establish its own order. Both callers already
  // select it; it is not a new read.
  started_at: string;
  record_status: string | null;
  electrolysis_entries: ReadonlyArray<unknown>;
  laser_entries: ReadonlyArray<unknown>;
};

export function pickLastTreatment<T extends LastTreatmentCandidate>(
  sessions: ReadonlyArray<T>,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<unknown>>,
): T | null {
  return (
    orderByRecency(sessions).find(
      (s) =>
        s.record_status !== "void" &&
        ((blocksBySession.get(s.id)?.length ?? 0) > 0 ||
          s.electrolysis_entries.length > 0 ||
          s.laser_entries.length > 0),
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
// hides the previous session's still-relevant guidance. Pure; no I/O.
//
// F3: orders by the shared rule itself, for the same reason as
// pickLastTreatment above. This selector picks the source of the WATCH/PLAN
// band, which sits directly beneath the last-treatment card — the two reading
// from differently-resolved ties is exactly the contradiction to avoid.
export type WatchPlanCandidate = {
  id: string;
  started_at: string;
  // HON-10 row 1 (Sam): a void session is never the Watch/Plan source either.
  // This is ONLY the void exclusion; which content qualifies (note OR caution)
  // is HON-10 row 2 and is unchanged.
  record_status: string | null;
  next_session_note?: string | null;
};

export function pickPreClientWatchPlanSource<T extends WatchPlanCandidate>(
  sessions: ReadonlyArray<T>,
  blocksBySession: ReadonlyMap<
    string,
    ReadonlyArray<
      Pick<ClinicalSummaryBlock, "caution_for_next_session" | "caution_note">
    >
  >,
): T | null {
  return (
    orderByRecency(sessions).find((s) => {
      if (s.record_status === "void") return false;
      if (s.next_session_note?.trim()) return true;
      const blocks = blocksBySession.get(s.id) ?? [];
      return blocks.some(
        (b) =>
          b.caution_for_next_session === true || !!b.caution_note?.trim(),
      );
    }) ?? null
  );
}
