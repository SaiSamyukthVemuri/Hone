-- Migration 0026: treatment goals + client-facing time toggle.
--
-- Treatment goals: a per-client estimated total in minutes. Single row per
-- client (unique constraint); editing in place. Status reflects whether the
-- original estimate held, was revised, or was reached.
--
-- Studio toggle: opt-in client-facing treatment time line in confirmation
-- and reminder emails. Off by default (privacy-preserving).
--
-- Sessions index: speeds up the per-client electrolysis sum used by the
-- treatment-time card and the running total on session detail.
--
-- Single paste block, additive only, safe to re-run.

create table if not exists public.treatment_goals (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  estimated_total_minutes integer not null
    check (estimated_total_minutes > 0 and estimated_total_minutes <= 100000),
  notes text,
  status text not null default 'active'
    check (status in ('active', 'reached', 'revised', 'archived')),
  created_by uuid references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.treatment_goals
  drop constraint if exists treatment_goals_client_unique;
alter table public.treatment_goals
  add constraint treatment_goals_client_unique unique (client_id);

create index if not exists treatment_goals_studio_idx
  on public.treatment_goals (studio_id);

alter table public.treatment_goals enable row level security;

drop policy if exists "treatment_goals_studio_member_all"
  on public.treatment_goals;
create policy "treatment_goals_studio_member_all"
  on public.treatment_goals for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- Studio toggle: opt-in client-facing display of treatment time in emails.
alter table public.studios
  add column if not exists show_treatment_time_to_clients boolean not null
    default false;

-- Per-client lookup of non-deleted electrolysis sessions, used by the
-- total-time queries.
create index if not exists sessions_client_electrolysis_idx
  on public.sessions (client_id, started_at)
  where deleted_at is null and modality = 'electrolysis';
