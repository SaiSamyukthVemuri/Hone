import {
  CLINICAL_NOTES_CSV_FILENAME,
  CLINICAL_NOTES_CSV_HEADERS,
} from "@/lib/export/clinical-notes";

// ===========================================================================
// THE EXPORT RESOURCE REGISTRY - TRUTH-01A
// ===========================================================================
//
// THE DEFECT THIS FILE EXISTS TO CLOSE. The studio data export was an IMPLICIT
// allowlist: whatever somebody remembered to add. Nothing anywhere was required
// to have an opinion about a table, so every migration that created one widened
// the gap in silence, and the product went on describing the result as a full
// export. The gap was not that anyone decided wrongly. It was that nothing
// forced a decision at all.
//
// So this registry is not another inventory. It is the ONE place a resource's
// export disposition is decided, and the guards beside it make a missing
// decision a BUILD FAILURE rather than a discovery someone makes years later
// while leaving.
//
// THREE DISPOSITIONS, AND EVERY RESOURCE HAS EXACTLY ONE:
//
//   exported   it is in the ZIP. The entry states the file, the emitted
//              headers, which of the table's columns reach that file, which do
//              NOT and why, which ROWS are in scope, and whether the row count
//              is verified against the database.
//
//   excluded   a decision, on the record, with the reason. Secrets, platform
//              records, machine-derived projections, tables no code writes, and
//              the two note tables the product deliberately withholds.
//
//   pending    studio-owned, NOT exported, and nobody is pretending otherwise.
//              Carries the ticket, a tier, and the exact reason. A pending
//              entry is the honest state of a gap; it is not permission to keep
//              the gap quiet, and the Data settings page renders it.
//
// WHAT THIS SLICE DELIBERATELY DOES NOT DO. It adds no file, no table and no
// column to the export. The payload is byte-for-byte what it was. TRUTH-01A
// makes the completeness of that payload MACHINE ACCOUNTABLE; TRUTH-01B and
// TRUTH-01C change it.
//
// SCHEMA AUTHORITY IS THE DATABASE, NOT THIS FILE. The guards below take the
// live resource and column lists as arguments; tests/db/export-resource-
// registry.db.test.ts supplies them by introspecting information_schema on the
// fully migrated LOCAL Supabase stack. Nothing here parses migration SQL: a
// migration can rename, drop, guard with IF EXISTS or act procedurally, and a
// text scan would confidently miss all four.

// ---------------------------------------------------------------------------
// THE CUSTOMER-RESOURCE UNIVERSE - the rule, written down so it is reviewable
// ---------------------------------------------------------------------------
//
// A resource needs a disposition when it is a BASE TABLE in schema `public`, or
// a bucket in Supabase Storage. Everything else is outside the universe:
//
//   * Other schemas (auth, storage, realtime, supabase_migrations,
//     supabase_functions, extensions, graphql, graphql_public, net, vault, and
//     the pg_* catalogs) are PROVISIONED BY THE PLATFORM, not by this
//     repository's migrations. Hone does not own their shape, cannot promise
//     their stability, and a studio does not own their contents. The one
//     exception is storage BUCKETS, which hold studio files and are therefore
//     enumerated as resources in their own right.
//   * Views and materialized views are excluded because they are projections of
//     base tables that already carry a disposition; exporting both would be
//     exporting the same fact twice.
//
// Bucket resources are namespaced `storage:<bucket id>` so a bucket can never
// silently collide with a table of the same name.
export const CUSTOMER_RESOURCE_SCHEMA = "public" as const;
export const STORAGE_RESOURCE_PREFIX = "storage:" as const;

/**
 * Schemas that are outside the customer-resource universe, and why.
 *
 * Held as data rather than prose so the DB guard can assert it queried exactly
 * `public` and a reviewer can see the whole rule at once.
 */
