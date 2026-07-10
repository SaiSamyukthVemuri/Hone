-- 0118_intake_terminal_immutability.sql
--
-- Close a same-tenant clinical-record integrity defect: after an intake is
-- submitted or reviewed, an authenticated studio member could still directly
-- PATCH its answers/status/review metadata via PostgREST, because the UPDATE
-- policy (0087) is only studio-membership scoped with no terminal-state guard.
-- The UI never does this (submit/save guard on status='in_progress', and
-- corrections go through the reissue flow that creates a NEW intake row), but
-- the DB boundary did not enforce it.
--
-- Fix (Option A, interim integrity guard): a BEFORE UPDATE trigger that, for
-- AUTHENTICATED end-user updates (service-role is exempt — trusted admin /
-- backfill paths reassert ownership in code), once status is submitted/reviewed:
--   * `responses` (the answers) are immutable — amend by creating a new intake;
--   * `submitted_at` is immutable;
--   * status cannot regress to 'in_progress';
--   * `reviewed_by` may only be set to one of the CALLER'S own active
--     practitioners (no foreign attribution), and once reviewed the review
--     attribution (reviewed_by / reviewed_at) is immutable.
-- Review metadata that MAY still change on a reviewed row (practitioner_notes,
-- reissue/link columns) is intentionally NOT restricted.
--
-- SAFE / SCOPE:
--   * NO schema change (no columns/constraints), NO data change, NO backfill;
--     existing rows are untouched (BEFORE UPDATE only affects new updates). A
--     read-only audit found 0 terminal→draft-inconsistent rows.
--   * NO RLS/policy/grant change — this ADDS a trigger; it does not weaken RLS.
--   * NO app code change: submit/save guard on in_progress; markIntakeReviewed
--     sets reviewed_by = the caller's own practitioner; saveIntakeNotes touches
--     only practitioner_notes; reissue INSERTs a new row. All satisfy the guard,
--     so migration-first is safe (no ordering hazard).
--   * SECURITY INVOKER (default): the reviewed_by check reads public.practitioners
--     under the caller's RLS, which can see the caller's own studio rows.
--
-- Migration max 0117 -> 0118.

create or replace function public.enforce_intake_terminal_immutability()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  -- Service-role / admin paths (no JWT) are trusted and exempt. The defect is a
  -- direct AUTHENTICATED PostgREST update, which always carries auth.uid().
  if auth.uid() is null then
    return new;
  end if;

  if old.status in ('submitted', 'reviewed') then
    if new.responses is distinct from old.responses then
      raise exception
        'Submitted intake answers are immutable; create a new intake to amend.'
        using errcode = 'check_violation';
    end if;

    if new.submitted_at is distinct from old.submitted_at then
      raise exception 'submitted_at is immutable after submission.'
        using errcode = 'check_violation';
    end if;

    if new.status = 'in_progress' then
      raise exception
        'A submitted or reviewed intake cannot be reverted to draft.'
        using errcode = 'check_violation';
    end if;

    -- Marking reviewed: the reviewer must be one of the caller's OWN active
    -- practitioners (server-derived actor), never a foreign practitioner.
    if new.status = 'reviewed'
       and new.reviewed_by is distinct from old.reviewed_by
       and (
         new.reviewed_by is null
         or new.reviewed_by not in (
           select id from public.practitioners
           where user_id = auth.uid() and active = true
         )
       ) then
      raise exception 'reviewed_by must be the reviewing practitioner.'
        using errcode = 'check_violation';
    end if;

    -- Once reviewed, the review attribution (who + when) is immutable.
    if old.status = 'reviewed'
       and (
         new.reviewed_by is distinct from old.reviewed_by
         or new.reviewed_at is distinct from old.reviewed_at
       ) then
      raise exception 'Review attribution is immutable once reviewed.'
        using errcode = 'check_violation';
    end if;
  end if;

  return new;
end;
$$;

drop trigger if exists client_intake_forms_terminal_immutability
  on public.client_intake_forms;

create trigger client_intake_forms_terminal_immutability
  before update on public.client_intake_forms
  for each row
  execute function public.enforce_intake_terminal_immutability();
