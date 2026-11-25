-- 0385: MultiPlex readings with NO registered machine.
--
-- A studio that has not registered a machine can still chart xCell Pur MultiPlex. The readings tables
-- require a unit (treatment_setup_readings / submissions / captures .studio_machine_id are NOT NULL), and
-- only an owner can register one, so each studio gets ONE inert, internal placeholder row per xCell Pur
-- profile version, created lazily by a practitioner's first save. It is never shown: every user-visible
-- surface prints "Machine not specified". A registered unit is never rewritten into it or out of it.
--
-- Standalone on production: touches only objects that exist in production. The 0366 exclusions (enable
-- trigger, default and choice commands, seed) are a REQUIRED item on that stack's rebase.
begin;

set local lock_timeout = '5s';

alter table public.studio_machines
  add column if not exists is_unspecified boolean not null default false;

-- The placeholder: never retired, never optioned, always the reserved name.
alter table public.studio_machines
  drop constraint if exists studio_machines_unspecified_shape;
alter table public.studio_machines
  add constraint studio_machines_unspecified_shape check (
    not is_unspecified
    or (retired_at is null
        and display_name = 'Machine not specified'
        and installed_options = '{}'::text[]
        and machine_profile_id = 'dectro-apilus:xcell-pur')
  );

-- The display-name index exempts the placeholder (two studios, or two versions, may each hold one) and
-- register_studio_machine refuses the reserved name, so a real unit can never collide with it.
drop index if exists public.studio_machines_studio_display_name_uniq;
create unique index studio_machines_studio_display_name_uniq
  on public.studio_machines (studio_id, lower(btrim(display_name)))
  where not is_unspecified;

-- One placeholder per studio, profile and version.
create unique index if not exists studio_machines_unspecified_uniq
  on public.studio_machines (studio_id, machine_profile_id, machine_profile_version)
  where is_unspecified;

-- Frozen: nothing may turn a real unit into the placeholder or back, retire it, or rename it.
create or replace function public.refuse_unspecified_machine_change()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  if new.is_unspecified is distinct from old.is_unspecified then
    raise exception 'is_unspecified is immutable.' using errcode = 'check_violation';
  end if;
  if old.is_unspecified and (
       new.retired_at is not null
    or new.display_name is distinct from old.display_name
    or new.installed_options is distinct from old.installed_options
    or new.machine_profile_id is distinct from old.machine_profile_id
    or new.machine_profile_version is distinct from old.machine_profile_version
    or new.studio_id is distinct from old.studio_id) then
    raise exception 'The unspecified machine cannot be changed.' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

revoke execute on function public.refuse_unspecified_machine_change() from public;
revoke execute on function public.refuse_unspecified_machine_change() from anon;
revoke execute on function public.refuse_unspecified_machine_change() from authenticated;
revoke execute on function public.refuse_unspecified_machine_change() from service_role;

drop trigger if exists studio_machines_unspecified_frozen on public.studio_machines;
create trigger studio_machines_unspecified_frozen
  before update on public.studio_machines
  for each row execute function public.refuse_unspecified_machine_change();

