-- MACHINE SWITCHES. Forward migration.
-- Depends on the platform rollout control (platform_rollout_enabled_for).
--
-- ONE SETTING PER STUDIO: which machine models are ON, and the default (a model or "Ask at each visit"). Turning a model on creates NO machine
-- record; a unit is made lazily, inside a real block save, by ensure_studio_machine_for_save. Every studio is seeded ONCE (here for existing
-- studios, by an AFTER INSERT trigger for new ones); nothing re-seeds, and nothing reads "absent row = enabled".
-- Also amends apply_block_machine_identity (frozen) so the xCell Pur model can be recorded with a legacy-column mode.

begin;
set local lock_timeout = '5s';

-- The lazy-unit rule assumes at most one live xCell Pur unit per studio. Two or more is a product decision, never worked around.
do $$
declare v_n integer;
begin
  select count(*) into v_n from (
    select studio_id from public.studio_machines
     where machine_profile_id = 'dectro-apilus:xcell-pur' and retired_at is null
     group by studio_id having count(*) >= 2) s;
  if v_n > 0 then
    raise exception 'machine switches: % studio(s) hold two or more live xCell Pur units; this needs a product decision before the migration can apply', v_n
      using errcode = 'check_violation';
  end if;
end $$;

-- AT MOST ONE LIVE xCell Pur UNIT PER STUDIO, enforced by the database. The owner registration path takes no advisory lock, so only a unique
-- index closes the race between two registrations (and the lazy unit command, which relies on this rule).
create unique index if not exists studio_machines_one_live_xcell_pur
  on public.studio_machines (studio_id)
  where machine_profile_id = 'dectro-apilus:xcell-pur' and retired_at is null;

