-- Migration 0035: Client personal notes (practitioner-only relationship memory).
--
-- Stores two practitioner-only freeform fields per client:
--   personal_notes    — kids/pets/partner/job/vacations/preferences/
--                       conversation follow-ups, etc.
--   private_warnings  — repeated lateness, ignored aftercare,
--                       uncomfortable interactions, boundary notes,
--                       safety/professional notes
--
-- One row per client (UNIQUE on client_id). The row is created lazily
-- on first save; the UI shows an empty-state until then.
--
-- Privacy contract (DB side has no public surface; the application-side
-- contract is enforced by the import audit + grep in the PR description):
--   * These notes MUST NOT appear in app/book/*, lib/email/*, app/intake/*,
--     app/cancel/*, app/reschedule/*, app/api/cron/*, or any Stripe/
--     webhook surface.
--   * RLS limits read/write to is_studio_member(studio_id); studio_id
--     is auto-derived from the parent clients row by the trigger below
--     so the browser cannot spoof it (same pattern as
--     treatment_plan_stages_set_studio_id from migration 0034).
--
-- Re-runnable: create/alter/drop-if-exists/add-if-not-exists throughout.

create table if not exists public.client_personal_notes (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null
    references public.clients(id) on delete cascade,
  -- Denormalized for RLS. Always kept in sync with the parent client's
  -- studio_id by the BEFORE INSERT/UPDATE trigger below.
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  personal_notes text not null default '',
  private_warnings text not null default '',
  updated_by_practitioner_id uuid
    references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Unique: one row per client.
alter table public.client_personal_notes
  drop constraint if exists client_personal_notes_client_unique;
alter table public.client_personal_notes
  add constraint client_personal_notes_client_unique unique (client_id);

-- Named length check constraints (drop-if-exists then add for
-- re-runnability against an existing database).
alter table public.client_personal_notes
  drop constraint if exists client_personal_notes_personal_length_check;
alter table public.client_personal_notes
  add constraint client_personal_notes_personal_length_check
  check (length(personal_notes) <= 20000);

alter table public.client_personal_notes
  drop constraint if exists client_personal_notes_warnings_length_check;
alter table public.client_personal_notes
  add constraint client_personal_notes_warnings_length_check
  check (length(private_warnings) <= 20000);

-- Indexes.
create index if not exists client_personal_notes_client_idx
  on public.client_personal_notes (client_id);

create index if not exists client_personal_notes_studio_idx
  on public.client_personal_notes (studio_id);

-- updated_at trigger reuses the existing public.set_updated_at() helper
-- defined in migration 0015 (used by client_intake_forms, session_blocks,
-- treatment_plan_stages).
drop trigger if exists client_personal_notes_set_updated_at
  on public.client_personal_notes;
create trigger client_personal_notes_set_updated_at
  before update on public.client_personal_notes
  for each row execute function public.set_updated_at();

-- Studio-id consistency trigger. Mirrors the structure of
-- treatment_plan_stages_set_studio_id from migration 0034: derives
-- studio_id from the parent clients row on INSERT and UPDATE OF
-- client_id, overwriting any caller-supplied value. Without this
-- trigger a buggy or malicious insert could attach a notes row whose
-- studio_id points to a different studio than the parent client and
-- slip past the is_studio_member() RLS check via the wrong studio.
create or replace function public.client_personal_notes_set_studio_id()
returns trigger
language plpgsql
as $$
begin
  select studio_id into new.studio_id
  from public.clients
  where id = new.client_id;

  if new.studio_id is null then
    raise exception 'client_personal_notes.client_id % does not reference an existing clients row',
      new.client_id;
  end if;

  return new;
end;
$$;

drop trigger if exists client_personal_notes_set_studio_id
  on public.client_personal_notes;
create trigger client_personal_notes_set_studio_id
  before insert or update of client_id
  on public.client_personal_notes
  for each row execute function public.client_personal_notes_set_studio_id();

-- RLS. Single for-all policy using the project-standard is_studio_member()
-- helper (same shape as treatment_goals/session_blocks/treatment_plan_stages).
alter table public.client_personal_notes enable row level security;

drop policy if exists "client_personal_notes_studio_member_all"
  on public.client_personal_notes;
create policy "client_personal_notes_studio_member_all"
  on public.client_personal_notes for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
