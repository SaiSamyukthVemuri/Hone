-- Migration 0024: treatment plans for multi-session electrolysis work.
-- Each plan tracks a target visit count for a client; sessions can be
-- attached to a plan via sessions.treatment_plan_id (nullable FK). A
-- plan stays in 'active' status until explicitly closed by a practitioner.
--
-- Single paste block, safe to re-run.

create table if not exists public.treatment_plans (
  id uuid primary key default gen_random_uuid(),
  client_id uuid not null references public.clients(id) on delete cascade,
  studio_id uuid not null references public.studios(id) on delete cascade,
  name text not null check (length(name) > 0 and length(name) <= 100),
  suggested_visit_count integer not null
    check (suggested_visit_count > 0 and suggested_visit_count <= 200),
  status text not null default 'active'
    check (status in ('active', 'closed')),
  created_by_practitioner_id uuid references public.practitioners(id) on delete set null,
  closed_by_practitioner_id uuid references public.practitioners(id) on delete set null,
  created_at timestamptz not null default now(),
  closed_at timestamptz
);

create index if not exists treatment_plans_client_idx
  on public.treatment_plans (client_id, status, created_at desc);

create index if not exists treatment_plans_studio_idx
  on public.treatment_plans (studio_id);

alter table public.treatment_plans enable row level security;

drop policy if exists "treatment_plans_studio_member_read"
  on public.treatment_plans;
create policy "treatment_plans_studio_member_read"
  on public.treatment_plans for select
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

drop policy if exists "treatment_plans_studio_member_insert"
  on public.treatment_plans;
create policy "treatment_plans_studio_member_insert"
  on public.treatment_plans for insert
  with check (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

drop policy if exists "treatment_plans_studio_member_update"
  on public.treatment_plans;
create policy "treatment_plans_studio_member_update"
  on public.treatment_plans for update
  using (
    studio_id in (
      select studio_id from public.practitioners
      where user_id = auth.uid() and active = true
    )
  );

-- Sessions.treatment_plan_id: nullable FK. Existing rows aren't attached
-- to any plan; new attach/detach actions toggle this value. On delete of
-- the plan, set the session's FK to null (don't cascade and orphan the
-- chart entries under that session).
alter table public.sessions
  add column if not exists treatment_plan_id uuid
    references public.treatment_plans(id) on delete set null;

create index if not exists sessions_treatment_plan_idx
  on public.sessions (treatment_plan_id)
  where treatment_plan_id is not null;
