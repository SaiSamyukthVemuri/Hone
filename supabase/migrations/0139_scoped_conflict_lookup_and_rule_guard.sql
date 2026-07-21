-- PR B 3E — remaining-defect corrections.
--
-- (A) Defect #2: a recurring rule assigned to an INACTIVE practitioner must not
--     be (re-)enabled. 0138's guard validated the active practitioner only when
--     scope was set or changed, so toggling active=false -> true with an
--     unchanged inactive practitioner_id bypassed validation. This adds a
--     rule-specific guard that ALSO validates on the inactive->active transition
--     and on any save of an already-active scoped rule, while still allowing
--     toggle-off / editing a disabled rule / delete / reassign-to-active /
--     change-to-studio-wide. Timed blocks keep the 0138 guard (they have no
--     active flag).
--
-- (B) 3E-7 + §10: resource-aware, PII-safe conflict lookup. Two SECURITY
--     DEFINER, service_role-only read functions replace the old
--     studio_id-only in-memory scan (which over-selected across practitioners).
--     They filter to the resource set that actually reserves the proposed
--     source (Legacy -> studio_id; ON scoped -> that practitioner; ON
--     studio-wide -> every practitioner key, active OR inactive, matching the
--     synchronizer's fan-out), dedup by (source_kind, source_id) in SQL, order
--     deterministically, and return ONLY source kind + interval + resource_key
--     (never client identity, service, notes, clinical data, contact info, or
--     tokens — the reservation table holds none of those anyway).
--
-- Migration-first, additive, flag-OFF. NOT hosted-applied; hosted max stays
-- 0133. No data migration, no destructive change.
--
-- ATOMIC: the whole migration runs in one explicit transaction (matching 0134-
-- 0138). Each SECURITY DEFINER reader is locked down (revoke default/public/
-- anon/authenticated, grant service_role) IMMEDIATELY after its definition and
-- inside the same transaction, so there is never a committed state where a
-- reader exists but is still world-executable — a partial apply either commits
-- fully (functions exist AND are service_role-only) or rolls back to nothing.

begin;

-- ---------------------------------------------------------------------------
-- (A) Recurring-rule capacity + active-practitioner guard (defect #2)
-- ---------------------------------------------------------------------------
create or replace function public.guard_scoped_recurring_rule_capacity()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_scope_set_or_changed boolean :=
    tg_op = 'INSERT' or new.practitioner_id is distinct from old.practitioner_id;
begin
  -- Capacity requirement: only when the scope is newly SET or reassigned, so a
  -- RETAINED scoped rule can still be toggled-off / edited / deleted after the
  -- studio drops back to Legacy (those rows are dormant anyway).
  if new.practitioner_id is not null and v_scope_set_or_changed then
    if not public.studio_capacity_enabled(new.studio_id) then
      raise exception 'per-practitioner break requires practitioner capacity to be enabled'
        using errcode = '42501';
    end if;
  end if;

  -- Active-practitioner requirement: a scope may never be newly assigned to an
  -- inactive practitioner, AND a scoped rule that is (or stays) ENABLED must
  -- target an active practitioner. Fires on: INSERT with scope, scope change,
  -- or new.active = true. Does NOT fire for toggle-OFF, editing a DISABLED
  -- rule, delete (no BEFORE-DELETE), or reassign to studio-wide / an active
  -- practitioner — so an inactive-scoped rule can always be wound down.
  if new.practitioner_id is not null
     and (v_scope_set_or_changed or new.active = true) then
    if not exists (
      select 1 from public.practitioners p
      where p.id = new.practitioner_id and p.active = true
    ) then
      raise exception 'recurring break is assigned to an inactive practitioner'
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$$;

-- Re-point the rule's scope-guard trigger at the rule-specific function. The
-- name is unchanged so it still sorts AFTER the 0138 "_00_lock_trg" (lock held
-- first). Timed blocks keep guard_scoped_source_capacity (0138).
drop trigger if exists studio_recurring_break_rules_scope_guard_trg
  on public.studio_recurring_break_rules;
create trigger studio_recurring_break_rules_scope_guard_trg
  before insert or update on public.studio_recurring_break_rules
  for each row execute function public.guard_scoped_recurring_rule_capacity();

-- ---------------------------------------------------------------------------
-- (B) 3E-7: resource-aware one-off (timed-block / blockout) conflict lookup
-- ---------------------------------------------------------------------------
create or replace function public.find_scoped_calendar_conflict(
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_starts_at       timestamptz,
  p_ends_at         timestamptz,
  p_exclude_kind    text default null,
  p_exclude_id      uuid default null
) returns table (
  source_kind  text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  resource_key uuid
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with cfg as (
    select public.studio_capacity_enabled(p_studio_id) as cap_on
  ),
  candidates as (
    select distinct on (r.source_kind, r.source_id)
           r.source_kind, r.source_id, r.starts_at, r.ends_at, r.resource_key
    from public.studio_calendar_reservations r
    cross join cfg
    where r.studio_id = p_studio_id
      -- half-open overlap [starts_at, ends_at)
      and r.starts_at < p_ends_at
      and r.ends_at   > p_starts_at
      -- relevant resource set for the proposed source
      and (
        case
          when not cfg.cap_on then r.resource_key = p_studio_id
          when p_practitioner_id is not null then r.resource_key = p_practitioner_id
          else r.resource_key in (
            select pr.id from public.practitioners pr where pr.studio_id = p_studio_id
          )
        end
      )
      -- exclude the source being edited (its own pre-rollback shadow rows)
      and not (
        p_exclude_id is not null
        and r.source_kind = p_exclude_kind
        and r.source_id = p_exclude_id
      )
    order by r.source_kind, r.source_id, r.starts_at, r.resource_key
  )
  select source_kind, starts_at, ends_at, resource_key
  from candidates
  order by starts_at, source_kind, source_id
  limit 1;
$$;

-- Lock down IMMEDIATELY (same transaction): service_role only, no browser role.
revoke execute on function public.find_scoped_calendar_conflict(uuid, uuid, timestamptz, timestamptz, text, uuid) from public;
revoke execute on function public.find_scoped_calendar_conflict(uuid, uuid, timestamptz, timestamptz, text, uuid) from anon;
revoke execute on function public.find_scoped_calendar_conflict(uuid, uuid, timestamptz, timestamptz, text, uuid) from authenticated;
grant execute on function public.find_scoped_calendar_conflict(uuid, uuid, timestamptz, timestamptz, text, uuid) to service_role;

-- ---------------------------------------------------------------------------
-- (B) §10: exact recurring-break conflict projection. Projects the proposed
-- pattern across the full materialization horizon in the studio timezone
-- (DST-correct via AT TIME ZONE), on the relevant resource set, excluding ALL
-- of the edited rule's own future occurrences, and returns the earliest actual
-- collision. Read-only: it does NOT materialize or mutate the rule.
-- ---------------------------------------------------------------------------
create or replace function public.find_recurring_break_conflict(
  p_studio_id       uuid,
  p_practitioner_id uuid,
  p_days_of_week    integer[],
  p_start_local     time,
  p_end_local       time,
  p_horizon_end     date,
  p_exclude_rule_id uuid default null
) returns table (
  source_kind  text,
  starts_at    timestamptz,
  ends_at      timestamptz,
  resource_key uuid
)
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  with cfg as (
    select
      coalesce((select s.timezone from public.studios s where s.id = p_studio_id), 'America/Toronto') as tz,
      public.studio_capacity_enabled(p_studio_id) as cap_on
  ),
  occ as (
    select
      ((d::date || ' ' || p_start_local::text)::timestamp at time zone cfg.tz) as occ_start,
      ((d::date || ' ' || p_end_local::text)::timestamp   at time zone cfg.tz) as occ_end
    from cfg
    -- Explicit timestamp bounds so the generate_series overload is unambiguous.
    cross join generate_series(
      date_trunc('day', now() at time zone cfg.tz),
      p_horizon_end::timestamp,
      interval '1 day'
    ) d
    where (extract(dow from d)::int) = any (p_days_of_week)
      and ((d::date || ' ' || p_end_local::text)::timestamp at time zone cfg.tz) > now()
  ),
  candidates as (
    select distinct on (r.source_kind, r.source_id)
           r.source_kind, r.source_id, r.starts_at, r.ends_at, r.resource_key
    from occ
    join public.studio_calendar_reservations r
      on r.studio_id = p_studio_id
     and r.starts_at < occ.occ_end
     and r.ends_at   > occ.occ_start
    cross join cfg
    where (
      case
        when not cfg.cap_on then r.resource_key = p_studio_id
        when p_practitioner_id is not null then r.resource_key = p_practitioner_id
        else r.resource_key in (
          select pr.id from public.practitioners pr where pr.studio_id = p_studio_id
        )
      end
    )
    -- exclude every future occurrence reservation belonging to the edited rule
    and not (
      p_exclude_rule_id is not null
      and r.source_kind = 'recurring_break_occurrence'
      and r.source_id in (
        select o.id from public.studio_recurring_break_occurrences o
        where o.rule_id = p_exclude_rule_id
      )
    )
    order by r.source_kind, r.source_id, r.starts_at, r.resource_key
  )
  select source_kind, starts_at, ends_at, resource_key
  from candidates
  order by starts_at, source_kind, source_id
  limit 1;
$$;

-- Lock down IMMEDIATELY (same transaction): service_role only, no browser role.
revoke execute on function public.find_recurring_break_conflict(uuid, uuid, integer[], time, time, date, uuid) from public;
revoke execute on function public.find_recurring_break_conflict(uuid, uuid, integer[], time, time, date, uuid) from anon;
revoke execute on function public.find_recurring_break_conflict(uuid, uuid, integer[], time, time, date, uuid) from authenticated;
grant execute on function public.find_recurring_break_conflict(uuid, uuid, integer[], time, time, date, uuid) to service_role;

commit;
