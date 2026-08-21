import "server-only";
import {
  buildAppointmentPrepMemory,
  type AppointmentPrepMemory,
} from "@/lib/sessions/appointment-prep-memory";
import { compactSummary } from "@/lib/dashboard/today-treatment-summary";
import type { HistoricalVisitDetail } from "@/lib/sessions/history/visit-detail";
import type { HistorySession } from "@/lib/sessions/history/select-visit";

// THE COMPACT CLINICAL PROJECTION — required fields, or an explicit state.
//
// WHY THE SHAPE IS THE FIX
// ------------------------
// `AppointmentPrepMemoryInput` marks its four evidence channels OPTIONAL:
//
//   laserEntries?  electrolysisEntries?  supersededByEmptySession?
//   hasLiveElectrolysisEntries?
//
// Omitting them is therefore NOT a type error, and two independent call sites
// omitted all four. TypeScript stayed silent while a laser visit lost its only
// narrative, a legacy entry-only visit was described as having "no charted
// treatment areas", and the "a newer session has no treatment details yet" line
// disappeared. Optionality turned NOT SUPPLIED into NOT RECORDED.
//
// Two mechanisms replace that, and neither relies on anyone remembering:
//
//   1. `memoryFromCanonicalVisit` below takes every channel as a REQUIRED
//      parameter and is the only permitted way to reach the builder from a
//      historical read. A missing channel is a compile error here even though
//      the builder itself would accept it.
//   2. The projection returned to callers is a DISCRIMINATED UNION. A visit that
//      recorded legacy passes is a different VARIANT from a visit that recorded
//      nothing, so no renderer can reach the wrong sentence by reading a null.
//
// WHAT CROSSES TO THE BROWSER
// ---------------------------
// Only this projection. The full `AppointmentPrepMemory` stays server-side until
// an explicit disclosure, because everything in a type that crosses the RSC
// boundary is transported for every row whether or not it is ever opened.

/** Watch/plan guidance, which frequently comes from a DIFFERENT visit. */
export type WatchPlanEvidence =
  /** At least one of these is non-null; both may be present. */
  | { kind: "recorded"; caution: string | null; planNote: string | null }
  /** Proven: the window was complete and carried no guidance. */
  | { kind: "none-recorded" }
  /** Not established. Renders nothing — never a denial. */
  | { kind: "unavailable" };

/** The "Latest setup" line, which is its own recency question. */
export type SetupEvidence =
  | { kind: "recorded"; line: string; sessionId: string }
  | { kind: "none-recorded" }
  | { kind: "unavailable" };

/**
 * HOW this visit recorded treatment. A VARIANT, not a nullable field.
 *
 * The three ways a visit can carry treatment are structurally distinct, so a
 * renderer cannot describe one as another. `legacy-entry-only` is the pre-0019
 * shape — passes charted with no settings block — and it is genuinely charted
 * treatment, which is exactly the claim that was being inverted.
 */
export type VisitTreatment =
  | { kind: "charted-areas"; headline: string; totalMinutes: number | null; totalHairs: number | null }
  | { kind: "legacy-entry-only"; passCount: number }
  | { kind: "laser"; passCount: number; narrative: ReadonlyArray<string> };

/** One historical visit, compact enough to cross to the browser. */
export type HistoricalVisitSummary =
  | {
      kind: "visit";
      sessionId: string;
      visitedAt: string;
      modality: string;
      /** The rendered one-liner. Always present on a visit. */
      compactLine: string;
      treatment: VisitTreatment;
      supersededByUnchartedVisit: boolean;
    }
  /** Proven: the window was COMPLETE and carried no prior visit. */
  | { kind: "no-prior-visit" }
  /** Not established. Never an absence. */
  | { kind: "evidence-unavailable"; reason: "read-failed" | "incomplete" };

/**
 * Everything a collapsed preparation surface paints, in one object.
 *
 * The three questions are kept APART because they are answered by different
 * visits: the treatment is the newest CHARTED visit, the setup is the newest
 * visit carrying a settings block, and the guidance is a bare positive fact that
 * may be older than both.
 */