export const NON_CUSTOMER_SCHEMAS: Readonly<Record<string, string>> = {
  auth: "Supabase Auth. Platform-owned identity tables; a studio owns no row here.",
  storage:
    "Supabase Storage internals. The BUCKETS are enumerated as resources; the object bookkeeping tables are platform-owned.",
  realtime: "Supabase Realtime internals.",
  _realtime: "Supabase Realtime internals.",
  supabase_migrations: "Migration bookkeeping. Hone's deployment record, not studio content.",
  supabase_functions: "Edge function internals.",
  extensions: "Installed PostgreSQL extensions.",
  graphql: "pg_graphql internals.",
  graphql_public: "pg_graphql internals.",
  net: "pg_net internals.",
  vault: "Supabase Vault. Secret storage; exporting it is precisely the thing never to do.",
  pgbouncer: "Connection-pooler internals.",
  cron: "pg_cron internals.",
  pgsodium: "pgsodium key management. Secret material.",
  information_schema: "SQL standard catalog.",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Whether a file's row count is checked against the database, and when it is
 * not, why not.
 *
 * `none` is a first-class member on purpose. Nine of the fifteen exported files
 * have no source-side count query today, and the manifest used to list them
 * beside four that did with nothing distinguishing the two. An unverified count
 * presented as a verified one is the same class of untruth as a partial export
 * presented as a complete one.
 */
export type SourceCountCheck =
  | { readonly kind: "studio_scoped" }
  | { readonly kind: "via_parent"; readonly parent: string; readonly reason: string }
  | { readonly kind: "none"; readonly reason: string };

/**
 * Why a column of an EXPORTED table does not reach its file.
 *
 * `pending_review` is the load-bearing member: it is how a genuine omission
 * stays visible instead of hiding inside a generic "excluded". Everything else
 * is a decision; `pending_review` is an admission.
 */
export type ColumnExclusionReason =
  | "tenant_key"
  | "delivery_mechanics"
  | "security_material"
  | "internal_state"
  | "retired_capability"
  | "pii_duplication"
  | "pending_review";

export type ExcludedColumn = {
  readonly column: string;
  readonly reason: ColumnExclusionReason;
  /** Required by the guard for every reason whose meaning is not self-evident. */
  readonly note?: string;
};

/**
 * An included column that reaches the CSV under a DIFFERENT header name, or
 * under several.
 *
 * Without this, "included" and "emitted" could only be compared for columns
 * that happen to keep their own name, and the two files that rename or flatten
 * would have had to be exempted wholesale - which is how an exemption becomes a
 * hole. Declaring the mapping makes the rename checkable instead.
 */
export type EmittedAs = {
  readonly headers: readonly string[];
  readonly note: string;
};

export type ExportedDisposition = {
  readonly kind: "exported";
  readonly file: string;
  /**
   * The EXACT header row emitted for this file. The exporter imports this; it
   * does not keep its own copy. Headers are not the same set as
   * `includedColumns`: several files carry joined labels (`client_name`) or
   * fields lifted from a related table (`block_*`, `probe_*` from
   * session_blocks), and several table columns are read and then dropped.
   */
  readonly csvHeaders: readonly string[];
  /** Columns OF THIS TABLE whose values actually reach the file. */
  readonly includedColumns: readonly string[];
  /** Every other column of this table, each with the reason it is absent. */
  readonly excludedColumns: readonly ExcludedColumn[];
  /**
   * Included columns whose value lands under a different header, keyed by
   * column name. Every included column NOT listed here must appear in
   * `csvHeaders` under its own name.
   */
  readonly emittedAs?: Readonly<Record<string, EmittedAs>>;
  /**
   * Headers that are NOT columns of this table: joined labels and fields lifted
   * from a related table. Keyed by header, valued with where it comes from.
   *
   * Declared so the emission contract can be checked in BOTH directions. A
   * header that is neither a column of this table, nor an `emittedAs` target,
   * nor declared here, is an unexplained column in a financial-grade artifact.
   */
  readonly derivedHeaders?: Readonly<Record<string, string>>;
  /** Which ROWS are in scope. Column accounting says nothing about this. */
  readonly rowScope: string;
  readonly sourceCountCheck: SourceCountCheck;
  /** One sentence, reused verbatim by the ZIP README and the settings page. */
  readonly description: string;
};

export type ExclusionCategory =
  | "security"
  | "platform"
  | "derived"
  | "dead"
  | "deliberate_privacy";

export type ExcludedDisposition = {
  readonly kind: "excluded";
  readonly category: ExclusionCategory;
  readonly reason: string;
};

export type PendingDisposition = {
  readonly kind: "pending";
  readonly ticket: string;
  /** 1 = studio-owned content. 2 = operational data needing a field review first. */
  readonly tier: 1 | 2;
  /**
   * Set when the resource must not be dumped raw even once it is exported:
   * provider identifiers, free-form audit payloads, security telemetry.
   * Customer recoverability is not the same thing as internal telemetry, and
   * TRUTH-01A records that distinction rather than pre-empting it.
   */
  readonly fieldReviewRequired?: boolean;
  readonly reason: string;
};

export type ResourceDisposition =
  | ExportedDisposition
  | ExcludedDisposition
  | PendingDisposition;

// ---------------------------------------------------------------------------
// THE REGISTRY
// ---------------------------------------------------------------------------

export const EXPORT_RESOURCE_REGISTRY: Readonly<Record<string, ResourceDisposition>> = {
  // -------------------------------------------------------------------------
  // EXPORTED - in the ZIP today. Nothing below changes the payload.
  // -------------------------------------------------------------------------
  clients: {
    kind: "exported",
    file: "clients.csv",
    csvHeaders: [
      "id",
      "name",
      "pronouns",
      "date_of_birth",
      "fitzpatrick_type",
      "allergies",
      "skin_notes",
      "emergency_contact_name",
      "emergency_contact_phone",
      "email",
      "phone",
      "created_at",
    ],
    includedColumns: [
      "id",
      "name",
      "pronouns",
      "date_of_birth",
      "fitzpatrick_type",
      "allergies",
      "skin_notes",
      "emergency_contact_name",
      "emergency_contact_phone",
      "email",
      "phone",
      "created_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "address", reason: "pending_review", note: "Client postal address. Genuine studio-owned contact data." },
      { column: "contraindications", reason: "pending_review", note: "Clinical safety data. Its absence is a real gap, not a decision." },
      { column: "photo_consent", reason: "pending_review", note: "Consent evidence the studio may need to produce." },
      { column: "notes", reason: "pending_review", note: "General client note text." },
      { column: "created_by", reason: "pending_review", note: "Creator attribution; belongs with the wider actor-attribution export decision." },
      { column: "normalized_email", reason: "internal_state", note: "Generated from email, which is exported; a second copy carries no new fact." },
      { column: "sms_consent_at", reason: "pending_review", note: "SMS consent evidence." },
      { column: "sms_consent_source", reason: "pending_review", note: "SMS consent evidence." },
      { column: "sms_opted_out_at", reason: "pending_review", note: "SMS opt-out evidence." },
      { column: "sms_opt_out_source", reason: "pending_review", note: "SMS opt-out evidence." },
      { column: "archived_at", reason: "pending_review", note: "Archived clients are exported today with nothing marking them archived." },
      { column: "archived_by", reason: "pending_review", note: "Archive attribution; see archived_at." },
    ],
    sourceCountCheck: { kind: "studio_scoped" },
    rowScope: "Every client row this studio holds, archived clients included (the archived_at flag itself is not emitted).",
    description:
      "Client master list with names, contact info, allergies, skin notes, Fitzpatrick type, emergency contacts.",
  },

  sessions: {
    kind: "exported",
    file: "sessions.csv",
    csvHeaders: [
      "id",
      "client_id",
      "practitioner_id",
      "performed_by_practitioner_id",
      "modality",
      "started_at",
      "ended_at",
      "price_paid_cents",
      "session_notes",
      "created_at",
    ],
    includedColumns: [
      "id",
      "client_id",
      "practitioner_id",
      "performed_by_practitioner_id",
      "modality",
      "started_at",
      "ended_at",
      "price_paid_cents",
      "session_notes",
      "created_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "started_at_original", reason: "pending_review", note: "Original start before an edit; part of the session audit story." },
      { column: "deleted_at", reason: "internal_state", note: "Constant NULL for every exported row: the read filters deleted_at IS NULL. Soft-deleted sessions are a ROW-scope gap, recorded in rowScope." },
      { column: "deleted_by", reason: "internal_state", note: "See deleted_at." },
      { column: "delete_reason", reason: "internal_state", note: "See deleted_at." },
      { column: "treatment_plan_id", reason: "pending_review", note: "Session-to-plan linkage. Without it the exported plan and session files cannot be joined." },
      { column: "appointment_id", reason: "pending_review", note: "Session-to-appointment linkage. Without it the exported session and appointment files cannot be joined." },
      { column: "next_session_note", reason: "pending_review", note: "Clinical carry-forward note." },
      { column: "aftercare_and_risks_explained_at", reason: "pending_review", note: "Aftercare/risk disclosure evidence." },
      { column: "aftercare_and_risks_explained_by", reason: "pending_review", note: "Aftercare/risk disclosure attribution." },
      { column: "record_status", reason: "retired_capability", note: "Signed/finalized clinical records were retired by migration 0159." },
      { column: "finalized_at", reason: "retired_capability", note: "Retired by 0159." },
      { column: "finalized_by", reason: "retired_capability", note: "Retired by 0159." },
      { column: "record_version", reason: "retired_capability", note: "Retired by 0159." },
      { column: "current_snapshot_id", reason: "retired_capability", note: "Retired by 0159." },
      { column: "record_origin", reason: "pending_review", note: "Native vs imported provenance." },
      { column: "legacy_classification", reason: "pending_review", note: "Legacy import classification." },
    ],
    sourceCountCheck: { kind: "studio_scoped" },
    rowScope: "Sessions with deleted_at IS NULL. A soft-deleted session, and every entry beneath it, is absent from the export.",
    description:
      "One row per session: client, performer, started_at, ended_at, price_paid_cents, session_notes.",
  },

  electrolysis_entries: {
    kind: "exported",
    file: "electrolysis_entries.csv",
    csvHeaders: [
      "id",
      "session_id",
      "area",
      "areas",
      "probe_size",
      "probe_lot_id",
      "mode",
      "intensity",
      "duration_seconds",
      "pulse_count",
      "comments",
      "created_at",
      "block_id",
      "energy_level",
      "apilus_modality",
      "machine_frequency",
      "minutes_performed",
      "probe_type",
      "hairs_treated",
      "galvanic_ma",
      "galvanic_duration_seconds",
      "galvanic_intensity_percent",
      "thermolysis_intensity_percent",
      "thermolysis_duration_seconds",
      "units_of_lye",
      "observation_chips",
      "block_primary_area",
      "block_side",
      "block_areas",
      "block_custom_area_detail",
      "probe_key",
      "probe_brand",
      "probe_material",
      "probe_piece_type",
      "probe_shank",
      "probe_size_value",
      "probe_length",
      "probe_label",
    ],
    includedColumns: [
      "id",
      "session_id",
      "area",
      "areas",
      "probe_size",
      "probe_lot_id",
      "mode",
      "intensity",
      "duration_seconds",
      "pulse_count",
      "comments",
      "created_at",
      "block_id",
      "energy_level",
      "apilus_modality",
      "machine_frequency",
      "minutes_performed",
      "probe_type",
      "hairs_treated",
      "galvanic_ma",
      "galvanic_duration_seconds",
      "galvanic_intensity_percent",
      "thermolysis_intensity_percent",
      "thermolysis_duration_seconds",
      "units_of_lye",
      "observation_chips",
    ],
    excludedColumns: [
      { column: "pulse_delay_seconds", reason: "pending_review", note: "Read by the export SELECT and then dropped before serialization. A charting value the studio recorded." },
      { column: "deleted_at", reason: "pending_review", note: "Entries are exported regardless of soft-delete state (only the parent session is filtered), and the state itself is not emitted." },
      { column: "deleted_by", reason: "pending_review", note: "See deleted_at." },
      { column: "delete_reason", reason: "pending_review", note: "See deleted_at." },
    ],
    sourceCountCheck: { kind: "via_parent", parent: "sessions", reason: "The table carries no studio_id (RLS reaches it through the parent session), so no safe studio-scoped count query exists. Rows are filtered against the exported session ids, so completeness follows the sessions check." },
    derivedHeaders: {
      block_primary_area: "session_blocks.primary_area, joined by block_id",
      block_side: "session_blocks.side, joined by block_id",
      block_areas: "session_block_areas for the block, joined into one label by blockAreasLabel",
      block_custom_area_detail: "session_blocks.custom_area_detail, joined by block_id",
      probe_key: "session_blocks.probe_key, joined by block_id",
      probe_brand: "session_blocks.probe_brand, joined by block_id",
      probe_material: "session_blocks.probe_material, joined by block_id",
      probe_piece_type: "session_blocks.probe_piece_type, joined by block_id",
      probe_shank: "session_blocks.probe_shank, joined by block_id",
      probe_size_value: "session_blocks.probe_size_value, joined by block_id",
      probe_length: "session_blocks.probe_length, joined by block_id",
      probe_label: "session_blocks.probe_label, joined by block_id",
    },
    rowScope: "Entries whose parent session is in sessions.csv. The entry's own soft-delete state is neither filtered nor emitted.",
    description:
      "Every electrolysis entry with area, mode, energy level, modality, machine frequency, pulse count, hairs treated, blend/galvanic and thermolysis readings (galvanic mA/duration/intensity, thermolysis intensity/duration, units of lye), the structured probe (brand, material, piece type, shank, size, length), the treatment area (primary area, side, specifics), structured observation chips, and free-text comments.",
  },

  laser_entries: {
    kind: "exported",
    file: "laser_entries.csv",
    csvHeaders: [
      "id",
      "session_id",
      "zone",
      "treatment_number",
      "fluence",
      "pulse_width",
      "spot_size",
      "observation_notes",
      "created_at",
    ],
    includedColumns: [
      "id",
      "session_id",
      "zone",
      "session_number",
      "equipment_params",
      "observation_notes",
      "created_at",
    ],
    excludedColumns: [
      { column: "ejection_results", reason: "pending_review", note: "Recorded laser outcome text." },
      { column: "deleted_at", reason: "pending_review", note: "Entries are exported regardless of soft-delete state (only the parent session is filtered), and the state itself is not emitted." },
      { column: "deleted_by", reason: "pending_review", note: "See deleted_at." },
      { column: "delete_reason", reason: "pending_review", note: "See deleted_at." },
    ],
    sourceCountCheck: { kind: "via_parent", parent: "sessions", reason: "The table carries no studio_id (RLS reaches it through the parent session), so no safe studio-scoped count query exists. Rows are filtered against the exported session ids, so completeness follows the sessions check." },
    emittedAs: {
      session_number: { headers: ["treatment_number"], note: "Emitted under the practitioner-facing name." },
      equipment_params: { headers: ["fluence", "pulse_width", "spot_size"], note: "The jsonb blob is FLATTENED into three top-level columns so a spreadsheet shows plain fields. Any key the blob holds beyond these three does not reach the CSV." },
    },
    rowScope: "Entries whose parent session is in sessions.csv. The entry's own soft-delete state is neither filtered nor emitted.",
    description:
      "Every laser entry with zone, fluence, pulse width, treatment number, observations.",
  },

  practitioners: {
    kind: "exported",
    file: "practitioners.csv",
    csvHeaders: [
      "id",
      "display_name",
      "email",
      "role",
      "active",
      "created_at",
    ],
    includedColumns: [
      "id",
      "display_name",
      "email",
      "role",
      "active",
      "created_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "user_id", reason: "internal_state", note: "Supabase auth user identifier. Platform identity, not studio content." },
      { column: "color", reason: "pending_review", note: "Calendar display preference." },
      { column: "terms_accepted_at", reason: "internal_state", note: "Hone platform agreement acceptance, not studio-owned client content." },
      { column: "terms_version", reason: "internal_state", note: "See terms_accepted_at." },
      { column: "privacy_accepted_at", reason: "internal_state", note: "See terms_accepted_at." },
      { column: "privacy_version", reason: "internal_state", note: "See terms_accepted_at." },
      { column: "calendar_feed_token_hash", reason: "security_material", note: "Calendar-feed credential material. Never exported." },
      { column: "default_machine_frequency", reason: "pending_review", note: "Practitioner charting preference." },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope:
      "ACTIVE practitioners only: the read filters active = true. A deactivated practitioner is absent from the export even though rows elsewhere in it still name her id, so an exported session can point at a performer who appears in no file. The `active` column is emitted and is therefore constant true. Widening this is TRUTH-01B.",
    description:
      "Practitioners at your studio, with role and active flag.",
  },

  client_pricing: {
    kind: "exported",
    file: "client_pricing.csv",
    csvHeaders: [
      "id",
      "client_id",
      "service_name",
      "price_cents",
      "notes",
      "effective_from",
    ],
    includedColumns: [
      "id",
      "client_id",
      "service_name",
      "price_cents",
      "notes",
      "effective_from",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope: "Every custom price row this studio holds.",
    description:
      "Per-client custom pricing.",
  },

  appointments: {
    kind: "exported",
    file: "appointments.csv",
    csvHeaders: [
      "id",
      "client_id",
      "client_name",
      "practitioner_id",
      "practitioner_name",
      "service_id",
      "service_name",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "status",
      "notes",
      "cancellation_reason",
      "cancelled_at",
      "cancelled_by",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "id",
      "client_id",
      "practitioner_id",
      "service_id",
      "starts_at",
      "ends_at",
      "duration_minutes",
      "status",
      "notes",
      "cancellation_reason",
      "cancelled_at",
      "cancelled_by",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "confirmation_sent_at", reason: "delivery_mechanics" },
      { column: "reminder_24h_sent_at", reason: "delivery_mechanics" },
      { column: "reminder_2h_sent_at", reason: "delivery_mechanics" },
      { column: "no_show_email_sent_at", reason: "delivery_mechanics" },
      { column: "confirmation_send_attempts", reason: "delivery_mechanics" },
      { column: "reminder_24h_send_attempts", reason: "delivery_mechanics" },
      { column: "reminder_2h_send_attempts", reason: "delivery_mechanics" },
      { column: "no_show_email_send_attempts", reason: "delivery_mechanics" },
      { column: "buffer_minutes_snapshot", reason: "internal_state", note: "Trigger-managed scheduling snapshot." },
      { column: "blocked_ends_at", reason: "internal_state", note: "Trigger-managed scheduling snapshot." },
      { column: "postcare_email_sent_at", reason: "delivery_mechanics" },
      { column: "postcare_email_send_attempts", reason: "delivery_mechanics" },
      { column: "sms_confirmation_sent_at", reason: "delivery_mechanics" },
      { column: "sms_confirmation_send_attempts", reason: "delivery_mechanics" },
      { column: "sms_confirmation_claimed_at", reason: "delivery_mechanics" },
      { column: "sms_reminder_24h_sent_at", reason: "delivery_mechanics" },
      { column: "sms_reminder_24h_send_attempts", reason: "delivery_mechanics" },
      { column: "sms_reminder_24h_claimed_at", reason: "delivery_mechanics" },
      { column: "sms_reminder_2h_sent_at", reason: "delivery_mechanics" },
      { column: "sms_reminder_2h_send_attempts", reason: "delivery_mechanics" },
      { column: "sms_reminder_2h_claimed_at", reason: "delivery_mechanics" },
      { column: "referral_source", reason: "pending_review", note: "How the client found the studio. Studio-owned marketing attribution." },
      { column: "confirmation_claimed_at", reason: "delivery_mechanics" },
      { column: "reminder_24h_claimed_at", reason: "delivery_mechanics" },
      { column: "reminder_2h_claimed_at", reason: "delivery_mechanics" },
      { column: "cancellation_token_hash", reason: "security_material", note: "Public cancellation credential. Never exported." },
      { column: "intake_reminder_7d_sent_at", reason: "delivery_mechanics" },
      { column: "intake_reminder_7d_send_attempts", reason: "delivery_mechanics" },
      { column: "intake_reminder_7d_claimed_at", reason: "delivery_mechanics" },
      { column: "intake_reminder_3d_sent_at", reason: "delivery_mechanics" },
      { column: "intake_reminder_3d_send_attempts", reason: "delivery_mechanics" },
      { column: "intake_reminder_3d_claimed_at", reason: "delivery_mechanics" },
      { column: "postcare_email_claimed_at", reason: "delivery_mechanics" },
      { column: "postcare_email_failed_at", reason: "delivery_mechanics" },
      { column: "postcare_email_last_error", reason: "delivery_mechanics" },
      { column: "postcare_email_last_attempt_at", reason: "delivery_mechanics" },
      { column: "sync_version", reason: "internal_state", note: "Google-calendar sync bookkeeping." },
      { column: "rescheduled_from_appointment_id", reason: "pending_review", note: "Reschedule lineage." },
      { column: "rescheduled_to_appointment_id", reason: "pending_review", note: "Reschedule lineage." },
      { column: "cancellation_kind", reason: "pending_review", note: "Distinguishes a cancellation from a reschedule." },
      { column: "capacity_enabled", reason: "internal_state", note: "Feature-state snapshot at booking time." },
      { column: "booked_outside_availability", reason: "pending_review", note: "Booking-policy fact." },
      { column: "created_by_practitioner_id", reason: "pending_review", note: "Booking attribution (migration 0174)." },
      { column: "cancelled_by_practitioner_id", reason: "pending_review", note: "Cancellation attribution (migration 0174)." },
      { column: "outside_availability_authorized_by_practitioner_id", reason: "pending_review", note: "Override authorization (migration 0174)." },
      { column: "outside_availability_authorized_role", reason: "pending_review", note: "Override authorization (migration 0174)." },
      { column: "outside_availability_authorized_at", reason: "pending_review", note: "Override authorization (migration 0174)." },
    ],
    sourceCountCheck: { kind: "studio_scoped" },
    derivedHeaders: {
      client_name: "clients.name, resolved from an in-memory map",
      practitioner_name: "practitioners.display_name, resolved from an in-memory map",
      service_name: "services.name, resolved from an in-memory map",
    },
    rowScope: "Every appointment this studio holds, in every status.",
    description:
      "One row per appointment with client, practitioner, and service (IDs plus readable names), start/end times, duration, status, appointment notes, and cancellation details.",
  },

  treatment_plans: {
    kind: "exported",
    file: "treatment_plans.csv",
    csvHeaders: [
      "id",
      "client_id",
      "client_name",
      "name",
      "primary_area",
      "treatment_areas",
      "estimated_timeline_months_min",
      "estimated_timeline_months_max",
      "status",
      "suggested_visit_count",
      "treatment_goal_minutes_override",
      "budget_notes",
      "practitioner_notes",
      "created_by_practitioner_id",
      "closed_by_practitioner_id",
      "created_at",
      "closed_at",
    ],
    includedColumns: [
      "id",
      "client_id",
      "name",
      "primary_area",
      "treatment_areas",
      "estimated_timeline_months_min",
      "estimated_timeline_months_max",
      "status",
      "suggested_visit_count",
      "treatment_goal_minutes_override",
      "budget_notes",
      "practitioner_notes",
      "created_by_practitioner_id",
      "closed_by_practitioner_id",
      "created_at",
      "closed_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    derivedHeaders: {
      client_name: "clients.name, resolved from an in-memory map",
    },
    rowScope: "Every plan this studio holds, open and closed.",
    description:
      "One row per treatment plan with client, name, primary area, all treatment areas (pipe-joined), estimated timeline months window, status, estimated visit count, treatment-goal minutes override, and plan/budget notes.",
  },

  treatment_plan_stages: {
    kind: "exported",
    file: "treatment_plan_stages.csv",
    csvHeaders: [
      "id",
      "plan_id",
      "plan_name",
      "client_id",
      "client_name",
      "sort_order",
      "name",
      "how_often_unit",
      "visit_length_minutes",
      "stage_length_value",
      "stage_length_unit",
      "notes",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "id",
      "plan_id",
      "sort_order",
      "name",
      "how_often_unit",
      "visit_length_minutes",
      "stage_length_value",
      "stage_length_unit",
      "notes",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    derivedHeaders: {
      plan_name: "treatment_plans.name for the parent plan",
      client_id: "treatment_plans.client_id for the parent plan",
      client_name: "clients.name for the parent plan's client",
    },
    rowScope: "Every stage of every exported plan.",
    description:
      "Schedule stages for treatment plans (cadence, visit length, stage length, notes), with the parent plan and client for reference.",
  },

  record_keeping_sterile_items: {
    kind: "exported",
    file: "record_keeping_sterile_items.csv",
    csvHeaders: [
      "id",
      "date_purchased",
      "item_description",
      "manufacturer_name",
      "amount_purchased",
      "lot_number",
      "expiry_date",
      "date_discarded",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "id",
      "date_purchased",
      "item_description",
      "manufacturer_name",
      "amount_purchased",
      "lot_number",
      "expiry_date",
      "date_discarded",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "probe_key", reason: "pending_review", note: "Links the sterile item to the probe taxonomy used in charting." },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope: "Every sterile-supply row this studio holds, discarded stock included.",
    description:
      "Sterile-supply inspection log: item, manufacturer, amount, lot number, purchase/expiry/discarded dates, notes. Expiry status is derivable from the expiry_date column (a date on or before today is expired); the in-app Records list and the print view flag expired / expires-today / expires-soon items. A date_discarded value means the practitioner recorded that this stock was physically thrown away on that date: it is then no longer current inventory (it raises no expiry reminder and is not offered as a probe lot), but the record and every treatment that used it are kept in full. An empty date_discarded means no discard was recorded.",
  },

  record_keeping_disinfectants: {
    kind: "exported",
    file: "record_keeping_disinfectants.csv",
    csvHeaders: [
      "id",
      "date_prepared",
      "disinfectant_name",
      "concentration",
      "date_discarded",
      "discard_due_date",
      "operator_practitioner_id",
      "operator_name",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "id",
      "date_prepared",
      "disinfectant_name",
      "concentration",
      "date_discarded",
      "discard_due_date",
      "operator_practitioner_id",
      "operator_name",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope: "Every disinfectant-preparation row this studio holds.",
    description:
      "Disinfectant preparation log: name, concentration, prepared/discarded/discard-due dates, operator, notes.",
  },

  record_keeping_exposure_incidents: {
    kind: "exported",
    file: "record_keeping_exposure_incidents.csv",
    csvHeaders: [
      "id",
      "incident_date",
      "exposed_person_full_name",
      "exposed_person_address",
      "exposed_person_phone",
      "exposure_details",
      "action_taken",
      "staff_involved_name",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "id",
      "incident_date",
      "exposed_person_full_name",
      "exposed_person_address",
      "exposed_person_phone",
      "exposure_details",
      "action_taken",
      "staff_involved_name",
      "notes",
      "created_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope: "Every exposure-incident row this studio holds. Owner-only twice over: the action's role gate and an owner-only RLS SELECT.",
    description:
      "Exposure-incident log (OWNER-ONLY). Contains sensitive personal information about the exposed person (name, address, phone) and incident details.",
  },

  record_keeping_audit_events: {
    kind: "exported",
    file: "record_keeping_audit_events.csv",
    csvHeaders: [
      "id",
      "record_type",
      "record_id",
      "action",
      "changed_fields",
      "actor_practitioner_id",
      "actor_display_name",
      "created_at",
    ],
    includedColumns: [
      "id",
      "record_type",
      "record_id",
      "action",
      "changed_fields",
      "actor_practitioner_id",
      "actor_display_name",
      "created_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
      { column: "changes", reason: "pii_duplication", note: "The value snapshot can contain exposure-incident personal information; the 2026-07-01 reduced-audit decision keeps it out of a second file." },
      { column: "actor_user_id", reason: "internal_state", note: "Supabase auth user identifier; actor_practitioner_id and actor_display_name are exported instead." },
      { column: "metadata", reason: "pii_duplication", note: "Free-form metadata, same reduced-audit decision as changes." },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    rowScope: "Every record-keeping change event this studio holds, reduced to the columns below.",
    description:
      "Record-keeping change history: record type/id, action, which fields changed, who made the change, and when. (Reduced: it does not include the before/after value snapshots.)",
  },

  client_clinical_notes: {
    kind: "exported",
    file: CLINICAL_NOTES_CSV_FILENAME,
    csvHeaders: CLINICAL_NOTES_CSV_HEADERS,
    includedColumns: [
      "id",
      "client_id",
      "practitioner_id",
      "kind",
      "body",
      "areas",
      "occurred_at",
      "created_at",
      "supersedes_note_id",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "studio_scoped" },
    derivedHeaders: {
      client_name: "clients.name, resolved by buildClinicalNoteExportRows",
      practitioner_display_name: "practitioners.display_name, resolved by buildClinicalNoteExportRows",
    },
    rowScope: "Every clinical note this studio holds, INCLUDING superseded revisions: the table is append-only and a correction is its own row.",
    description:
      "The clinical narrative for every client: consultation notes and skin/hair analyses, with the authoring practitioner, the treatment areas tagged, when the note describes (occurred_at) and when it was recorded (created_at). FULL HISTORY: these records are append-only, so a correction appears as its own row whose supersedes_note_id points at the note it revised, and the superseded note is kept.",
  },

  client_budget_context: {
    kind: "exported",
    file: "client_budget_context.csv",
    csvHeaders: [
      "client_id",
      "client_name",
      "budget_level",
      "budget_notes",
      "updated_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    includedColumns: [
      "client_id",
      "budget_level",
      "budget_notes",
      "updated_by_practitioner_id",
      "created_at",
      "updated_at",
    ],
    excludedColumns: [
      { column: "studio_id", reason: "tenant_key" },
    ],
    sourceCountCheck: { kind: "none", reason: "No source-side count query is issued for this file today, so its row count is recorded but NOT verified against the database. Adding the check is TRUTH-01B; declaring the gap here is what stops the manifest reading as though every file were verified." },
    derivedHeaders: {
      client_name: "clients.name, resolved from an in-memory map",
    },
    rowScope: "One row per client for whom budget context was recorded.",
    description:
      "The client's CURRENT budget context as recorded by the practitioner: a broad budget level (no_stated_limit / somewhat_limited / severely_limited, or empty when none was recorded) and free-text budget notes, with who last updated it and when. One row per client, and only for clients where something was recorded. This is practitioner-authored planning context, not a financial assessment of the client: it holds no income, no affordability score and no payment data, and it never affected pricing or charges. Historical plan-scoped budget notes written before this record existed remain in treatment_plans.csv and were deliberately not copied here.",
  },

  // -------------------------------------------------------------------------
  // EXCLUDED - a decision on the record, with the reason it was made.
  // -------------------------------------------------------------------------

  // security
  calendar_connection_secrets: {
    kind: "excluded",
    category: "security",
    reason:
      "Google Calendar refresh/access token material. Exporting it would hand over live credentials to a third-party account.",
  },
  google_oauth_states: {
    kind: "excluded",
    category: "security",
    reason:
      "Short-lived OAuth state/nonce values used to defend the Google connect flow against CSRF. Credential material, never studio content.",
  },
  client_portal_magic_links: {
    kind: "excluded",
    category: "security",
    reason:
      "Client-portal login credentials (token hashes and their expiry). Exporting them would export a way to sign in as a client.",
  },
  client_portal_sessions: {
    kind: "excluded",
    category: "security",
    reason:
      "Live client-portal session credentials. Same reason as the magic links they are issued from.",
  },
  payment_recovery_tokens: {
    kind: "excluded",
    category: "security",
    reason:
      "Payment-recovery credential material from migration 0032. Credential category governs regardless of the fact that no runtime code writes it.",
  },

  // platform
  demo_requests: {
    kind: "excluded",
    category: "platform",
    reason:
      "Inbound Hone sales enquiries. Hone's records, not any studio's, and the table carries no studio_id.",
  },
  waitlist: {
    kind: "excluded",
    category: "platform",
    reason:
      "The Hone product waitlist from migration 0004. Platform marketing, not studio content, and unrelated to new_client_waitlist_entries.",
  },
  calendar_sync_control: {
    kind: "excluded",
    category: "platform",
    reason:
      "A single global row holding the calendar worker kill-switch. No studio_id, no studio meaning.",
  },
  admin_action_events: {
    kind: "excluded",
    category: "platform",
    reason:
      "Hone operator (platform administrator) action log. Hone's own accountability record.",
  },

  // derived
  studio_calendar_reservations: {
    kind: "excluded",
    category: "derived",
    reason:
      "A shadow projection of appointments, blockouts and break occurrences, rebuilt by trigger. Every fact in it is already in, or derivable from, its sources.",
  },
  studio_recurring_break_occurrences: {
    kind: "excluded",
    category: "derived",
    reason:
      "Materialized from studio_recurring_break_rules. The rule is the fact; the occurrence is the expansion.",
  },
  calendar_sync_outbox: {
    kind: "excluded",
    category: "derived",
    reason:
      "Transient outbound job queue for Google Calendar. Rows are consumed and carry no record of studio activity that is not already in appointments.",
  },
  calendar_sync_metric_events: {
    kind: "excluded",
    category: "derived",
    reason:
      "Sync telemetry Hone uses to observe the worker. Operational instrumentation, not studio content.",
  },
  conversion_event_deliveries: {
    kind: "excluded",
    category: "derived",
    reason:
      "Delivery log for outbound marketing-tracking events. The underlying booking is already exported in appointments.csv.",
  },
  stripe_events: {
    kind: "excluded",
    category: "derived",
    reason:
      "Raw Stripe webhook receipts kept for idempotency. The authoritative copy lives at Stripe and is retrievable from the Stripe dashboard.",
  },

  // dead
  appointment_payments: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application. Zero readers, zero writers; the live payment ledger is payment_charge_attempts.",
  },
  payment_consents: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application.",
  },
  pending_booking_payment_sessions: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 for public-booking card collection, which is off and unwired. Unreachable from application code: no module opens the table directly, and none of the nine SECURITY DEFINER functions that write it is invoked from the application.",
  },
  stripe_charge_attempts: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application.",
  },
  stripe_disputes: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application. Dispute handling is alert-only via ops_alerts.",
  },
  stripe_payment_audit: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application.",
  },
  stripe_refund_attempts: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application. Live refund state lives on payment_charge_attempts.refund_*.",
  },
  stripe_refunds: {
    kind: "excluded",
    category: "dead",
    reason:
      "Created by migration 0032 and unreachable from application code: no module opens the table directly, and no SECURITY DEFINER function that writes it is invoked from the application. Live refund state lives on payment_charge_attempts.refund_*.",
  },

  // deliberate_privacy
  client_personal_notes: {
    kind: "excluded",
    category: "deliberate_privacy",
    reason:
      "Private practitioner warnings about a client, deliberately withheld from the general studio export and disclosed as withheld on the Data settings page. Recorded here as the decision it is; whether it should survive a studio DEPARTURE is a product question for TRUTH-01B, not a defect in this slice.",
  },
  client_pinned_notes: {
    kind: "excluded",
    category: "deliberate_privacy",
    reason:
      "Pinned private notes, same deliberate withholding and same open departure question as client_personal_notes.",
  },

  // -------------------------------------------------------------------------
  // PENDING - studio-owned and NOT exported today. Named, ticketed, and counted.
  // -------------------------------------------------------------------------

  // tier 1
  session_blocks: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "The unit of charting, and it has no file of its own. Eleven of its forty columns travel as denormalized decoration on electrolysis_entries.csv; a block with no electrolysis entry is absent from the export entirely, and block-level clinical fields (tolerance_rating, reaction_notes, caution_for_next_session, caution_note, numbing_status, numbing_notes, probe_lot_number, probe_inventory_item_id) reach no file.",
  },
  session_block_areas: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Folded into electrolysis_entries.csv as a semicolon-joined block_areas label, which is lossy and cannot be parsed back into rows.",
  },
  services: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Read by the export for id and name only, to label appointments.csv. The service menu itself - price, duration, active flag, ordering, colour - reaches no file, so a departing studio cannot reconstruct what it charges for.",
  },
  client_intake_forms: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Client-completed intake responses. Studio-owned clinical intake content with no representation in any exported file.",
  },
  client_consent_signatures: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Signed client consent records. Evidence a studio may need to produce; absent from every file.",
  },
  consent_form_templates: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "The studio's own consent form wording. Without it an exported signature cannot be tied to what was agreed.",
  },
  treatment_images: {
    kind: "pending",
    ticket: "TRUTH-01C",
    tier: 1,
    reason:
      "Treatment photo METADATA (client, session, block, note, capture time). Deferred to TRUTH-01C with the binaries it describes, so metadata and files ship together rather than as a catalogue of things the studio did not receive.",
  },
  photos: {
    kind: "pending",
    ticket: "TRUTH-01C",
    tier: 1,
    reason:
      "Legacy photo records from migration 0001. Same binary-bearing deferral as treatment_images.",
  },
  treatment_goals: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Per-client treatment goals. Practitioner-authored planning content.",
  },
  client_tags: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Studio-authored client tags. Small, but it is how a studio segments its own client list, and none of it is recoverable from any other exported file.",
  },
  probe_lots: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Probe lot inventory. Inspection-relevant and referenced by exported charting rows through probe_lot_id, which currently resolves to nothing in the ZIP.",
  },
  imported_treatment_memories: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Treatment history brought in by operator-assisted CSV migration. A studio that paid to have its history imported cannot currently get that history back out.",
  },
  import_batches: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Provenance for imported_treatment_memories: what was imported, when, and from what.",
  },
  appointment_settlements: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    fieldReviewRequired: true,
    reason:
      "Practitioner-attested settlement of a visit (paid cash / e-transfer / another way / waived / still owes), live since migration 0187. Customer-owned financial truth. Field review first: the table carries actor attribution and supersession lineage, and the export shape has to state that an attestation is not a Stripe receipt.",
  },
  studios: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    fieldReviewRequired: true,
    reason:
      "The studio's own settings row - name, slug, timezone, booking policy. Field review first: the row also carries operational and feature-gate columns that are Hone configuration rather than studio content.",
  },
  studio_availability_default: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Weekly working hours - the studio's own opening pattern. Practice configuration it authored, and the base every availability override is measured against.",
  },
  studio_availability_overrides: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Date-specific availability overrides: the days a studio deliberately opened, shortened or closed. Practice configuration it authored and cannot rebuild from the appointments file.",
  },
  studio_blockouts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Calendar blockouts the studio authored - holidays, personal time, anything held out of bookable hours. Not derivable from any exported file.",
  },
  studio_timed_blocks: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Timed calendar blocks the studio authored. Same class as blockouts: configuration the studio entered by hand and would have to re-enter elsewhere.",
  },
  studio_recurring_break_rules: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Recurring break rules. The rule, not the derived occurrence, is the studio's fact.",
  },
  service_practitioners: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Which practitioner performs which service. Part of the service menu the export cannot currently reconstruct.",
  },
  new_client_waitlist_entries: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Prospective clients who asked to be seen. Studio-owned demand records.",
  },
  client_portal_messages: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Messages exchanged with clients through the portal. Studio-client correspondence.",
  },
  client_portal_message_replies: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Client replies to portal messages. The other half of the same correspondence.",
  },
  appointment_policy_acknowledgements: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Client acknowledgement of the studio's booking policy. Consent-adjacent evidence.",
  },
  booking_tracking_consents: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Per-booking tracking consent decisions. Compliance evidence.",
  },
  clinical_record_snapshots: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Migration 0159 retired signed clinical records but deliberately dropped nothing: existing rows are untouched. Any pre-retirement row is clinical evidence a studio owns, so this is PENDING rather than EXCLUDED until TRUTH-01B establishes whether production holds any such row.",
  },
  clinical_record_amendments: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Same 0159 retirement and the same unverified row-bearing question as clinical_record_snapshots.",
  },
  clinical_audit_events: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 1,
    reason:
      "Same 0159 retirement and the same unverified row-bearing question as clinical_record_snapshots.",
  },

  // tier 2
  payment_charge_attempts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "The Stripe-verified card ledger. Customer-owned money truth, but the row also carries Stripe account, customer, payment-method, PaymentIntent and charge identifiers, idempotency keys and provider failure codes. A raw dump would export provider identifiers; the field selection is a deliberate decision TRUTH-01B must make, not a default.",
  },
  manual_fee_charge_attempts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Legacy manual fee ledger, same provider-identifier review as payment_charge_attempts.",
  },
  audit_logs: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "The studio's own audit trail, which this export writes to on every run. Customer-relevant, but metadata is free-form JSON and needs a field review before any raw dump.",
  },
  appointment_audit: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Appointment lifecycle audit. Its details JSON has historically carried raw booking payloads, so it needs field-level review before export.",
  },
  session_audit: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Session change audit. Same free-form payload review as appointment_audit.",
  },
  imported_treatment_memory_audit_events: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Audit of the import path. Same free-form payload review.",
  },
  client_portal_access_events: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Portal access telemetry (who opened what, when). Security-relevant observation data rather than studio content; review before export.",
  },
  ops_alerts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Operational alerts, studio-scoped. safe_details is deliberately bounded but is still operational telemetry, and some rows reference Stripe identifiers.",
  },
  client_payment_methods: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Card-on-file metadata. The authoritative copy lives at Stripe; a Hone export would carry provider identifiers and nothing a studio can act on independently.",
  },
  client_stripe_customers: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Stripe customer identifiers per client. Provider identifiers; review before export.",
  },
  stripe_account_provisioning_attempts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "The Stripe Connect onboarding attempt ledger, and it is LIVE: create_or_claim_stripe_account_provisioning, complete_stripe_account_provisioning and mark_stripe_account_provisioning_failed are all invoked from lib/stripe/account.ts, which the payment settings actions and the return/refresh pages drive. It was classified `dead` on the first TRUTH-01A head, which was wrong - the liveness check looked for direct table access and could not see a SECURITY DEFINER writer - and that error would have printed a false statement into the generated README and settings page. Field review before any export: the row carries the Stripe account identifier, the onboarding claim token and provider failure detail, none of which a studio can act on outside Hone.",
  },
  stripe_customer_provisioning_attempts: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "The Stripe customer provisioning ledger, and it is LIVE: create_or_claim_stripe_customer_provisioning and complete_stripe_customer_provisioning are invoked from lib/stripe/setup-intent.ts, which app/portal/payment-method-actions.ts drives when a client saves a card. Same mis-classification and same correction as stripe_account_provisioning_attempts. Field review before any export: it is per-client provider linkage, so it carries a Stripe customer identifier and nothing independently useful.",
  },
  studio_payment_settings: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Stripe Connect account state per mode. Provider configuration and identifiers, not studio content.",
  },
  calendar_connections: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Which Google account is connected and its sync state. Non-secret half of the connection (the secrets are separately and permanently EXCLUDED); still provider metadata needing review.",
  },
  calendar_event_links: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    reason:
      "Mapping between Hone appointments and Google Calendar event ids. Provider identifiers with no standalone studio value.",
  },
  studio_tracking_providers: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    fieldReviewRequired: true,
    reason:
      "Configured marketing-tracking providers. Configuration that can contain provider credentials or ids; review before export.",
  },
  practitioner_notifications: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    reason:
      "In-app notifications to practitioners. Operational rather than record-keeping; decide deliberately.",
  },
  pending_invitations: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    reason:
      "Outstanding team invitations. Transient onboarding state; decide deliberately.",
  },
  studio_onboarding: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    reason:
      "Onboarding checklist progress. Product state rather than studio content; decide deliberately.",
  },
  session_copy_operations: {
    kind: "pending",
    ticket: "TRUTH-01B",
    tier: 2,
    reason:
      "Whole-session-copy operation log written by the 0157 command. Provenance for copied charting; decide deliberately.",
  },
  // -------------------------------------------------------------------------
  // STORAGE
  // -------------------------------------------------------------------------
  "storage:treatment-images": {
    kind: "pending",
    ticket: "TRUTH-01C",
    tier: 1,
    reason:
      "The private bucket holding every treatment photo a studio has taken. It is the single largest studio-owned asset the export does not carry, and it CANNOT ship on the current path: the exporter returns one base64 string from a server action, which is not a mechanism for an image corpus. TRUTH-01C is the asynchronous, object-storage-backed export that makes binaries possible; deferring it here is a capability statement, not a decision that photos do not matter. Terms section 6 defines Your Data to include photos, so the settings page must say plainly that this export does not contain them.",
  },
};

