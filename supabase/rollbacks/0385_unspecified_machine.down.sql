-- DOWN for 0385. EMERGENCY ONLY, and the application must be rolled back FIRST (pill off, no new saves).
-- Refuses, changing nothing, when any row still points at a placeholder, or when restoring the full
-- display-name index would collide.
begin;

set local lock_timeout = '5s';

do $guard$
begin
  if exists (select 1 from public.session_blocks b join public.studio_machines m on m.id = b.studio_machine_id where m.is_unspecified)
     or exists (select 1 from public.treatment_setup_readings r join public.studio_machines m on m.id = r.studio_machine_id where m.is_unspecified)
     or exists (select 1 from public.treatment_setup_submissions s join public.studio_machines m on m.id = s.studio_machine_id where m.is_unspecified)
     or exists (select 1 from public.treatment_setup_captures c join public.studio_machines m on m.id = c.studio_machine_id where m.is_unspecified)
     or exists (select 1 from public.block_write_receipts w join public.studio_machines m on m.id = w.studio_machine_id where m.is_unspecified)
     or exists (select 1 from public.practitioners p join public.studio_machines m on m.id = p.default_machine_id where m.is_unspecified) then
    raise exception '0385 down refuses: charted data still points at an unspecified machine' using errcode = '55000';
  end if;
  -- The placeholders are deleted below, so only real units can still collide on the restored full index.
  if exists (
    select 1 from public.studio_machines
     where not is_unspecified
     group by studio_id, lower(btrim(display_name))
    having count(*) > 1) then
    raise exception '0385 down refuses: restoring the unique display-name index would collide' using errcode = '55000';
  end if;
end
$guard$;

-- The 0223 bodies, which do not reference is_unspecified, go back before the column is dropped.
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
begin
  select m.studio_id
    into v_studio
    from public.studio_machines m
   where m.id = p_machine_id;

  if v_studio is null then
    raise exception 'Unknown machine.' using errcode = 'no_data_found';
  end if;

  if not public.is_studio_owner(v_studio) then
    raise exception 'Only the studio owner may retire a machine.'
      using errcode = 'insufficient_privilege';
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

    select m.studio_id, m.retired_at
      into v_machine_studio, v_retired
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

delete from public.studio_machines where is_unspecified;

drop trigger if exists studio_machines_unspecified_frozen on public.studio_machines;
drop function if exists public.refuse_unspecified_machine_change();
drop function if exists public.ensure_unspecified_machine(uuid);
drop index if exists public.studio_machines_unspecified_uniq;
drop index if exists public.studio_machines_studio_display_name_uniq;
create unique index studio_machines_studio_display_name_uniq
  on public.studio_machines (studio_id, lower(btrim(display_name)));
alter table public.studio_machines drop constraint if exists studio_machines_unspecified_shape;
alter table public.studio_machines drop column if exists is_unspecified;

commit;
