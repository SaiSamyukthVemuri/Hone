// ===========================================================================
// WAIT-ADMIT-01 — LEGACY WAITLIST IMPORT: VALIDATION AND CLASSIFICATION
// ===========================================================================
//
// A studio that ran its waitlist out of an email inbox has a list of people who
// have been waiting — sometimes for months — and almost none of the fields the
// durable record requires. This module decides, per row, whether that row can
// be imported truthfully. It writes nothing; it classifies.
//
// ---------------------------------------------------------------------------
// THE RULE THIS MODULE EXISTS TO ENFORCE
// ---------------------------------------------------------------------------
//
//     A FACT THE SOURCE DOES NOT CONTAIN IS NOT MANUFACTURED HERE.
//
// The temptation is specific and strong, because the schema makes each omission
// easy to paper over:
//
//   * `joined_at` is NOT NULL DEFAULT now(). Import a year-old prospect without
//     a date and the database cheerfully stamps today. Nothing errors. The
//     record now asserts they joined this morning, every "days waiting" figure
//     is wrong, and the ranking engine — which weights waiting time — acts on
//     it. This is the single most damaging fabrication available here, and it
//     is available BY DEFAULT.
//
//   * `name` is NOT NULL with CHECK (length(btrim(name)) >= 1). An email-only
//     row has no name, so an import must either be given one or invent one.
import { type ValidInstant } from "./validated";
//     "Unknown", the email local-part, "Legacy import" — each satisfies the
//     constraint and each is a fabricated identity sitting in the field a
//     practitioner reads before contacting a stranger.
//
// So both are classified as DECISIONS A HUMAN MUST MAKE, never filled in. A row
// missing either comes back `needs_decision` naming exactly what is absent.
//
// ---------------------------------------------------------------------------
// WHAT "TRUTHFUL" REQUIRES OF THE SCHEMA
// ---------------------------------------------------------------------------
//
// Recording an imported entry honestly needs somewhere to say "this join date
// came from an operator's records, not from our form" — and to say "we do not
// know when this person joined" without that becoming "today". Neither is
// expressible in the current table. This module therefore emits a
// `provenance` value per row describing what the source actually supported, and
// leaves persisting it to the schema work that follows.
//
// Pure: no I/O, no clock, no database. The caller injects `importedAt`.
// ===========================================================================

// JoinedAtProvenance is NOT re-exported. It has one home — ./provenance — and a
// second export site is how two modules end up disagreeing about a vocabulary.
import type { JoinedAtProvenance } from "./provenance";

/** The same shape the public form and the table CHECK both use. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mirrors new_client_waitlist_entries CHECK constraints exactly. */
export const IMPORT_EMAIL_MAX = 254;
export const IMPORT_NAME_MIN = 1;
export const IMPORT_NAME_MAX = 120;
export const IMPORT_PHONE_MAX = 40;

/** One row as it arrives from an operator's list. Every field untrusted. */
export type LegacyImportRow = {
  readonly email?: unknown;
  readonly name?: unknown;
  readonly phone?: unknown;
  /** ISO 8601, or absent. NEVER defaulted. */
  readonly joinedAt?: unknown;
};

export type NormalizedImportRow = {
  readonly email: string;
  readonly emailNormalized: string;
  readonly name: string;
  readonly phone: string | null;
  /**
   * The wait anchor. For `operator_supplied` this is the date the operator
   * asserts. For `unknown` it is the IMPORT INSTANT and means nothing about how
   * long the person has waited — `joinedAtProvenance` is the only thing that
   * says which, and every reader must consult it before showing a duration.
   */
  readonly joinedAt: Date;
  readonly joinedAtProvenance: JoinedAtProvenance;
};

/** Facts the row is missing that a human must supply before it can be stored. */
export type MissingFact = "name" | "joined_at";

