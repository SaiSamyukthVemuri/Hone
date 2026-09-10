import {
  parseAvailabilityPreference,
  statedAvailability,
  UNSTATED_AVAILABILITY,
  type CandidateAvailability,
} from "./preferences";
import {
  classifyPreferenceFreshness,
  NEVER_STALE,
  preferenceIsActionable,
  type PreferenceFreshness,
  type StalenessPolicy,
} from "./confirmation";
import {
  AVAILABILITY_SOURCES,
  JOINED_AT_PROVENANCES,
  joinedAtSupportsDuration,
  parseVocabulary,
  type AvailabilitySource,
  type JoinedAtProvenance,
} from "./provenance";
import {
  UNSTATED_SERVICE_INTEREST,
  type ScoringCandidate,
  type ServiceInterest,
} from "./scoring";
import {
  optionalInstant,
  type DisabledStalenessPolicy,
  type ValidInstant,
} from "./validated";

// ===========================================================================
// WAIT-ADMIT-01 — PERSISTED ROW -> SCORING CANDIDATE
// ===========================================================================
//
// The adapter between a `new_client_waitlist_entries` row and the shape the
// ranking engine consumes. Written BEFORE the preference columns exist, and
// correct both before and after they are added — which is the point.
//
// TODAY every one of the added columns is absent from every row, so every
// candidate comes back with UNSTATED availability and UNSTATED service
// interest. That is not a degraded mode: it is the truthful description of 17
// waiting prospects nobody has asked yet, and the engine already handles it
// (`unknownPolicy`). The ranking that results is FIFO, which is exactly what
// production does now.
//
// AFTER the consolidated schema lands the same function reads the same rows and
// starts seeing stated preferences. No second adapter, no flag, no branch on
// schema version — an absent field and a null field are treated identically
// because they mean the same thing: not stated.
//
// ---------------------------------------------------------------------------
// STALENESS IS DECIDED HERE, NOT IN THE ENGINE
// ---------------------------------------------------------------------------
//
// A preference confirmed two years ago is real but no longer reliable. Deciding
// that at READ time keeps the engine's contract to the one question it should
// answer — stated or not — instead of giving it a clock and a second notion of
// "sort of stated". A stale preference therefore arrives at the engine as an
// ordinary unstated one, and the studio's own `unknownPolicy` decides what
// happens to it. One rule for missing evidence, not two.
//
// The default is NEVER_STALE. Expiring an honest answer has a real cost, and no
// studio should acquire that behaviour by upgrading.
//
// ---------------------------------------------------------------------------
// IT DROPS CONTACT DETAIL ON THE FLOOR
// ---------------------------------------------------------------------------
//
// A row carries name, email, email_normalized and phone. None of them crosses
// into a ScoringCandidate. This is the narrowing that lets the explanation
// output be safe to log and paste: the engine cannot leak what it was never
// given, and the guarantee is enforced here, once, rather than trusted at every
// call site.
//
// ---------------------------------------------------------------------------
// A ROW IT CANNOT READ TRUTHFULLY IS SKIPPED, NOT GUESSED
// ---------------------------------------------------------------------------
//
// A missing or unparseable `joined_at` is the one field with no honest default:
// substituting `now()` would claim the person joined today, which is the same
// fabrication the legacy importer refuses. Such a row is returned as `skipped`
// with its id, so the caller can surface it rather than silently ranking a
// short cohort.
//
// An entry whose `joined_at_provenance` is 'unknown' is a DIFFERENT case and is
// NOT skipped: the person is really waiting and belongs in the queue. What is
// unknown is how long, so the projection marks the duration unusable and the
// caller must not render one.
// ===========================================================================

/**
 * The columns this adapter reads. Deliberately a STRUCTURAL type, not the
 * generated database row: every field the consolidated schema adds is optional
 * here, so this compiles and behaves correctly against today's schema and
 * tomorrow's without edit.
 */
export type WaitlistEntryRow = {
  readonly id: string;
  readonly joined_at: string | Date | null;
  readonly joined_at_provenance?: string | null;
  readonly availability_preference?: string | null;
  readonly availability_stated_at?: string | Date | null;
  readonly availability_confirmed_at?: string | Date | null;
  readonly availability_source?: string | null;
  /** Not in the consolidated proposal; tolerated so the factor can light up later. */
  readonly service_interest_ids?: readonly string[] | null;
};

