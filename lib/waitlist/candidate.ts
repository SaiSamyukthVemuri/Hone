import {
  parseAvailabilityPreference,
  statedAvailability,
  UNSTATED_AVAILABILITY,
  type CandidateAvailability,
} from "./preferences";
import {
  UNSTATED_SERVICE_INTEREST,
  type ScoringCandidate,
  type ServiceInterest,
} from "./scoring";

// ===========================================================================
// WAIT-ADMIT-01 — PERSISTED ROW -> SCORING CANDIDATE
// ===========================================================================
//
// The adapter between a `new_client_waitlist_entries` row and the shape the
// ranking engine consumes. Written BEFORE the preference columns exist, and
// correct both before and after they are added — which is the point.
//
// TODAY the columns are absent from every row, so every candidate comes back
// with UNSTATED availability and UNSTATED service interest. That is not a
// degraded mode: it is the truthful description of 17 waiting prospects nobody
// has asked yet, and the engine already handles it (`unknownPolicy`). The
// ranking that results is FIFO, which is exactly what production does now.
//
// AFTER the migration the same function reads the same rows and starts seeing
// stated preferences as studios collect them. No second adapter, no flag, no
// branch on schema version — an absent field and a null field are treated
// identically because they mean the same thing: not stated.
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
// ===========================================================================

/**
 * The columns this adapter reads. Deliberately a STRUCTURAL type, not the
 * generated database row: the preference fields are optional here, so this
 * compiles against today's schema and tomorrow's without edit.
 */
export type WaitlistEntryRow = {
  readonly id: string;
  readonly joined_at: string | Date | null;
  /** Added by the pending migration. Absent today; null = not stated. */
  readonly availability_preference?: string | null;
  /** Added by the pending migration. Absent today; empty = not stated. */
  readonly service_interest_ids?: readonly string[] | null;
};

export type CandidateProjection = {
  readonly candidates: readonly ScoringCandidate[];
  /** Rows that could not be read truthfully, with the reason. Never dropped. */
  readonly skipped: readonly { readonly entryId: string; readonly reason: string }[];
};

function readJoinedAt(value: string | Date | null | undefined): Date | null {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value : null;
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
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
 * Project stored rows into ranking candidates.
 *
 * Input order is preserved in `candidates`; the engine imposes its own total
 * order, so this function never sorts.
 */
export function projectCandidates(
  rows: readonly WaitlistEntryRow[],
): CandidateProjection {
  const candidates: ScoringCandidate[] = [];
  const skipped: { entryId: string; reason: string }[] = [];

  for (const row of rows) {
    const joinedAt = readJoinedAt(row.joined_at);
    if (joinedAt === null) {
      skipped.push({ entryId: row.id, reason: "joined_at is missing or unreadable" });
      continue;
    }
    candidates.push({
      entryId: row.id,
      joinedAt,
      availability: readAvailability(row.availability_preference),
      serviceInterest: readServiceInterest(row.service_interest_ids),
    });
  }

  return { candidates, skipped };
}
