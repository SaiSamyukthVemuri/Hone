import { COMMON_COMMENTS } from "@/lib/constants";

// Structured treatment-observation chips (Chloe charting reliability).
//
// Chips are the studio-static preset list (COMMON_COMMENTS). Going forward they
// are stored STRUCTURALLY in electrolysis_entries.observation_chips as an array
// of these exact canonical labels; free-text notes stay in `comments`. These
// helpers replace the old string/token approach (lib/comments.ts) for chips —
// selection is now explicit state, never re-derived from free text, so a
// selected chip can no longer silently disappear.
//
// Pure + client-safe (no I/O). Canonical labels (not opaque ids) are stored so
// the value stays human-readable and matches what legacy `comments` already
// contain, which makes non-destructive per-record migration trivial.

export const OBSERVATION_CHIPS: ReadonlyArray<string> = COMMON_COMMENTS;

const CANONICAL = new Map<string, string>(
  OBSERVATION_CHIPS.map((c) => [c.trim().toLowerCase(), c]),
);

// Coerce an unknown stored value (jsonb) into a clean canonical chip array:
// keep only known chips (normalized to canonical casing), dedup, drop anything
// unrecognized. Never throws — a null/garbage/legacy value yields [] rather than
// breaking the render. This is the single read-side contract for the column.
export function normalizeChips(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of value) {
    if (typeof v !== "string") continue;
    const canon = CANONICAL.get(v.trim().toLowerCase());
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

export function isChipSelected(
  chips: readonly string[],
  chip: string,
): boolean {
  const target = chip.trim().toLowerCase();
  return chips.some((c) => c.toLowerCase() === target);
}

// Toggle a chip in/out of the structured array. Unknown chips are a no-op (we
// never write a non-canonical value into structured state). Selecting is
// idempotent (no duplicates); deselecting removes every casing match.
export function toggleChip(chips: readonly string[], chip: string): string[] {
  const canon = CANONICAL.get(chip.trim().toLowerCase());
  if (!canon) return [...chips];
  return isChipSelected(chips, canon)
    ? chips.filter((c) => c.toLowerCase() !== canon.toLowerCase())
    : [...chips, canon];
}

// Split a LEGACY `comments` string (chips + free-text mixed as comma tokens)
// into structured chips + the remaining free-text, WITHOUT losing anything.
// Used ONLY to present a legacy record (observation_chips empty) in the new
// structured UI — the stored `comments` is untouched until the practitioner
// saves. Tokens matching a canonical chip become chips (deduped, canonical
// casing); every other token is preserved verbatim as free-text, rejoined with
// the same ", " separator and in original order. This is the non-destructive,
// per-record migration path (no bulk backfill).
export function hydrateLegacyChips(comments: string | null | undefined): {
  chips: string[];
  freeText: string;
} {
  const tokens = (comments ?? "").split(",").map((t) => t.trim());
  const chips: string[] = [];
  const rest: string[] = [];
  const seen = new Set<string>();
  for (const tok of tokens) {
    if (tok.length === 0) continue;
    const canon = CANONICAL.get(tok.toLowerCase());
    if (canon) {
      if (!seen.has(canon)) {
        seen.add(canon);
        chips.push(canon);
      }
    } else {
      rest.push(tok);
    }
  }
  return { chips, freeText: rest.join(", ") };
}