/** Everything about one row that the queue UI needs and the engine must not see. */
export type CandidateProvenance = {
  readonly entryId: string;
  readonly joinedAtProvenance: JoinedAtProvenance;
  /** False when joined_at_provenance is 'unknown' — do NOT render a duration. */
  readonly durationIsMeaningful: boolean;
  readonly availabilitySource: AvailabilitySource | null;
  readonly freshness: PreferenceFreshness | null;
};

export type CandidateProjection = {
  readonly candidates: readonly ScoringCandidate[];
  /** Parallel provenance, keyed by entry id. Never passed to the engine. */
  readonly provenance: readonly CandidateProvenance[];
  /** Rows that could not be read truthfully, with the reason. Never dropped. */
  readonly skipped: readonly { readonly entryId: string; readonly reason: string }[];
};

/**
 * Staleness and the clock travel together — expressed by which BRANCH a caller
 * lands in, not by narrowing the policy type.
 *
 * THE FIRST SHAPE MADE BOTH INDEPENDENTLY OPTIONAL, so
 * `{ staleness: { maxAgeDays: 90 } }` with no `now` type-checked AND ran,
 * quietly reporting every preference fresh. A studio that had decided its
 * answers expire after 90 days would have got no staleness at all.
 *
 * THE SECOND SHAPE OVERCORRECTED: it demanded a literal `maxAgeDays`, so an
 * ordinary caller holding a runtime-loaded policy —
 *
 *     const policy: StalenessPolicy = loadPolicy();
 *     projectCandidates(rows, { now, staleness: policy });
 *
 * — was rejected even though it supplies the clock. Refusing a correct caller
 * is its own defect; the clock is what the rule is actually about.
 *
 * So the discriminator is the CLOCK:
 *
 *   now present  -> ANY StalenessPolicy, dynamic or literal. There is a clock
 *                   to measure against, so `number | null` is fine.
 *   now absent   -> only staleness that is STATICALLY known to be disabled.
 *                   A `number | null` cannot be admitted here: the compiler
 *                   cannot rule out the finite case, which is the one that
 *                   silently did nothing.
 *
 * The runtime refusal in projectCandidates stays regardless, for a policy the
 * types never saw — absent is a decision, incomplete is an error.
 */
export type ProjectionOptions =
  | {
      /** A clock is supplied, so any VALIDATED policy is evaluable. */
      readonly now: ValidInstant;
      readonly staleness?: StalenessPolicy;
    }
  | {
      /** No clock: only staleness the compiler can see is disabled. */
      readonly now?: undefined;
      readonly staleness?: DisabledStalenessPolicy;
    };

/**
 * Read an instant off a database row.
 *
 * This is the ROW-side constructor: it already refused an unreadable value, so
 * it now says so in its type. A row that cannot be read yields null and the
 * caller decides what that means — never a substituted clock.
 */
function readInstant(value: string | Date | null | undefined): ValidInstant | null {
  return optionalInstant(value);
}

/**
 * Read a stored availability value.
 *
 * An UNRECOGNISED string is treated as NOT STATED, not as an error and not as a
 * guess. The column's CHECK constraint is the authority on what is storable; if
 * something outside the vocabulary is nonetheless present — an older value, a
 * hand-edited row — the honest reading is that this code does not know what the
 * person said, which is precisely `stated: false`.
 */
export function readAvailability(raw: unknown): CandidateAvailability {
  const parsed = parseAvailabilityPreference(raw);
  return parsed === null ? UNSTATED_AVAILABILITY : statedAvailability(parsed);
}

/** An absent, null or EMPTY service list is "not stated", never "wants nothing". */
export function readServiceInterest(raw: readonly string[] | null | undefined): ServiceInterest {
  if (!Array.isArray(raw)) return UNSTATED_SERVICE_INTEREST;
  const ids = raw.filter((id): id is string => typeof id === "string" && id.length > 0);
  return ids.length === 0 ? UNSTATED_SERVICE_INTEREST : { stated: true, serviceIds: ids };
}

/**
 * Read `joined_at_provenance`.
 *
 * Absent means 'form': today the table's own CHECK admits only
 * source='public_booking', so every existing row demonstrably came through the
 * public form. This is a fact about the current data, not an assumption — and
 * it is the same argument that justifies the column's DEFAULT in the proposed
 * schema. An unrecognised stored value falls back to 'unknown', which is the
 * conservative reading: it suppresses the duration rather than asserting one.
 */
export function readJoinedAtProvenance(raw: unknown): JoinedAtProvenance {
  if (raw === undefined || raw === null) return "form";
  return parseVocabulary(raw, JOINED_AT_PROVENANCES) ?? "unknown";
}

