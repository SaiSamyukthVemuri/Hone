-- Migration 0034: Treatment plan stages (Treatment Plan v2 schema).
--
-- Adds a child table public.treatment_plan_stages so a treatment plan can
-- represent a real electrolysis schedule, e.g.:
--   Plan: Chin hair removal
--     Stage 1: weekly 15-minute visits for 3 months
--     Stage 2: monthly 15-minute maintenance visits for 12 months
--
-- Also adds three additive nullable columns to treatment_plans
-- (budget_notes, practitioner_notes, treatment_goal_minutes_override).
-- No existing column is dropped, narrowed, or renamed. The legacy
-- suggested_visit_count stays NOT NULL with its existing check, so
-- the current "Estimated visits" UI keeps working unchanged. Existing
-- treatment_plans rows remain valid; no data is rewritten.
--
-- This migration is schema only. The UI, server actions, treatment-time
-- (TTT) calculations, public booking, Stripe/payments, middleware,
-- require_card_on_file, booking availability, appointment lifecycle,
-- and recurring break logic are all intentionally untouched. Phase C+
-- will wire stages into the UI and TTT.
--
-- Re-runnable: create/alter/drop-if-exists/add-if-not-exists throughout.

-- ============================================================
-- 1. Child table: treatment_plan_stages
-- ============================================================

create table if not exists public.treatment_plan_stages (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null
    references public.treatment_plans(id) on delete cascade,
  -- Denormalized for RLS. Always kept in sync with the parent plan's
  -- studio_id by the BEFORE INSERT/UPDATE trigger below, so server
  -- actions cannot accidentally insert a stage whose studio_id points
  -- to a different studio than the parent plan.
  studio_id uuid not null
    references public.studios(id) on delete cascade,
  sort_order integer not null default 1,
  name text,
  how_often_unit text not null,
  visit_length_minutes integer not null,
  stage_length_value integer not null,
  stage_length_unit text not null,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Named check constraints (drop-if-exists then add) so re-runs work
-- cleanly against an existing database.

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_how_often_unit_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_how_often_unit_check
  check (how_often_unit in ('weekly', 'every_2_weeks', 'monthly'));

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_stage_length_unit_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_stage_length_unit_check
  check (stage_length_unit in ('weeks', 'months'));

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_visit_length_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_visit_length_check
  check (visit_length_minutes between 5 and 240);

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_stage_length_value_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_stage_length_value_check
  check (stage_length_value > 0 and stage_length_value <= 240);

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_sort_order_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_sort_order_check
  check (sort_order >= 0);

alter table public.treatment_plan_stages
  drop constraint if exists treatment_plan_stages_name_check;
alter table public.treatment_plan_stages
  add constraint treatment_plan_stages_name_check
  check (name is null or length(name) <= 80);

-- Indexes.
create index if not exists treatment_plan_stages_plan_sort_idx
  on public.treatment_plan_stages (plan_id, sort_order);

create index if not exists treatment_plan_stages_studio_idx
  on public.treatment_plan_stages (studio_id);

-- updated_at trigger uses the existing public.set_updated_at() helper
-- defined in migration 0015 (also reused by client_intake_forms and
-- session_blocks). No new function created here.
drop trigger if exists treatment_plan_stages_set_updated_at
  on public.treatment_plan_stages;
create trigger treatment_plan_stages_set_updated_at
  before update on public.treatment_plan_stages
  for each row execute function public.set_updated_at();

-- Studio-id consistency trigger. Always derive studio_id from the parent
-- treatment_plans row so the denormalized column on this child table
-- cannot drift from its parent. The RLS policy on this table evaluates
-- is_studio_member(studio_id) directly; without this trigger a buggy or
-- malicious insert could attach a stage whose studio_id points to a
-- different studio than the parent plan.
create or replace function public.treatment_plan_stages_set_studio_id()
returns trigger
language plpgsql
as $$
begin
  select studio_id into new.studio_id
  from public.treatment_plans
  where id = new.plan_id;

  if new.studio_id is null then
    raise exception 'treatment_plan_stages.plan_id % does not reference an existing treatment_plans row',
      new.plan_id;
  end if;

  return new;
end;
$$;

drop trigger if exists treatment_plan_stages_set_studio_id
  on public.treatment_plan_stages;
create trigger treatment_plan_stages_set_studio_id
  before insert or update of plan_id
  on public.treatment_plan_stages
  for each row execute function public.treatment_plan_stages_set_studio_id();

-- RLS. Single for-all policy using the project-standard
-- is_studio_member() helper (same shape as treatment_goals in 0026
-- and session_blocks in 0019).
alter table public.treatment_plan_stages enable row level security;

drop policy if exists "treatment_plan_stages_studio_member_all"
  on public.treatment_plan_stages;
create policy "treatment_plan_stages_studio_member_all"
  on public.treatment_plan_stages for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

-- ============================================================
-- 2. Additive nullable columns on treatment_plans
-- ============================================================
-- suggested_visit_count is intentionally left NOT NULL with its existing
-- check (1..200). The current Estimated-visits UI keeps writing it. The
-- new columns below feed the Phase C+ UI without affecting any current
-- flow; an existing treatment_plans row remains valid because all three
-- new columns are nullable.

alter table public.treatment_plans
  add column if not exists budget_notes text;

alter table public.treatment_plans
  add column if not exists practitioner_notes text;

alter table public.treatment_plans
  add column if not exists treatment_goal_minutes_override integer;

alter table public.treatment_plans
  drop constraint if exists treatment_plans_goal_override_check;
alter table public.treatment_plans
  add constraint treatment_plans_goal_override_check
  check (
    treatment_goal_minutes_override is null
    or treatment_goal_minutes_override between 1 and 60000
  );
