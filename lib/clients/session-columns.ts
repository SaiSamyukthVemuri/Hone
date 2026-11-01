// The `sessions` columns the client profile reads, split by who may be sent them.
//
// RBAC G-1 / Sam decision 2: a practitioner must not receive what a client has
// paid. HIDING the figure in the page is not enough (it would still sit in the
// RSC payload), so the non-owner read never SELECTs the financial column at all.
//
// PostgREST cannot say "every column except one", so the non-owner read names its
// columns. tests/db/sessions-columns-split.db.test.ts compares this list with the
// live table, so a column added later cannot silently drop out of the profile
// (or, worse, a new financial column ride along in the owner list unnoticed).

export const SESSION_FINANCIAL_COLUMNS = ["price_paid_cents"] as const;

export const SESSION_NON_FINANCIAL_COLUMNS = [
  "id",
  "studio_id",
  "client_id",
  "practitioner_id",
  "performed_by_practitioner_id",
  "modality",
  "started_at",
  "started_at_original",
  "ended_at",
  "session_notes",
  "created_at",
  "record_status",
  "record_origin",
  "legacy_classification",
  "finalized_at",
  "finalized_by",
  "record_version",
  "current_snapshot_id",
  "deleted_at",
  "deleted_by",
  "delete_reason",
  "treatment_plan_id",
  "appointment_id",
  "next_session_note",
  "aftercare_and_risks_explained_at",
  "aftercare_and_risks_explained_by",
] as const;

const ENTRIES = "electrolysis_entries(*), laser_entries(*)";

/** The `.select()` string for a client's sessions. Non-owners never name the price column. */
export function clientSessionsSelect(includeFinancials: boolean): string {
  return includeFinancials
    ? `*, ${ENTRIES}`
    : `${SESSION_NON_FINANCIAL_COLUMNS.join(", ")}, ${ENTRIES}`;
}