/**
 * Project stored rows into ranking candidates plus their provenance.
 *
 * Input order is preserved; the engine imposes its own total order, so this
 * function never sorts.
 */
export function projectCandidates(
  rows: readonly WaitlistEntryRow[],
  options: ProjectionOptions = {},
): CandidateProjection {
  const staleness: StalenessPolicy = options.staleness ?? NEVER_STALE;
  /** Non-null exactly when a finite cap is in force; see the refusal below. */
  let clock: ValidInstant | null = null;

  // FAIL CLOSED ON AN INCOMPLETE POLICY. The type above stops this at a literal
  // call site; a policy built at runtime can still arrive with a finite cap and
  // no clock, and the old code answered that by quietly reporting everything
  // fresh. Refusing is the only honest answer: the caller asked for staleness
  // and would otherwise have received none.
  if (staleness.maxAgeDays !== null) {
    if (options.now === undefined) {
      throw new Error(
        "projectCandidates: staleness.maxAgeDays is set but `now` was not supplied; " +
          "a finite staleness policy cannot be evaluated without a clock",
      );
    }
    // BOUND HERE, WHERE THE COMPILER CAN SEE IT. The previous shape re-read
    // `options.now` inside the loop and needed an `as Date` to convince tsc it
    // was defined -- an assertion standing in for a fact the code had already
    // established. Binding it at the point of the refusal makes the narrowing
    // real, so nothing downstream asserts anything.
    clock = options.now;
    // THE CAP AND THE CLOCK ARE NO LONGER CHECKED HERE, and that is the repair
    // rather than a regression: neither can be unreadable, because neither can
    // be CONSTRUCTED unreadable. `stalenessPolicy()` and `instant()` own that,
    // once each, and every path into a comparison runs through them.
    //
    // WHAT SURVIVES IS A DIFFERENT RULE. "A finite cap with no clock" is not a
    // question about either operand's validity — both may be perfectly valid —
    // it is a question about the PAIR. The union above states it to the
    // compiler; this states it to a caller the types never saw. Absent is a
    // decision, incomplete is an error.
  }
  const candidates: ScoringCandidate[] = [];
  const provenance: CandidateProvenance[] = [];
  const skipped: { entryId: string; reason: string }[] = [];

  for (const row of rows) {
    const joinedAt = readInstant(row.joined_at);
    if (joinedAt === null) {
      skipped.push({ entryId: row.id, reason: "joined_at is missing or unreadable" });
      continue;
    }

    const joinedAtProvenance = readJoinedAtProvenance(row.joined_at_provenance);
    const stored = readAvailability(row.availability_preference);
    const availabilitySource = parseVocabulary(row.availability_source, AVAILABILITY_SOURCES);

    let availability = stored;
    let freshness: PreferenceFreshness | null = null;

    if (stored.stated) {
      const statedAt = readInstant(row.availability_stated_at);
      const confirmedAt = readInstant(row.availability_confirmed_at) ?? statedAt;

      if (statedAt === null || confirmedAt === null) {
        // A PREFERENCE WITH NO STAMP CANNOT BE AGED, so it cannot be trusted as
        // a current answer. The proposed schema forbids this pairing outright;
        // encountering it means the row predates that rule or was written
        // around it, and reading it as unstated is the conservative answer.
        availability = UNSTATED_AVAILABILITY;
        freshness = { kind: "inconsistent", detail: "preference stored without a timestamp" };
      } else {
        if (clock === null) {
          // Nothing can go stale, so no clock is needed and none is invented.
          freshness = { kind: "fresh", ageDays: 0 };
        } else {
          freshness = classifyPreferenceFreshness(
            {
              preference: stored.preference,
              statedAt,
              confirmedAt,
              source: availabilitySource ?? "public_form",
            },
            clock,
            staleness,
          );
        }
        if (!preferenceIsActionable(freshness)) availability = UNSTATED_AVAILABILITY;
      }
    }

    candidates.push({
      entryId: row.id,
      joinedAt,
      // The provenance flag becomes a RANKING input here, not just a display
      // hint: an entry whose join date nobody has must not be scored on a wait
      // it never had.
      waitIsMeasurable: joinedAtSupportsDuration(joinedAtProvenance),
      availability,
      serviceInterest: readServiceInterest(row.service_interest_ids),
    });

    provenance.push({
      entryId: row.id,
      joinedAtProvenance,
      durationIsMeaningful: joinedAtSupportsDuration(joinedAtProvenance),
      availabilitySource,
      freshness,
    });
  }

  return { candidates, provenance, skipped };
}
