import {
  NONE_VALUE,
  getOptionLabel,
  getQuestionLabel,
} from "@/lib/intake/questions";

// ---------------------------------------------------------------------------
// PR #266. Practitioner-only intake REVIEW FLAGS.
// ---------------------------------------------------------------------------
//
// Surfaces existing intake answers that Chloe wants flagged for review before
// treatment. Hone does NOT make clinical decisions — it only surfaces what the
// client already reported on their intake, for the practitioner to review.
//
// Derivation is a PURE read-time map over the structured answers already in
// `client_intake_forms.responses` (multi_select option values, single_select
// values, yes_no = "yes"). NO new fields, NO migration, NO free-text parsing,
// NO AI/OCR, NO persisted risk score. Free-text `_notes` companions are never
// inspected (parsing prose for medical terms would be inference, not
// surfacing). Allergy / EpiPen signals are intentionally NOT flagged here —
// they already have dedicated cards on the review page; this avoids
// duplication.
//
// The wording mapping below is a practitioner WORKFLOW reference (Chloe's
// precaution chart), not a clinical authority. Every level uses only the
// allowed copy; the card appends "Use professional judgment and clinic
// policy." The rule table is the single place to adjust what surfaces.

export type IntakeReviewLevel = "authorization" | "review" | "precaution";

export type IntakeReviewFlag = {
  // Stable id for keys/tests, e.g. "medical_conditions:pacemaker".
  id: string;
  level: IntakeReviewLevel;
  // Allowed wording for the level (see LEVEL_WORDING).
  wording: string;
  // Short human label of the matched item.
  category: string;
  // "Based on intake response: <question label> — <answer label>".
  basis: string;
  // PR #267. Modality/category badges from Chloe's clinic reference chart
  // (resolve to wording via MODALITY_WORDING). For a chart-mapped condition
  // these are the chart's per-modality review signals; otherwise a single
  // fallback derived from `level`. Render-only — never a treatment decision.
  badges: IntakeModality[];
};

// PR #267. Modality / category signals (Chloe's clinic reference chart
// columns). "review" is the V1 generic fallback for flags with no chart row.
export type IntakeModality =
  | "thermolysis"
  | "galvanic"
  | "authorization"
  | "authorization_depends"
  | "precaution"
  | "review";

// Allowed copy only (PR #267 wording list). NOT rendered as a treatment
// decision; the card pairs these with the basis + professional-judgment caveat.
export const MODALITY_WORDING: Record<IntakeModality, string> = {
  thermolysis: "Review before thermolysis",
  galvanic: "Review before continuous/galvanic current",
  authorization: "Medical authorization may be required",
  authorization_depends: "Authorization depends on practitioner review",
  precaution: "Precaution noted",
  review: "Review before treatment",
};

// Allowed copy only.
export const LEVEL_WORDING: Record<IntakeReviewLevel, string> = {
  authorization: "Medical authorization may be required",
  review: "Review before treatment",
  precaution: "Precaution noted",
};

const LEVEL_ORDER: Record<IntakeReviewLevel, number> = {
  authorization: 0,
  review: 1,
  precaution: 2,
};

// Stable badge display order (most-to-least urgent).
const MODALITY_ORDER: ReadonlyArray<IntakeModality> = [
  "authorization",
  "authorization_depends",
  "thermolysis",
  "galvanic",
  "review",
  "precaution",
];

// Fallback badge for a flag with no chart row: mirror its V1 level.
const LEVEL_FALLBACK_MODALITY: Record<IntakeReviewLevel, IntakeModality> = {
  authorization: "authorization",
  review: "review",
  precaution: "precaution",
};

