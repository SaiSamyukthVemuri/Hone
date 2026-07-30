-- ---------------------------------------------------------------------------
-- Migration 0160: a treatment record belongs to ONE client and ONE encounter,
-- for good. Closes same-studio wrong-client / wrong-record re-parenting.
--
-- DEPENDS ON: migration 0159 (retire signed clinical records). Apply 0159 first.
--
-- THE DEFECT (reproduced against a CI-parity database, as the `authenticated`
-- browser role with a real studio-member JWT, in rolled-back transactions):
--
--   update public.sessions      set client_id  = <another client in my studio>  -- REACHABLE
--   update public.session_blocks set session_id = <another client's session>     -- REACHABLE
--
-- Both succeed. Tenant isolation holds — RLS correctly refuses a cross-STUDIO
-- re-tenant (42501) — but WITHIN a studio the member policies are
-- `using (is_studio_member(studio_id)) with check (is_studio_member(studio_id))`,
-- and that predicate is still satisfied after the parent changes. So a raw
-- PostgREST PATCH can move a whole treatment session onto a different client's
-- chart, or move a settings block — and with it its structured treatment areas —
-- onto another client's encounter.
--
-- The second one is only reachable when the block has no electrolysis entries yet:
-- with entries, the composite FK electrolysis_entries(session_id, block_id) fails
-- first. That INCIDENTAL protection is exactly why an explicit guard is needed —
-- correctness that depends on a child row happening to exist is not correctness.
--
-- WHY THIS IS NOT THE RETIRED CAPABILITY. Nothing here freezes a record or makes it
-- signed. Treatment sessions stay ORDINARY and EDITABLE: notes, settings, areas,
-- passes, timings, practitioner, aftercare, soft-delete — all unchanged. The only
-- thing made immutable is WHOSE record it is and WHICH encounter a child belongs
-- to. A mis-filed session is not corrected by silently re-pointing a row; it is
-- corrected by soft-deleting it and charting it on the right client, which leaves
-- an actor-attributed audit trail instead of rewriting history in place.
--
-- WHY IT NEEDS NO APPLICATION CHANGE. The deployed application never updates any of
-- these columns. Verified by call-site inventory across app/, lib/ and components/:
-- every write derives studio/session/client server-side and none of the 26
-- direct-DML sites puts client_id, session_id or block_id in an UPDATE payload.
-- treatment_images sets client_id/session_id/session_block_id on INSERT only (the
-- upload path, which validates the block's parent lineage server-side first), and
-- is only ever UPDATEd for practitioner_note and soft-delete. So this migration is
-- invisible to both the deployed app and the new one.
--
-- SCOPE. Only the lineage columns, only on UPDATE, and only when the value actually
-- changes. INSERT is untouched — that is where a row's lineage is legitimately
-- established.
--
-- Migration max 0159 -> 0160.
--
-- ---------------------------------------------------------------------------
-- WHY THIS FILE OPENS ITS OWN TRANSACTION (learned the hard way from 0159).
--
-- Applying migration 0159 to production on 2026-07-30 emitted:
--
--   WARNING (25P01): SET LOCAL can only be used in transaction blocks
--
-- The production apply path (`supabase db push --linked`) does NOT wrap a
-- migration file in an explicit transaction. Two consequences, both bad:
--
--   1. `SET LOCAL lock_timeout` silently did nothing. The five-second timeout
--      NEVER ARMED, so the apply could have blocked indefinitely behind a live
--      charting transaction instead of failing fast.
--   2. The file was NOT ATOMIC. A failure partway through would have left some
--      objects created and others not, with no rollback — 0159's completeness
--      had to be re-verified section by section afterwards rather than being
--      guaranteed.
--
-- A file containing `SET LOCAL` is therefore NOT transactional merely because it
-- says so. This migration opens the transaction itself, so the timeout genuinely
-- arms and the whole file commits or rolls back as one unit.
--
-- EXPECTED ROLLBACK BEHAVIOUR. If any statement fails — including a
-- lock_timeout (SQLSTATE 55P03) while acquiring the ACCESS EXCLUSIVE lock that
-- CREATE TRIGGER needs — the COMMIT is never reached and the entire transaction
-- rolls back. The required post-failure state is: ZERO 0160 ledger rows, ZERO of
-- the two guard functions, ZERO of the five triggers, no partial COMMENT, and
-- every existing row unchanged. Re-running is then safe and idempotent.
--
-- `SET LOCAL` (not a session-global `SET`) is deliberate: it is scoped to this
-- transaction and reverts at COMMIT/ROLLBACK, so it can never leak a modified
-- lock_timeout into the pooled connection that runs the next migration.
--
-- Every statement below is legal inside a transaction block. This migration uses
-- no CREATE INDEX CONCURRENTLY, no ALTER TYPE ... ADD VALUE, no database
-- create/drop, no VACUUM, and no other transaction-forbidden operation.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ===========================================================================
-- 1. The guard.
-- ===========================================================================
-- One function for every clinical table, driven by TG_ARGV so each trigger names
-- the columns that are immutable for its own table. SECURITY INVOKER: it inspects
-- only OLD/NEW, reads nothing, and therefore needs no elevated rights — the less
-- authority a guard holds, the less there is to abuse.
create or replace function public.guard_immutable_clinical_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_col  text;
  v_old  text;
  v_new  text;
begin
  foreach v_col in array tg_argv
  loop
    execute format('select ($1).%I::text, ($2).%I::text', v_col, v_col)
       into v_old, v_new
      using old, new;
    if v_old is distinct from v_new then
      raise exception
        'A treatment record cannot be re-assigned: %.% is fixed once the row exists (attempted % -> %). File it on the correct client instead — soft-delete this record and chart it where it belongs, which keeps an attributable trail.',
        tg_table_name, v_col, coalesce(v_old, 'null'), coalesce(v_new, 'null')
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

-- Companion for a column that an FK ON DELETE SET NULL is allowed to CLEAR but
-- nothing may ever RE-POINT. electrolysis_entries.block_id is exactly that: the
-- composite FK electrolysis_entries(session_id, block_id) -> session_blocks is
-- ON DELETE SET NULL (block_id), so hard-deleting a settings block legitimately
-- nulls it on every pass that referenced it. A blunt immutability guard would
-- REJECT that cascade and wedge block deletion — the same trap migration 0093
-- already navigated for treatment_images. Clearing to NULL is permitted; changing
-- to a DIFFERENT non-null parent is not.
create or replace function public.guard_clearable_clinical_lineage()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_col text;
  v_old text;
  v_new text;
begin
  foreach v_col in array tg_argv
  loop
    execute format('select ($1).%I::text, ($2).%I::text', v_col, v_col)
       into v_old, v_new
      using old, new;
    if v_old is distinct from v_new and v_new is not null then
      raise exception
        'A treatment record cannot be re-assigned: %.% may be cleared by a parent delete but never re-pointed (attempted % -> %). File it on the correct record instead.',
        tg_table_name, v_col, coalesce(v_old, 'null'), v_new
        using errcode = 'check_violation';
    end if;
  end loop;
  return new;
end;
$$;

comment on function public.guard_clearable_clinical_lineage() is
  '0160: like guard_immutable_clinical_lineage, but tolerates a transition to NULL so an FK ON DELETE SET NULL cascade still works. Used for electrolysis_entries.block_id.';

comment on function public.guard_immutable_clinical_lineage() is
  '0160: refuses an UPDATE that changes a clinical row''s lineage (which client / which encounter / which settings block it belongs to). Column list per table comes from TG_ARGV. Tenant isolation is already handled by RLS; this closes the SAME-STUDIO wrong-client and wrong-record re-parenting that the member policies allow because their predicate still holds after the parent changes.';

-- ===========================================================================
-- 2. Attach it, table by table, naming only genuinely immutable columns.
-- ===========================================================================
-- sessions: a session is one client's encounter. studio_id is pinned as well —
-- RLS already refuses a cross-studio move, but a defence that depends on a policy
-- predicate is worth backing with a trigger.
drop trigger if exists sessions_immutable_lineage on public.sessions;
create trigger sessions_immutable_lineage
  before update of client_id, studio_id on public.sessions
  for each row execute function public.guard_immutable_clinical_lineage('client_id', 'studio_id');

-- session_blocks: a settings block (and every structured area hanging off it)
-- belongs to one encounter.
drop trigger if exists session_blocks_immutable_lineage on public.session_blocks;
create trigger session_blocks_immutable_lineage
  before update of session_id, studio_id on public.session_blocks
  for each row execute function public.guard_immutable_clinical_lineage('session_id', 'studio_id');

-- electrolysis_entries / laser_entries: a recorded pass belongs to one encounter,
-- and (for electrolysis) one settings block. Today the composite FK blocks most of
-- this incidentally; make it explicit.
drop trigger if exists electrolysis_entries_immutable_lineage on public.electrolysis_entries;
create trigger electrolysis_entries_immutable_lineage
  before update of session_id on public.electrolysis_entries
  for each row execute function public.guard_immutable_clinical_lineage('session_id');

-- block_id separately: clearable by the FK cascade, never re-pointable.
drop trigger if exists electrolysis_entries_clearable_lineage on public.electrolysis_entries;
create trigger electrolysis_entries_clearable_lineage
  before update of block_id on public.electrolysis_entries
  for each row execute function public.guard_clearable_clinical_lineage('block_id');

drop trigger if exists laser_entries_immutable_lineage on public.laser_entries;
create trigger laser_entries_immutable_lineage
  before update of session_id on public.laser_entries
  for each row execute function public.guard_immutable_clinical_lineage('session_id');

commit;

-- treatment_images: DELIBERATELY NOT COVERED HERE. Migration 0093's
-- treatment_images_enforce_integrity trigger already freezes studio_id, client_id,
-- storage_bucket and storage_path outright and forbids RE-POINTING session_id /
-- session_block_id while still allowing the FK ON DELETE SET NULL cascade to clear
-- them. That is strictly better than a blunt guard here would be — adding one would
-- be redundant at best and would wedge the cascade at worst. Verified against the
-- live schema: the trigger exists and raises 'treatment_images identity columns are
-- immutable'. The image case is covered by tests here to prove it, not re-guarded.

-- ===========================================================================
-- 3. Operator verification (READ-ONLY; run after apply).
-- ===========================================================================
--   -- five triggers, all pointing at the one guard
--   select tgrelid::regclass as tbl, tgname
--     from pg_trigger
--    where tgfoid in ('public.guard_immutable_clinical_lineage'::regproc,
--                     'public.guard_clearable_clinical_lineage'::regproc)
--      and not tgisinternal
--    order by 1;
--
--   -- ZERO DATA OPERATION: nothing above writes a row. Counts must be unchanged.
--   select (select count(*) from public.sessions)             as sessions,
--          (select count(*) from public.session_blocks)       as blocks,
--          (select count(*) from public.electrolysis_entries) as entries,
--          (select count(*) from public.treatment_images)     as images;
--
--   -- Sanity: no existing row violates the new invariant, because the invariant is
--   -- about TRANSITIONS. Nothing to validate, nothing to backfill.