// ---------------------------------------------------------------------------
// Derived views of the registry. Everything downstream reads these, so nothing
// downstream keeps a second list.
// ---------------------------------------------------------------------------

export type RegistryEntry<T extends ResourceDisposition = ResourceDisposition> = {
  readonly resource: string;
  readonly disposition: T;
};

function entries(): RegistryEntry[] {
  return Object.entries(EXPORT_RESOURCE_REGISTRY).map(([resource, disposition]) => ({
    resource,
    disposition,
  }));
}

export function exportedResources(): ReadonlyArray<RegistryEntry<ExportedDisposition>> {
  return entries().filter(
    (e): e is RegistryEntry<ExportedDisposition> => e.disposition.kind === "exported",
  );
}

export function pendingResources(): ReadonlyArray<RegistryEntry<PendingDisposition>> {
  return entries().filter(
    (e): e is RegistryEntry<PendingDisposition> => e.disposition.kind === "pending",
  );
}

export function excludedResources(): ReadonlyArray<RegistryEntry<ExcludedDisposition>> {
  return entries().filter(
    (e): e is RegistryEntry<ExcludedDisposition> => e.disposition.kind === "excluded",
  );
}

/**
 * The exported disposition for a resource, or a throw.
 *
 * The exporter calls this instead of holding filenames and header arrays of its
 * own, so a file's NAME and its HEADER ROW exist in exactly one place. Renaming
 * a column in the registry renames it in the CSV; there is no second copy to
 * forget.
 */