create table if not exists public.studio_machine_models (
  studio_id  uuid not null references public.studios (id) on delete cascade,
  profile_id text not null,
  enabled    boolean not null,
  updated_by uuid,
  updated_at timestamptz not null default now(),
  primary key (studio_id, profile_id),
  constraint studio_machine_models_profile_check
    check (profile_id in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g'))
);
create table if not exists public.studio_machine_default (
  studio_id          uuid primary key references public.studios (id) on delete cascade,
  default_profile_id text,
  ask_each_visit     boolean not null,
  seeded_at          timestamptz not null default now(),
  updated_by         uuid,
  updated_at         timestamptz not null default now(),
  constraint studio_machine_default_profile_check
    check (default_profile_id is null or default_profile_id in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g')),
  constraint studio_machine_default_ask_check check (ask_each_visit = (default_profile_id is null))
);
create table if not exists public.studio_machine_setting_events (
  id            bigint generated always as identity primary key,
  studio_id     uuid not null references public.studios (id) on delete cascade,
  kind          text not null,
  profile_id    text,
  value         jsonb not null,
  actor_user_id uuid,
  occurred_at   timestamptz not null default now(),
  constraint studio_machine_setting_events_kind_check check (kind in ('model_set', 'default_set', 'unit_created')),
  constraint studio_machine_setting_events_profile_check
    check (profile_id is null or profile_id in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g')),
  -- Closed shapes, never free text: one boolean, or one closed value, or the constant.
  constraint studio_machine_setting_events_value_shape check (
    pg_column_size(value) < 200 and (
      (kind = 'model_set' and value - 'enabled' = '{}'::jsonb and coalesce(jsonb_typeof(value -> 'enabled'), '') = 'boolean')
      or (kind = 'default_set' and value - 'default' = '{}'::jsonb
          and coalesce(value ->> 'default', '') in ('ask', 'dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g'))
      or (kind = 'unit_created' and value = '{"created": true}'::jsonb)))
);

-- Append-only events. A studio's removal may cascade its rows; nothing else may change or delete one.
create or replace function public.studio_machine_setting_events_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin
  if tg_op = 'DELETE' and not exists (select 1 from public.studios s where s.id = old.studio_id) then
    return old;
  end if;
  raise exception 'studio_machine_setting_events is append-only' using errcode = 'check_violation';
end $$;
drop trigger if exists studio_machine_setting_events_row_guard on public.studio_machine_setting_events;
create trigger studio_machine_setting_events_row_guard before update or delete on public.studio_machine_setting_events
  for each row execute function public.studio_machine_setting_events_guard();
create or replace function public.studio_machine_setting_events_truncate_guard()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
begin raise exception 'studio_machine_setting_events is append-only' using errcode = 'check_violation'; end $$;
drop trigger if exists studio_machine_setting_events_truncate_guard on public.studio_machine_setting_events;
create trigger studio_machine_setting_events_truncate_guard before truncate on public.studio_machine_setting_events
  for each statement execute function public.studio_machine_setting_events_truncate_guard();

alter table public.studio_machine_models enable row level security;
alter table public.studio_machine_default enable row level security;
alter table public.studio_machine_setting_events enable row level security;
alter table public.studio_machine_models force row level security;
alter table public.studio_machine_default force row level security;
alter table public.studio_machine_setting_events force row level security;
revoke all on public.studio_machine_models from public, anon, authenticated, service_role;
revoke all on public.studio_machine_default from public, anon, authenticated, service_role;
revoke all on public.studio_machine_setting_events from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- THE SEED, applied once. xCell Pur is ON for every studio and is the DEFAULT for every studio that has no explicit default (product decision,
-- 24 Nov 2026, superseding 21 Nov): that is every studio at the moment this runs, and every new studio. Senior/Junior are ON exactly where the
-- studio has a live unit of that model, so a studio's configured machines are kept. Nothing here is a choice an owner made, so nothing an owner
-- chose is overwritten: ON CONFLICT DO NOTHING is the idempotence, and a studio that later turns xCell off (or picks another default) keeps its
-- explicit row. This changes only what NEW chart entries are offered; machines already recorded on historical visits are not touched.
-- ---------------------------------------------------------------------------
create or replace function public.seed_studio_machine_settings(p_studio_id uuid)
returns void language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  insert into public.studio_machine_models (studio_id, profile_id, enabled)
  select p_studio_id, p.profile_id,
         case when p.profile_id = 'dectro-apilus:xcell-pur' then true
              else exists (select 1 from public.studio_machines m
                            where m.studio_id = p_studio_id and m.machine_profile_id = p.profile_id and m.retired_at is null) end
    from (values ('dectro-apilus:xcell-pur'), ('dectro-apilus:senior-3g'), ('dectro-apilus:junior-3g')) as p(profile_id)
  on conflict (studio_id, profile_id) do nothing;
  insert into public.studio_machine_default (studio_id, default_profile_id, ask_each_visit)
  values (p_studio_id, 'dectro-apilus:xcell-pur', false)
  on conflict (studio_id) do nothing;
end $$;

create or replace function public.studios_seed_machine_settings_trigger()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  perform public.seed_studio_machine_settings(new.id);
  return null;
end $$;
drop trigger if exists studios_seed_machine_settings on public.studios;
create trigger studios_seed_machine_settings after insert on public.studios
  for each row execute function public.studios_seed_machine_settings_trigger();

select public.seed_studio_machine_settings(s.id) from public.studios s;

-- REGISTERING A SENIOR OR JUNIOR UNIT TURNS THAT MODEL ON when nobody has ever decided otherwise (what an owner expects of registering a machine). "Decided"
-- is the change log: any model_set event for the studio and model (the owner's switch, in either direction, or an earlier registration) means the
-- switch is a recorded choice and a unit never overrides it. No event means the model is off only because the seed found no live unit (a studio whose
-- only unit was retired before this migration seeds off), so a replacement unit turns it on. xCell Pur is not touched here: its registration has its
-- own gate and its switch is the owner's. One event row, by the registering practitioner.
create or replace function public.studio_machines_enable_model_trigger()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_changed integer;
begin
  if new.machine_profile_id in ('dectro-apilus:senior-3g', 'dectro-apilus:junior-3g')
     and not exists (select 1 from public.studio_machine_setting_events e
                      where e.studio_id = new.studio_id and e.profile_id = new.machine_profile_id and e.kind = 'model_set') then
    update public.studio_machine_models m
       set enabled = true, updated_by = auth.uid(), updated_at = now()
     where m.studio_id = new.studio_id and m.profile_id = new.machine_profile_id and not m.enabled;
    get diagnostics v_changed = row_count;
    if v_changed > 0 then
      insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value, actor_user_id)
      values (new.studio_id, 'model_set', new.machine_profile_id, '{"enabled": true}'::jsonb, auth.uid());
    end if;
  end if;
  return null;
end $$;
drop trigger if exists studio_machines_enable_model on public.studio_machines;
create trigger studio_machines_enable_model after insert on public.studio_machines
  for each row execute function public.studio_machines_enable_model_trigger();

-- ---------------------------------------------------------------------------
-- COMMANDS. Owner writes run as the signed-in user. A studio argument is NEVER trusted: the caller must be an active owner of THAT studio
-- (a database fact), and another studio's id gets the same generic refusal as a nonexistent one (no existence oracle).
-- ---------------------------------------------------------------------------
create or replace function public.set_studio_machine_model(p_studio uuid, p_profile text, p_enabled boolean)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_prev boolean;
  v_def text;
  v_new_def text;
begin
  if v_uid is null or p_studio is null or p_profile is null or p_enabled is null
     or not exists (select 1 from public.practitioners pr
                     where pr.studio_id = p_studio and pr.user_id = v_uid and pr.active and pr.role = 'owner')
     or p_profile not in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g') then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if not public.platform_rollout_enabled_for('charting_new_view_xcell', p_studio) then
    raise exception 'Machine switches are not available yet.' using errcode = 'check_violation';
  end if;
  -- the default row first (the same lock order in every command), then the model row
  select d.default_profile_id into v_def from public.studio_machine_default d where d.studio_id = p_studio for update;
  select m.enabled into v_prev from public.studio_machine_models m where m.studio_id = p_studio and m.profile_id = p_profile for update;
  if not found then raise exception 'Not available.' using errcode = '42501'; end if;
  if v_prev = p_enabled then return 'unchanged'; end if;
  update public.studio_machine_models set enabled = p_enabled, updated_by = v_uid, updated_at = now()
   where studio_id = p_studio and profile_id = p_profile;
  insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value, actor_user_id)
  values (p_studio, 'model_set', p_profile, jsonb_build_object('enabled', p_enabled), v_uid);
  if not p_enabled and v_def = p_profile then
    -- the default may never name a model that is off: the next enabled model in the fixed order, else Ask
    select m.profile_id into v_new_def from public.studio_machine_models m
     where m.studio_id = p_studio and m.enabled
     order by array_position(array['dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g'], m.profile_id) limit 1;
    update public.studio_machine_default
       set default_profile_id = v_new_def, ask_each_visit = (v_new_def is null), updated_by = v_uid, updated_at = now()
     where studio_id = p_studio;
    insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value, actor_user_id)
    values (p_studio, 'default_set', v_new_def, jsonb_build_object('default', coalesce(v_new_def, 'ask')), v_uid);
  end if;
  return 'changed';
end $$;

create or replace function public.set_studio_machine_default(p_studio uuid, p_profile text, p_ask boolean)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_cur text;
begin
  if v_uid is null or p_studio is null or p_ask is null
     or not exists (select 1 from public.practitioners pr
                     where pr.studio_id = p_studio and pr.user_id = v_uid and pr.active and pr.role = 'owner')
     or (p_ask and p_profile is not null) or (not p_ask and p_profile is null)
     or (p_profile is not null and p_profile not in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g')) then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  if not public.platform_rollout_enabled_for('charting_new_view_xcell', p_studio) then
    raise exception 'Machine switches are not available yet.' using errcode = 'check_violation';
  end if;
  select d.default_profile_id into v_cur from public.studio_machine_default d where d.studio_id = p_studio for update;
  if not found then raise exception 'Not available.' using errcode = '42501'; end if;
  if p_profile is not null and not exists (select 1 from public.studio_machine_models m
                                            where m.studio_id = p_studio and m.profile_id = p_profile and m.enabled) then
    raise exception 'The default must be a machine that is switched on.' using errcode = 'check_violation';
  end if;
  if v_cur is not distinct from p_profile then return 'unchanged'; end if;
  update public.studio_machine_default
     set default_profile_id = p_profile, ask_each_visit = p_ask, updated_by = v_uid, updated_at = now()
   where studio_id = p_studio;
  insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value, actor_user_id)
  values (p_studio, 'default_set', p_profile, jsonb_build_object('default', coalesce(p_profile, 'ask')), v_uid);
  return 'changed';
end $$;

-- The caller's own studios only (an active practitioner row; a receptionist has none), no argument, the minimum: EVERY model's switch (so
-- 'nothing is switched on' is a set of rows that are all off, never an empty answer that reads as 'unavailable'), the default (or ask), and each
-- model's LIVE unit id if one exists. Nothing is returned while the rollout is off for the studio.
create or replace function public.get_studio_machine_choices()
returns table (studio_id uuid, profile_id text, is_default boolean, ask_each_visit boolean, live_unit_id uuid, enabled boolean)
language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select m.studio_id, m.profile_id,
         coalesce(d.default_profile_id = m.profile_id, false) as is_default,
         d.ask_each_visit,
         (select u.id from public.studio_machines u
           where u.studio_id = m.studio_id and u.machine_profile_id = m.profile_id and u.retired_at is null
           order by u.id limit 1) as live_unit_id,
         m.enabled
    from public.studio_machine_models m
    join public.studio_machine_default d on d.studio_id = m.studio_id
   where exists (select 1 from public.practitioners pr where pr.studio_id = m.studio_id and pr.user_id = auth.uid() and pr.active and pr.role in ('owner', 'practitioner'))
     and public.platform_rollout_enabled_for('charting_new_view_xcell', m.studio_id)
$$;

-- LAZY UNIT. The studio comes from the BLOCK (a session the caller may write), never from an argument. Reuses the live unit; never recreates
-- a unit the studio's owner retired (decided from THIS studio's history only); one event row per creation.
create or replace function public.ensure_studio_machine_for_save(p_block_id uuid, p_profile text)
returns text language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
declare
  v_uid uuid := auth.uid();
  v_studio uuid;
  v_unit uuid;
  v_version integer;
  v_label text;
  v_session uuid;
  v_client uuid;
