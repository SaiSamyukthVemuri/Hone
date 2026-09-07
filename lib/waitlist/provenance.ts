// ===========================================================================
// WAIT-ADMIT-01 — PROVENANCE VOCABULARIES
// ===========================================================================
//
// Every value this feature stores about a prospect arrived by one of a small
// number of routes, and those routes differ in EVIDENCE STRENGTH. A date the
// public form stamped is strong. The same date typed by an operator from their
// records is weaker. A date nobody has is not a date.
//
// The failure this module exists to prevent is those three becoming
// indistinguishable once written down. A weak value in a strong value's column
// does not look weak — it looks like data, and every reader downstream
// (ranking, "days waiting", the operator's queue) treats it as such.
//
// Pure vocabulary + validation. No I/O, no clock, no database.
// ===========================================================================

// ---------------------------------------------------------------------------
// 1. WHERE THE ENTRY CAME FROM
// ---------------------------------------------------------------------------

/**
 * How a waitlist entry came to exist.
 *
 * Today the column's CHECK admits only 'public_booking'; the other two are
 * unrepresentable until the consolidated schema lands. The vocabulary is
 * defined here first so the code that will write them is testable now.
 */
export type EntrySource = "public_booking" | "practitioner" | "legacy_import";

export const ENTRY_SOURCES: readonly EntrySource[] = [
  "public_booking",
  "practitioner",
  "legacy_import",
] as const;

/** The one source that is NOT operator-originated. */
export const SELF_SERVICE_SOURCE: EntrySource = "public_booking";

/**
 * Does this source require a named operator?
 *
 * A practitioner-created or imported entry must record WHO created it; a
 * public-form entry must not name one, because nobody at the studio did.
 * Both directions matter, which is why this is a predicate rather than a
 * "requires" list.
 */
export function sourceRequiresCreatingPractitioner(source: EntrySource): boolean {
  return source !== SELF_SERVICE_SOURCE;
}

// ---------------------------------------------------------------------------
// 2. WHERE THE JOIN DATE CAME FROM
// ---------------------------------------------------------------------------

/**
 * The evidence behind `joined_at`.
 *
 * 'form'              the public form stamped it as it happened. Strongest.
 * 'operator_supplied' a human asserted it from their own records. Weaker, and
 *                     the distinction must survive: it is the difference
 *                     between an observation and a recollection.
 * 'unknown'           nobody has a date. The entry exists, the wait is real,
 *                     and its length is genuinely not known — which is a fact,
 *                     not a gap to be filled with now().
 */
export type JoinedAtProvenance = "form" | "operator_supplied" | "unknown";

export const JOINED_AT_PROVENANCES: readonly JoinedAtProvenance[] = [
  "form",
  "operator_supplied",
  "unknown",
] as const;

/**
 * Only the form may claim 'form'.
 *
 * Without this rule the column stops meaning anything: an import could write
 * 'form' and a recollection would be indistinguishable from an observation,
 * which is the exact confusion the column exists to prevent.
 */
export function provenanceMatchesSource(
  source: EntrySource,
  provenance: JoinedAtProvenance,
): boolean {
  return source === SELF_SERVICE_SOURCE
    ? provenance === "form"
    : provenance === "operator_supplied" || provenance === "unknown";
}

/**
 * Is `days waiting` a meaningful number for this entry?
 *
 * False for 'unknown', and callers must not render a duration for it. Showing
 * "0 days" or "waiting since import" for someone who has in fact waited eight
 * months is the visible form of the fabrication this whole vocabulary prevents.
 */
export function joinedAtSupportsDuration(provenance: JoinedAtProvenance): boolean {
  return provenance !== "unknown";
}

// ---------------------------------------------------------------------------
// 3. WHERE THE AVAILABILITY PREFERENCE CAME FROM
// ---------------------------------------------------------------------------

/**
 * How the studio learned a prospect's availability.
 *
 * 'public_form'   the prospect chose it themselves when joining.
 * 'practitioner'  a practitioner recorded it — a phone call, a walk-in. Still
 *                 the prospect's own answer, relayed. Requires a named actor.
 * 'prospect_link' the prospect answered through a preference-update link. Their
 *                 own answer again, but authenticated only by a token, so it is
 *                 kept distinct from the two above rather than merged into
 *                 'public_form'.
 */
export type AvailabilitySource = "public_form" | "practitioner" | "prospect_link";

export const AVAILABILITY_SOURCES: readonly AvailabilitySource[] = [
  "public_form",
  "practitioner",
  "prospect_link",
] as const;

/** Only a practitioner-recorded preference names a practitioner. */
export function availabilitySourceRequiresPractitioner(
  source: AvailabilitySource,
): boolean {
  return source === "practitioner";
}

// ---------------------------------------------------------------------------
// 4. WHERE THE NAME CAME FROM  —  PROPOSED, NOT IN USE
// ---------------------------------------------------------------------------
//
// RECORDED FOR THE SCHEMA PROPOSAL AND DELIBERATELY NOT WIRED IN. `name`
// remains NOT NULL with its existing length CHECK, and nothing in this codebase
// reads or writes a name provenance today.
//
// WHETHER IT IS GENUINELY NEEDED — the honest answer, because "add a column for
// symmetry" is how a schema grows fields nobody reads:
//
//   * For the SOURCE-LEVEL distinction it is REDUNDANT. `source` already tells
//     you who produced the name: 'public_booking' means the person typed it,
//     'practitioner' means a practitioner took it down, 'legacy_import' means an
//     operator transcribed it. A separate column would restate that.
//
//   * There is exactly ONE distinction `source` cannot make, and it is real:
//     within a legacy import, a name the operator KNOWS from correspondence and
//     a name the operator INFERRED from an email local part are both
//     'legacy_import'. Addressing someone by a guessed name is a small but
//     genuine harm, and no existing column separates the two.
//
//   * That case is currently CLOSED BY REFUSAL rather than by schema:
//     planLegacyWaitlistImport returns a row with no name as `needs_decision`,
//     so an inferred name can only enter if an operator types it deliberately.
//     The column becomes necessary only if that refusal is relaxed at volume.
//
// So: proposed, justified narrowly, and not implemented until migration
// ownership is settled.
export type ProposedNameProvenance =
  | "self_reported"
  | "practitioner_recorded"
  | "operator_transcribed"
  | "operator_inferred";

export const PROPOSED_NAME_PROVENANCES: readonly ProposedNameProvenance[] = [
  "self_reported",
  "practitioner_recorded",
  "operator_transcribed",
  "operator_inferred",
] as const;

/**
 * The only member that marks a name as NOT sourced from a human who knew it.
 *
 * If the field is ever implemented, this is the value an operator UI must
 * surface as a warning before the name is used in a message to that person.
 */
export const INFERRED_NAME_PROVENANCE: ProposedNameProvenance = "operator_inferred";

// ---------------------------------------------------------------------------
// Shared parsing
// ---------------------------------------------------------------------------

/**
 * Exact-membership parse for any of the vocabularies above.
 *
 * Trims and lowercases, then requires an exact member. Returns null rather than
 * throwing, so a stored value outside the vocabulary — an older row, a
 * hand-edited one — is read as "not known" instead of crashing a queue render.
 */
export function parseVocabulary<T extends string>(
  raw: unknown,
  vocabulary: readonly T[],
): T | null {
  if (typeof raw !== "string") return null;
  const value = raw.trim().toLowerCase();
  return (vocabulary as readonly string[]).includes(value) ? (value as T) : null;
}
