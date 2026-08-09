/**
 * scripts/synthetic-mirror/plan-schema.mjs — the CLOSED execution-plan schema.
 *
 * The exported plan is the boundary between this repository (which decides WHAT
 * a synthetic population should look like) and a future executor (which writes
 * it). Treat it as a security boundary in the same way a request body from an
 * untrusted client would be treated: the executor's authority is exactly what
 * this schema permits and nothing more.
 *
 * CLOSED, NOT EXTENSIBLE
 * ----------------------
 * Every writable entity and every writable column is allowlisted here by name.
 * An unknown entity, an unknown column or an unknown top-level key is a hard
 * REFUSAL, never a warning and never silently ignored — silently ignoring an
 * unknown field is how execution authority widens without anyone deciding to
 * widen it. `schema_version` is checked exactly; a plan from a future version is
 * refused rather than best-effort interpreted.
 *
 * WHAT THE EXECUTOR MAY NEVER RECEIVE
 * -----------------------------------
 * There is no table name, SQL fragment, connection string, studio selector or
 * free-form identifier anywhere in this format. The executor cannot be told to
 * write somewhere else, because the format has nowhere to say it.
 */

export const SCHEMA_VERSION = 1;

/** Top-level keys. Anything else is a refusal. */
export const ENVELOPE_KEYS = Object.freeze([
  "schema_version",
  "plan_id",
  "generated_at",
  "body",
]);

/** Keys of the digested body. Anything else is a refusal. */
export const BODY_KEYS = Object.freeze([
  "namespace",
  "target",
  "source_profile",
  "expected_counts",
  "entities",
  "safety_assertions",
]);

/**
 * The ONLY writable entities, in DEPENDENCY-SAFE INSERT ORDER.
 *
 * Order is derived from the live foreign keys, not guessed:
 *   clients              -> studios
 *   client_intake_forms  -> studios, clients
 *   appointments         -> studios, clients, practitioners, services
 *   sessions             -> studios, clients, practitioners, appointments
 *   session_blocks       -> studios, sessions
 * so clients precede their children, appointments precede the sessions that
 * chart them, and sessions precede their blocks. Reset walks this list in
 * REVERSE, which is what keeps the deletes FK-safe.
 */
export const ENTITY_ORDER = Object.freeze([
  "clients",
  "client_intake_forms",
  "appointments",
  "sessions",
  "session_blocks",
]);

/** entity -> the exact physical table it may touch. Not caller-supplied. */
export const ENTITY_TABLE = Object.freeze({
  clients: "clients",
  client_intake_forms: "client_intake_forms",
  appointments: "appointments",
  sessions: "sessions",
  session_blocks: "session_blocks",
});

/** entity -> the synthetic identity kind used to derive/prove its primary key. */
export const ENTITY_IDENTITY = Object.freeze({
  clients: "client",
  client_intake_forms: "intake",
  appointments: "appointment",
  sessions: "session",
  session_blocks: "session_block",
});

/**
 * entity -> allowlisted columns. A column absent from this list may not be
 * written even if the table has it. Note what is deliberately ABSENT:
 * every provider identifier, every token column, every payment column, and
 * every _sent_at / _send_attempts reminder-bookkeeping column.
 */
export const ALLOWED_COLUMNS = Object.freeze({
  clients: Object.freeze([
    "id", "studio_id", "name", "pronouns", "date_of_birth",
    "email", "phone", "address",
    "fitzpatrick_type", "skin_notes", "contraindications",
    "photo_consent", "notes",
  ]),
  client_intake_forms: Object.freeze([
    "id", "studio_id", "client_id", "status",
  ]),
  appointments: Object.freeze([
    "id", "studio_id", "client_id", "practitioner_id", "service_id",
    "starts_at", "ends_at", "duration_minutes",
    "buffer_minutes_snapshot", "blocked_ends_at",
    "status", "notes",
    "cancelled_at", "cancelled_by", "cancellation_reason",
  ]),
  sessions: Object.freeze([
    "id", "studio_id", "client_id", "practitioner_id", "modality",
    "appointment_id",
    "started_at", "ended_at",
    "session_notes", "next_session_note",
    "aftercare_and_risks_explained_at",
  ]),
  session_blocks: Object.freeze([
    "id", "studio_id", "session_id",
    "primary_area",
    "probe_lot_number", "probe_lot_confirmed",
    "caution_for_next_session", "caution_note",
    "reaction_type", "reaction_notes", "tolerance_rating",
  ]),
});

/**
 * Columns that MUST be null on every generated client row. This is the
 * structural provider guarantee, restated as a schema rule so it is enforced by
 * the verifier rather than only by the generator's good behaviour.
 */
export const MUST_BE_NULL = Object.freeze({
  clients: Object.freeze(["email", "phone", "address"]),
});

/** Closed value vocabularies, taken from the tables' own CHECK constraints. */
export const ALLOWED_VALUES = Object.freeze({
  appointments: Object.freeze({
    status: Object.freeze(["confirmed", "cancelled", "completed", "no_show"]),
    cancelled_by: Object.freeze(["client", "practitioner", "owner", null]),
  }),
  sessions: Object.freeze({
    modality: Object.freeze(["electrolysis", "laser"]),
  }),
  client_intake_forms: Object.freeze({
    status: Object.freeze(["in_progress", "submitted", "reviewed"]),
  }),
  session_blocks: Object.freeze({
    probe_lot_confirmed: Object.freeze([true, false]),
  }),
});

/**
 * Conservative ceilings. A plan larger than this is refused outright rather
 * than executed, on the principle that a runaway generator should fail loudly
 * long before it fills a studio. Willow is ~50 clients / ~130 appointments, so
 * these leave roughly an order of magnitude of headroom.
 */
export const CEILINGS = Object.freeze({
  perEntity: 2000,
  total: 5000,
});

/**
 * Substrings that must never appear in a serialized plan.
 *
 * Deliberately specific rather than broad: a bare "photo" would collide with
 * the legitimate `clients.photo_consent` column and a bare "image" with
 * ordinary prose, and a check that fires on a legal field teaches the next
 * author to weaken the check. Each entry below names an actual leak.
 */
export const FORBIDDEN_PLAN_KEYS = Object.freeze([
  "source_client", "source_id", "source_studio", "willow", "mapping",
  "stripe", "payment_intent", "payment_method", "customer_id", "receipt",
  "cancellation_token", "auth_token", "access_token", "token_hash",
  "google_event", "message_sid", "ip_address", "user_agent",
  "photo_url", "photo_path", "image_path", "treatment_image",
]);