begin
  if v_uid is null or p_block_id is null or p_profile is null or p_profile = ''
     or p_profile not in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g') then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  select b.studio_id, s.id, s.client_id into v_studio, v_session, v_client
    from public.session_blocks b join public.sessions s on s.id = b.session_id and s.studio_id = b.studio_id
   where b.id = p_block_id and b.deleted_at is null and s.deleted_at is null
     and s.record_status not in ('finalized', 'void');
  if v_studio is null
     or not exists (select 1 from public.practitioners pr where pr.studio_id = v_studio and pr.user_id = v_uid and pr.active and pr.role in ('owner', 'practitioner')) then
    raise exception 'Not available.' using errcode = '42501';
  end if;
  -- the same writability guard every block write uses (an active practitioner of the session's studio, the session belonging to its client)
  perform public.assert_session_writable(v_session, v_client);
  if not public.platform_rollout_enabled_for('charting_new_view_xcell', v_studio) then
    raise exception 'Machine switches are not available yet.' using errcode = 'check_violation';
  end if;
  if not exists (select 1 from public.studio_machine_models m where m.studio_id = v_studio and m.profile_id = p_profile and m.enabled) then
    raise exception 'That machine is not switched on for this studio.' using errcode = 'check_violation';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(v_studio::text || '|' || p_profile, 0));
  select u.id into v_unit from public.studio_machines u
   where u.studio_id = v_studio and u.machine_profile_id = p_profile and u.retired_at is null order by u.id limit 1;
  if v_unit is not null then return v_unit::text; end if;
  if exists (select 1 from public.studio_machines u where u.studio_id = v_studio and u.machine_profile_id = p_profile and u.retired_at is not null) then
    return 'retired';
  end if;
  select max(c.machine_profile_version) into v_version from public.machine_profile_mode_contract c where c.machine_profile_id = p_profile;
  if v_version is null then return 'unpublished'; end if;
  v_label := case p_profile when 'dectro-apilus:xcell-pur' then 'Dectro xCell'
                            when 'dectro-apilus:senior-3g' then 'Apilus Senior 3G' else 'Apilus Junior 3G' end;
  insert into public.studio_machines (studio_id, machine_profile_id, machine_profile_version, display_name, installed_options)
  values (v_studio, p_profile, v_version, v_label, '{}')
  on conflict do nothing
  returning id into v_unit;
  if v_unit is null then return 'name_taken'; end if;
  insert into public.studio_machine_setting_events (studio_id, kind, profile_id, value, actor_user_id)
  values (v_studio, 'unit_created', p_profile, '{"created": true}'::jsonb, v_uid);
  return v_unit::text;
