-- Migration 0015: client health intake forms.
-- One row per intake (a returning client after a year can be asked to fill
-- a fresh one). Responses live as JSONB so question text can evolve without
-- schema migrations. Token verification happens in app code; the row itself
-- has no token column.
--
-- Re-runnable: create table if not exists, drop constraint/policy if exists.

-- Step 1: shared updated_at trigger helper. The spec assumed this existed
-- from earlier migrations but it did not, so we create it here.
create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- Step 2: the table.
create table if not exists public.client_intake_forms (
  id uuid primary key default gen_random_uuid(),
  studio_id uuid not null references public.studios(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,

  status text not null default 'in_progress',
  current_step integer not null default 1,

  responses jsonb not null default '{}'::jsonb,

  started_at timestamptz not null default now(),
  submitted_at timestamptz,
  reviewed_at timestamptz,
  reviewed_by uuid references public.practitioners(id) on delete set null,

  practitioner_notes text,

  deleted_at timestamptz,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.client_intake_forms
  drop constraint if exists client_intake_forms_status_check;
alter table public.client_intake_forms
  add constraint client_intake_forms_status_check
  check (status in ('in_progress', 'submitted', 'reviewed'));

alter table public.client_intake_forms
  drop constraint if exists client_intake_forms_step_check;
alter table public.client_intake_forms
  add constraint client_intake_forms_step_check
  check (current_step between 1 and 5);

-- Partial indexes ignore soft-deleted rows.
drop index if exists client_intake_forms_client_id_idx;
create index client_intake_forms_client_id_idx
  on public.client_intake_forms (client_id)
  where deleted_at is null;

drop index if exists client_intake_forms_studio_id_idx;
create index client_intake_forms_studio_id_idx
  on public.client_intake_forms (studio_id)
  where deleted_at is null;

drop index if exists client_intake_forms_status_idx;
create index client_intake_forms_status_idx
  on public.client_intake_forms (studio_id, status)
  where deleted_at is null;

-- updated_at trigger.
drop trigger if exists client_intake_forms_set_updated_at on public.client_intake_forms;
create trigger client_intake_forms_set_updated_at
  before update on public.client_intake_forms
  for each row execute function public.set_updated_at();

-- Step 3: RLS. Studio members read/write their own studio's intakes.
-- Public save/submit paths use the service-role admin client and bypass RLS.
alter table public.client_intake_forms enable row level security;

drop policy if exists "client_intake_forms_member_all" on public.client_intake_forms;
create policy "client_intake_forms_member_all"
  on public.client_intake_forms
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
