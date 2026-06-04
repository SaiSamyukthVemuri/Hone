-- PR #156. Foundation for treatment memory: link sessions to appointments.
--
-- BEFORE this migration, sessions had no appointment_id. Code in
-- lib/supabase/queries.ts:getPastConfirmedAppointmentsForClient
-- relied on a +/- 2 hour starts_at proximity filter to dedupe
-- charted sessions against past confirmed appointments for the
-- client's "uncharted visits" surface. The PR #43 postcare migration
-- header acknowledged this gap. Time-window matching is fine for
-- legacy data, but is brittle for same-day visits and reschedules.
--
-- This migration adds the explicit linkage so new appointment-scoped
-- session creation can record which appointment produced which
-- session. Three invariants are deliberately NOT enforced here:
--
--   1. NO historical backfill. Mutating clinical records by guessing
--      which appointment produced which session would silently
--      corrupt the exact treatment memory this column exists to
--      protect. Backfill, if it ever happens, will be a separate
--      supervised PR that previews matches, leaves ambiguous rows
--      null, and ships only after human review.
--
--   2. NO uniqueness constraint. One appointment may legitimately
--      have zero or more session rows (treatment-block split,
--      multi-area work). One session belongs to zero or one
--      appointment. The runtime invariant is one-to-many in that
--      direction, not one-to-one.
--
--   3. NO cross-table consistency trigger. Server-side action code
--      validates lineage (same studio, same client) before linking;
--      that pattern matches every other write path in the codebase
--      and is easier to reason about than a SECURITY DEFINER
--      trigger.
--
-- ON DELETE SET NULL preserves the session row when the parent
-- appointment is removed (rare; we soft-delete or status-flip
-- appointments rather than DELETE them). The treatment record is
-- the durable clinical artefact; losing the appointment pointer
-- is a smaller harm than losing the session.
--
-- RLS posture is unchanged. The single "sessions: members all"
-- policy from migration 0001 (using public.is_studio_member
-- (studio_id)) already gates every read and write through studio
-- membership. Appointments carry the same studio-member policy
-- from migration 0010. Adding a nullable FK pointer does not widen
-- the visibility boundary, and the server action verifies
-- (studio_id, client_id) lineage before writing appointment_id.

-- 1. Nullable FK column. ON DELETE SET NULL keeps the session row
--    alive if the appointment is deleted (we generally do not
--    delete appointments, but the cascade-on-delete is explicit
--    insurance against an orphaned-row situation).
alter table public.sessions
  add column if not exists appointment_id uuid
  references public.appointments(id)
  on delete set null;

-- 2. Lookup index for "give me the appointment for this session"
--    and "is this appointment already charted?" The partial WHERE
--    keeps the index small while the column is mostly null in this
--    PR (historical rows + client-scoped flow).
create index if not exists sessions_appointment_id_idx
  on public.sessions(appointment_id)
  where appointment_id is not null;

-- 3. Compound index for the studio-scoped path
--    getPastConfirmedAppointmentsForClient takes: "load the set of
--    appointment_ids explicitly linked to a session under this
--    studio." Partial on appointment_id is not null mirrors the
--    same null-skew posture as index 2.
create index if not exists sessions_studio_appointment_idx
  on public.sessions(studio_id, appointment_id)
  where appointment_id is not null;

-- Verification SQL (operator runs after deploy; do NOT run UPDATE):
--
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public'
--     and table_name = 'sessions'
--     and column_name = 'appointment_id';
--
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--   where conrelid = 'public.sessions'::regclass
--     and conname ilike '%appointment%';
--
--   select indexname, indexdef
--   from pg_indexes
--   where schemaname = 'public'
--     and tablename = 'sessions'
--     and indexdef ilike '%appointment_id%';
--
--   select
--     count(*) filter (where appointment_id is not null) as linked_sessions,
--     count(*) filter (where appointment_id is null)     as unlinked_sessions
--   from public.sessions;
--
-- Expected immediately after deploy:
--   linked_sessions = 0
--   unlinked_sessions = current total session row count
--
-- The "linked" count climbs only as new appointment-scoped session
-- creation runs in production. Historical rows stay null until a
-- supervised backfill PR ships.
