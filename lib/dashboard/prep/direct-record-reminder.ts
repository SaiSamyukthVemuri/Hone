// THE WITNESS: the only way to say that something was not recorded.
//
// WHY THIS MODULE EXISTS
// ----------------------
// Five consecutive review rounds on PR #608 found the same defect, five times,
// in five different strings:
//
//   a bounded / capped / sliced / partially-read collection loses rows
//     -> the missing rows are interpreted as ABSENCE
//     -> the Dashboard renders a confident negative clinical statement
//
// Each round was closed by proving one more string safe, or by adding one more
// completeness boolean (`hasHistory`, then `briefingComplete`) whose job was to
// license the prose. That model does not converge: it requires every future
// negative claim to be re-proved against every future narrowing operation, and
// round 5 arrived through a path round 4's flag did not describe.
//
// So this is not another guard. It is a TYPE that makes the unsafe claim
// unspellable.
//
// THE DISTINCTION IT ENCODES
// --------------------------
// (A) AUTHORITATIVE FIELD VALUE IS NULL. We loaded the exact row and read its
//     own scalar column. "Probe lot missing" is then a fact about a record we
//     hold in our hand.
//
// (B) A CHILD / COLLECTION ROW WAS NOT RETURNED. `session_blocks` came back
//     without a row for this session. That proves NOTHING about the domain: the
//     read may have been capped (PostgREST `max_rows`, supabase/config.toml),
//     sliced (a per-client window), filtered, or failed with its error
//     discarded. "Treatment area not recorded" is not licensed by it.
//
// HOW THE TYPE ENFORCES IT
// ------------------------
// A witness requires a ROW WITH A PRIMARY KEY. That single requirement is the
// whole architecture, because none of the shapes that caused the five failures
// can produce one:
//
//   blocks.length === 0             -> a number.    No `id`.
//   blocksBySession.get(id) ?? []   -> an array.    No `id`.
//   a missing Map entry             -> undefined.   No `id`.
//   a capped / sliced collection    -> a list.      No `id`.
//
// You cannot pass any of them to `directRecordReminder`. The compiler stops
// you, and if it did not, the runtime null-check below reads a scalar off a row
// that does not exist and refuses.
//
// Pure. No I/O. Client-safe.

/**
 * A row that came back from the database. Its primary key IS the proof of that:
 * PostgREST cannot return an `id` for a row it did not return.
 */
export type AuthoritativeRow = { id: string };

/**
 * Proof that ONE authoritative row was read and ONE named scalar field on it
 * was observed null.
 *
 * `field` deliberately excludes `id`: the key proves the row exists, so a null
 * key is a contradiction rather than a missing-record fact.
 */
export type FieldNullWitness<TRow extends AuthoritativeRow> = {
  /** The row as it came back. Holding it is the evidence. */
  readonly row: TRow;
  /** The scalar column observed null ON THAT ROW. */
  readonly field: Exclude<keyof TRow & string, "id">;
};

// The brand is module-private and NOT exported, so no other module can
// construct a DirectRecordReminder by writing an object literal. The only
// public door is `directRecordReminder` below, and it demands a witness.
declare const DIRECT_RECORD_REMINDER: unique symbol;

/**
 * A practitioner-visible missing-record line that is licensed by an observed
 * field null on an observed row.
 *
 * `sourceField` is carried so a test (and a reviewer) can assert WHICH scalar
 * licensed the sentence, rather than trusting the copy.
 */
export type DirectRecordReminder = {
  readonly [DIRECT_RECORD_REMINDER]: true;
  /** The chip text. Deliberately carries no superlative — see below. */
  readonly text: string;
  /** The authoritative row's table and the scalar read on it, e.g. "sessions.aftercare_and_risks_explained_at". */
  readonly sourceField: string;
};

/**
 * A value counts as "not recorded" when the column is null/undefined, or is a
 * string the practitioner left blank.
 *
 * `0` and `false` are NOT absent: a recorded zero is a measurement, and
 * flattening it with a falsy check is the mistake `compactSummary` and
 * `outcomeRecorded` already avoid elsewhere in this codebase.
 */
function observedNull(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  return typeof value === "string" && value.trim() === "";
}

/**
 * Build a missing-record reminder, or return null when the field was in fact
 * recorded.
 *
 * THE COPY MUST NOT CARRY A SUPERLATIVE. "Aftercare not marked" is licensed by
 * the scalar. "Aftercare not marked ON THE LAST SESSION" additionally asserts
 * that this row IS the last session, which is a claim about a selection made
 * over a collection — exactly what the witness does not prove. Callers pass the
 * scoped wording; this function has no opinion about which record it is.
 */
export function directRecordReminder<TRow extends AuthoritativeRow>(
  witness: FieldNullWitness<TRow>,
  text: string,
  sourceField: string,
): DirectRecordReminder | null {
  // Defensive: a caller who defeats the type (a cast, an `any`) still cannot
  // get a sentence out of a value that is not a row carrying a key.
  if (!witness.row || typeof witness.row.id !== "string" || witness.row.id === "") {
    return null;
  }
  if (!observedNull(witness.row[witness.field])) return null;
  return { text, sourceField } as DirectRecordReminder;
}
