/**
 * Hone intake form questions, v1.
 *
 * These questions were drafted from standard contraindication categories used across
 * the electrolysis industry. They are NOT copied from any specific copyrighted form
 * including Dectro training materials or "Beyond Electrolysis Basics" by Sara N. Pazner.
 *
 * This list MUST be reviewed and approved by a licensed electrologist before being
 * used with real clients. Practitioners should treat this as a starting point and
 * modify questions to match their practice.
 *
 * For Hone-internal use: questions are editable via direct code change. A future
 * sprint will surface this as an admin UI.
 */

export type QuestionType =
  | "short_text"
  | "long_text"
  | "date"
  | "yes_no"
  | "single_select"
  | "multi_select"
  | "checkbox";

export type ConditionalRule = {
  // Show this question only when the named question equals one of these values.
  // For yes_no: "yes" or "no". For multi_select: the option's `value`.
  whenKey: string;
  whenEquals: ReadonlyArray<string>;
};

export type Option = { value: string; label: string };

export type Question = {
  key: string;
  type: QuestionType;
  label: string;
  helpText?: string;
  required?: boolean;
  options?: ReadonlyArray<Option>;
  // Optional follow-up text question shown when the parent triggers it.
  // Used for "If yes, tell us more" patterns. Stored under `${key}_notes`.
  followUpNotesPrompt?: string;
  // Show this question only when another question's value matches.
  conditional?: ConditionalRule;
};

export type Step = {
  id: number;
  shortLabel: string;
  title: string;
  description?: string;
  questions: ReadonlyArray<Question>;
};

const BODY_AREAS: ReadonlyArray<Option> = [
  { value: "face", label: "Face" },
  { value: "neck", label: "Neck" },
  { value: "chest", label: "Chest" },
  { value: "back", label: "Back" },
  { value: "underarms", label: "Underarms" },
  { value: "bikini", label: "Bikini" },
  { value: "legs", label: "Legs" },
  { value: "feet", label: "Feet" },
  { value: "other", label: "Other" },
];

const HAIR_DURATION: ReadonlyArray<Option> = [
  { value: "lt_6m", label: "Less than 6 months" },
  { value: "6_12m", label: "6 to 12 months" },
  { value: "1_3y", label: "1 to 3 years" },
  { value: "3_plus", label: "3+ years" },
  { value: "adolescence", label: "Since adolescence" },
];

// Sentinel value used by multi_select questions to express "none of the
// above" as an active choice rather than an empty selection. The wizard
// treats this value as exclusive: selecting it clears all other choices;
// selecting any other option clears this one.
export const NONE_VALUE = "__none__";

const REMOVAL_METHODS: ReadonlyArray<Option> = [
  { value: "shaving", label: "Shaving" },
  { value: "waxing", label: "Waxing" },
  { value: "threading", label: "Threading" },
  { value: "laser", label: "Laser" },
  { value: "depilatory", label: "Depilatory creams" },
  { value: "plucking", label: "Plucking" },
  { value: "other", label: "Other" },
  { value: NONE_VALUE, label: "I haven't tried any of these" },
];

const RECENCY: ReadonlyArray<Option> = [
  { value: "lt_week", label: "Within the last week" },
  { value: "lt_month", label: "Within the last month" },
  { value: "lt_3mo", label: "Within the last 3 months" },
  { value: "gt_3mo", label: "More than 3 months ago" },
];

const MEDS: ReadonlyArray<Option> = [
  { value: "blood_thinners", label: "Blood thinners (warfarin, daily aspirin, etc)" },
  { value: "accutane", label: "Accutane or isotretinoin (within the last 6 months)" },
  { value: "topical_retinoid", label: "Topical retinoids (Retin-A, tretinoin)" },
  { value: "antibiotics", label: "Antibiotics" },
  { value: "hormone_therapy", label: "Hormone therapy or HRT" },
  { value: "steroids", label: "Steroids (oral or topical near treatment area)" },
  { value: "immunosuppressants", label: "Immunosuppressants" },
  { value: "acne_meds", label: "Acne medications" },
  { value: NONE_VALUE, label: "I'm not taking any of these" },
];

