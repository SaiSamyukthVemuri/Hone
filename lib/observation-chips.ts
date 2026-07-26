import { COMMON_COMMENTS } from "@/lib/constants";
import {
  REACTION_CHIP_LABELS,
  isReactionType,
  isReactionChipLabel,
  reactionTypeLabel,
  type ReactionType,
} from "@/lib/sessions/clinical-response";

// "No visible reaction" label (the non-reaction reaction).
const NO_REACTION_LABEL = reactionTypeLabel("none");

// Structured treatment-observation chips (Chloe charting reliability).
//
// Charting UNIFICATION (Chloe): "Treatment observations" and "Client / skin
// response" are now ONE multi-select box, "Treatment observations & skin
// response". The chip vocabulary is therefore the observation presets
// (COMMON_COMMENTS) PLUS the legacy reaction labels (REACTION_CHIP_LABELS), all
// stored STRUCTURALLY in electrolysis_entries.observation_chips as an array of
// these exact canonical labels; free-text notes stay in `comments`. observation_
// chips is the canonical multi-select representation going forward; a legacy
// session_blocks.reaction_type is folded into this set on load/display and the
// value is preserved (never silently lost).
//
// Pure + client-safe (no I/O). Canonical labels (not opaque ids) are stored so
// the value stays human-readable and matches what legacy `comments`/reaction_type
// already contain, which makes non-destructive per-record migration trivial.

// The full merged chip list shown in the ONE unified box (observation presets
// first, then the reaction labels), deduped in order.
export const MERGED_OBSERVATION_CHIPS: ReadonlyArray<string> = (() => {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of [...COMMON_COMMENTS, ...REACTION_CHIP_LABELS]) {
    const k = c.trim().toLowerCase();
    if (!seen.has(k)) {
      seen.add(k);
      out.push(c);
    }
  }
  return out;
})();

// Back-compat alias — now the merged vocabulary (reaction labels are valid chips).
export const OBSERVATION_CHIPS: ReadonlyArray<string> = MERGED_OBSERVATION_CHIPS;

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
  // Vocabulary cleanup (Chloe): the redness/erythema and swelling/edema concepts
  // now have ONE preferred label each. These map the SAME concept's older/plain
  // spellings to the current canonical label so legacy stored values keep
  // resolving (never dropped). Exact-token (not substring), so clinically-distinct
  // chips like "Follicular erythema"/"Follicular edema" (laser list) are untouched.
  erythema: "Redness (erythema)",
  redness: "Redness (erythema)",
  "slight edema": "Slight swelling (edema)",
  "slight swelling": "Slight swelling (edema)",
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

// Toggle a chip in the UNIFIED findings box, preventing clinically contradictory
// reaction combinations (Chloe): selecting "No visible reaction" removes every
// other reaction chip, and selecting any real reaction removes "No visible
// reaction". Ordinary observation chips toggle freely and are never affected;
// multiple REAL reactions may coexist. Deselecting never triggers exclusivity.
export function toggleFindingChip(chips: readonly string[], chip: string): string[] {
  const next = toggleChip(chips, chip);
  // Only enforce on SELECT of a reaction chip.
  if (!isChipSelected(next, chip) || !isReactionChipLabel(chip)) return next;
  const isNone = chip.trim().toLowerCase() === NO_REACTION_LABEL.toLowerCase();
  return next.filter((c) => {
    if (!isReactionChipLabel(c)) return true; // keep all observation chips
    const cIsNone = c.trim().toLowerCase() === NO_REACTION_LABEL.toLowerCase();
    // Selecting "No visible reaction" → keep only it among reactions.
    // Selecting a real reaction → drop "No visible reaction".
    return isNone ? cIsNone || c === chip : !cIsNone;
  });
}

// Split a LEGACY `comments` string (chips + free-text mixed as comma tokens)
// into structured chips + the remaining free-text, WITHOUT losing anything.
// Used ONLY to present a legacy record (observation_chips empty) in the new
// structured UI — the stored `comments` is untouched until the practitioner
// saves. Tokens matching a canonical chip become chips (deduped, canonical
// casing); every other token is preserved verbatim as free-text, rejoined with
// the same ", " separator and in original order. This is the non-destructive,
// per-record migration path (no bulk backfill).
// UNIFIED representation (charting unification). Given a stored entry's
// observation_chips and its block's legacy reaction_type, return the single
// merged chip set: the normalized observation chips PLUS the reaction's label
// (folded in) if the legacy reaction_type is set and not already present. This is
// the ONE contract for hydrating the unified box on load, rendering the saved
// record, exporting, and driving reaction-aware surfaces — so old (reaction_type)
// and new (chip-in-observation_chips) records read identically. Never mutates.
export function mergeReactionIntoChips(
  observationChips: unknown,
  reactionType: string | null | undefined,
): string[] {
  const chips = normalizeChips(observationChips);
  if (reactionType && isReactionType(reactionType)) {
    const label = reactionTypeLabel(reactionType as ReactionType);
    if (!isChipSelected(chips, label)) chips.push(label);
  }
  return chips;
}

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
    // Promote a legacy comment token to a chip ONLY if it is a canonical
    // OBSERVATION chip. Reaction labels are intentionally NOT promoted here: a
    // free-text comment that happens to equal a reaction word must not be
    // string-guessed into a coded reaction (which would spuriously flag safety
    // surfaces). It stays as free-text, exactly as before unification.
    if (canon && !isReactionChipLabel(canon)) {
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
