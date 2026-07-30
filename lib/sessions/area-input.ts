// Custom treatment-area TEXT INPUT contract (Chloe charting hotfix).
//
// WHY THIS MODULE EXISTS
// ----------------------
// The multi-area settings-block editor used to treat every `AreaPicker`
// `onChange` as a COMMITTED area. Because the picker's free-text ("Other")
// input called `onChange` on every keystroke, typing "Glabella" appended eight
// selected rows — "G", "Gl", "Gla", "Glab", "Glabe", "Glabel", "Glabell", "Glabella"
// — and all eight were persisted as canonical `session_block_areas` rows. That is a charting-
// integrity defect, not a cosmetic one.
//
// The fix separates DRAFT text from a COMMIT. This module is the pure,
// server-safe half of that contract so the rules can be unit-tested without a
// DOM: normalization, the blank guard, and case-insensitive duplicate
// protection. The components own only the wiring.
//
// It deliberately does NOT canonicalize casing or validate against the
// `AREAS` catalog — `lib/sessions/area-validation.ts` owns that, and custom
// practitioner text is stored verbatim by design.

import type { BlockArea, Laterality } from "@/lib/sessions/block-areas";

// Matches TREATMENT_AREA_MAX (lib/sessions/area-validation.ts) and the
// server-side AREA_MAX in the block write action. Kept as its own constant so
// the input layer never silently exceeds what the action will accept.
export const CUSTOM_AREA_MAX = 60;

// Normalize a raw free-text area for COMMIT:
//   * collapse every run of whitespace to a single space (fixes the accidental
//     double-space that reads as a different area to a case-insensitive
//     comparison, e.g. "upper  lip" vs "upper lip");
//   * trim the surrounding whitespace;
//   * cap at CUSTOM_AREA_MAX, then trim again so a cut mid-space cannot leave
//     a trailing space.
// Returns "" for blank / whitespace-only input — the caller MUST treat "" as
// "nothing to commit".
export function normalizeCustomArea(raw: string | null | undefined): string {
  const collapsed = (raw ?? "").replace(/\s+/g, " ").trim();
  if (collapsed.length <= CUSTOM_AREA_MAX) return collapsed;
  return collapsed.slice(0, CUSTOM_AREA_MAX).trim();
}

// True iff `raw` would commit something. Drives the disabled state of the
// explicit "Add area" button and the Enter-key guard.
export function canCommitCustomArea(raw: string | null | undefined): boolean {
  return normalizeCustomArea(raw).length > 0;
}

// True iff `area` (case-insensitively, after normalization) is already in the
// selected set. Mirrors the editor's long-standing duplicate rule: adding never
// duplicates; laterality is edited on the existing row.
export function areaAlreadySelected(
  value: ReadonlyArray<BlockArea>,
  area: string,
): boolean {
  const key = normalizeCustomArea(area).toLowerCase();
  if (key.length === 0) return false;
  return value.some((a) => a.area.trim().toLowerCase() === key);
}

export type AreaCommit =
  // Nothing to add: blank/whitespace-only input.
  | { status: "blank"; value: ReadonlyArray<BlockArea> }
  // The area is already selected — the set is returned UNCHANGED (one
  // submission never adds a second row for the same area).
  | { status: "duplicate"; value: ReadonlyArray<BlockArea>; area: string }
  // Exactly one row appended, at the end, with the default N/A laterality.
  | { status: "added"; value: ReadonlyArray<BlockArea>; area: string };

// THE commit rule for the multi-area ADD workflow. One call adds AT MOST one
// row. Callers render `status` and always adopt `value`.
export function commitAreaToSet(
  value: ReadonlyArray<BlockArea>,
  raw: string | null | undefined,
  laterality: Laterality = "not_applicable",
): AreaCommit {
  const area = normalizeCustomArea(raw);
  if (area.length === 0) return { status: "blank", value };
  if (areaAlreadySelected(value, area)) return { status: "duplicate", value, area };
  return { status: "added", value: [...value, { area, laterality }], area };
}