export function exportSpec(resource: string): ExportedDisposition {
  const disposition = EXPORT_RESOURCE_REGISTRY[resource];
  if (!disposition || disposition.kind !== "exported") {
    throw new Error(
      `export registry: "${resource}" has no exported disposition, so it has no file or header row.`,
    );
  }
  return disposition;
}

/** The exact set of CSV files the ZIP must contain. Guard 3 compares against this. */
export function expectedCsvFiles(): ReadonlySet<string> {
  return new Set(exportedResources().map((e) => e.disposition.file));
}

/** The resources whose row count IS compared against a studio-scoped database count. */
export function studioScopedCountResources(): ReadonlyArray<string> {
  return exportedResources()
    .filter((e) => e.disposition.sourceCountCheck.kind === "studio_scoped")
    .map((e) => e.resource);
}

/** Columns of exported tables that are absent only because nobody has decided yet. */
export function pendingColumns(): ReadonlyArray<{ resource: string; column: string; note?: string }> {
  return exportedResources().flatMap((e) =>
    e.disposition.excludedColumns
      .filter((c) => c.reason === "pending_review")
      .map((c) => ({ resource: e.resource, column: c.column, note: c.note })),
  );
}

// ---------------------------------------------------------------------------
// GUARD 1 - resource exhaustiveness
// ---------------------------------------------------------------------------

