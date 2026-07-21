-- ===========================================================================
-- 0140 — First-time studio onboarding experience (owner onboarding v2)
-- ===========================================================================
--
-- Goal: turn the buried, read-only "getting started" checklist into a guided,
-- resumable, celebrated first-run experience for a brand-new studio OWNER —
-- welcome email, auto-opening dashboard wizard, pinned setup-progress card,
-- progressive nudges, and an admin-visible invite/onboarding status.
--
-- This migration is the ADDITIVE, DEFAULT-OFF foundation only:
--   * studios.onboarding_v2_enabled  — per-studio kill-switch, default false.
--   * public.studio_onboarding        — per-studio resumable wizard state
--                                       (step pointer, skipped/completed steps,
--                                       dismissed/completed/celebrated stamps,
--                                       welcome-email send status).
--
-- PRIME DIRECTIVE — while studios.onboarding_v2_enabled = false (every existing
-- production studio, Willow included, by default) the observable experience is
-- byte-for-byte today's: the current /getting-started checklist + the small
-- dashboard "N of M steps" link, NO wizard, NO welcome email, NO celebration.
-- The v2 experience is strictly opt-in per studio.
--
-- The flag is OPERATOR-CONTROLLED (same posture as 0119/0134): the studios
-- UPDATE RLS policy is row-level and would otherwise let an owner flip ANY
-- studios column, so a SECURITY INVOKER guard trigger blocks browser-role flips.
-- The OWNER controls their own progress (dismiss/skip/resume/complete) through
-- the studio_onboarding row instead, which they own via is_studio_owner RLS.
--
-- Rollback: flip the flag off (instant, per-studio). This migration deletes /
-- rewrites no source-of-truth row; studio_onboarding is pure UI/progress state.
--
-- Repo/hosted max was 0134 (PR A). Repo migrations 0135-0139 live on the
-- practitioner-capacity PR-B branch and are intentionally absent here; Supabase
-- applies migrations in filename order, so the 0134 -> 0140 gap is inert.
-- Install as ONE transaction.
-- ---------------------------------------------------------------------------

begin;

-- ---------------------------------------------------------------------------
-- Step 1: per-studio onboarding-v2 flag. Additive, default false, read as
-- `studio.onboarding_v2_enabled === true`. No UPDATE runs, so Willow and every
-- existing studio stay false and see exactly today's experience.
-- ---------------------------------------------------------------------------
alter table public.studios
  add column if not exists onboarding_v2_enabled boolean not null default false;

-- ---------------------------------------------------------------------------
-- Step 1b: the flag is OPERATOR-CONTROLLED. The studios UPDATE RLS policy
-- ("studios: owners update", 0001) lets a studio owner write any studios column,
-- including this one, via a direct table update. Enabling the v2 experience must
-- instead be a reviewed operator/service-role action (set at studio creation by
-- the admin wizard, or by an operator activation). This SECURITY INVOKER guard
-- (invoker so current_user is the REAL caller, not the function owner) rejects
-- any change to the flag by a browser role (anon / authenticated, owners
-- included). Service role and direct operator connections are unaffected, as are
-- updates that do not change the flag.
create or replace function public.guard_onboarding_flag_activation()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.onboarding_v2_enabled is distinct from old.onboarding_v2_enabled
     and current_user in ('anon', 'authenticated') then
    raise exception
      'onboarding_v2_enabled is operator-controlled; role % may not change it',
      current_user
      using errcode = '42501';  -- insufficient_privilege
  end if;
  return new;
end;
$$;

create or replace trigger studios_guard_onboarding_flag_trg
  before update of onboarding_v2_enabled on public.studios
  for each row
  execute function public.guard_onboarding_flag_activation();