-- ---------------------------------------------------------------------------
-- The three production commands that take a machine id and must REFUSE the placeholder
-- (register: the reserved name; retire; set own default). Bodies are 0223's, plus the marked lines.
-- ---------------------------------------------------------------------------
create or replace function public.register_studio_machine(
  p_studio_id uuid,
  p_machine_profile_id text,
  p_machine_profile_version integer,
  p_display_name text,
  p_installed_options text[] default '{}'
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id uuid;
begin
  -- The studio id is a filter, not a claim. A non-owner is refused whatever
  -- they pass.
  if not public.is_studio_owner(p_studio_id) then
    raise exception 'Only the studio owner may register a machine.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 0385: the placeholder row's name is reserved. Case and whitespace folded, so
  -- an owner cannot register a lookalike that reads as the placeholder.
  if lower(btrim(regexp_replace(coalesce(p_display_name, ''), '[[:space:]\u00a0\u1680\u2000-\u200b\u202f\u205f\u3000\ufeff]+', ' ', 'g'))) = 'machine not specified' then
    raise exception 'That machine name is reserved.'
      using errcode = 'check_violation';
  end if;

  if p_machine_profile_version is null or p_machine_profile_version < 1 then
    raise exception 'A machine profile version is required.'
      using errcode = 'check_violation';
  end if;

  -- CONSUME-ONLY, ENFORCED HERE AND NOT ONLY IN THE SERVER ACTION.
  --
  -- registerMachineAction checks this too, but an owner can call this RPC
  -- directly - it is granted to `authenticated` because it must resolve the
  -- caller's own ownership - and would then create a PERMANENT inventory row
  -- whose settings can never be recorded, because recording fails closed
  -- without a published contract. A boundary that only the application
  -- enforces is not a boundary.
  if not exists (
    select 1 from public.machine_profile_mode_contract c
     where c.machine_profile_id = btrim(p_machine_profile_id)
       and c.machine_profile_version = p_machine_profile_version
  ) then
    raise exception
      'No field contract is published for that machine profile version, so a unit cannot be registered against it.'
      using errcode = 'check_violation';
  end if;

  insert into public.studio_machines
    (studio_id, machine_profile_id, machine_profile_version,
     display_name, installed_options)
  values
    (p_studio_id, btrim(p_machine_profile_id), p_machine_profile_version,
     btrim(p_display_name), coalesce(p_installed_options, '{}'))
  returning id into v_id;

  return v_id;
end;
$$;

create or replace function public.retire_studio_machine(p_machine_id uuid)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
  v_id     uuid;
  v_unspec boolean;
begin
  select m.studio_id, m.is_unspecified
    into v_studio, v_unspec
    from public.studio_machines m
   where m.id = p_machine_id;

  if v_studio is null then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  if not public.is_studio_owner(v_studio) then
    raise exception 'Only the studio owner may retire a machine.'
      using errcode = 'insufficient_privilege';
  end if;

  -- 0385: the placeholder is never in or out of service; a retired one would
  -- make every later save refuse.
  if v_unspec then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  -- Idempotent: retiring a retired unit is not an error and does not move the
  -- recorded instant.
  -- CONDITIONAL, so two overlapping retirements cannot both claim the work.
  --
  -- This read `retired_at` with a plain select and then updated by id. Two
  -- requests could both observe NULL, both run their update, and the second
  -- would overwrite the first's recorded retirement INSTANT while also
  -- returning true - so the stamped time belonged to neither request and the
  -- documented idempotence ("returns false if it was already retired") was not
  -- true under concurrency (Codex, d3e8b17b).
  --
  -- The fix is the predicate, not another lock. The UPDATE's own row lock IS
  -- the serialisation point: under READ COMMITTED the loser blocks, then
  -- re-evaluates `retired_at is null` against the committed new version and
  -- matches nothing. The return value is then derived from the row actually
  -- affected rather than from a read that may already be stale. Adding FOR
  -- UPDATE above would serialise the same pair at more cost and still leave
  -- the return value derived from the earlier read.
  --
  -- studio_machines before practitioners, which is this migration's stated
  -- order - see record_treatment_setup_group.
  update public.studio_machines
     set retired_at = now()
   where id = p_machine_id
     and retired_at is null
  returning id into v_id;

  if v_id is null then
    -- Already out of service. Nothing changed, and nothing is cleared below:
    -- whichever request won did that, and re-running the cleanup could undo a
    -- default legitimately set against ANOTHER machine since.
    return false;
  end if;

  update public.practitioners
     set default_machine_id = null,
         default_machine_mode = null
   where default_machine_id = p_machine_id;

  return true;
end;
$$;

create or replace function public.set_own_default_machine(
  p_studio_id uuid,
  p_machine_id uuid,
  p_mode_key text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_pract uuid;
  v_machine_studio uuid;
  v_retired timestamptz;
  v_unspec boolean;
begin
  -- Resolves the CALLER's own active membership in exactly this studio, and
  -- returns NULL for a non-member. No practitioner id is accepted, so nobody
  -- can write another practitioner's default.
  v_pract := public.own_practitioner_in_studio(p_studio_id);
  if v_pract is null then
    return null;
  end if;

  if p_machine_id is not null then
    -- LOCKED BEFORE VALIDATED, and before the practitioners UPDATE below.
    --
    -- Unlocked, this command could observe the machine live, have
    -- `retire_studio_machine` commit - which retires the unit AND clears it
    -- from every practitioner default - and then write it back as a default.
    -- The retirement's own cleanup would be undone by a command that started
    -- earlier, leaving a remembered machine that is out of service.
    --
    -- MACHINE BEFORE PRACTITIONER is retirement's own order (it stamps
    -- `retired_at`, then clears the defaults), so the two serialise rather
    -- than cycle. FOR SHARE, not FOR KEY SHARE: `retired_at` is a non-key
    -- UPDATE taking FOR NO KEY UPDATE, which FOR KEY SHARE does not conflict
    -- with.
    perform 1 from public.studio_machines m where m.id = p_machine_id for share;

    select m.studio_id, m.retired_at, m.is_unspecified
      into v_machine_studio, v_retired, v_unspec
      from public.studio_machines m
     where m.id = p_machine_id;

    if v_machine_studio is null then
      raise exception 'Unknown machine.' using errcode = 'no_data_found';
    end if;

    -- CROSS-STUDIO REFUSAL. A machine from another studio is refused even for
    -- a caller who is a member of both: the remembered choice belongs to one
    -- (studio, practitioner) pair and must name a unit in that studio.
    if v_machine_studio <> p_studio_id then
      raise exception 'That machine belongs to another studio.'
        using errcode = 'insufficient_privilege';
    end if;

    -- 0385: the placeholder is never a remembered default.
    if v_unspec then
      raise exception 'Unknown machine.' using errcode = 'no_data_found';
    end if;

    if v_retired is not null then
      raise exception 'That machine is out of service.'
        using errcode = 'check_violation';
    end if;
  end if;

  update public.practitioners p
     set default_machine_id = p_machine_id,
         default_machine_mode =
           case when p_machine_id is null then null else nullif(btrim(p_mode_key), '') end
   where p.id = v_pract;

  return v_pract;
end;
$$;

-- ---------------------------------------------------------------------------
-- The command: ensure the studio's placeholder for the CURRENT published xCell Pur MultiPlex version.
-- ---------------------------------------------------------------------------
create or replace function public.ensure_unspecified_machine(p_studio_id uuid)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_version integer;
  v_id uuid;
begin
  -- ONE generic refusal for every miss (non-member, receptionist, no such studio, contract not published),
  -- so the answer says nothing about which. is_studio_member is a practitioner of the studio from auth.uid();
  -- a receptionist is not one.
  if p_studio_id is null or auth.uid() is null or not public.is_studio_member(p_studio_id) then
    raise exception 'Machine not available.' using errcode = 'insufficient_privilege';
  end if;

  -- The CURRENT published version: the highest with the MultiPlex contract published. The profile is fixed
  -- here, so nothing a caller passes selects a profile or a version.
  select max(c.machine_profile_version)
    into v_version
    from public.machine_profile_mode_contract c
   where c.machine_profile_id = 'dectro-apilus:xcell-pur'
     and c.mode_key = 'multiplex';

  if v_version is null then
    raise exception 'Machine not available.' using errcode = 'insufficient_privilege';
  end if;

  insert into public.studio_machines
    (studio_id, machine_profile_id, machine_profile_version, display_name, installed_options, is_unspecified)
  values
    (p_studio_id, 'dectro-apilus:xcell-pur', v_version, 'Machine not specified', '{}', true)
  on conflict (studio_id, machine_profile_id, machine_profile_version) where is_unspecified
  do nothing;

  select m.id
    into v_id
    from public.studio_machines m
   where m.studio_id = p_studio_id
     and m.machine_profile_id = 'dectro-apilus:xcell-pur'
     and m.machine_profile_version = v_version
     and m.is_unspecified;

  return v_id;
end;
$$;

comment on function public.ensure_unspecified_machine(uuid) is
  '0385. Returns the studio''s inert placeholder unit for the current published xCell Pur MultiPlex version, creating it on first use. Practitioner of the studio only; one generic refusal on any miss. Returns the id only.';

revoke execute on function public.ensure_unspecified_machine(uuid) from public;
revoke execute on function public.ensure_unspecified_machine(uuid) from anon;
revoke execute on function public.ensure_unspecified_machine(uuid) from service_role;
grant execute on function public.ensure_unspecified_machine(uuid) to authenticated;

-- Re-state the grants of the three replaced commands by name (create or replace keeps them; this proves it).
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from public;
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from anon;
revoke execute on function public.register_studio_machine(uuid, text, integer, text, text[]) from service_role;
grant execute on function public.register_studio_machine(uuid, text, integer, text, text[]) to authenticated;
revoke execute on function public.retire_studio_machine(uuid) from public;
revoke execute on function public.retire_studio_machine(uuid) from anon;
revoke execute on function public.retire_studio_machine(uuid) from service_role;
grant execute on function public.retire_studio_machine(uuid) to authenticated;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from public;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from anon;
revoke execute on function public.set_own_default_machine(uuid, uuid, text) from service_role;
grant execute on function public.set_own_default_machine(uuid, uuid, text) to authenticated;

do $check$
declare
  f text;
begin
  foreach f in array array[
    'public.ensure_unspecified_machine(uuid)',
    'public.register_studio_machine(uuid, text, integer, text, text[])',
    'public.retire_studio_machine(uuid)',
    'public.set_own_default_machine(uuid, uuid, text)'] loop
    if not has_function_privilege('authenticated', f, 'execute')
       or has_function_privilege('anon', f, 'execute')
       or has_function_privilege('service_role', f, 'execute') then
      raise exception '0385 after-check: grants wrong on %', f;
    end if;
  end loop;
end
$check$;

commit;
