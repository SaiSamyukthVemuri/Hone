// Pure helpers + types for Treatment Plan v2 planned-vs-actual.
//
// This file is the canonical home of the stages → estimate formula
// (Phase C had a local copy in components/treatment-schedule-editor.tsx;
// this PR consolidates here so the same numbers show up everywhere).
//
// SAFE TO IMPORT FROM CLIENT COMPONENTS. No DB access, no createClient,
// no admin client. The companion server query getActualMinutesForPlans
// lives in lib/treatment-time/queries.ts because it imports createClient
// from @/lib/supabase/server, which would pull server-only code into
// the client bundle if it lived here. The two files coordinate via the
// PlannedVsActual type below — pure callers compute, server callers
// supply the actual side.

import type {
  TreatmentPlan,
  TreatmentPlanStage,
} from "@/lib/types/database";

// Convert a stage's declared length into weeks. The factor 4 is the
// rounded "weeks per month" used in plain-English schedule estimates
// (a calendar month is actually ~4.345 weeks but practitioners think
// in 4-week blocks; we keep it simple to avoid implying precision the
// schedule does not have).
function stageWeeks(stage: TreatmentPlanStage): number {
  return stage.stage_length_unit === "weeks"
    ? stage.stage_length_value
    : stage.stage_length_value * 4;
}

export function estimateStageVisits(stage: TreatmentPlanStage): number {
  const weeks = stageWeeks(stage);
  switch (stage.how_often_unit) {
    case "weekly":
      return weeks;
    case "every_2_weeks":
      return Math.ceil(weeks / 2);
    case "monthly":
      // If the stage is declared in months use it directly; if in weeks
      // approximate the month count from the weeks.
      return stage.stage_length_unit === "months"
        ? stage.stage_length_value
        : Math.ceil(weeks / 4);
  }
}

export function estimateStageMinutes(stage: TreatmentPlanStage): number {
  return estimateStageVisits(stage) * stage.visit_length_minutes;
}

export function estimatePlanTotalVisits(
  stages: ReadonlyArray<TreatmentPlanStage>,
): number {
  return stages.reduce((acc, s) => acc + estimateStageVisits(s), 0);
}

export function estimatePlanTotalMinutes(
  stages: ReadonlyArray<TreatmentPlanStage>,
): number {
  return stages.reduce((acc, s) => acc + estimateStageMinutes(s), 0);
}

// The shape callers render. The `source` field tells the UI which copy
// to use when an estimate is unavailable vs. derived from stages vs.
// overridden by treatment_goal_minutes_override.
export type PlannedVsActualSource = "stages" | "override" | "none";

export type PlannedVsActual = {
  // Estimated total in minutes. null when neither stages nor an
  // override exist; the UI should hide the estimate row in that case.
  estimatedTotalMinutes: number | null;
  // Estimated visit count derived from stages. null when no stages
  // exist (an override gives minutes only; visit count cannot be
  // back-derived because cadence is unknown).
  estimatedTotalVisits: number | null;
  // Actual logged minutes. Always a number (0 when nothing logged).
  actualLoggedMinutes: number;
  actualSessionCount: number;
  // max(estimated - actual, 0). null when estimate is null.
  estimatedRemainingMinutes: number | null;
  // min(round(actual / estimated * 100), 100). null when estimate is
  // null or zero.
  plannedVsActualPercent: number | null;
  source: PlannedVsActualSource;
};

export function computePlannedVsActual(
  plan: Pick<TreatmentPlan, "treatment_goal_minutes_override">,
  stages: ReadonlyArray<TreatmentPlanStage>,
  actual: { minutes: number; sessionCount: number },
): PlannedVsActual {
  const stagesMinutes =
    stages.length > 0 ? estimatePlanTotalMinutes(stages) : 0;
  const stagesVisits = stages.length > 0 ? estimatePlanTotalVisits(stages) : 0;

  let estimatedTotalMinutes: number | null;
  let estimatedTotalVisits: number | null;
  let source: PlannedVsActualSource;

  if (plan.treatment_goal_minutes_override != null) {
    estimatedTotalMinutes = plan.treatment_goal_minutes_override;
    // The override is a minutes-only target. Visit count is undefined
    // without cadence — set to null so the UI doesn't render a
    // fabricated visit count.
    estimatedTotalVisits = null;
    source = "override";
  } else if (stages.length > 0) {
    estimatedTotalMinutes = stagesMinutes;
    estimatedTotalVisits = stagesVisits;
    source = "stages";
  } else {
    estimatedTotalMinutes = null;
    estimatedTotalVisits = null;
    source = "none";
  }

  const estimatedRemainingMinutes =
    estimatedTotalMinutes != null
      ? Math.max(estimatedTotalMinutes - actual.minutes, 0)
      : null;

  const plannedVsActualPercent =
    estimatedTotalMinutes != null && estimatedTotalMinutes > 0
      ? Math.min(
          Math.round((actual.minutes / estimatedTotalMinutes) * 100),
          100,
        )
      : null;

  return {
    estimatedTotalMinutes,
    estimatedTotalVisits,
    actualLoggedMinutes: actual.minutes,
    actualSessionCount: actual.sessionCount,
    estimatedRemainingMinutes,
    plannedVsActualPercent,
    source,
  };
}