// PR #267. Modality/category signals from Chloe's clinic reference chart,
// keyed by the flag id (`questionKey:optionValue` or `questionKey:yes`) the
// rules below produce. ONLY chart rows backed by an EXISTING structured intake
// field are listed; chart rows with no structured field (e.g. puberty,
// haemophilia, MS / nervous-system disorder, radiotherapy, chemotherapy,
// arteritis, retinal implant, circulatory problems, hyper/hypotension,
// infectious disease, total paralysis) are NOT invented. Surfaced for review
// only — not a treatment decision.
const CHART_MODALITIES: Record<string, ReadonlyArray<IntakeModality>> = {
  // Heart problem or pacemaker → continuous/galvanic + medical authorization.
  "medical_conditions:heart": ["galvanic", "authorization"],
  "medical_conditions:pacemaker": ["galvanic", "authorization"],
  // Pregnancy (chart row "pregnancy after 3 months"; the intake has no
  // trimester field) → continuous/galvanic + medical authorization.
  "medical_conditions:pregnancy": ["galvanic", "authorization"],
  // Controlled epilepsy → continuous/galvanic + medical authorization.
  "medical_conditions:epilepsy": ["galvanic", "authorization"],
  // Cancer → continuous/galvanic + medical authorization. (Radiotherapy /
  // chemotherapy are separate chart rows with no structured intake field, so
  // they are not mapped here.)
  "medical_conditions:cancer": ["galvanic", "authorization"],
  // Hepatitis and AIDS/HIV (the intake's single blood-borne option covers
  // both rows) → thermolysis + continuous/galvanic.
  "medical_conditions:blood_borne": ["thermolysis", "galvanic"],
  // Diabetes — the conservative UNION of all three diabetes chart rows.
  //
  // The intake now DOES collect a Type 1 / Type 2 subtype (`diabetes_type`),
  // and this mapping deliberately continues to ignore it. Two reasons, both
  // load-bearing:
  //
  //   * Narrowing which modalities are flagged based on the client's diabetes
  //     type would be a clinical judgement. Hone surfaces intake answers for
  //     review; it does not decide treatment, and no one has approved a
  //     per-type rule.
  //   * Every intake submitted before the subtype existed has no type at all,
  //     and gestational diabetes — a chart row in its own right — is not one of
  //     the two options offered. Keying off the subtype would quietly flag those
  //     records differently from each other for no clinically stated reason.
  //
  // So the union stands, and the subtype is information for the practitioner to
  // read on the review grid rather than an input to this table.
  "medical_conditions:diabetes": [
    "thermolysis",
    "galvanic",
    "authorization",
    "precaution",
  ],
  // Prolonged bleeding (mapped from the blood-thinners medication answer) →
  // medical authorization + precaution.
  "medications_list:blood_thinners": ["authorization", "precaution"],
};

// Resolve a flag's badges: the chart row if mapped, else the level fallback.
// Deduped and returned in MODALITY_ORDER.
function badgesFor(id: string, level: IntakeReviewLevel): IntakeModality[] {
  const base = CHART_MODALITIES[id] ?? [LEVEL_FALLBACK_MODALITY[level]];
  return MODALITY_ORDER.filter((m) => base.includes(m));
}

type Rule =
  // multi_select: triggers when responses[questionKey] is an array containing
  // optionValue (the NONE sentinel never triggers).
  | {
      kind: "multi";
      questionKey: string;
      optionValue: string;
      level: IntakeReviewLevel;
      label?: string;
    }
  // single_select: triggers when responses[questionKey] === optionValue.
  | {
      kind: "single";
      questionKey: string;
      optionValue: string;
      level: IntakeReviewLevel;
      label?: string;
    }
  // yes_no: triggers when responses[questionKey] === "yes".
  | {
      kind: "yes";
      questionKey: string;
      level: IntakeReviewLevel;
      label: string;
    };