export type CoverageAudit = {
  readonly ok: boolean;
  /** Live resources with no registry disposition. A new table lands here. */
  readonly unregistered: readonly string[];
  /** Registry entries naming something the live schema does not have. */
  readonly stale: readonly string[];
};

/**
 * Compare the live customer-resource universe against the registry, both ways.
 *
 * `unregistered` is the one that fails CI when somebody adds a table: it cannot
 * be satisfied by editing this file's prose, only by deciding the disposition.
 * `stale` catches the opposite drift - a renamed or dropped table leaving a
 * registry entry that describes nothing.
 */
export function auditResourceCoverage(
  liveResources: readonly string[],
): CoverageAudit {
  const live = new Set(liveResources);
  const registered = new Set(Object.keys(EXPORT_RESOURCE_REGISTRY));
  const unregistered = [...live].filter((r) => !registered.has(r)).sort();
  const stale = [...registered].filter((r) => !live.has(r)).sort();
  return { ok: unregistered.length === 0 && stale.length === 0, unregistered, stale };
}

// ---------------------------------------------------------------------------
// GUARD 2 - column exhaustiveness
// ---------------------------------------------------------------------------

export type ColumnAudit = {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<{
    readonly resource: string;
    readonly kind:
      | "unaccounted_column"
      | "phantom_column"
      | "listed_twice"
      | "missing_reason_note";
    readonly detail: string;
  }>;
};

