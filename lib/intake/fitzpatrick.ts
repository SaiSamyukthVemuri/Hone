// Fitzpatrick skin-typing scoring helper.
//
// Reads the ten Fitzpatrick intake answers (each stored as a string
// numeric "0".."4" in client_intake_forms.responses) and computes:
//   * total score (0..40)
//   * estimated type per the source form's bands:
//       0..7   -> I
//       8..16  -> II
//       17..25 -> III
//       26..30 -> IV
//       > 30   -> V-VI
//
// Returns null when any answer is missing or malformed (e.g. an older
// intake submitted before this PR's section was added). Pure compute;
// no I/O. Safe to call from the practitioner intake review render
// path -- old records simply show "not completed" instead of crashing.
//
// The estimate is intentionally NOT auto-synced to the clinical
// `clients.fitzpatrick_type` column. Self-reported answers are an
// intake estimate, not a clinical assessment; the practitioner sets
// the canonical type manually after evaluating the client. See the
// "Client profile sync decision" in the PR body.

export const FITZ_QUESTION_KEYS = [
  "fitz_eye_color",
  "fitz_natural_hair_color",
  "fitz_skin_color_unexposed",
  "fitz_freckles_unexposed",
  "fitz_sun_too_long",
  "fitz_tan_degree",
  "fitz_tan_speed",
  "fitz_face_sun_reaction",
  "fitz_last_sun_exposure",
  "fitz_area_sun_exposure",
] as const;

export type FitzpatrickQuestionKey = (typeof FITZ_QUESTION_KEYS)[number];

export type FitzpatrickEstimate = {
  score: number;
  type: "I" | "II" | "III" | "IV" | "V-VI";
};

export function computeFitzpatrickEstimate(
  responses: Record<string, unknown>,
): FitzpatrickEstimate | null {
  let total = 0;
  for (const key of FITZ_QUESTION_KEYS) {
    const raw = responses[key];
    if (typeof raw !== "string") return null;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n) || n < 0 || n > 4) return null;
    total += n;
  }

  let type: FitzpatrickEstimate["type"];
  if (total <= 7) type = "I";
  else if (total <= 16) type = "II";
  else if (total <= 25) type = "III";
  else if (total <= 30) type = "IV";
  else type = "V-VI";

  return { score: total, type };
}
