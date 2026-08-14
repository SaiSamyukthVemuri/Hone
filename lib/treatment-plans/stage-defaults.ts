import type {
  TreatmentPlanStageHowOftenUnit,
  TreatmentPlanStageLengthUnit,
} from "@/lib/types/database";

// Fixed clinical stages that every NEW treatment plan starts with.
//
// The three phases (Clearing / Control / Maintenance) are a clinical
// convention for permanent hair removal, not arbitrary user-created stages.
// What varies per plan is the cadence, visit length, duration, and notes,
// which the practitioner edits. The names and the set are fixed.
//
// The timing values below are GENERIC, fully-editable placeholders, NOT
// area-specific clinical recommendations. Area-specific defaults (e.g. Upper
// lip) and practitioner templates are intentionally out of scope here.
//
// English textbook terminology: "Clearing" (not "Cleaning", that is a
// French-origin Dectro translation of the same phase).

export type FixedStageDefault = {
  name: string;
  description: string;
  howOftenUnit: TreatmentPlanStageHowOftenUnit;
  visitLengthMinutes: number;
  stageLengthValue: number;
  stageLengthUnit: TreatmentPlanStageLengthUnit;
};

export const DEFAULT_PLAN_STAGES: ReadonlyArray<FixedStageDefault> = [
  {
    name: "Clearing",
    description: "First pass through the treatment area.",
    howOftenUnit: "weekly",
    visitLengthMinutes: 15,
    stageLengthValue: 3,
    stageLengthUnit: "months",
  },
  {
    name: "Control",
    description: "Follow-up visits for regrowth after clearing.",
    howOftenUnit: "every_2_weeks",
    visitLengthMinutes: 15,
    stageLengthValue: 6,
    stageLengthUnit: "months",
  },
  {
    name: "Maintenance",
    description: "Short, spaced-out visits to finish the remaining hairs.",
    howOftenUnit: "monthly",
    visitLengthMinutes: 15,
    stageLengthValue: 6,
    stageLengthUnit: "months",
  },
];

// Canonical ordered stage names, used to detect "fixed-stage mode".
export const FIXED_STAGE_NAMES: ReadonlyArray<string> = DEFAULT_PLAN_STAGES.map(
  (s) => s.name,
);

// Short description for a fixed stage by its canonical name (null otherwise).
export function descriptionForStage(name: string | null): string | null {
  return DEFAULT_PLAN_STAGES.find((s) => s.name === name)?.description ?? null;
}

// A plan is in "fixed-stage mode" when its stages are exactly the canonical
// three names in order. `stages` is expected sort_order-ascending (as loaded
// by getTreatmentPlansForClient). Legacy plans (zero stages, custom names, or
// a different count) are NOT fixed-stage mode and keep the free-form editor.
export function isFixedStageSet(
  stages: ReadonlyArray<{ name: string | null }>,
): boolean {
  if (stages.length !== FIXED_STAGE_NAMES.length) return false;
  return FIXED_STAGE_NAMES.every((n, i) => stages[i]?.name === n);
}