/**
 * Reasons whose meaning is NOT self-evident from the label, and therefore
 * require a note. `tenant_key` and `delivery_mechanics` are self-describing;
 * `pending_review` in particular must say what the studio is missing, or the
 * admission degrades into a shrug.
 */
const REASONS_REQUIRING_NOTE: ReadonlySet<ColumnExclusionReason> = new Set([
  "security_material",
  "internal_state",
  "retired_capability",
  "pii_duplication",
  "pending_review",
]);

/**
 * For every EXPORTED table: included UNION excluded must equal the live column
 * set, and the two must be disjoint.
 *
 * This is the guard that catches a new column. Adding `numbing_notes` to
 * session_blocks or `contraindications` to clients without deciding where it
 * goes leaves it in neither list, and `unaccounted_column` fails. Nothing here
 * names a specific column: the mechanism is set arithmetic against the
 * database, so it keeps working for columns nobody has thought of yet.
 */
export function auditColumnCoverage(
  liveColumnsByResource: Readonly<Record<string, readonly string[]>>,
): ColumnAudit {
  const problems: Array<{
    resource: string;
    kind: "unaccounted_column" | "phantom_column" | "listed_twice" | "missing_reason_note";
    detail: string;
  }> = [];

  for (const { resource, disposition } of exportedResources()) {
    const live = liveColumnsByResource[resource];
    if (!live) {
      problems.push({
        resource,
        kind: "phantom_column",
        detail: `no live column list was supplied for exported resource "${resource}"`,
      });
      continue;
    }
    const liveSet = new Set(live);
    const included = disposition.includedColumns;
    const excluded = disposition.excludedColumns.map((c) => c.column);
    const includedSet = new Set(included);
    const excludedSet = new Set(excluded);

    for (const column of [...includedSet].filter((c) => excludedSet.has(c)).sort()) {
      problems.push({
        resource,
        kind: "listed_twice",
        detail: `"${column}" is in BOTH includedColumns and excludedColumns`,
      });
    }
    for (const column of live.filter((c) => !includedSet.has(c) && !excludedSet.has(c))) {
      problems.push({
        resource,
        kind: "unaccounted_column",
        detail: `"${column}" exists in the database and is in neither includedColumns nor excludedColumns`,
      });
    }
    for (const column of [...includedSet, ...excludedSet].filter((c) => !liveSet.has(c)).sort()) {
      problems.push({
        resource,
        kind: "phantom_column",
        detail: `"${column}" is accounted for in the registry but does not exist in the database`,
      });
    }
    for (const excludedColumn of disposition.excludedColumns) {
      if (
        REASONS_REQUIRING_NOTE.has(excludedColumn.reason) &&
        (excludedColumn.note ?? "").trim().length === 0
      ) {
        problems.push({
          resource,
          kind: "missing_reason_note",
          detail: `"${excludedColumn.column}" is excluded as "${excludedColumn.reason}" with no note explaining what the studio does not get`,
        });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// GUARD 2b - THE EMISSION CONTRACT
// ---------------------------------------------------------------------------
//
// WHY GUARD 2 ALONE WAS NOT ENOUGH (Codex P1 on 25c066ab).
//
// Guard 2 is set arithmetic: included UNION excluded must equal the live column
// set. Nothing in it connects `includedColumns` to what the CSV actually
// carries. So a migration adds a column, somebody adds its NAME to
// includedColumns, Guard 2 goes green, and the studio is told it receives a
// field that reaches no file. That is the exact silent omission the registry
// exists to prevent, wearing the registry's own approval.
//
// This closes the declaration end of the chain in both directions:
//
//   every INCLUDED column resolves to at least one real header - itself, or the
//   headers its `emittedAs` entry names;
//   every EXCLUDED column is absent from the headers under its own name, so
//   "excluded" cannot describe a column the file is in fact emitting;
//   every HEADER is accounted for - an included column, an emittedAs target, or
//   a declared derivation.
//
// The value end of the chain - that the column is actually SELECTED and its
// value actually lands in the cell - is proved separately and against real
// rows, by tests/db/export-column-round-trip.db.test.ts. Declaration arithmetic
// cannot prove a value moved, and this function does not pretend to.

export type EmissionContractAudit = {
  readonly ok: boolean;
  readonly problems: ReadonlyArray<{
    readonly resource: string;
    readonly kind:
      | "included_not_emitted"
      | "excluded_but_emitted"
      | "unexplained_header"
      | "emitted_as_unknown_column"
      | "emitted_as_missing_header"
      | "derived_header_shadows_column";
    readonly detail: string;
  }>;
};

export function auditEmissionContract(
  resources: ReadonlyArray<RegistryEntry<ExportedDisposition>> = exportedResources(),
): EmissionContractAudit {
  const problems: Array<{
    resource: string;
    kind: EmissionContractAudit["problems"][number]["kind"];
    detail: string;
  }> = [];

  for (const { resource, disposition } of resources) {
    const headers = new Set(disposition.csvHeaders);
    const included = new Set(disposition.includedColumns);
    const excluded = new Set(disposition.excludedColumns.map((c) => c.column));
    const emittedAs = disposition.emittedAs ?? {};
    const derived = disposition.derivedHeaders ?? {};

    // A rename may only be declared for a column that is actually included, and
    // it must land somewhere real.
    for (const [column, mapping] of Object.entries(emittedAs)) {
      if (!included.has(column)) {
        problems.push({
          resource,
          kind: "emitted_as_unknown_column",
          detail: `emittedAs names "${column}", which is not an included column`,
        });
      }
      if (mapping.headers.length === 0) {
        problems.push({
          resource,
          kind: "emitted_as_missing_header",
          detail: `emittedAs for "${column}" names no header at all`,
        });
      }
      for (const header of mapping.headers) {
        if (!headers.has(header)) {
          problems.push({
            resource,
            kind: "emitted_as_missing_header",
            detail: `emittedAs maps "${column}" to "${header}", which is not in csvHeaders`,
          });
        }
      }
    }

    // THE P1 CHECK. Included means emitted.
    for (const column of disposition.includedColumns) {
      if (headers.has(column)) continue;
      const mapping = emittedAs[column];
      if (mapping && mapping.headers.length > 0 && mapping.headers.every((h) => headers.has(h))) {
        continue;
      }
      problems.push({
        resource,
        kind: "included_not_emitted",
        detail: `"${column}" is declared included but reaches no header: it is not in csvHeaders and has no emittedAs mapping`,
      });
    }

    // The reverse: a column cannot be called excluded while the file emits it.
    for (const column of disposition.excludedColumns) {
      if (headers.has(column.column)) {
        problems.push({
          resource,
          kind: "excluded_but_emitted",
          detail: `"${column.column}" is declared excluded (${column.reason}) but appears in csvHeaders`,
        });
      }
    }

    // And no header may be unexplained.
    const emittedTargets = new Set(
      Object.values(emittedAs).flatMap((m) => [...m.headers]),
    );
    for (const header of disposition.csvHeaders) {
      if (included.has(header) || emittedTargets.has(header) || header in derived) {
        continue;
      }
      problems.push({
        resource,
        kind: "unexplained_header",
        detail: `header "${header}" is neither an included column, an emittedAs target, nor a declared derivation`,
      });
    }

    // A derivation must not quietly stand in for a real column of this table:
    // that would let a genuine column be marked excluded while its name is
    // filled from somewhere else.
    for (const header of Object.keys(derived)) {
      if (included.has(header) || excluded.has(header)) {
        problems.push({
          resource,
          kind: "derived_header_shadows_column",
          detail: `"${header}" is declared derived but is also a real column of this table`,
        });
      }
    }
  }
  return { ok: problems.length === 0, problems };
}

// ---------------------------------------------------------------------------
// GUARD 2c - THE MIDDLE LINK: IS THE COLUMN ACTUALLY ASKED FOR?
// ---------------------------------------------------------------------------
//
// A column can be declared included, appear in csvHeaders, and STILL never
// reach the studio - because the exporter's explicit `.select()` list does not
// ask PostgREST for it. The cell would simply be empty, and every declaration
// check above would be satisfied.
//
// The caller supplies the column list the exporter actually requested, captured
// from the real `.select()` call rather than read out of the source. A regex
// over actions.ts would happily pass for a select string that is built and
// never used.
export type SelectedColumnAudit = {
  readonly ok: boolean;
  /** `resource.column` pairs declared included that the exporter never asks for. */
  readonly notSelected: readonly string[];
  /** Exported resources for which no SELECT was observed at all. */
  readonly notObserved: readonly string[];
};

export function auditSelectedColumns(
  selectedByResource: Readonly<Record<string, readonly string[]>>,
  resources: ReadonlyArray<RegistryEntry<ExportedDisposition>> = exportedResources(),
): SelectedColumnAudit {
  const notSelected: string[] = [];
  const notObserved: string[] = [];
  for (const { resource, disposition } of resources) {
    const selected = selectedByResource[resource];
    if (!selected) {
      notObserved.push(resource);
      continue;
    }
    const have = new Set(selected);
    for (const column of disposition.includedColumns) {
      if (!have.has(column)) notSelected.push(`${resource}.${column}`);
    }
  }
  return {
    ok: notSelected.length === 0 && notObserved.length === 0,
    notSelected: notSelected.sort(),
    notObserved: notObserved.sort(),
  };
}

// ---------------------------------------------------------------------------
// GUARD 3a - EXPORTED FILENAMES MUST BE UNIQUE
// ---------------------------------------------------------------------------
//
// Codex P2 on 25c066ab. `expectedCsvFiles()` collapses to a Set and JSZip keeps
// one entry per path, so two resources declaring the same `file` would produce:
// the second writeCsv silently overwriting the first's rows AND its manifest
// count, while emission parity still sees the expected filename and passes.
// Every downstream check would agree, and one resource's data would simply be
// gone.
//
// Checked BEFORE any Set or archive operation can collapse them.
export type FilenameAudit = {
  readonly ok: boolean;
  readonly duplicates: ReadonlyArray<{ file: string; resources: readonly string[] }>;
};

export function auditExportedFilenames(
  resources: ReadonlyArray<RegistryEntry<ExportedDisposition>> = exportedResources(),
): FilenameAudit {
  const byFile = new Map<string, string[]>();
  for (const { resource, disposition } of resources) {
    const bucket = byFile.get(disposition.file) ?? [];
    bucket.push(resource);
    byFile.set(disposition.file, bucket);
  }
  const duplicates = [...byFile.entries()]
    .filter(([, resourceNames]) => resourceNames.length > 1)
    .map(([file, resourceNames]) => ({ file, resources: [...resourceNames].sort() }))
    .sort((a, b) => a.file.localeCompare(b.file));
  return { ok: duplicates.length === 0, duplicates };
}

export function duplicateFilenameError(audit: FilenameAudit): string {
  const detail = audit.duplicates
    .map((d) => `${d.file} is declared by ${d.resources.join(" and ")}`)
    .join("; ");
  return (
    `Export aborted: the export registry declares the same filename twice (${detail}). ` +
    "One resource's rows would overwrite the other's. No export was produced."
  );
}

// ---------------------------------------------------------------------------
// GUARD 3 - emission parity
// ---------------------------------------------------------------------------

export type EmissionParity = {
  readonly ok: boolean;
  /** Declared exported, absent from the archive. */
  readonly missing: readonly string[];
  /** In the archive, declared nowhere. */
  readonly unregistered: readonly string[];
};

/**
 * The archive's CSV entries and the registry's exported file set must be equal,
 * in both directions.
 *
 * This REPLACES the older "was every written file counted" check. That one only
 * looked one way - a file written without a count failed, but a file the
 * registry promised and the archive never contained passed happily, and so did
 * a file nothing had declared. Two half-checks and two authorities became one
 * check and one authority.
 */
export function auditEmissionParity(
  emittedCsvFiles: readonly string[],
  /**
   * Files this run legitimately did not write, and which the manifest records
   * as omitted. Exactly one such omission exists: client_budget_context.csv
   * when migration 0183 is not applied. It is a PARAMETER rather than a
   * registry flag because it is a property of the RUN, not of the resource -
   * on a migrated database that file must be present, and a permanent
   * exemption would make its absence unfalsifiable.
   */
  toleratedOmissions: readonly string[] = [],
): EmissionParity {
  const emitted = new Set(emittedCsvFiles);
  const tolerated = new Set(toleratedOmissions);
  const expected = expectedCsvFiles();
  const missing = [...expected]
    .filter((f) => !emitted.has(f) && !tolerated.has(f))
    .sort();
  const unregistered = [...emitted].filter((f) => !expected.has(f)).sort();
  return { ok: missing.length === 0 && unregistered.length === 0, missing, unregistered };
}

/**
 * The single refusal message for an emission-parity failure. The export withholds
 * the ZIP rather than shipping one whose contents nothing describes.
 */
export function emissionParityError(parity: EmissionParity): string {
  const parts: string[] = [];
  if (parity.missing.length > 0) {
    parts.push(
      `the export registry declares ${parity.missing.join(", ")} but the archive does not contain ${parity.missing.length === 1 ? "it" : "them"}`,
    );
  }
  if (parity.unregistered.length > 0) {
    parts.push(
      `the archive contains ${parity.unregistered.join(", ")}, which no registry entry declares`,
    );
  }
  return `Export aborted: ${parts.join("; ")}. No partial export was produced.`;
}

// ---------------------------------------------------------------------------
// R2 - source-count coverage parity
// ---------------------------------------------------------------------------

export type CountCoverageAudit = {
  readonly ok: boolean;
  /** Declared studio_scoped, but the exporter runs no count for it. */
  readonly uncovered: readonly string[];
  /** The exporter counts it, but no registry entry declares a studio_scoped check. */
  readonly undeclared: readonly string[];
};

/**
 * The count checks the exporter actually performs must be exactly the ones the
 * registry declares `studio_scoped`.
 *
 * Without this, coverage drifts the quiet way: somebody adds a file, the
 * manifest lists it with a row count, and nothing anywhere says the count was
 * never compared to the database.
 */
export function auditSourceCountCoverage(
  checkedResources: readonly string[],
): CountCoverageAudit {
  const checked = new Set(checkedResources);
  const declared = new Set(studioScopedCountResources());
  const uncovered = [...declared].filter((r) => !checked.has(r)).sort();
  const undeclared = [...checked].filter((r) => !declared.has(r)).sort();
  return { ok: uncovered.length === 0 && undeclared.length === 0, uncovered, undeclared };
}
