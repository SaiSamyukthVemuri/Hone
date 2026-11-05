-- HELD DRAFT, NEVER RUN, UNNUMBERED IN THE REPOSITORY. Number 0297 claimed for Willow by OPS (3 Nov 2026). Option 1 approved by OPS.
-- HON-48: calendar block vs booking deadlock (SQLSTATE 40P01). Diagnosis: DIAGNOSIS-BLOCK-BOOKING-DEADLOCK-20261103.md.
--
-- The bookings (create_appointment_core 0220, create_public_appointment 0170/v2 0222, move_appointment_core 0220, reschedule_appointment_v3 0234)
-- take the studios row FOR UPDATE, then the studio capacity advisory lock. The block trigger (0138) took ONLY the advisory lock, so a block held
-- the advisory lock and then needed FOR KEY SHARE on the same studios row (its foreign-key check) while a booking held that row and waited for the
-- advisory lock: a cycle. This file makes the trigger take the studios row first, then the advisory lock, the same order as everyone else.
--
-- FOR NO KEY UPDATE (not FOR UPDATE): it still conflicts with the bookings' FOR UPDATE, so blocks and bookings serialize per studio, but it does
-- not conflict with other transactions' FOR KEY SHARE foreign-key checks, so unrelated inserts do not queue behind a block.
--
-- PART A: one function body replaced. PART B (below): four recurring-break command bodies, one added line each. PART C (below): the practitioner-change refan trigger function. A, B AND C MUST SHIP TOGETHER, NEVER A ALONE (Part A alone makes delete_recurring_break_rule deadlock, proven in slot 2). The four triggers (<table>_00_lock_trg on studio_timed_blocks, studio_recurring_break_rules,
-- studio_recurring_break_occurrences, studio_blockouts) are untouched. No table, column, data or grant changes. The privileges are re-asserted
-- by name, as CLAUDE.md requires, even though CREATE OR REPLACE keeps the existing ACL.
-- An UPDATE that moves a row to another studio locks only the destination, as before (studio_id is not changed by any application writer: UNVERIFIED).
-- A DELETE that cascades from deleting the studio itself finds its own row already deleted; the PERFORM then returns no row and does not error.
begin;
set local lock_timeout = '5s';

create or replace function public.lock_structural_calendar_source_mutation()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
begin
  if tg_op = 'DELETE' then
    v_studio := old.studio_id;
  else
    v_studio := new.studio_id;
  end if;

  -- 1. The studios row, in the same mode-strength order as the booking commands (they use FOR UPDATE, which conflicts with this).
  perform 1 from public.studios s where s.id = v_studio for no key update;
  -- 2. Then the studio capacity advisory lock.
  perform public.acquire_studio_capacity_lock(v_studio);

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

revoke execute on function public.lock_structural_calendar_source_mutation() from public;
revoke execute on function public.lock_structural_calendar_source_mutation() from anon;
revoke execute on function public.lock_structural_calendar_source_mutation() from authenticated;
revoke execute on function public.lock_structural_calendar_source_mutation() from service_role;

-- ---------------------------------------------------------------------------
-- PART B (OPS decision, 3 Nov 2026: in 0297, same defect class). The four recurring-break commands took the advisory lock BEFORE any
-- studios row lock, which is the same inversion (found by the catalog audit, willow/slot-willow4-20261103-0297/audit-baseline.txt). Each now
-- takes the studios row FOR NO KEY UPDATE first, then the advisory lock. Nothing else in these bodies changes. Privileges are unchanged
-- (CREATE OR REPLACE keeps the ACL; they are service_role-only commands, as before).
-- materialize_recurring_break_rule reads the studio id from the rule, then locks; the three RPCs lock with their p_studio_id argument.
-- ---------------------------------------------------------------------------
create or replace function public.materialize_recurring_break_rule(
  p_rule_id      uuid,
  p_horizon_end  date
) returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio     uuid;
  v_rule       public.studio_recurring_break_rules%rowtype;
  v_studio_tz  text;
  v_iter       date;
  v_dow        integer;
  v_starts_at  timestamptz;
  v_ends_at    timestamptz;
begin
  select studio_id into v_studio from public.studio_recurring_break_rules where id = p_rule_id;
  if v_studio is null then
    return;
  end if;
  perform 1 from public.studios s where s.id = v_studio for no key update;
  perform public.acquire_studio_capacity_lock(v_studio);

  -- Re-read under a row lock AFTER the advisory lock: a concurrent update/delete
  -- committed before the lock is now visible.
  select * into v_rule from public.studio_recurring_break_rules
    where id = p_rule_id for update;
  if not found or not v_rule.active then
    return;
  end if;

  select coalesce(s.timezone, 'America/Toronto') into v_studio_tz
  from public.studios s where s.id = v_rule.studio_id;

  v_iter := (now() at time zone v_studio_tz)::date;
  while v_iter <= p_horizon_end loop
    v_dow := extract(dow from v_iter)::integer;
    if v_dow = any (v_rule.days_of_week) then
      v_starts_at := (v_iter::text || ' ' || v_rule.start_local_time::text)::timestamp at time zone v_studio_tz;
      v_ends_at   := (v_iter::text || ' ' || v_rule.end_local_time::text)::timestamp at time zone v_studio_tz;
      if v_ends_at > now() then
        insert into public.studio_recurring_break_occurrences
          (rule_id, studio_id, practitioner_id, occurrence_date, starts_at, ends_at)
        values
          (p_rule_id, v_rule.studio_id, v_rule.practitioner_id, v_iter, v_starts_at, v_ends_at)
        on conflict on constraint studio_recurring_break_occurrences_rule_date_unique
        do nothing;
      end if;
    end if;
    v_iter := v_iter + 1;
  end loop;