end $$;

-- PILOT ORDER: migration A (the amended apply_block_machine_identity below) is part of THIS apply. Until it is applied a pilot studio cannot save
-- xCell Pur Thermolysis, Blend or Galvanic (the application refuses it by design), so the pilot starts only after this migration is applied.
-- NOTES for reviewers:
--  (c) A block that moves to a native identity keeps its legacy `mode` and `machine_frequency` columns exactly as they were: this migration neither
--      clears nor reads them. They are not part of the readings definition below, so a stale legacy mode or frequency never counts as a legacy
--      reading and never freezes anything. The chart shows a native reading by ITS OWN capture key (the unit, model and mode stored on the reading
--      row), never by the block's current identity.
--  (a) The legacy `mode` column on session_blocks is NOT frozen at DB level: practitioners legitimately edit it today. The mode freeze for
--      legacy modes is application-only (the charting action refuses it on the server behind the rollout); the race there is narrow.
--      Only machine_profile_id, studio_machine_id and machine_mode_key are frozen here.
--  (b) Every reading write (electrolysis_entries, treatment_setup_readings insert/update) now takes FOR SHARE on its block row. The cost is
--      measured in tests/db/machine-switches.db.test.ts (a burst of reading writes timed with the trigger and with it dropped).
-- ---------------------------------------------------------------------------
-- DB-LEVEL FREEZE (the application freeze in the charting actions is read-then-write and can race; this closes the race in the database).
-- A block that already holds readings may not CHANGE its machine identity (model, unit or machine mode) once one is set. First assignment
-- (null to a value) stays allowed; the existing identity command already limits what may be assigned. Always on, not behind the rollout: no existing path changes an
-- identity under readings (that command refuses it), so there is nothing for an Off state to preserve, and the protection is for existing records.
-- RACE: the identity UPDATE holds the block row lock when this trigger runs; every reading write takes FOR SHARE on its block row first
-- (the second trigger, SECURITY INVOKER so it locks only a block the caller may write), so a reading cannot commit between this check and the identity update, and the check then sees committed readings.
-- ---------------------------------------------------------------------------
-- ONE DEFINITION of "this block holds legacy readings", shared by the freeze trigger below, identity migration A (the area guard in
-- apply_block_machine_identity) and the application (a test pins the agreement): the machine readings a practitioner recorded. On the block that is
-- the energy level and the modality; on its live entries the thermolysis, galvanic, units-of-lye, energy-level and modality columns. A soft-deleted
-- entry is not a reading. NOT part of it, on purpose: the block's `mode` (a selection, not a reading) and `machine_frequency` (a sticky per-
-- practitioner default that a save writes even when no reading was touched), so a block saved with only an area stays free to change machine.
-- Native MultiPlex readings (treatment_setup_readings) do not freeze the identity either: each carries its own unit, model and mode (the capture
-- key), so a later unit correction cannot rewrite what a reading says, and the existing submission commands already allow that correction.
create or replace function public.block_holds_legacy_readings(p_block_id uuid)
returns boolean language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select exists (select 1 from public.session_blocks b
                  where b.id = p_block_id
                    and (nullif(btrim(b.apilus_modality::text), '') is not null or b.energy_level is not null))
      or exists (select 1 from public.electrolysis_entries e
                  where e.block_id = p_block_id and e.deleted_at is null
                    and (e.thermolysis_intensity_percent is not null or e.thermolysis_duration_seconds is not null
                         or e.galvanic_ma is not null or e.galvanic_duration_seconds is not null or e.units_of_lye is not null
                         or e.intensity is not null or e.duration_seconds is not null or e.galvanic_intensity_percent is not null
                         or e.energy_level is not null or nullif(btrim(e.apilus_modality::text), '') is not null))
