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

// Explicit BACKWARD-COMPATIBLE aliases: a legacy stored token (lowercased) → the
// current canonical chip label. No chip label has ever been renamed (verified
// against git history), so these cover only unambiguous spelling/spacing variants
// of the SAME observation. This is the ONE place to add a mapping if a chip is
// ever renamed, so legacy stored values keep resolving to the current chip
// instead of being dropped. It NEVER maps a clinically-distinct term. Anything
// not resolved here stays visible as free-text (never silently discarded).
export const OBSERVATION_CHIP_ALIASES: Readonly<Record<string, string>> = {
  "hyper-pigmentation": "Hyperpigmentation",
  "hyper pigmentation": "Hyperpigmentation",
};

// Resolve a raw token to its canonical chip label (direct match first, then an
// explicit alias). Casing/whitespace-insensitive. Returns undefined for anything
// that is not a known chip or alias.
function canonicalFor(token: string): string | undefined {
  const key = token.trim().toLowerCase();
  const direct = CANONICAL.get(key);
  if (direct) return direct;
  const aliased = OBSERVATION_CHIP_ALIASES[key];
  return aliased ? CANONICAL.get(aliased.trim().toLowerCase()) : undefined;
}

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
    const canon = canonicalFor(v);
    if (canon && !seen.has(canon)) {
      seen.add(canon);
      out.push(canon);
    }
  }
  return out;
}

// Single DISPLAY/preload contract for a stored entry (structured column +
// legacy comments). Returns the chips to show as pills and the free-text note to
// show separately — WITHOUT ever mutating stored data. Structured rows use their
// observation_chips (+ full comments as the note). Legacy rows (empty structured
// column) hydrate chips out of `comments` so pre-0108 observations still render
// as pills, and the note shows the remaining free-text so nothing double-shows
// and nothing is lost. Used by the read (entry row) AND edit-preload paths.
export function resolveDisplayChips(
  observationChips: unknown,
  comments: string | null | undefined,
): { chips: string[]; note: string } {
  const structured = normalizeChips(observationChips);
  if (structured.length > 0) {
    return { chips: structured, note: (comments ?? "").trim() };
  }
  const { chips, freeText } = hydrateLegacyChips(comments);
  return { chips, note: freeText };
}

// Reason a persisted row FAILED verification (for logging/telemetry; never shown
// raw to the practitioner).
export type StoredChipsVerificationFailure =
  | "not-array" // the stored value wasn't a JSON array at all
  | "non-string-member" // an array member wasn't a string
  | "noncanonical" // a member isn't EXACTLY a canonical chip label (unknown, alias-form, or wrong casing)
  | "duplicate" // the RAW stored array contains a repeated member
  | "missing" // an expected chip is absent from the stored array
  | "unexpected"; // the stored array contains a chip that wasn't submitted

export type StoredChipsVerification =
  | { ok: true }
  | { ok: false; reason: StoredChipsVerificationFailure };

// STRICT persisted-row verification for the write action's read-back. Unlike a
// normalize-both-sides set-equality (which would DEDUP the stored value and thus
// HIDE a raw duplicate the database actually holds), this inspects the RAW stored
// array element-by-element:
//   * must be an array;
//   * every member must be a string;
//   * every member must be EXACTLY a canonical chip label — we insert canonical
//     labels, so a value coming back non-canonical (unknown / alias-form / wrong
//     casing) means the stored data is not what we wrote → fail (documented
//     contract: noncanonical stored casing/spacing FAILS raw verification rather
//     than being silently canonicalized away);
//   * NO raw duplicates (a repeated member fails — never masked by dedup);
//   * the set of members must equal `expected` exactly (no missing, no extra).
// `expected` is the canonical, unique array we submitted to the insert. Returns a
// structured verdict so the caller can distinguish verified success from a
// persisted-but-unverified write.
export function verifyStoredChips(
  raw: unknown,
  expected: readonly string[],
): StoredChipsVerification {
  if (!Array.isArray(raw)) return { ok: false, reason: "not-array" };
  const seen = new Set<string>();
  for (const v of raw) {
    if (typeof v !== "string") return { ok: false, reason: "non-string-member" };
    const canon = canonicalFor(v);
    if (!canon || canon !== v) return { ok: false, reason: "noncanonical" };
    if (seen.has(v)) return { ok: false, reason: "duplicate" };
    seen.add(v);
  }
  const exp = new Set(expected);
  // Any expected chip not present in the raw stored set → missing.
  for (const e of exp) {
    if (!seen.has(e)) return { ok: false, reason: "missing" };
  }
  // Any stored chip that wasn't expected → unexpected extra.
  if (seen.size !== exp.size) return { ok: false, reason: "unexpected" };
  return { ok: true };
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
  const canon = canonicalFor(chip);
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
    const canon = canonicalFor(tok);
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