// Note: the "Keloid scarring tendency" item was removed from this list when
// the Skin step's scarring_tendency question was relabeled to "Tendency to
// scar or keloid?" The single question now covers both signals.
const CONDITIONS: ReadonlyArray<Option> = [
  { value: "pregnancy", label: "Pregnancy or breastfeeding" },
  { value: "diabetes", label: "Diabetes" },
  { value: "thyroid", label: "Thyroid disorder (hyper or hypothyroid)" },
  { value: "pcos", label: "Polycystic ovarian syndrome (PCOS / PMOD)" },
  { value: "lupus_autoimmune", label: "Lupus or other autoimmune conditions" },
  { value: "epilepsy", label: "Epilepsy or seizure disorder" },
  { value: "heart", label: "Heart conditions" },
  { value: "pacemaker", label: "Pacemaker or implanted defibrillator" },
  { value: "metal_implants", label: "Metal implants, plates, or screws" },
  { value: "cancer", label: "Cancer (current or recent treatment)" },
  { value: "blood_borne", label: "HIV, hepatitis, or other blood-borne conditions" },
  { value: "skin_condition", label: "Eczema, psoriasis, or other skin conditions" },
  { value: "recent_surgery", label: "Recent surgery (within the last 6 months)" },
  { value: "other", label: "Other" },
  { value: NONE_VALUE, label: "None of these apply to me" },
];

const METAL_ALLERGY_TYPES: ReadonlyArray<Option> = [
  { value: "nickel", label: "Nickel" },
  { value: "stainless_steel", label: "Stainless steel" },
  { value: "gold", label: "Gold" },
  { value: "other", label: "Other (please specify below)" },
];

const SENSITIVITY: ReadonlyArray<Option> = [
  { value: "very", label: "Very sensitive" },
  { value: "somewhat", label: "Somewhat sensitive" },
  { value: "normal", label: "Normal" },
  { value: "not", label: "Not sensitive" },
];

const SCARRING: ReadonlyArray<Option> = [
  { value: "easily", label: "Scars easily" },
  { value: "sometimes", label: "Sometimes" },
  { value: "rarely", label: "Rarely" },
  { value: "never", label: "Never" },
];