// The rule table. Categories map to EXISTING intake option/question keys only.
const RULES: ReadonlyArray<Rule> = [
  // --- Medical conditions (multi_select medical_conditions) ---
  { kind: "multi", questionKey: "medical_conditions", optionValue: "pacemaker", level: "authorization" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "heart", level: "authorization" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "pregnancy", level: "authorization" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "cancer", level: "authorization" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "metal_implants", level: "review" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "recent_surgery", level: "review" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "epilepsy", level: "review" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "diabetes", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "thyroid", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "pcos", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "lupus_autoimmune", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "blood_borne", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "skin_condition", level: "precaution" },
  { kind: "multi", questionKey: "medical_conditions", optionValue: "other", level: "review", label: "Other medical condition noted" },

  // --- Medications (multi_select medications_list) ---
  { kind: "multi", questionKey: "medications_list", optionValue: "accutane", level: "review" },
  { kind: "multi", questionKey: "medications_list", optionValue: "blood_thinners", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "topical_retinoid", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "steroids", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "immunosuppressants", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "acne_meds", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "antibiotics", level: "precaution" },
  { kind: "multi", questionKey: "medications_list", optionValue: "hormone_therapy", level: "precaution" },

  // --- Skin / treatment area (single_select + yes_no) ---
  { kind: "single", questionKey: "scarring_tendency", optionValue: "easily", level: "review", label: "Tendency to scar or keloid" },
  { kind: "yes", questionKey: "active_cold_sore", level: "review", label: "Active cold sore in treatment area" },
  { kind: "yes", questionKey: "recent_sun", level: "review", label: "Recent sun exposure, sunburn, or tanning" },
  { kind: "yes", questionKey: "skin_sensitizing_products", level: "review", label: "Recent skin-sensitizing products near treatment area" },
  { kind: "yes", questionKey: "current_skin_issues", level: "review", label: "Current skin issues in treatment area" },
  { kind: "yes", questionKey: "recent_self_tanner", level: "precaution", label: "Recent self-tanner use" },
  { kind: "yes", questionKey: "cold_sore_tendency", level: "precaution", label: "Cold sore tendency (treatment area)" },
];

function multiHas(value: unknown, optionValue: string): boolean {
  return (
    Array.isArray(value) &&
    optionValue !== NONE_VALUE &&
    value.some((v) => typeof v === "string" && v === optionValue)
  );
}

function basisLine(questionKey: string, answerLabel: string): string {
  return `Based on intake response: ${getQuestionLabel(questionKey)} — ${answerLabel}`;
}

// Pure. Derives the practitioner review flags from a single intake's
// `responses` map. Returns [] for an empty / legacy / malformed map (older
// intakes whose keys predate a category simply produce no flag). Never throws.
// Sorted by level (authorization → review → precaution), preserving rule order
// within a level.
export function deriveIntakeReviewFlags(
  responses: Record<string, unknown> | null | undefined,
): IntakeReviewFlag[] {
  if (!responses || typeof responses !== "object") return [];
  const flags: Array<Omit<IntakeReviewFlag, "badges">> = [];

  for (const rule of RULES) {
    if (rule.kind === "multi") {
      if (!multiHas(responses[rule.questionKey], rule.optionValue)) continue;
      const answerLabel = getOptionLabel(rule.questionKey, rule.optionValue);
      flags.push({
        id: `${rule.questionKey}:${rule.optionValue}`,
        level: rule.level,
        wording: LEVEL_WORDING[rule.level],
        category: rule.label ?? answerLabel,
        basis: basisLine(rule.questionKey, answerLabel),
      });
    } else if (rule.kind === "single") {
      if (responses[rule.questionKey] !== rule.optionValue) continue;
      const answerLabel = getOptionLabel(rule.questionKey, rule.optionValue);
      flags.push({
        id: `${rule.questionKey}:${rule.optionValue}`,
        level: rule.level,
        wording: LEVEL_WORDING[rule.level],
        category: rule.label ?? answerLabel,
        basis: basisLine(rule.questionKey, answerLabel),
      });
    } else {
      if (responses[rule.questionKey] !== "yes") continue;
      flags.push({
        id: `${rule.questionKey}:yes`,
        level: rule.level,
        wording: LEVEL_WORDING[rule.level],
        category: rule.label,
        basis: basisLine(rule.questionKey, "Yes"),
      });
    }
  }

  return flags
    .map((f) => ({ ...f, badges: badgesFor(f.id, f.level) }))
    .sort((a, b) => LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]);
}
