import { AREAS, OTHER_AREA } from "@/lib/constants";

// Server-safe treatment-area validation (Charting Validation PR 2).
//
// The canonical allow-list is the FLAT AREAS list (lib/constants.ts), which
// deliberately INCLUDES "Full face" and "Other". It is NOT AREA_REGIONS: that
// grouped list decomposes "Full face" and would wrongly reject a legitimate
// "Full face" pick. Matching is case-insensitive and canonical CASING is
// normalized (e.g. "chin" -> "Chin"); the practitioner's custom text is never
// mutated.
//
// This validates NEW/updated writes only. It is never applied on read/render, so
// legacy rows (custom free text, older casings) always keep displaying as-is.

const CANONICAL_BY_LOWER = new Map(
  AREAS.map((a) => [a.toLowerCase(), a] as const),
);

export const TREATMENT_AREA_MAX = 60;

// True iff the value is a canonical area (flat AREAS, case-insensitive).
export function isCanonicalTreatmentArea(value: string | null | undefined): boolean {
  return CANONICAL_BY_LOWER.has((value ?? "").trim().toLowerCase());
}

export type AreaValidation =
  | { ok: true; value: string | null; custom: boolean }
  | { ok: false; error: string };

// Validate a single treatment area:
//   empty         -> null (allowed; an empty area is soft-gated by the UI, not here)
//   canonical     -> accepted, normalized to the canonical casing
//   non-canonical -> accepted ONLY when areaIsCustom is explicitly true (the
//                    practitioner chose "Other"); otherwise rejected. Custom text
//                    is stored verbatim.
export function validateTreatmentArea(
  raw: string | null | undefined,
  areaIsCustom: boolean,
  maxLen: number = TREATMENT_AREA_MAX,
): AreaValidation {
  const trimmed = (raw ?? "").trim();
  if (trimmed.length === 0) return { ok: true, value: null, custom: false };
  if (trimmed.length > maxLen) {
    return { ok: false, error: `Treatment area must be ${maxLen} characters or fewer.` };
  }
  const canonical = CANONICAL_BY_LOWER.get(trimmed.toLowerCase());
  if (canonical) {
    return { ok: true, value: canonical, custom: canonical === OTHER_AREA };
  }
  if (areaIsCustom) {
    return { ok: true, value: trimmed, custom: true };
  }
  return {
    ok: false,
    error:
      "That treatment area isn’t recognized. Pick one from the list, or choose “Other” to enter a custom area.",
  };
}