$$;

-- SECURITY DEFINER: the freeze must see EVERY entry of the block whatever the caller's row-level access, so it cannot be fooled by a role that
-- sees fewer rows. The only way to reach it is an UPDATE of the three identity columns, and the trigger function itself is not callable.
create or replace function public.session_blocks_machine_identity_freeze()
returns trigger language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  if (old.machine_profile_id is not null and new.machine_profile_id is distinct from old.machine_profile_id)
     or (old.studio_machine_id is not null and new.studio_machine_id is distinct from old.studio_machine_id)
     or (old.machine_mode_key is not null and new.machine_mode_key is distinct from old.machine_mode_key) then
    if public.block_holds_legacy_readings(old.id) then
      raise exception 'This area already holds readings; its machine and mode can no longer change.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists session_blocks_machine_identity_freeze on public.session_blocks;
create trigger session_blocks_machine_identity_freeze before update of machine_profile_id, studio_machine_id, machine_mode_key
  on public.session_blocks for each row execute function public.session_blocks_machine_identity_freeze();

create or replace function public.reading_write_share_lock_block()
returns trigger language plpgsql set search_path = pg_catalog, pg_temp as $$
declare v_block uuid;
begin
  -- one branch per table: plpgsql resolves NEW's fields at evaluation, so a CASE naming both columns fails on either table
  if tg_table_name = 'electrolysis_entries' then v_block := new.block_id; else v_block := new.session_block_id; end if;
  perform 1 from public.session_blocks b where b.id = v_block for share;
  return new;
end $$;
drop trigger if exists electrolysis_entries_share_lock_block on public.electrolysis_entries;
create trigger electrolysis_entries_share_lock_block before insert or update on public.electrolysis_entries
  for each row execute function public.reading_write_share_lock_block();
drop trigger if exists treatment_setup_readings_share_lock_block on public.treatment_setup_readings;
create trigger treatment_setup_readings_share_lock_block before insert or update on public.treatment_setup_readings
  for each row execute function public.reading_write_share_lock_block();

-- ---------------------------------------------------------------------------
-- MIGRATION A: apply_block_machine_identity (frozen) re-created from its CURRENT body, asserted by md5 below, with the xCell Pur
-- model accepted for the three legacy-column modes. Everything else in the body is unchanged.
-- ---------------------------------------------------------------------------
do $$
begin
  if (select md5(p.prosrc) from pg_proc p where p.oid = 'public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text)'::regprocedure)
     <> '218c39a20344d2effd4d934f702b0338' then
    raise exception 'apply_block_machine_identity is not the body this migration was written against; re-derive it' using errcode = 'check_violation';
  end if;
end $$;

