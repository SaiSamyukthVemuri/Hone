// The Client Profile's price-free reads (Sam's ruling: no client price, session price or service price
// may be in a NON-OWNER's server payload for the profile; the loader must not fetch it, not just hide
// it). A non-owner's reads name their columns instead of selecting "*", so a price column cannot ride
// along. The lists are kept in step with the row types by tests/lib/clients/profile-pricing.test.ts.

/** sessions columns, every column of `Session` except `price_paid_cents`. */
export const SESSION_COLUMNS_WITHOUT_PRICE = [
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
].join(", ");

/** services columns, every column of `Service` except `price_cents`. */
export const SERVICE_COLUMNS_WITHOUT_PRICE = [
  "id",
  "studio_id",
  "name",
  "description",
  "default_duration_minutes",
  "active",
  "modality",
  "sort_order",
  "pre_care_instructions",
  "calendar_color",
  "created_at",
  "updated_at",
].join(", ");

export type ProfileReadOptions = {
  /** Owners only. Absent or false: no client pricing, session price or service price is fetched. */
  includePrices?: boolean;
};

/** The services column list for a read: "*" unless the caller must not carry the price. */
export function serviceSelect(options: ProfileReadOptions): string {
  return options.includePrices === false ? SERVICE_COLUMNS_WITHOUT_PRICE : "*";
}