-- ---------------------------------------------------------------------------
-- Step 2: per-studio resumable onboarding/wizard state. ONE row per studio
-- (studio_id primary key). Pure UI/progress state — no clinical or booking
-- source-of-truth lives here; step "done" for data-backed steps (service,
-- availability, booking page, payments) is still DERIVED live from real data by
-- lib/onboarding/getting-started.ts. This table records only:
--   * the resume pointer (current_step) so closing the wizard never loses place,
--   * which steps were explicitly advanced-past / skipped,
--   * dismissed / completed / celebrated stamps (celebrate-once, honest
--     completion), and
--   * the welcome-email send outcome for the admin status view.
-- ---------------------------------------------------------------------------
create table if not exists public.studio_onboarding (
  studio_id                  uuid primary key
                               references public.studios(id) on delete cascade,
  status                     text not null default 'not_started'
                               check (status in ('not_started', 'in_progress', 'completed', 'skipped')),
  -- Resume pointer: the wizard step key the owner is currently on. Free text (a
  -- step key like 'welcome'|'service'|'availability'|'booking'|'payments'|'done');
  -- the app owns the vocabulary so new steps need no migration.
  current_step               text not null default 'welcome',
  -- Steps the owner has explicitly acknowledged / advanced past (e.g. 'welcome',
  -- 'done') and steps they chose to skip (e.g. 'payments'). Data-backed steps are
  -- NOT recorded here — their completion is derived from real data.
  completed_steps            text[] not null default '{}'::text[],
  skipped_steps              text[] not null default '{}'::text[],
  -- The owner closed the wizard overlay (progress preserved; re-openable from the
  -- pinned dashboard card). Distinct from completed / skipped.
  dismissed_at               timestamptz,
  -- All required setup done (derived signals all green) AND acknowledged.
  completed_at               timestamptz,
  -- The one-time celebration has been shown, so it never re-fires on later loads.
  celebrated_at              timestamptz,
  -- Welcome-email send outcome (Sent / Failed / not-sent). "Accepted" is derived
  -- separately from pending_invitations.status; this column is the SEND result
  -- only. No delivered/opened tracking (no Resend webhook / pixel — deliberate
  -- privacy posture for a clinical app).
  welcome_email_status       text not null default 'not_sent'
                               check (welcome_email_status in ('not_sent', 'sent', 'failed')),
  -- Which welcome template variant was sent: a brand-new owner vs. an email that
  -- already belongs to an existing Hone account (added-to-studio notice).
  welcome_email_variant      text
                               check (welcome_email_variant in ('new_owner', 'existing_account')),
  welcome_email_last_sent_at timestamptz,
  created_at                 timestamptz not null default now(),
  updated_at                 timestamptz not null default now()
);

create index if not exists studio_onboarding_status_idx
  on public.studio_onboarding (status);

-- Keep updated_at honest on every write.
create or replace function public.set_studio_onboarding_updated_at()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger studio_onboarding_set_updated_at_trg
  before update on public.studio_onboarding
  for each row
  execute function public.set_studio_onboarding_updated_at();

-- ---------------------------------------------------------------------------
-- Step 3: RLS. Studio members READ their studio's onboarding row; only the
-- studio OWNER may INSERT/UPDATE their own row (drive the wizard). No delete
-- policy (parent-studio CASCADE tears the row down). The admin studio-creation
-- path and any operator seed run as service_role and bypass RLS to stamp the
-- welcome-email status at provisioning time (the owner practitioner row does not
-- exist yet at that moment). anon / portal / public-booking get nothing.
-- ---------------------------------------------------------------------------
alter table public.studio_onboarding enable row level security;

drop policy if exists "studio_onboarding_member_select" on public.studio_onboarding;
create policy "studio_onboarding_member_select"
  on public.studio_onboarding for select to authenticated
  using (public.is_studio_member(studio_id));

drop policy if exists "studio_onboarding_owner_insert" on public.studio_onboarding;
create policy "studio_onboarding_owner_insert"
  on public.studio_onboarding for insert to authenticated
  with check (public.is_studio_owner(studio_id));

drop policy if exists "studio_onboarding_owner_update" on public.studio_onboarding;
create policy "studio_onboarding_owner_update"
  on public.studio_onboarding for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));

-- Grants: authenticated may SELECT/INSERT/UPDATE (RLS-gated above); DELETE/
-- TRUNCATE revoked (teardown is via parent CASCADE only). anon gets nothing.
-- service_role is narrow (SELECT/INSERT/UPDATE) for the provisioning-time
-- welcome-email stamp and operator reads.
grant select, insert, update on public.studio_onboarding to authenticated;
revoke delete, truncate on public.studio_onboarding from authenticated;
revoke all on public.studio_onboarding from anon;
grant select, insert, update on public.studio_onboarding to service_role;

-- ---------------------------------------------------------------------------
-- Step 4: lock down the new trigger functions (match the 0030/0134 posture — no
-- direct client execute; they run only inside triggers).
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.guard_onboarding_flag_activation()',
    'public.set_studio_onboarding_updated_at()'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;
end $$;

commit;