export const INTAKE_STEPS: ReadonlyArray<Step> = [
  {
    id: 1,
    shortLabel: "Personal",
    title: "Personal information",
    questions: [
      { key: "legal_name", type: "short_text", label: "Full legal name", required: true },
      { key: "preferred_name", type: "short_text", label: "Preferred name" },
      // Pronouns is its own field (was previously folded into "preferred
      // name"). Separating it lets the intake submit sync this answer
      // directly onto clients.pronouns, where the client profile reads it.
      { key: "pronouns", type: "short_text", label: "Pronouns", helpText: "she/her, he/him, they/them, etc." },
      { key: "date_of_birth", type: "date", label: "Date of birth", required: true },
      { key: "phone", type: "short_text", label: "Phone", required: true },
      { key: "email", type: "short_text", label: "Email", required: true },
      // Address required for insurance / legal reasons per Chloe. The
      // intake sync below populates clients.address (fill-only-if-null)
      // so the practitioner doesn't have to retype it.
      { key: "address", type: "long_text", label: "Address", required: true },
      {
        key: "emergency_contact_name",
        type: "short_text",
        label: "Emergency contact name",
        required: true,
      },
      {
        key: "emergency_contact_phone",
        type: "short_text",
        label: "Emergency contact phone",
        required: true,
      },
      { key: "referral_source", type: "short_text", label: "How did you hear about us?" },
    ],
  },
  {
    id: 2,
    shortLabel: "Goals",
    title: "Treatment goals and history",
    questions: [
      {
        key: "areas_of_concern",
        type: "multi_select",
        label: "Primary areas of concern",
        options: BODY_AREAS,
        required: true,
      },
      {
        key: "areas_of_concern_other_text",
        type: "short_text",
        label: "Tell us about the area you'd like treated",
        required: true,
        conditional: {
          whenKey: "areas_of_concern",
          whenEquals: ["other"],
        },
      },
      {
        key: "hair_growth_duration",
        type: "single_select",
        label: "How long has hair growth been a concern?",
        options: HAIR_DURATION,
        required: true,
      },
      {
        key: "had_electrolysis",
        type: "yes_no",
        label: "Have you had electrolysis before?",
        followUpNotesPrompt: "When and where? Any reactions?",
        required: true,
      },
      {
        key: "other_methods",
        type: "multi_select",
        label: "Have you tried other hair removal methods?",
        options: REMOVAL_METHODS,
        required: true,
      },
      {
        key: "most_recent_method",
        type: "short_text",
        label: "Which method is most recent?",
        conditional: {
          whenKey: "other_methods",
          whenEquals: [
            "shaving",
            "waxing",
            "threading",
            "laser",
            "depilatory",
            "plucking",
            "other",
          ],
        },
      },
      {
        key: "most_recent_method_recency",
        type: "single_select",
        label: "How recently?",
        options: RECENCY,
        conditional: {
          whenKey: "other_methods",
          whenEquals: [
            "shaving",
            "waxing",
            "threading",
            "laser",
            "depilatory",
            "plucking",
            "other",
          ],
        },
      },
      {
        key: "outcome_hoped",
        type: "long_text",
        label: "What outcome are you hoping for?",
      },
    ],
  },
  {
    id: 3,
    shortLabel: "Medical",
    title: "Medical history",
    description:
      "This section is about your safety. Be as specific as you can. Your electrologist will treat your answers as confidential.",
    questions: [
      {
        key: "taking_prescriptions",
        type: "yes_no",
        label: "Are you currently taking any prescription medications?",
        followUpNotesPrompt: "Please list them.",
        required: true,
      },
      {
        key: "medications_list",
        type: "multi_select",
        label: "Are you taking any of the following?",
        options: MEDS,
        required: true,
      },
      {
        key: "medical_conditions",
        type: "multi_select",
        label: "Do any of the following apply to you?",
        options: CONDITIONS,
        required: true,
      },
      {
        key: "metal_implants_location",
        type: "long_text",
        label: "Where on your body are the metal implants, plates, or screws?",
        required: true,
        conditional: {
          whenKey: "medical_conditions",
          whenEquals: ["metal_implants"],
        },
      },
      {
        key: "recent_surgery_details",
        type: "long_text",
        label: "Where was the recent surgery and when?",
        required: true,
        conditional: {
          whenKey: "medical_conditions",
          whenEquals: ["recent_surgery"],
        },
      },
      {
        key: "medical_conditions_other_details",
        type: "long_text",
        label: "Tell us more about anything you marked 'Other' above.",
        required: true,
        conditional: {
          whenKey: "medical_conditions",
          whenEquals: ["other"],
        },
      },
      {
        key: "has_allergies",
        type: "yes_no",
        label: "Do you have any known allergies?",
        followUpNotesPrompt: "Please list them.",
        required: true,
      },
      {
        key: "requires_epipen",
        type: "yes_no",
        label: "Do you require an EpiPen?",
        helpText: "If yes, please bring it to your appointment.",
        required: true,
        conditional: { whenKey: "has_allergies", whenEquals: ["yes"] },
      },
      {
        key: "metal_allergy",
        type: "yes_no",
        label: "Do you have a metal allergy?",
        required: true,
      },
      {
        key: "metal_allergy_types",
        type: "multi_select",
        label: "Which metal are you allergic to?",
        options: METAL_ALLERGY_TYPES,
        required: true,
        conditional: { whenKey: "metal_allergy", whenEquals: ["yes"] },
      },
      {
        key: "metal_allergy_other_text",
        type: "short_text",
        label: "If other, please describe",
        required: true,
        conditional: {
          whenKey: "metal_allergy_types",
          whenEquals: ["other"],
        },
      },
      { key: "latex_allergy", type: "yes_no", label: "Latex allergy?", required: true },
      {
        key: "anesthetic_allergy",
        type: "yes_no",
        label: "Topical anesthetic allergies?",
        required: true,
      },
    ],
  },
  {
    id: 4,
    shortLabel: "Skin",
    title: "Skin and treatment area",
    questions: [
      {
        key: "skin_sensitivity",
        type: "single_select",
        label: "Skin sensitivity",
        options: SENSITIVITY,
        required: true,
      },
      {
        key: "scarring_tendency",
        type: "single_select",
        label: "Tendency to scar or keloid",
        options: SCARRING,
        required: true,
      },
      {
        key: "recent_sun",
        type: "yes_no",
        label: "Recent sun exposure (within the last 2 weeks)?",
        required: true,
      },
      {
        key: "recent_self_tanner",
        type: "yes_no",
        label: "Recent self-tanner use (within the last 2 weeks)?",
        required: true,
      },
      {
        key: "regular_spf_use",
        type: "yes_no",
        label: "Do you regularly wear SPF on the treatment area?",
        followUpNotesPrompt: "Any details?",
        required: true,
      },
      {
        key: "cold_sore_tendency",
        type: "yes_no",
        label: "Cold sore tendency in treatment area (face or lip)?",
        required: true,
      },
      {
        key: "active_cold_sore",
        type: "yes_no",
        // Label rewritten to be self-contained for the practitioner
        // review surface (which renders this label without the parent
        // question right above it). "Are you currently experiencing
        // one?" was ambiguous when read alone.
        label: "Are you currently experiencing an active cold sore?",
        required: true,
        conditional: { whenKey: "cold_sore_tendency", whenEquals: ["yes"] },
      },
      {
        key: "skin_sensitizing_products",
        type: "yes_no",
        label: "Recent use of skin-sensitizing products near treatment area?",
        helpText:
          "Examples: AHA, BHA, retinoids, prescription acne medications.",
        followUpNotesPrompt: "Which products?",
        required: true,
      },
      {
        key: "current_skin_issues",
        type: "yes_no",
        label: "Any current skin issues in the treatment area (acne, irritation, cuts)?",
        followUpNotesPrompt: "Describe.",
        required: true,
      },
    ],
  },
  {
    id: 5,
    shortLabel: "Confirm",
    title: "Acknowledgments",
    description:
      "These confirmations help your electrologist trust the information they're working with. They are not a consent form. Treatment-specific consent happens with your electrologist in person.",
    questions: [
      {
        key: "ack_not_a_substitute",
        type: "checkbox",
        label:
          "I understand this intake is not a substitute for an in-person consultation with my electrologist.",
        required: true,
      },
      {
        key: "ack_accurate",
        type: "checkbox",
        label: "I confirm the above information is accurate to the best of my knowledge.",
        required: true,
      },
      {
        key: "ack_understands_risk",
        type: "checkbox",
        label:
          "I understand that incomplete or inaccurate information may affect my treatment safety.",
        required: true,
      },
      {
        key: "ack_will_update",
        type: "checkbox",
        label:
          "I will inform my electrologist if any of the above information changes between sessions.",
        required: true,
      },
    ],
  },
];

