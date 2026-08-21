// POSITIVE PREP OBSERVATIONS over an appointment-bounded candidate window.
//
// WHAT THIS IS FOR
// ----------------
// The Dashboard needs three prep facts besides the previous treatment itself:
// the plan note ("Remember"), the caution ("Caution"), and the most recent
// concrete machine setup ("Latest setup"). Before this module they came from a
// SECOND historical pipeline (lib/dashboard/before-today-previews.ts) that ran
// only on Today, had no `before` bound, no void filter and no own-appointment
// exclusion, and discarded the `error` on all four of its reads.
//
// Every input here is already in the prep loader's hand: the candidate window
// it already computed, and the batched block read it already performed. So
// these observations cost ZERO additional queries and ZERO additional waves.
//
// THE LAW THIS MODULE OBEYS
// -------------------------
// Each function returns a FACT or `null`. `null` means "we did not observe
// one", never "there is none". A caller may render a fact; it may not render a
// sentence about the null, because the block map it was derived from can be
// capped (PostgREST `max_rows`), sliced (the per-client candidate window) or
// short. Absence here is a reason to say nothing.
//
// NO DISPLAY VOCABULARY IS FORKED. Both observers run the shared
// `buildPointOfCareMemory`, which is the one authority for watch lines, area
// labels, probe lines, mode labels and energy levels. If that vocabulary
// changes, these follow, because none of it is restated here.
//
// Pure. No I/O. Client-safe.

import {
  buildPointOfCareMemory,
  type PointOfCareBlock,
} from "@/lib/sessions/point-of-care-memory";

/** The minimum a candidate must expose for these observers. */
export type PrepObservationCandidate = {
  id: string;
  started_at: string;
  modality?: string | null;
};

/** Where an observation was made. Carried so the render can attribute it. */
export type PrepObservationSource = {
  sessionId: string;
  startedAt: string;
};

export type PrepCautionObservation = PrepObservationSource & {
  /** The practitioner's own words, in the shared "<area>: <note>" grammar. */
  text: string;
};

export type PrepSetupObservation = PrepObservationSource & {
  /** "27.12 MHz · Ballet F3 · Thermolysis · EL 14" */
  line: string;
  /** The treatment area the setup was recorded on, when the record names one. */
  areaLabel: string | null;
};

// One shared projection per session, so a session is never folded twice when
// both observers walk the same window.
function memoryFor(
  candidate: PrepObservationCandidate,
  blocks: ReadonlyArray<PointOfCareBlock>,
) {
  return buildPointOfCareMemory({
    session: {
      id: candidate.id,
      started_at: candidate.started_at,
      modality: candidate.modality ?? "",
    },
    blocks,
  });
}

/**
 * The newest candidate carrying a caution the practitioner recorded.
 *
 * Candidates arrive newest-first, already appointment-bounded, already
 * void-filtered and already stripped of this appointment's own sessions, so the
 * first hit is the answer.
 *
 * A session whose blocks are absent from `blocksBySession` simply yields
 * nothing and the walk continues. It is NEVER read as "this session had no
 * caution": we did not see its blocks, which is not the same as seeing that it
 * has none.
 */
export function observeCaution(
  candidatesNewestFirst: ReadonlyArray<PrepObservationCandidate>,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<PointOfCareBlock>>,
): PrepCautionObservation | null {
  for (const candidate of candidatesNewestFirst) {
    const blocks = blocksBySession.get(candidate.id);
    if (!blocks || blocks.length === 0) continue;
    const watchLine = memoryFor(candidate, blocks).watchLines[0];
    if (watchLine && watchLine.trim()) {
      return {
        sessionId: candidate.id,
        startedAt: candidate.started_at,
        text: watchLine.trim(),
      };
    }
  }
  return null;
}

/**
 * The newest candidate carrying a CONCRETE machine setup, and the first area on
 * it that records one.
 *
 * "Concrete" means at least one of frequency / probe / mode / energy level was
 * actually recorded. A block with none of them contributes nothing rather than
 * an empty chip row — the same rule `before-today` applied, kept so the
 * rendered string is unchanged.
 *
 * Same absence rule as above: an unseen block set is skipped, never denied.
 */
export function observeLatestSetup(
  candidatesNewestFirst: ReadonlyArray<PrepObservationCandidate>,
  blocksBySession: ReadonlyMap<string, ReadonlyArray<PointOfCareBlock>>,
): PrepSetupObservation | null {
  for (const candidate of candidatesNewestFirst) {
    const blocks = blocksBySession.get(candidate.id);
    if (!blocks || blocks.length === 0) continue;
    // `buildPointOfCareMemory` sorts by sort_order and maps blocks to areas
    // index-for-index, so sorting the same way keeps the two aligned and lets
    // each part be taken from whichever of the pair is CORRECT for it.
    const ordered = [...blocks].sort(
      (a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0),
    );
    const { areas } = memoryFor(candidate, ordered);
    for (let i = 0; i < areas.length; i += 1) {
      const area = areas[i];
      const block = ordered[i];
      if (!area || !block) continue;
      const parts = [
        area.frequency,
        // THE PROBE LABEL, NOT `area.probeLine`.
        //
        // `probeLine` is the point-of-care card's string and it embeds the
        // probe LOT NUMBER ("Ballet F3 · Lot #A12 (confirmed)"). This line is
        // painted on the COLLAPSED row, which the practitioner has not asked to
        // open, and the lot is part of the full treatment record that must not
        // cross to the browser until she does — the contract
        // `toDisclosureSummary` and the on-demand server action exist to keep.
        //
        // It is also what the retired pipeline showed here
        // (treatment-intelligence's `latestProbe` is `probe_label`), so keeping
        // the label keeps the rendered copy identical rather than quietly
        // widening it.
        typeof block.probe_label === "string" && block.probe_label.trim()
          ? block.probe_label.trim()
          : null,
        area.modeLabel,
        area.energyLevel != null ? `EL ${area.energyLevel}` : null,
      ].filter((p): p is string => Boolean(p && String(p).trim()));
      if (parts.length === 0) continue;
      return {
        sessionId: candidate.id,
        startedAt: candidate.started_at,
        line: parts.join(" · "),
        areaLabel: area.areaLabel?.trim() || null,
      };
    }
  }
  return null;
}