export type VisitPreparation = {
  treatment: HistoricalVisitSummary;
  setup: SetupEvidence;
  watchPlan: WatchPlanEvidence;
};

/**
 * Build the full clinical model from a CANONICAL visit record.
 *
 * Every channel is a REQUIRED parameter. That is the entire reason this function
 * exists: the underlying builder accepts partial input, and partial input is
 * what produced three false clinical statements.
 */
export function memoryFromCanonicalVisit(args: {
  session: Pick<HistorySession, "id" | "started_at" | "modality" | "session_notes" | "next_session_note">;
  detail: HistoricalVisitDetail;
  /** From the session row's COUNT, never from embedded rows a cap could cut. */
  hasLiveElectrolysisEntries: boolean;
  supersededByUnchartedVisit: boolean;
}): AppointmentPrepMemory {
  return buildAppointmentPrepMemory({
    session: {
      id: args.session.id,
      started_at: args.session.started_at,
      modality: args.session.modality ?? "",
      session_notes: args.session.session_notes ?? null,
      next_session_note: args.session.next_session_note ?? null,
    },
    blocks: args.detail.blocks,
    // The three channels the retired adapter dropped.
    laserEntries: args.detail.laserEntries,
    electrolysisEntries: args.detail.orphanEntries,
    hasLiveElectrolysisEntries: args.hasLiveElectrolysisEntries,
    supersededByEmptySession: args.supersededByUnchartedVisit,
  });
}

/**
 * Which VARIANT of treatment this visit recorded.
 *
 * Decided from the canonical record, in priority order: settings blocks first
 * (the richest), then legacy passes with no block, then laser passes. A visit
 * the authority called charted always lands on one of the three.
 */
function treatmentOf(
  memory: AppointmentPrepMemory,
  detail: HistoricalVisitDetail,
): VisitTreatment | null {
  if (detail.blocks.length > 0) {
    return {
      kind: "charted-areas",
      headline: memory.areaHeadline ?? "",
      totalMinutes: memory.totalMinutes,
      totalHairs: memory.totalHairs,
    };
  }
  if (detail.orphanEntries.length > 0) {
    return { kind: "legacy-entry-only", passCount: detail.orphanEntries.length };
  }
  if (detail.laserEntries.length > 0) {
    return {
      kind: "laser",
      passCount: detail.laserEntries.length,
      // A laser visit's ONLY narrative. Not selecting it is what made the card
      // fall back to "Open the full chart to review what was recorded".
      narrative: detail.laserEntries
        .map((e) => e.observation_notes?.trim())
        .filter((t): t is string => Boolean(t)),
    };
  }
  return null;
}

/**
 * Project a canonical visit down to what a collapsed surface may paint.
 *
 * Returns `evidence-unavailable` when the record is incomplete: rendering a
 * SUBSET of a visit's areas as though it were the whole visit is a false claim
 * of completeness, and it is the claim that made a truncated read look like a
 * sparse one.
 */
export function summariseVisit(args: {
  session: Pick<HistorySession, "id" | "started_at" | "modality" | "session_notes" | "next_session_note">;
  detail: HistoricalVisitDetail;
  complete: boolean;
  hasLiveElectrolysisEntries: boolean;
  supersededByUnchartedVisit: boolean;
}): { summary: HistoricalVisitSummary; memory: AppointmentPrepMemory | null } {
  if (!args.complete) {
    return { summary: { kind: "evidence-unavailable", reason: "incomplete" }, memory: null };
  }
  const memory = memoryFromCanonicalVisit(args);
  const treatment = treatmentOf(memory, args.detail);
  if (!treatment) {
    // The authority said this visit was charted and its record came back empty
    // and complete. Those cannot both be true, so the honest answer is that we
    // could not establish it — never that the visit recorded nothing.
    return { summary: { kind: "evidence-unavailable", reason: "incomplete" }, memory };
  }
  return {
    summary: {
      kind: "visit",
      sessionId: args.session.id,
      visitedAt: args.session.started_at,
      modality: args.session.modality ?? "",
      compactLine: compactSummary(memory),
      treatment,
      supersededByUnchartedVisit: args.supersededByUnchartedVisit,
    },
    memory,
  };
}
