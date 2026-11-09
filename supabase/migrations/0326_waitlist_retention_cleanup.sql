-- 0326 — waitlist retention cleanup (HON-7 V1, pre-activation requirement; Sam, 9 Nov). DRAFT: not applied, not reviewed.
--
-- WHAT THIS DOES. (1) A scheduled erase: run_waitlist_retention_cleanup erases every answer past its deadline and writes the erase
-- record ('retention') in the same statement. (2) Read-time suppression: the owner follow-up read and the export return NULL text for
-- an answer past its deadline even if the job is late. (3) A run log + health read. (4) Purges: erase records past greatest(30 days,
-- PITR 7 days + 1 day margin), terminal outbox rows past 90 days, run rows past 90 days.
-- THE RULE, once: waitlist_answer_erase_by(answer) = the earlier of submitted_at + 90 days and the 30-day clock of any follow-up
-- that shows it. The job and both reads call it, so what the owner is promised is what happens.
-- 0325 is applied and frozen; this file REPLACES two of its functions (same signatures, return types, owner re-derivation, grants).
-- Held and sending outbox rows are never purged here (not terminal).

begin;

set local lock_timeout = '5s';

-- Run log: ids, counts and class codes ONLY. Kept (never dropped by the down) like the erase records.
create table if not exists public.waitlist_retention_runs (
  id                      uuid primary key default gen_random_uuid(),
  started_at              timestamptz not null,
  finished_at             timestamptz not null,
  outcome                 text not null,
  erased_answers          integer not null default 0,
  failed_answers             integer not null default 0,
  purged_erase_records    integer not null default 0,
  purged_outbox           integer not null default 0,
  purged_runs             integer not null default 0,
  remaining_answers       integer not null default 0,
  remaining_erase_records integer not null default 0,
  remaining_outbox        integer not null default 0,
  error_class             text,
  -- The one row written by this migration itself, so the health read never reports a missed run before the first real one.
  is_bootstrap            boolean not null default false,
  constraint waitlist_retention_runs_bootstrap_check check (not is_bootstrap or (outcome = 'success' and erased_answers = 0 and failed_answers = 0)),
  constraint waitlist_retention_runs_outcome_check check (outcome in ('success','partial_failure','failed')),
  constraint waitlist_retention_runs_counts_check check (
    erased_answers >= 0 and failed_answers >= 0 and purged_erase_records >= 0 and purged_outbox >= 0 and purged_runs >= 0
    and remaining_answers >= 0 and remaining_erase_records >= 0 and remaining_outbox >= 0),
  constraint waitlist_retention_runs_time_check check (finished_at >= started_at),
  constraint waitlist_retention_runs_error_check check (
    (outcome = 'failed') = (error_class is not null)
    and (error_class is null or error_class in ('exception','timeout','route_error','unknown')))
);
alter table public.waitlist_retention_runs enable row level security;
revoke all on public.waitlist_retention_runs from public, anon, authenticated, service_role;
create index if not exists waitlist_retention_runs_finished_idx on public.waitlist_retention_runs (finished_at desc, id desc);
create index if not exists waitlist_decline_answers_unerased_idx on public.waitlist_decline_answers (submitted_at, followup_id) where erased_at is null;
create index if not exists waitlist_erase_records_erased_at_idx on public.waitlist_erase_records (erased_at, id);
create index if not exists waitlist_decline_owner_emails_terminal_idx
  on public.waitlist_decline_owner_emails (created_at, id) where status in ('sent','failed','cancelled');
comment on table public.waitlist_retention_runs is 'Retention cleanup run log (0326): ids, counts and class codes only. No client text, no names, no addresses.';