end;
$$;

CREATE OR REPLACE FUNCTION public.create_recurring_break_rule_and_materialize(p_studio_id uuid, p_label text, p_days_of_week integer[], p_start_local_time time without time zone, p_end_local_time time without time zone, p_active boolean, p_created_by uuid, p_horizon_end date, p_practitioner_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_rule_id uuid;
begin
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  perform public.acquire_studio_capacity_lock(p_studio_id);
  insert into public.studio_recurring_break_rules
    (studio_id, label, days_of_week, start_local_time, end_local_time,
     active, created_by, practitioner_id)
  values
    (p_studio_id, p_label, p_days_of_week, p_start_local_time,
     p_end_local_time, p_active, p_created_by, p_practitioner_id)
  returning id into v_rule_id;
  if p_active then
    perform public.materialize_recurring_break_rule(v_rule_id, p_horizon_end);
  end if;
  return v_rule_id;
end;
$function$;

CREATE OR REPLACE FUNCTION public.update_recurring_break_rule_and_rematerialize(p_rule_id uuid, p_studio_id uuid, p_label text, p_days_of_week integer[], p_start_local_time time without time zone, p_end_local_time time without time zone, p_active boolean, p_horizon_end date, p_practitioner_id uuid DEFAULT NULL::uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  perform public.acquire_studio_capacity_lock(p_studio_id);
  perform 1 from public.studio_recurring_break_rules
    where id = p_rule_id and studio_id = p_studio_id for update;
  if not found then
    raise exception 'recurring break rule not found' using errcode = 'P0002';
  end if;

  update public.studio_recurring_break_rules
  set label = p_label, days_of_week = p_days_of_week,
      start_local_time = p_start_local_time, end_local_time = p_end_local_time,
      active = p_active, practitioner_id = p_practitioner_id, updated_at = now()
  where id = p_rule_id and studio_id = p_studio_id;

  -- Future/in-progress occurrences only (preserve completed history). A scope
  -- change therefore replaces every future occurrence under the NEW scope.
  delete from public.studio_recurring_break_occurrences
  where rule_id = p_rule_id and ends_at > now();

  if p_active then
    perform public.materialize_recurring_break_rule(p_rule_id, p_horizon_end);
  end if;
end;
$function$;

CREATE OR REPLACE FUNCTION public.delete_recurring_break_rule(p_rule_id uuid, p_studio_id uuid)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
begin
  perform 1 from public.studios s where s.id = p_studio_id for no key update;
  perform public.acquire_studio_capacity_lock(p_studio_id);
  perform 1 from public.studio_recurring_break_rules
    where id = p_rule_id and studio_id = p_studio_id for update;
  if not found then
    raise exception 'recurring break rule not found' using errcode = 'P0002';
  end if;
  delete from public.studio_recurring_break_occurrences
    where rule_id = p_rule_id and ends_at > now();
  delete from public.studio_recurring_break_rules
    where id = p_rule_id and studio_id = p_studio_id;
end;
$function$;

-- PART C (OPS decision, 3 Nov 2026, after slot 2): on_practitioner_change_refan (0134), a trigger on PRACTITIONERS (insert, delete, update of studio_id),
-- calls rematerialize_studio_reservations, which takes the advisory lock and then re-inserts studio_calendar_reservations rows. Each insert needs
-- FOR KEY SHARE on the studios row (foreign key studio_id), so it is the same inversion: a practitioner DELETE (no studios lock before the refan)
-- holds the advisory lock and waits for the studios row, while a booking holds the row FOR UPDATE and waits for the advisory lock. On INSERT the
-- studios foreign-key check runs first, but the lock is taken anyway so every path follows one rule. A studio move locks BOTH studios rows in id
-- order (no cross-studio cycle). FOR NO KEY UPDATE, as above. The no-op for studios with capacity OFF is unchanged: no lock is taken for them.
create or replace function public.on_practitioner_change_refan()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_move boolean := tg_op = 'UPDATE' and new.studio_id is distinct from old.studio_id;
begin
  if tg_op = 'DELETE' then
    if public.studio_capacity_enabled(old.studio_id) then
      perform 1 from public.studios s where s.id = old.studio_id for no key update;
      perform public.rematerialize_studio_reservations(old.studio_id);
    end if;
    return null;
  end if;

  -- INSERT, or UPDATE that moved the practitioner between studios
  -- (unique(studio_id,user_id) makes the latter rare): re-fan both studios.
  if v_move and (public.studio_capacity_enabled(old.studio_id) or public.studio_capacity_enabled(new.studio_id)) then
    perform 1 from public.studios s where s.id in (old.studio_id, new.studio_id) order by s.id for no key update;
  end if;
  if v_move and public.studio_capacity_enabled(old.studio_id) then
    perform public.rematerialize_studio_reservations(old.studio_id);
  end if;
  if public.studio_capacity_enabled(new.studio_id) then
    if not v_move then
      perform 1 from public.studios s where s.id = new.studio_id for no key update;
    end if;
    perform public.rematerialize_studio_reservations(new.studio_id);
  end if;
  return null;
end;
$$;

commit;
