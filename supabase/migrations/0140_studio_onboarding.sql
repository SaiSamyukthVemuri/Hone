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
  -- Welcome-email TRUTHFUL state machine: not_sent -> sending -> sent | failed.
  -- attempt_id gates concurrent sends: a claim atomically flips to 'sending' and
  -- mints a fresh attempt_id; only that winning attempt_id may stamp the final
  -- result, so a stale/slow attempt can never overwrite a newer retry.
  -- last_attempted_at = last claim time; last_sent_at is set ONLY on a genuine
  -- successful send. No delivered/opened tracking (no webhook/pixel). "Accepted"
  -- is derived separately from pending_invitations.status.
  welcome_email_status            text not null default 'not_sent'
                                    check (welcome_email_status in ('not_sent', 'sending', 'sent', 'failed')),
  welcome_email_attempt_id        uuid,
  welcome_email_last_attempted_at timestamptz,
  welcome_email_last_sent_at      timestamptz,
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
-- Step 2c: PROTECT the completion-lifecycle fields from direct browser writes.
-- Owners have row-level INSERT/UPDATE on this table (to drive the wizard), but
-- the fields that make "completed / celebrated" TRUTHFUL must only ever be set
-- by the trusted service-role commands below — never by a hand-crafted browser
-- write. This SECURITY INVOKER guard (invoker so current_user is the REAL caller,
-- not the SECURITY DEFINER function owner) rejects any browser-role (anon /
-- authenticated) attempt to write: completed_at, celebrated_at, a status
-- transition INTO 'completed', or the completion-only 'done' step marker — on
-- BOTH insert and update. Normal owner-controlled navigation (current_step,
-- skipped_steps, dismissed_at, status='in_progress', resume/reopen) is untouched;
-- the trusted commands run SECURITY DEFINER (current_user = the function owner)
-- and direct service_role connections are unaffected.
create or replace function public.guard_onboarding_completion_fields()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if current_user in ('anon', 'authenticated') then
    if tg_op = 'INSERT' then
      if new.completed_at is not null
         or new.celebrated_at is not null
         or new.status = 'completed'
         or ('done' = any (new.completed_steps)) then
        raise exception
          'onboarding completion fields are trusted-server-only (role %)',
          current_user using errcode = '42501';
      end if;
    elsif tg_op = 'UPDATE' then
      if new.completed_at is distinct from old.completed_at
         or new.celebrated_at is distinct from old.celebrated_at
         or (new.status = 'completed' and old.status is distinct from 'completed')
         or (('done' = any (new.completed_steps))
             and not ('done' = any (old.completed_steps))) then
        raise exception
          'onboarding completion fields are trusted-server-only (role %)',
          current_user using errcode = '42501';
      end if;
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger studio_onboarding_guard_completion_trg
  before insert or update on public.studio_onboarding
  for each row
  execute function public.guard_onboarding_completion_fields();

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
-- Step 3b: TRUSTED completion + celebration commands (SERVICE-ROLE ONLY). The
-- browser can NEVER self-complete: these are reachable only from the trusted
-- /dashboard server actions via the admin client, which resolve the session user
-- and pass ONLY (p_user_id, p_studio_id) — no role/status/timestamp/step state.
-- Each command re-verifies IN THE DB that p_user_id is an ACTIVE OWNER of
-- p_studio_id AND that onboarding_v2 is enabled, so a forged user/studio pairing
-- or a flag-off studio is refused at the source, independent of the app layer.
-- Any direct authenticated call is denied by the grants below; any hand-crafted
-- direct table write is denied by guard_onboarding_completion_fields above.
--
-- admin_complete_onboarding stamps completed_at exactly ONCE (CAS on
-- `completed_at is null`) and returns whether THIS call performed the transition,
-- so two concurrent calls produce exactly one transition (Postgres serializes on
-- the row; the loser sees the freshly-stamped value and returns false). The
-- action then schedules the analytics dispatch only on a true return.
-- ---------------------------------------------------------------------------
create or replace function public.admin_complete_onboarding(
  p_user_id uuid,
  p_studio_id uuid
)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_transitioned boolean;
begin
  if not exists (
    select 1 from public.practitioners
    where studio_id = p_studio_id and user_id = p_user_id
      and role = 'owner' and active
  ) then
    raise exception 'not an active owner of the studio' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.studios
    where id = p_studio_id and onboarding_v2_enabled = true
  ) then
    raise exception 'onboarding_v2 is not enabled for the studio'
      using errcode = '42501';
  end if;

  insert into public.studio_onboarding as so
    (studio_id, status, completed_at, completed_steps)
  values (p_studio_id, 'completed', now(), array['done']::text[])
  on conflict (studio_id) do update
    set status = 'completed',
        completed_at = now(),
        completed_steps = (
          select array(
            select distinct t.step
            from unnest(so.completed_steps || array['done']::text[]) as t(step)
          )
        )
    where so.completed_at is null  -- first-transition compare-and-set
  returning true into v_transitioned;

  -- NULL (no row returned) => the row was already completed => not this call.
  return coalesce(v_transitioned, false);
end;
$$;

-- admin_mark_onboarding_celebrated stamps celebrated_at exactly once (idempotent
-- CAS on `celebrated_at is null`) so the one-time celebration fires once. The
-- action gates the call on LIVE required completion, so a premature celebration
-- is never consumed. Same service-role-only + active-owner + flag guards.
create or replace function public.admin_mark_onboarding_celebrated(
  p_user_id uuid,
  p_studio_id uuid
)
returns boolean
language plpgsql security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_stamped boolean;
begin
  if not exists (
    select 1 from public.practitioners
    where studio_id = p_studio_id and user_id = p_user_id
      and role = 'owner' and active
  ) then
    raise exception 'not an active owner of the studio' using errcode = '42501';
  end if;
  if not exists (
    select 1 from public.studios
    where id = p_studio_id and onboarding_v2_enabled = true
  ) then
    raise exception 'onboarding_v2 is not enabled for the studio'
      using errcode = '42501';
  end if;

  insert into public.studio_onboarding as so (studio_id, celebrated_at)
  values (p_studio_id, now())
  on conflict (studio_id) do update
    set celebrated_at = now()
    where so.celebrated_at is null  -- stamp-once compare-and-set
  returning true into v_stamped;

  return coalesce(v_stamped, false);
end;
$$;

-- ---------------------------------------------------------------------------
-- Step 4: lock down the new functions. The trigger functions run only inside
-- triggers (no direct client execute). The completion + celebration commands are
-- SERVICE-ROLE ONLY — revoked from public/anon/authenticated so a browser role
-- can never call them directly (bypassing the flag / live-model validation).
-- ---------------------------------------------------------------------------
do $$
declare fn text;
begin
  foreach fn in array array[
    'public.guard_onboarding_flag_activation()',
    'public.set_studio_onboarding_updated_at()',
    'public.guard_onboarding_completion_fields()'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
  end loop;

  foreach fn in array array[
    'public.admin_complete_onboarding(uuid, uuid)',
    'public.admin_mark_onboarding_celebrated(uuid, uuid)'
  ]
  loop
    execute format('revoke execute on function %s from public', fn);
    execute format('revoke execute on function %s from anon', fn);
    execute format('revoke execute on function %s from authenticated', fn);
    execute format('grant execute on function %s to service_role', fn);
  end loop;
end $$;

commit;