create or replace function public.waitlist_answer_erase_by(p_followup_id uuid)
returns timestamptz
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  -- THE retention rule, once: the EARLIER of 90 days after the answer was submitted and 30 days after the earliest close of any
  -- follow-up that shows it (its own decline follow-up; a withdrawal follow-up of the same entry shows the entry's LATEST decline
  -- answer). An open request has only the 90-day clock. least() ignores the null of a clock that has not started.
  select least(
           a.submitted_at + interval '90 days',
           (select min(g.closed_at) + interval '30 days'
              from public.waitlist_followups g
             where g.studio_id = d.studio_id and g.entry_id = d.entry_id and g.closed_at is not null
               and (g.id = d.id
                    or (g.kind = 'withdrawal'
                        and a.followup_id = (select a3.followup_id
                                               from public.waitlist_decline_answers a3
                                               join public.waitlist_followups d3 on d3.id = a3.followup_id
                                              where d3.entry_id = d.entry_id and d3.studio_id = d.studio_id and d3.kind = 'decline'
                                              order by a3.submitted_at desc, a3.followup_id desc
                                              limit 1)))))
    from public.waitlist_decline_answers a
    join public.waitlist_followups d on d.id = a.followup_id
   where a.followup_id = p_followup_id;
$$;

create or replace function public.run_waitlist_retention_cleanup(p_batch_size integer default 500)
returns table (run_id uuid, outcome text, erased_answers integer, failed_answers integer,
               purged_erase_records integer, purged_outbox integer, purged_runs integer,
               remaining_answers integer, remaining_erase_records integer, remaining_outbox integer,
               started_at timestamptz, finished_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
#variable_conflict use_column
declare
  v_now     timestamptz := pg_catalog.now();   -- the ONE clock: the database's, for every comparison and every stamp
  v_started timestamptz := pg_catalog.clock_timestamp();
  -- Erase records: the 30-day rule, never below the PITR window (7 days, Sam-verified) plus a one-day margin.
  v_floor   interval := greatest(interval '30 days', interval '7 days' + interval '1 day');
  v_erased int := 0; v_failed int := 0; v_rec int := 0; v_out int := 0; v_runs int := 0;
  v_rem_a int; v_rem_r int; v_rem_o int; v_n int; v_run uuid; v_outcome text; r record;
begin
  if p_batch_size is null or p_batch_size < 1 or p_batch_size > 1000 then
    raise exception 'invalid_batch_size' using errcode = '22023';
  end if;

  -- 1. Erase overdue answers, most overdue first, at most one batch.
  for r in
    select a.followup_id as fid, d.entry_id as eid, d.studio_id as sid
      from public.waitlist_decline_answers a
      join public.waitlist_followups d on d.id = a.followup_id
     where a.erased_at is null and public.waitlist_answer_erase_by(a.followup_id) <= v_now
     order by public.waitlist_answer_erase_by(a.followup_id), a.followup_id
     limit p_batch_size
  loop
    begin
      -- 0325's lock order: the entry row first (a row already gone means its answers went with it), then the answer.
      perform 1 from public.new_client_waitlist_entries e where e.id = r.eid and e.studio_id = r.sid for update;
      if found then
        -- Erase and its record in ONE statement. The deadline is re-checked under the lock; unique (followup_id, reason) makes a retry a no-op.
        with erased as (
          update public.waitlist_decline_answers a
             set why_not_work = null, better_times = null, erased_at = v_now, erased_by_practitioner_id = null
           where a.followup_id = r.fid and a.erased_at is null and public.waitlist_answer_erase_by(a.followup_id) <= v_now
          returning a.followup_id
        ), logged as (
          insert into public.waitlist_erase_records (studio_id, followup_id, kind, erased_at, erased_by_practitioner_id, reason)
          select r.sid, x.followup_id, (select d.kind from public.waitlist_followups d where d.id = x.followup_id), v_now, null, 'retention'
            from erased x
          on conflict (followup_id, reason) do nothing
          returning 1
        )
        select count(*) into v_n from erased;
        v_erased := v_erased + v_n;
      end if;
    exception when others then
      v_failed := v_failed + 1;   -- one row failing (a lock timeout, say) never stops the batch; it stays overdue and is retried next run
    end;
  end loop;

  -- 2. Purge erase records past the floor, terminal outbox rows past 90 days, and run rows past 90 days. Bounded batches.
  with del as (
    delete from public.waitlist_erase_records x
     where x.id in (select y.id from public.waitlist_erase_records y where y.erased_at < v_now - v_floor order by y.erased_at, y.id limit p_batch_size)
    returning 1)
  select count(*) into v_rec from del;
  with del as (
    delete from public.waitlist_decline_owner_emails x
     where x.id in (select y.id from public.waitlist_decline_owner_emails y
                     where y.status in ('sent','failed','cancelled') and y.created_at < v_now - interval '90 days'
                     order by y.created_at, y.id limit p_batch_size)
    returning 1)
  select count(*) into v_out from del;
  with del as (
    delete from public.waitlist_retention_runs x
     where x.id in (select y.id from public.waitlist_retention_runs y where y.finished_at < v_now - interval '90 days' order by y.finished_at, y.id limit p_batch_size)
    returning 1)
  select count(*) into v_runs from del;

  select count(*) into v_rem_a from public.waitlist_decline_answers a
   where a.erased_at is null and public.waitlist_answer_erase_by(a.followup_id) <= v_now;
  select count(*) into v_rem_r from public.waitlist_erase_records y where y.erased_at < v_now - v_floor;
  select count(*) into v_rem_o from public.waitlist_decline_owner_emails y
   where y.status in ('sent','failed','cancelled') and y.created_at < v_now - interval '90 days';

  v_outcome := case when v_failed > 0 then 'partial_failure' else 'success' end;
  insert into public.waitlist_retention_runs
    (started_at, finished_at, outcome, erased_answers, failed_answers, purged_erase_records, purged_outbox, purged_runs,
     remaining_answers, remaining_erase_records, remaining_outbox)
  values (v_started, pg_catalog.clock_timestamp(), v_outcome, v_erased, v_failed, v_rec, v_out, v_runs, v_rem_a, v_rem_r, v_rem_o)
  returning id into v_run;

  return query
    select t.id, t.outcome, t.erased_answers, t.failed_answers, t.purged_erase_records, t.purged_outbox, t.purged_runs,
           t.remaining_answers, t.remaining_erase_records, t.remaining_outbox, t.started_at, t.finished_at
      from public.waitlist_retention_runs t where t.id = v_run;
end;
$$;

create or replace function public.record_waitlist_retention_failure(p_error_class text)
returns uuid
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_run uuid; v_t timestamptz := pg_catalog.clock_timestamp();
begin
  if p_error_class is null or p_error_class not in ('exception','timeout','route_error','unknown') then
    raise exception 'invalid_error_class' using errcode = '22023';
  end if;
  insert into public.waitlist_retention_runs (started_at, finished_at, outcome, error_class)
  values (v_t, v_t, 'failed', p_error_class)
  returning id into v_run;
  return v_run;
end;
$$;

create or replace function public.waitlist_retention_health()
returns table (last_success_at timestamptz, last_run_at timestamptz, last_outcome text,
               last_erased_count integer, last_failed_count integer,
               overdue_unerased_count integer, oldest_overdue_age_hours numeric, stuck_held_outbox_count integer)
language sql stable security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    (select max(r.finished_at) from public.waitlist_retention_runs r where r.outcome = 'success'),
    (select max(r.finished_at) from public.waitlist_retention_runs r),
    (select r.outcome from public.waitlist_retention_runs r order by r.finished_at desc, r.id desc limit 1),
    (select r.erased_answers from public.waitlist_retention_runs r order by r.finished_at desc, r.id desc limit 1),
    (select r.failed_answers from public.waitlist_retention_runs r order by r.finished_at desc, r.id desc limit 1),
    (select count(*)::integer from public.waitlist_decline_answers a
      where a.erased_at is null and public.waitlist_answer_erase_by(a.followup_id) <= pg_catalog.now()),
    (select round(extract(epoch from pg_catalog.now() - min(public.waitlist_answer_erase_by(a.followup_id))) / 3600.0, 1)
       from public.waitlist_decline_answers a
      where a.erased_at is null and public.waitlist_answer_erase_by(a.followup_id) <= pg_catalog.now()),
    -- Owner-email rows that are still held or sending after 24 hours: a count, never an id.
    (select count(*)::integer from public.waitlist_decline_owner_emails o
      where o.status in ('held','sending') and o.created_at < pg_catalog.now() - interval '24 hours');
$$;

create or replace function public.read_waitlist_followups(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_invitation_id uuid default null
)
returns table (followup_id uuid, kind text, entry_id uuid, invitation_id uuid, client_name text,
               opened_at timestamptz, status text, why_not_work text, better_times text,
               answers_erased_at timestamptz, submitted_at timestamptz, closed_at timestamptz, erase_by timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_actor uuid; v_code text;
begin
  select o.practitioner_id, o.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code <> 'ok' then return; end if;

  return query
    select f.id, f.kind, f.entry_id, f.invitation_id, e.name,
           f.opened_at, f.status,
           case when a.erased_at is null and a.eb <= pg_catalog.now() then null else a.why_not_work end,
           case when a.erased_at is null and a.eb <= pg_catalog.now() then null else a.better_times end,
           coalesce(a.erased_at, case when a.eb <= pg_catalog.now() then a.eb end), a.submitted_at, f.closed_at,
           case when a.followup_id is null or a.erased_at is not null or a.eb <= pg_catalog.now() then null else a.eb end
      from public.waitlist_followups f
      join public.new_client_waitlist_entries e on e.id = f.entry_id and e.studio_id = f.studio_id
      left join lateral (
        select a2.*, public.waitlist_answer_erase_by(a2.followup_id) as eb from public.waitlist_decline_answers a2
          join public.waitlist_followups d on d.id = a2.followup_id
         where d.entry_id = f.entry_id and d.kind = 'decline'
           and (f.kind = 'decline' and d.id = f.id or f.kind = 'withdrawal')
         order by a2.submitted_at desc
         limit 1) a on true
     where f.studio_id = p_studio_id
       -- No invitation id: every OPEN follow-up PLUS closed ones whose answers still exist, so the owner can still read and
       -- erase them before the retention date. With an id: that invitation's follow-ups, whatever their state.
       and (case when p_invitation_id is null then (f.status = 'open' or (a.followup_id is not null and a.erased_at is null and a.eb > pg_catalog.now()))
                 else f.invitation_id = p_invitation_id end)
     -- OPEN rows first, newest first, then closed rows with answers still present: past the cap it is the oldest CLOSED rows that drop.
     order by (f.status <> 'open'), f.opened_at desc, f.id
     limit 500;
end;
$$;

create or replace function public.export_waitlist_decline_answers(
  p_studio_id     uuid,
  p_actor_user_id uuid,
  p_after_id      uuid default null,
  p_limit         int  default 1000
)
returns table (answer_id uuid, followup_id uuid, entry_id uuid, invitation_id uuid, client_id uuid, kind text,
               why_not_work text, better_times text, submitted_at timestamptz, answers_erased_at timestamptz)
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_code text;
begin
  if p_limit is null or p_limit < 1 or p_limit > 1000 then
    raise exception 'invalid_limit' using errcode = '22023';
  end if;
  select o.code into v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) o;
  if v_code is distinct from 'ok' then return; end if;
  return query
    select a.followup_id, d.id, d.entry_id, d.invitation_id, c.id, d.kind,
           case when a.erased_at is null and x.eb <= pg_catalog.now() then null else a.why_not_work end,
           case when a.erased_at is null and x.eb <= pg_catalog.now() then null else a.better_times end,
           a.submitted_at, coalesce(a.erased_at, case when x.eb <= pg_catalog.now() then x.eb end)
      from public.waitlist_decline_answers a
      join public.waitlist_followups d on d.id = a.followup_id and d.studio_id = a.studio_id
      join public.new_client_waitlist_entries e on e.id = d.entry_id and e.studio_id = d.studio_id
      left join public.clients c on c.studio_id = e.studio_id and c.normalized_email = e.email_normalized
      cross join lateral (select public.waitlist_answer_erase_by(a.followup_id) as eb) x
     where a.studio_id = p_studio_id
       and (p_after_id is null or a.followup_id > p_after_id)
     order by a.followup_id
     limit p_limit;
end;
$$;

revoke all on function public.waitlist_answer_erase_by(uuid) from public, anon, authenticated, service_role;
revoke all on function public.run_waitlist_retention_cleanup(integer) from public, anon, authenticated, service_role;
revoke all on function public.record_waitlist_retention_failure(text) from public, anon, authenticated, service_role;
revoke all on function public.waitlist_retention_health() from public, anon, authenticated, service_role;
revoke all on function public.read_waitlist_followups(uuid, uuid, uuid) from public, anon, authenticated, service_role;
revoke all on function public.export_waitlist_decline_answers(uuid, uuid, uuid, int) from public, anon, authenticated, service_role;
grant execute on function public.run_waitlist_retention_cleanup(integer) to service_role;
grant execute on function public.record_waitlist_retention_failure(text) to service_role;
grant execute on function public.waitlist_retention_health() to service_role;
grant execute on function public.read_waitlist_followups(uuid, uuid, uuid) to service_role;
grant execute on function public.export_waitlist_decline_answers(uuid, uuid, uuid, int) to service_role;

-- Bootstrap: ONE run row at apply time (counts 0), so "no successful run in 26 hours" can only fire if a real run is then missed.
insert into public.waitlist_retention_runs (started_at, finished_at, outcome, is_bootstrap)
select pg_catalog.now(), pg_catalog.now(), 'success', true
 where not exists (select 1 from public.waitlist_retention_runs r where r.is_bootstrap);

do $$
declare
  v_fn text; v_role text; v_oid oid;
begin
  if not (select c.relrowsecurity from pg_catalog.pg_class c where c.oid = 'public.waitlist_retention_runs'::regclass) then
    raise exception '0326: RLS is not enabled on waitlist_retention_runs';
  end if;
  if exists (select 1 from pg_catalog.pg_policies p where p.schemaname = 'public' and p.tablename = 'waitlist_retention_runs') then
    raise exception '0326: waitlist_retention_runs must have no policy';
  end if;
  foreach v_role in array array['anon','authenticated','service_role'] loop
    if pg_catalog.has_any_column_privilege(v_role, 'public.waitlist_retention_runs', 'select,insert,update,references')
       or pg_catalog.has_table_privilege(v_role, 'public.waitlist_retention_runs', 'select,insert,update,delete,truncate,references,trigger') then
      raise exception '0326: waitlist_retention_runs must not be reachable by %', v_role;
    end if;
  end loop;
  foreach v_fn in array array['waitlist_answer_erase_by','run_waitlist_retention_cleanup','record_waitlist_retention_failure',
                              'waitlist_retention_health','read_waitlist_followups','export_waitlist_decline_answers'] loop
    if (select count(*) from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
         where n.nspname = 'public' and p.proname = v_fn) <> 1 then
      raise exception '0326: expected exactly one function %', v_fn;
    end if;
    select p.oid into v_oid from pg_catalog.pg_proc p join pg_catalog.pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = v_fn;
    if not (select p.prosecdef and p.proconfig @> array['search_path=pg_catalog, pg_temp'] from pg_catalog.pg_proc p where p.oid = v_oid) then
      raise exception '0326: % must be a security definer with a pinned search_path', v_fn;
    end if;
    foreach v_role in array array['anon','authenticated'] loop
      if pg_catalog.has_function_privilege(v_role, v_oid, 'EXECUTE') then
        raise exception '0326: % must not be executable by %', v_fn, v_role;
      end if;
    end loop;
    if pg_catalog.has_function_privilege('public', v_oid, 'EXECUTE') then
      raise exception '0326: % must not be executable by PUBLIC', v_fn;
    end if;
    if (v_fn = 'waitlist_answer_erase_by') = pg_catalog.has_function_privilege('service_role', v_oid, 'EXECUTE') then
      raise exception '0326: service_role EXECUTE on % is not as intended', v_fn;
    end if;
  end loop;
  if not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.read_waitlist_followups(uuid,uuid,uuid)') and md5(p.prosrc) = 'd98705fc14e1c1e89bbfd618648993c1')
     or not exists (select 1 from pg_catalog.pg_proc p where p.oid = pg_catalog.to_regprocedure('public.export_waitlist_decline_answers(uuid,uuid,uuid,integer)') and md5(p.prosrc) = 'fb2b2659843c53301755b9f76c0c53b4') then
    raise exception '0326: a replaced read is not the sealed body';
  end if;
end $$;

commit;