export type ImportRowOutcome =
  | { readonly kind: "ready"; readonly rowIndex: number; readonly value: NormalizedImportRow }
  | {
      readonly kind: "needs_decision";
      readonly rowIndex: number;
      readonly emailNormalized: string;
      readonly missing: readonly MissingFact[];
      readonly detail: string;
    }
  | {
      readonly kind: "rejected";
      readonly rowIndex: number;
      readonly reason: string;
    }
  | {
      /**
       * A later row repeating an earlier row's normalized email.
       *
       * NOT merged. Two lines for one address may be a duplicate, or two people
       * sharing a mailbox, or a correction — and the source does not say which.
       * The database's own partial unique index permits only one active entry
       * per normalized email per studio, so silently merging here would pick a
       * winner the operator never chose.
       */
      readonly kind: "duplicate";
      readonly rowIndex: number;
      readonly emailNormalized: string;
      readonly firstSeenAtIndex: number;
    };

export type LegacyImportOptions = {
  /** VALIDATED at construction: the batch authority cannot be unreadable. */
  readonly importedAt: ValidInstant;
  /**
   * Permit rows whose join date is genuinely unrecoverable.
   *
   * DEFAULT FALSE, deliberately: the first pass should send the operator back
   * to their records, because a real date recovered is worth far more than a
   * row admitted without one. Setting it true is the operator saying "I have
   * looked and the date does not exist", and it is the ONLY way a dateless row
   * enters — it is never inferred from the row itself.
   *
   * Such a row is stored with the import instant in `joined_at` and
   * `joined_at_provenance = 'unknown'`. That combination is NOT a fabrication
   * ONLY BECAUSE the provenance travels with it: the ranking engine scores its
   * waiting-time factor as unknown rather than as one day, and the queue must
   * not render a duration. If a reader ever ignores the provenance column, the
   * date will look real — which is precisely why nothing in lib/waitlist reads
   * `joined_at` without it.
   */
  readonly allowUnknownJoinedAt?: boolean;
};

