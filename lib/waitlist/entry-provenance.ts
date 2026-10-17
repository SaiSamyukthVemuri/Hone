// WAIT-04A. How an entry GOT here, and what the queue may therefore claim
// about it.
//
// ===========================================================================
// WHY THIS MODULE EXISTS
// ===========================================================================
//
// Migration 0193 added two columns that together decide what a reader is
// ALLOWED to say about a waitlist row:
//
//   source               'public_booking' | 'practitioner' | 'legacy_import'
//   joined_at_provenance 'form' | 'operator_supplied' | 'unknown'
//
// and bound them to each other with a CHECK: only `public_booking` may claim
// `form`. Every other origin must say `operator_supplied` or `unknown`.
//
// THE RULE THAT MAKES THIS A MODULE RATHER THAN TWO LABELS. 0193's import
// command stamps `joined_at` with the import instant when the provenance is
// `unknown`, because a row still needs a position in the (joined_at, id) total
// order. Its own comment states the consequence outright:
//
//     "joined_at_provenance stays 'unknown', so no reader may render it as a
//      wait"
//
// The queue today renders `Joined <date> · N days waiting` for every row
// unconditionally. That is correct while every row came from the form — which
// was true until this slice — and becomes a FABRICATION the moment an imported
// row appears: it would report a stranger's import timestamp as the day they
// joined, and a wait of zero days for someone who has been waiting since
// before Hone existed.
//
// So the display decision is derived HERE, once, from the provenance, rather
// than being a formatting choice made at the call site. A renderer that
// receives a `JoinedAtClaim` cannot accidentally assert a wait, because the
// `unknown` case carries no date to render.
//
// Pure module: no I/O, no database, no server-only import.

/** Every `source` value 0193's CHECK permits. */
export const ENTRY_SOURCES = ["public_booking", "practitioner", "legacy_import"] as const;
export type EntrySource = (typeof ENTRY_SOURCES)[number];

/** Every `joined_at_provenance` value 0193's CHECK permits. */
export const JOINED_AT_PROVENANCES = ["form", "operator_supplied", "unknown"] as const;
export type JoinedAtProvenance = (typeof JOINED_AT_PROVENANCES)[number];

export function isEntrySource(value: unknown): value is EntrySource {
  return typeof value === "string" && (ENTRY_SOURCES as readonly string[]).includes(value);
}

export function isJoinedAtProvenance(value: unknown): value is JoinedAtProvenance {
  return (
    typeof value === "string" && (JOINED_AT_PROVENANCES as readonly string[]).includes(value)
  );
}

/**
 * WHAT THE QUEUE MAY CLAIM about when this person joined.
 *
 * Three cases, and the third deliberately carries NO date. A caller cannot
 * render a wait it was not given, which is the whole point of returning a
 * discriminated union instead of `{ joinedAt, provenance }` and trusting every
 * renderer to branch correctly.
 */
export type JoinedAtClaim =
  /** The public form stamped it as it happened. The strongest claim; a wait may be shown. */
  | { kind: "observed"; joinedAt: string }
  /**
   * A human asserted it from their own records. The date is as good as their
   * records and is shown AS an assertion — a wait may be computed from it,
   * because the studio is standing behind the date.
   */
  | { kind: "asserted"; joinedAt: string }
  /**
   * Nobody has a date. `joined_at` holds the import instant purely to give the
   * row a position, and it is NOT a join date. No date, no wait, no ordinal.
   */
  | { kind: "unknown" };

/**
 * Derive the claim. UNRECOGNISED PROVENANCE FAILS TO `unknown`, never to
 * `observed`: a value this build does not know about is exactly the case where
 * guessing produces a confident false statement, and `unknown` is the only
 * branch that asserts nothing.
 */
export function joinedAtClaim(
  provenance: string | null | undefined,
  joinedAt: string | null | undefined,
): JoinedAtClaim {
  if (typeof joinedAt !== "string" || joinedAt.length === 0) return { kind: "unknown" };
  if (provenance === "form") return { kind: "observed", joinedAt };
  if (provenance === "operator_supplied") return { kind: "asserted", joinedAt };
  return { kind: "unknown" };
}

/**
 * May this row be rendered as a WAIT — a date plus an elapsed time?
 *
 * Exposed separately because the queue computes `daysWaiting` before it has a
 * claim in hand, and a boolean at that point is clearer than reconstructing the
 * union. Both answers are derived from the same predicate so they cannot drift.
 */
export function mayRenderAsWait(claim: JoinedAtClaim): claim is
  | { kind: "observed"; joinedAt: string }
  | { kind: "asserted"; joinedAt: string } {
  return claim.kind !== "unknown";
}

/**
 * The note that appears beside an asserted or unknown date, or `null` for the
 * form case.
 *
 * `null` FOR `observed` IS DELIBERATE. Annotating every ordinary row with "from
 * the booking form" would bury the two cases that actually need a caveat in
 * noise, and the unannotated row is already the one the reader assumes.
 */
export function joinedAtNote(claim: JoinedAtClaim): string | null {
  switch (claim.kind) {
    case "observed":
      return null;
    case "asserted":
      return "from studio records";
    case "unknown":
      return "join date unknown";
  }
}

/** What the queue says when it has no date to show. Never a zero, never a dash. */
export const UNKNOWN_JOINED_AT_COPY =
  "Join date unknown — listed from studio records";

/**
 * How this person reached the waitlist, in the practitioner's language.
 *
 * `public_booking` returns `null` for the same reason `observed` does: it is
 * the default every reader already assumes, and labelling it would make the
 * two exceptional origins harder to spot rather than easier.
 */
export function originLabel(source: string | null | undefined): string | null {
  switch (source) {
    case "practitioner":
      return "Added by the studio";
    case "legacy_import":
      return "From studio records";
    default:
      return null;
  }
}