export const TOTAL_STEPS = INTAKE_STEPS.length;

export function stepById(id: number): Step | undefined {
  return INTAKE_STEPS.find((s) => s.id === id);
}

// Quick lookup of all question keys, used by save/submit to validate payload keys.
export const ALL_QUESTION_KEYS: ReadonlyArray<string> = INTAKE_STEPS.flatMap(
  (s) => s.questions.flatMap((q) => [q.key, `${q.key}_notes`]),
);

// Whether a conditional question is "live" for a given response map. Pure
// function; same predicate the wizard's visibleQuestions filter uses
// client-side. Server-side required-validation uses this so a question
// whose parent answer isn't satisfied is NOT considered missing.
export function isConditionalSatisfied(
  responses: Record<string, unknown>,
  conditional: ConditionalRule | undefined,
): boolean {
  if (!conditional) return true;
  const parent = responses[conditional.whenKey];
  const allowed = conditional.whenEquals;
  if (Array.isArray(parent)) {
    return parent.some(
      (v): v is string => typeof v === "string" && allowed.includes(v),
    );
  }
  if (typeof parent === "string") {
    return allowed.includes(parent);
  }
  return false;
}

// Returns true when the given answer value satisfies the question's
// required predicate. Mirrors the wizard's client-side validateStep
// rules: multi_select needs a non-empty array, checkbox needs `true`,
// everything else needs a non-empty trimmed string.
function isAnswerProvided(
  q: Question,
  value: unknown,
): boolean {
  if (q.type === "multi_select") {
    return Array.isArray(value) && value.length > 0;
  }
  if (q.type === "checkbox") {
    return value === true;
  }
  return typeof value === "string" && value.trim().length > 0;
}

// Server-side required-fields check, used by submitIntakeAction. Walks
// every step + question, skips conditionally-hidden ones (so e.g. the
// "Which metal are you allergic to?" question only counts as missing
// when metal_allergy === "yes"), and returns the list of missing
// required keys. Empty list = ready to submit.
//
// Pure compute; no I/O. Safe to call from server actions. NEVER called
// on the display/read path; already-submitted intakes are not
// re-validated when the practitioner views them.
export function findMissingRequiredAnswers(
  responses: Record<string, unknown>,
): string[] {
  const missing: string[] = [];
  for (const step of INTAKE_STEPS) {
    for (const q of step.questions) {
      if (!q.required) continue;
      if (!isConditionalSatisfied(responses, q.conditional)) continue;
      if (!isAnswerProvided(q, responses[q.key])) {
        missing.push(q.key);
      }
    }
  }
  return missing;
}
