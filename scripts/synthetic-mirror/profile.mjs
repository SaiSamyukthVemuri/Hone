/**
 * scripts/synthetic-mirror/profile.mjs — the aggregate-only source reader.
 *
 * THIS FILE IS THE PRIVACY BOUNDARY. Everything the mirror ever learns about
 * the source studio passes through the one SQL statement below, and that
 * statement returns nothing but `(key, count)` pairs.
 *
 * It answers "how busy and operationally messy is this studio?" and is
 * structurally incapable of answering "who are its clients and what happened to
 * each one?" — there is no row-level projection anywhere in it.
 *
 * HARD RULES (pinned by tests/scripts/synthetic-mirror/privacy.test.ts):
 *   - every selected expression is `count(*)` or `count(distinct <id column>)`;
 *   - no `select *`;
 *   - no identifying or clinical column is named anywhere in the SQL —
 *     see FORBIDDEN_IDENTIFIERS;
 *   - `client_id` appears ONLY inside `count(distinct client_id)`, which
 *     yields a cardinality, never an identity;
 *   - the result set is a fixed, closed vocabulary of keys, so a schema change
 *     cannot silently widen what crosses the boundary.
 *
 * Consequently NO source client id is ever selected, returned, stored or
 * mapped, and there is no source-client -> synthetic-client correspondence to
 * leak: the mirror only ever learns totals.
 */

/**
 * Column and concept names that must never appear in the source SQL. The
 * privacy test greps the generated statement for each of these.
 */
export const FORBIDDEN_IDENTIFIERS = Object.freeze([
  "name", "email", "phone", "address", "date_of_birth", "pronouns",
  "skin_notes", "contraindications", "notes", "session_notes",
  "next_session_note", "responses", "answers", "medical", "medication",
  "allergy", "allergies", "consent_text", "cancellation_reason",
  "stripe_", "payment_method", "payment_intent", "receipt",
  "token", "token_hash", "google_event_id", "message_sid", "ip_address",
  "user_agent", "photo", "image_path", "file_name",
]);

/** The closed vocabulary of aggregate keys the profile may contain. */
export const PROFILE_KEYS = Object.freeze([
  "clients_total",
  "clients_with_upcoming",
  "appt_confirmed",
  "appt_completed",
  "appt_cancelled",
  "appt_no_show",
  "intake_in_progress",
  "intake_submitted",
  "intake_reviewed",
  "sessions_total",
  "sessions_missing_aftercare",
  "sessions_with_next_note",
]);

/**
 * Build the aggregate-only profile statement for one studio.
 *
 * `studioId` is interpolated as a quoted literal rather than bound, because the
 * operator CLI shells out to `supabase db query --linked` (the repository's
 * only sanctioned read-only production path — see CLAUDE.md §5). It is
 * validated as a UUID by the caller and re-validated here, so the string can
 * never carry SQL.
 */
export function buildProfileSql(studioId) {
  if (!/^[0-9a-fA-F-]{36}$/.test(studioId)) {
    throw new TypeError("buildProfileSql: studioId must be a UUID");
  }
  const s = `'${studioId}'::uuid`;
  return `
select 'clients_total' as k, count(*)::int as n
  from public.clients where studio_id = ${s}
union all select 'clients_with_upcoming', count(distinct client_id)::int
  from public.appointments
  where studio_id = ${s} and status = 'confirmed' and starts_at > now()
union all select 'appt_confirmed', count(*)::int
  from public.appointments where studio_id = ${s} and status = 'confirmed'
union all select 'appt_completed', count(*)::int
  from public.appointments where studio_id = ${s} and status = 'completed'
union all select 'appt_cancelled', count(*)::int
  from public.appointments where studio_id = ${s} and status = 'cancelled'
union all select 'appt_no_show', count(*)::int
  from public.appointments where studio_id = ${s} and status = 'no_show'
union all select 'intake_in_progress', count(*)::int
  from public.client_intake_forms
  where studio_id = ${s} and deleted_at is null and status = 'in_progress'
union all select 'intake_submitted', count(*)::int
  from public.client_intake_forms
  where studio_id = ${s} and deleted_at is null and status = 'submitted'
union all select 'intake_reviewed', count(*)::int
  from public.client_intake_forms
  where studio_id = ${s} and deleted_at is null and status = 'reviewed'
union all select 'sessions_total', count(*)::int
  from public.sessions where studio_id = ${s} and deleted_at is null
union all select 'sessions_missing_aftercare', count(*)::int
  from public.sessions
  where studio_id = ${s} and deleted_at is null
    and aftercare_and_risks_explained_at is null
union all select 'sessions_with_next_note', count(*)::int
  from public.sessions
  where studio_id = ${s} and deleted_at is null
    and next_session_note is not null and length(btrim(next_session_note)) > 0
`.trim();
}

/**
 * Fold `(k, n)` rows into a profile object with every key present.
 * Unknown keys are DROPPED rather than passed through, so even a future schema
 * change cannot widen what the mirror consumes.
 */
export function foldProfile(rows) {
  const profile = {};
  for (const key of PROFILE_KEYS) profile[key] = 0;
  for (const row of rows ?? []) {
    const k = row?.k;
    if (typeof k !== "string" || !PROFILE_KEYS.includes(k)) continue;
    const n = Number(row.n);
    profile[k] = Number.isFinite(n) && n >= 0 ? Math.trunc(n) : 0;
  }
  return profile;
}

/** True if `value` is a profile object and nothing else. */
export function isCleanProfile(value) {
  if (typeof value !== "object" || value === null) return false;
  const keys = Object.keys(value);
  if (keys.length !== PROFILE_KEYS.length) return false;
  return keys.every(
    (k) => PROFILE_KEYS.includes(k) && Number.isInteger(value[k]) && value[k] >= 0,
  );
}