create or replace function public.apply_block_machine_identity(
  p_block_id           uuid,
  p_studio_id          uuid,
  p_profile_id         text,
  p_studio_machine_id  uuid,
  p_mode_key           text,
  p_expected_updated_at timestamptz default null,
  p_receipt_kind       text default null,
  p_idempotency_key    text default null
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_new timestamptz;
  v_current timestamptz;
  v_key text := nullif(btrim(coalesce(p_idempotency_key, '')), '');
  v_digest text;
  v_receipt public.block_write_receipts%rowtype;
  v_profile text := nullif(btrim(coalesce(p_profile_id, '')), '');
  v_mode text := nullif(btrim(coalesce(p_mode_key, '')), '');
  v_unit_profile text;
  v_unit_version integer;
  v_unit_options text[];
  v_requires text;
  v_session_id uuid;
  v_cur_profile text;
  v_cur_unit uuid;
  v_cur_mode text;
  v_new_identity boolean;
  v_pur_legacy boolean := false;
begin
  -- THE HELD VERSION IS CHECKED INSIDE THIS TRANSACTION, under the row lock
  -- A caller that holds the block's
  -- updated_at passes it; a mismatch is the same refusal as the block commands'
  -- own stale check, so a write by another tab between the caller's read and
  -- this call is detected, never overwritten. The NEW updated_at comes back from
  -- the same UPDATE ... RETURNING, so the caller adopts exactly the version its
  -- own write produced and no separate read can race it.
  --
  -- THE SESSION MUST BE LIVE, AND IS LOCKED BEFORE THE BLOCK.
  -- assert_session_writable (frozen) does not look at sessions.deleted_at, and
  -- soft_delete_session stamps the session and leaves its blocks alone, so a direct
  -- call could change the machine identity of a block in a removed session. The session is
  -- read from the block (a plain read, no lock), then locked FOR SHARE with the liveness
  -- test in the same statement, then the block is locked FOR UPDATE and must still belong
  -- to it. That is the documented order: SESSION, then BLOCK (assert_block_in_session,
  -- assert_setup_scope; copy_session_setup and correct_finalized_session hold the
  -- session FOR UPDATE and then want its blocks). FOR SHARE is the same mode the
  -- record_setup_submission_with_identity wrapper already holds, so it is a no-op there.
  select b.session_id into v_session_id
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = p_studio_id
     and b.deleted_at is null;
  if not found then
    raise exception 'Block not found.' using errcode = 'check_violation';
  end if;
  perform 1
    from public.sessions s
   where s.id = v_session_id
     and s.studio_id = p_studio_id
     and s.deleted_at is null
     for share;
  if not found then
    raise exception '%', 'Session not found or not writable by this practitioner.' using errcode = 'check_violation';
  end if;
  select b.updated_at, b.machine_profile_id, b.studio_machine_id, b.machine_mode_key
    into v_current, v_cur_profile, v_cur_unit, v_cur_mode
    from public.session_blocks b
   where b.id = p_block_id
     and b.studio_id = p_studio_id
     and b.session_id = v_session_id
     and b.deleted_at is null
     for update;
  if not found then
    raise exception 'Block not found.' using errcode = 'check_violation';
  end if;
  -- A SAME-KEY REPLAY IS ANSWERED FROM ITS RECEIPT, BEFORE ANY CHECK THAT DEPENDS ON THE BLOCK'S CURRENT STATE.
  -- The earlier attempt committed and its answer was lost; the block may since have been edited, the unit retired or
  -- the version moved on, none of which changes what that attempt did. The stored version is the one THAT write
  -- produced (never the current one), so the caller adopts it and any later edit still conflicts on
  -- its next save. The same key with a different identity is refused, never answered with the original.
  if v_key is not null then
    if p_receipt_kind is null or p_receipt_kind not in ('identity', 'readings', 'create') then
      raise exception 'A receipt kind is required with a retry key.' using errcode = 'check_violation';
    end if;
    if length(v_key) not between 8 and 100 then
      raise exception 'The retry key is not valid.' using errcode = 'check_violation';
    end if;
    v_digest := md5(
      coalesce(nullif(btrim(coalesce(p_profile_id, '')), ''), '') || '|' ||
      coalesce(p_studio_machine_id::text, '') || '|' ||
      coalesce(nullif(btrim(coalesce(p_mode_key, '')), ''), ''));
    -- THE READINGS KIND NEVER REPLAYS FROM HERE. A readings replay is decided by the submission command's own claim
    -- (record_treatment_setup_submission, in the wrapper): this function is reached only for a submission the wrapper judged NEW.
    -- If the claim were ever gone while this key's receipt remained, answering from the receipt would hand back a stale version for
    -- readings that were just written; a new submission instead writes a fresh receipt over the stale one (below).
    if p_receipt_kind <> 'readings' then
      select r.* into v_receipt
        from public.block_write_receipts r
       where r.session_block_id = p_block_id
         and r.studio_id = p_studio_id
         and r.kind = p_receipt_kind
         and r.idempotency_key = v_key;
    end if;
    if found and p_receipt_kind <> 'readings' then
      if v_receipt.payload_digest <> v_digest then
        raise exception 'That save key was already used for a different machine choice.'
          using errcode = 'unique_violation';
      end if;
      return jsonb_build_object(
        'updated_at', v_receipt.resulting_updated_at,
        'reused', true,
        'machine_profile_id', v_receipt.machine_profile_id,
        'studio_machine_id', v_receipt.studio_machine_id,
        'machine_mode_key', v_receipt.machine_mode_key);
    end if;
  end if;
  if p_expected_updated_at is not null and v_current <> p_expected_updated_at then
    raise exception 'stale_block_version: this settings block was changed elsewhere';
  end if;

  if p_studio_machine_id is not null then
    select m.machine_profile_id, m.machine_profile_version, m.installed_options
      into v_unit_profile, v_unit_version, v_unit_options
      from public.studio_machines m
     where m.id = p_studio_machine_id
       and m.studio_id = p_studio_id
       and m.retired_at is null
       -- LOCK THE UNIT BEFORE ACCEPTING IT. retire_studio_machine serialises only through its UPDATE row lock, so an
       -- unlocked read here could see retired_at null, lose the race to a committed retire, and then record a retired unit on the block.
       -- FOR SHARE (taken after the session and block locks, so the order stays session, block, unit) makes a concurrent retire wait, and
       -- under READ COMMITTED the predicate is then re-evaluated against the committed row: a retired unit is refused below.
       for share of m;
    if v_unit_profile is null then
      raise exception 'That machine is not available in this studio.'
        using errcode = 'check_violation';
    end if;
    if v_profile is not null and v_profile <> v_unit_profile then
      raise exception 'The machine does not match the selected model.'
        using errcode = 'check_violation';
    end if;
    v_profile := v_unit_profile;
    v_pur_legacy := coalesce(v_unit_profile = 'dectro-apilus:xcell-pur' and v_mode in ('thermolysis', 'blend', 'galvanic'), false); -- coalesce: a NULL mode must be false, never NULL
    -- THE MODE MUST BE ONE THIS UNIT'S PROFILE VERSION PUBLISHED, AND ITS OPTION MUST BE FITTED. Only modes the published contract lists
    -- for the unit's profile and version are accepted, and an option-gated mode only when the option is fitted. This sits AFTER the
    -- same-key receipt replay and the stale-version check above, so a committed attempt is still answered from its receipt and never
    -- becomes an error, and the lock order is unchanged. It mirrors the submission command: the contract row must exist (fail
    -- closed), and the unit's own installed options decide an option-gated mode.
    if v_mode is not null and not v_pur_legacy then
      select c.requires_installed_option into v_requires
        from public.machine_profile_mode_contract c
       where c.machine_profile_id = v_unit_profile
         and c.machine_profile_version = v_unit_version
         and c.mode_key = v_mode;
      if not found then
        raise exception 'That machine does not offer that mode.'
          using errcode = 'check_violation';
      end if;
      -- `= any` is NULL, not false, when the array holds a NULL element and lacks the option; "is not true" refuses that case too.
      if v_requires is not null
         and (v_requires = any (coalesce(v_unit_options, '{}'::text[]))) is not true then
        raise exception 'This machine does not have the % option fitted, so its mode cannot be recorded.', v_requires
          using errcode = 'check_violation';
      end if;
    end if;
  else
    if v_profile is null then
      raise exception 'A machine model is required.'
        using errcode = 'check_violation';
    end if;
    v_pur_legacy := coalesce(v_profile = 'dectro-apilus:xcell-pur' and v_mode in ('thermolysis', 'blend', 'galvanic'), false); -- coalesce: a NULL mode must be false, never NULL
    if v_mode is not null and not v_pur_legacy then
      raise exception 'A mode needs a registered machine.'
        using errcode = 'check_violation';
    end if;
    -- WITHOUT A REGISTERED UNIT ONLY THE EXISTING xCell Pur IDENTITY IS SUPPORTED (the legacy workflow: a model with no unit and
    -- no mode). Any other profile text was previously accepted on length alone.
    if v_profile <> 'dectro-apilus:xcell' and not v_pur_legacy then
      raise exception 'A machine without a registered unit must be the xCell Pur machine.'
        using errcode = 'check_violation';
    end if;
  end if;


  -- A NEW assignment of the Pur model with a legacy-column mode needs the studio's switch ON and the rollout ON, decided in the database.
  -- An EXISTING block whose identity is unchanged (same model, unit and mode) is not a new assignment and still saves with either off.
  -- A failed rollout read raises, so this fails closed.
  v_new_identity := v_cur_profile is distinct from v_profile
                    or v_cur_unit is distinct from p_studio_machine_id
                    or v_cur_mode is distinct from v_mode;
  if v_pur_legacy and v_new_identity then
    if not exists (select 1 from public.studio_machine_models sm
                    where sm.studio_id = p_studio_id and sm.profile_id = 'dectro-apilus:xcell-pur' and sm.enabled)
       or not public.platform_rollout_enabled_for('charting_new_view_xcell', p_studio_id) then
      raise exception 'That machine is not available for new settings in this studio.'
        using errcode = 'check_violation';
    end if;
  end if;

  -- A NEW binding to ANY model the owner switched OFF is refused, native or legacy (the legacy xCell choice is the xCell model). A model with no
  -- switch row is not switched off. While the rollout is off the switches are dormant, as everywhere else; a failed rollout read raises (fails closed).
  -- An unchanged identity on an existing block is not a new binding and still saves.
  if v_new_identity
     and v_profile in ('dectro-apilus:xcell-pur', 'dectro-apilus:senior-3g', 'dectro-apilus:junior-3g', 'dectro-apilus:xcell')
     and exists (select 1 from public.studio_machine_models sm
                  where sm.studio_id = p_studio_id and not sm.enabled
                    and sm.profile_id = case v_profile when 'dectro-apilus:xcell' then 'dectro-apilus:xcell-pur' else v_profile end)
     -- NOT A NEW BINDING: an area that holds legacy READINGS (block_holds_legacy_readings: the readings, never the mode selection or the sticky
     -- frequency, which a save writes with nothing touched) and has no identity yet, created BEFORE the owner switched the xCell off, being recorded as
     -- the legacy xCell it already is. Both halves are needed: readings alone could be forged into a new area after the switch, and the date alone
     -- would exempt an empty area. Any other area choosing the legacy xCell, or any other model, is still a new binding and is refused.
     and not (v_profile = 'dectro-apilus:xcell' and v_cur_profile is null and v_cur_unit is null
              and public.block_holds_legacy_readings(p_block_id)
              and exists (select 1 from public.session_blocks lb
                            join public.studio_machine_models xm on xm.studio_id = lb.studio_id and xm.profile_id = 'dectro-apilus:xcell-pur' and not xm.enabled
                           where lb.id = p_block_id and lb.created_at < xm.updated_at
                             -- a block created by THIS transaction (the create wrapper writes the legacy content first, then calls this) is never old
                             and lb.created_at < pg_catalog.transaction_timestamp()))
     and public.platform_rollout_enabled_for('charting_new_view_xcell', p_studio_id) then
    raise exception 'That machine is switched off for this studio.' using errcode = 'check_violation';
  end if;

  -- AN AREA THAT ALREADY HOLDS xCell Pur READINGS NEVER GETS A NATIVE IDENTITY (this protects
  -- the studio's existing records). Two machines' settings on one area, or the second overwriting the first, is the harm.
  -- The same list the app's lock uses: the legacy columns on the block and the legacy reading columns on its entries.
  -- A soft-deleted entry is not a reading.
  -- Choosing the legacy xCell Pur machine itself stays allowed. The block row is already locked above, so this read is
  -- consistent with the write below. A new area (create wrapper) has no readings at this point.
  if v_profile <> 'dectro-apilus:xcell' and not v_pur_legacy and public.block_holds_legacy_readings(p_block_id) then
    raise exception 'This area already holds xCell Pur readings; add a new area for another machine.'
      using errcode = 'check_violation';
  end if;

  update public.session_blocks b
     set machine_profile_id = v_profile,
         studio_machine_id = p_studio_machine_id,
         machine_mode_key = v_mode
   where b.id = p_block_id
   returning b.updated_at into v_new;
  if v_key is not null then
    insert into public.block_write_receipts (
      session_block_id, studio_id, kind, idempotency_key, payload_digest,
      resulting_updated_at, machine_profile_id, studio_machine_id, machine_mode_key)
    values (
      p_block_id, p_studio_id, p_receipt_kind, v_key, v_digest,
      v_new, v_profile, p_studio_machine_id, v_mode)
    on conflict (session_block_id, kind, idempotency_key) do update
      set payload_digest = excluded.payload_digest,
          resulting_updated_at = excluded.resulting_updated_at,
          machine_profile_id = excluded.machine_profile_id,
          studio_machine_id = excluded.studio_machine_id,
          machine_mode_key = excluded.machine_mode_key;
  end if;
  return jsonb_build_object(
    'updated_at', v_new,
    'reused', false,
    'machine_profile_id', v_profile,
    'studio_machine_id', p_studio_machine_id,
    'machine_mode_key', v_mode);
end;
$$;

revoke execute on function public.apply_block_machine_identity(uuid, uuid, text, uuid, text, timestamptz, text, text) from public, anon, authenticated, service_role;

revoke all on function public.session_blocks_machine_identity_freeze() from public, anon, authenticated, service_role;
revoke all on function public.block_holds_legacy_readings(uuid) from public, anon, authenticated, service_role;
revoke all on function public.reading_write_share_lock_block() from public, anon, authenticated, service_role;
revoke all on function public.seed_studio_machine_settings(uuid) from public, anon, authenticated, service_role;
revoke all on function public.studio_machines_enable_model_trigger() from public, anon, authenticated, service_role;
revoke all on function public.studios_seed_machine_settings_trigger() from public, anon, authenticated, service_role;
revoke all on function public.studio_machine_setting_events_guard() from public, anon, authenticated, service_role;
revoke all on function public.studio_machine_setting_events_truncate_guard() from public, anon, authenticated, service_role;
revoke all on function public.set_studio_machine_model(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.set_studio_machine_default(uuid, text, boolean) from public, anon, authenticated, service_role;
revoke all on function public.get_studio_machine_choices() from public, anon, authenticated, service_role;
revoke all on function public.ensure_studio_machine_for_save(uuid, text) from public, anon, authenticated, service_role;
grant execute on function public.set_studio_machine_model(uuid, text, boolean) to authenticated;
grant execute on function public.set_studio_machine_default(uuid, text, boolean) to authenticated;
grant execute on function public.get_studio_machine_choices() to authenticated;
grant execute on function public.ensure_studio_machine_for_save(uuid, text) to authenticated;

comment on table public.studio_machine_models is 'Machine switches. One row per studio and model; written only by set_studio_machine_model (owner of that studio). No policy: no direct access.';
comment on table public.studio_machine_default is 'Machine switches. The studio default (a model or Ask at each visit); written only by the owner commands.';
comment on table public.studio_machine_setting_events is 'Machine switches. Append-only, studio-scoped, by user id only; closed value shapes.';

commit;