export type LegacyImportPlan = {
  readonly ready: readonly Extract<ImportRowOutcome, { kind: "ready" }>[];
  readonly needsDecision: readonly Extract<ImportRowOutcome, { kind: "needs_decision" }>[];
  readonly rejected: readonly Extract<ImportRowOutcome, { kind: "rejected" }>[];
  readonly duplicates: readonly Extract<ImportRowOutcome, { kind: "duplicate" }>[];
  /**
   * Normalized emails of every importable row, for the caller to check against
   * existing entries BEFORE writing.
   *
   * This module cannot answer "is this person already waiting?" — it has no
   * database. The authority is the partial unique index on
   * (studio_id, email_normalized) WHERE status IN ('waiting','claimed','invited').
   */
  readonly emailsToCheck: readonly string[];
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Parse an operator-supplied join date.
 *
 * Accepts only a value that parses to a real instant AND is not in the future
 * relative to the import. A future join date is not a plausible historical fact
 * and is far more likely a mis-parsed day/month order than a real one, so it is
 * refused rather than stored.
 */
function parseJoinedAt(
  raw: unknown,
  importedAt: Date,
): { ok: true; value: Date } | { ok: false; reason: string } | null {
  const asText = text(raw);
  if (asText.length === 0) return null; // absent — a decision, not an error
  const parsed = new Date(asText);
  const ms = parsed.getTime();
  if (!Number.isFinite(ms)) {
    return { ok: false, reason: `join date "${asText}" is not a valid date` };
  }
  if (ms > importedAt.getTime()) {
    return { ok: false, reason: `join date "${asText}" is in the future` };
  }
  return { ok: true, value: parsed };
}

/**
 * Classify one batch of legacy rows.
 *
 * Order is preserved and every row is reported exactly once, so an operator can
 * reconcile the output against their source line by line. `rowIndex` is the
 * 0-based position in the input.
 */
export function planLegacyWaitlistImport(
  rows: readonly LegacyImportRow[],
  options: LegacyImportOptions,
): LegacyImportPlan {
  // THE IMPORT CLOCK IS BATCH AUTHORITY, and it is validated at CONSTRUCTION
  // rather than here: `importedAt` is a ValidInstant, so a batch whose
  // authority cannot be read is unconstructable. Every row's chronology is
  // measured against this instant — parseJoinedAt refuses a future date with
  // `ms > importedAt.getTime()`, and an unrecoverable date is anchored to it —
  // so an unreadable one made that comparison NaN, always false, and the
  // future-date refusal stopped existing. Reproduced: 2099-01-01 came back
  // `ready` carrying provenance 'operator_supplied'.
  const allowUnknown = options.allowUnknownJoinedAt === true;
  const ready: Extract<ImportRowOutcome, { kind: "ready" }>[] = [];
  const needsDecision: Extract<ImportRowOutcome, { kind: "needs_decision" }>[] = [];
  const rejected: Extract<ImportRowOutcome, { kind: "rejected" }>[] = [];
  const duplicates: Extract<ImportRowOutcome, { kind: "duplicate" }>[] = [];
  const seen = new Map<string, number>();

  rows.forEach((row, rowIndex) => {
    const emailRaw = text(row.email);
    if (emailRaw.length === 0) {
      rejected.push({ kind: "rejected", rowIndex, reason: "email is required" });
      return;
    }
    if (emailRaw.length > IMPORT_EMAIL_MAX) {
      rejected.push({ kind: "rejected", rowIndex, reason: "email exceeds 254 characters" });
      return;
    }
    const emailNormalized = emailRaw.toLowerCase();
    if (!EMAIL_RE.test(emailNormalized)) {
      rejected.push({ kind: "rejected", rowIndex, reason: "email is not a valid address" });
      return;
    }

    const firstSeen = seen.get(emailNormalized);
    if (firstSeen !== undefined) {
      duplicates.push({
        kind: "duplicate",
        rowIndex,
        emailNormalized,
        firstSeenAtIndex: firstSeen,
      });
      return;
    }
    seen.set(emailNormalized, rowIndex);

    const phoneRaw = text(row.phone);
    if (phoneRaw.length > IMPORT_PHONE_MAX) {
      rejected.push({ kind: "rejected", rowIndex, reason: "phone exceeds 40 characters" });
      return;
    }

    const name = text(row.name);
    if (name.length > IMPORT_NAME_MAX) {
      rejected.push({ kind: "rejected", rowIndex, reason: "name exceeds 120 characters" });
      return;
    }

    const joined = parseJoinedAt(row.joinedAt, options.importedAt);
    if (joined !== null && !joined.ok) {
      rejected.push({ kind: "rejected", rowIndex, reason: joined.reason });
      return;
    }

    // BOTH GAPS ARE REPORTED TOGETHER. Fixing them one at a time means two
    // passes over the same list; an operator wants to know everything a row
    // needs before they go back to their records.
    const missing: MissingFact[] = [];
    // NAME IS NEVER WAIVED. There is no `allowUnknownName` counterpart to the
    // date option, because the column is NOT NULL and the honest alternatives
    // are all fabrications: the email local part, "Unknown", a placeholder. An
    // operator supplies a real name or the row does not import.
    if (name.length < IMPORT_NAME_MIN) missing.push("name");
    if (joined === null && !allowUnknown) missing.push("joined_at");

    if (missing.length > 0) {
      needsDecision.push({
        kind: "needs_decision",
        rowIndex,
        emailNormalized,
        missing,
        detail: missing
          .map((m) =>
            m === "name"
              ? "no name in source — the table requires one and this module will not invent it"
              : "no join date in source — importing without one would stamp today and erase the real wait",
          )
          .join("; "),
      });
      return;
    }

    ready.push({
      kind: "ready",
      rowIndex,
      value: {
        email: emailNormalized,
        emailNormalized,
        name,
        phone: phoneRaw.length === 0 ? null : phoneRaw,
        joinedAt: joined === null ? options.importedAt : joined.value,
        joinedAtProvenance: joined === null ? "unknown" : "operator_supplied",
      },
    });
  });

  return {
    ready,
    needsDecision,
    rejected,
    duplicates,
    emailsToCheck: ready.map((r) => r.value.emailNormalized),
  };
}

/**
 * A one-line, PII-light summary of a plan.
 *
 * Counts only — no addresses — so it is safe in a log line or a ticket. The
 * per-row detail stays in the plan, which the operator reads on screen.
 */
export function summariseImportPlan(plan: LegacyImportPlan): string {
  const undated = plan.ready.filter((r) => r.value.joinedAtProvenance === "unknown").length;
  return [
    `${plan.ready.length} ready${undated > 0 ? ` (${undated} with no known join date)` : ""}`,
    `${plan.needsDecision.length} need a decision`,
    `${plan.duplicates.length} duplicate`,
    `${plan.rejected.length} rejected`,
  ].join(", ");
}
