-- HON-48 Q7: a data-free "the schedule changed" signal, studio-isolated.
--
-- WHAT: AFTER STATEMENT triggers (transition tables) on the four tables that put time
-- on the calendar grid call realtime.send('{}', 'changed', 'schedule:<studio uuid>',
-- private => true): ONE message per studio per statement. Supabase Realtime delivers a
-- realtime.messages row to subscribers AFTER the writing transaction commits (it reads
-- the committed WAL), so a rolled-back write sends nothing. The browser treats the
-- message only as "ask the server for a refresh"; it carries no row data, no studio
-- data and no client data.
--
--   appointments                        insert, delete, update of the schedule columns
--   studio_timed_blocks                 insert, delete, update of the schedule columns
--                                       (including the note the grid shows as the block's tooltip)
--   studio_blockouts                    insert, delete, update of the date range and reason
--   studio_recurring_break_occurrences  insert, delete, update of the time range
--
-- An UPDATE signals only for studios with a row whose LISTED columns changed (compared
-- between the old and new transition tables; the column list is the trigger argument),
-- so reminder, email, SMS, postcare and Google-sync bookkeeping on appointments sends
-- nothing. tests/lib/calendar/schedule-signal-census.test.ts derives the schedule-
-- visible columns from what the calendar and drawer read and fails when one is missing
-- here. NOT triggered, covered by the 60 s and focus refresh: availability defaults and
-- overrides, practitioners, services, clients, studios.
--
-- WHO MAY LISTEN: one SELECT policy on realtime.messages, authenticated only: the
-- topic must be exactly 'schedule:<uuid>' AND the caller an active member of that
-- studio (is_studio_member, 0001). No INSERT policy exists, so no browser can publish.
--
-- FAILS OPEN: a failure in the signal path never fails the caller's write. A failure the
-- emitter can observe (its owner cannot insert into realtime.messages) raises a WARNING
-- carrying a running count (public.schedule_signal_failures_seq, which a rollback does not
-- reset); an error inside realtime.send's own insert is swallowed by realtime.send and shows
-- as its own 'ErrorSendingBroadcastMessage' WARNING (uncounted).
--
-- ENVIRONMENT: realtime.messages and realtime.send() are created by the Realtime
-- SERVICE, not by Postgres. CI and a fresh `supabase db reset` run migrations before
-- they exist (CI excludes the service), so this file guards with to_regclass and
-- to_regprocedure, emits a NOTICE and skips the policy; the emitter returns quietly
-- while send() is absent and works as soon as it appears. The file is idempotent:
-- re-run it once Realtime has initialised to install the policy. Hosted Supabase has
-- Realtime. UNPROVEN on hosted: that the migration role may create a policy on
-- realtime.messages and that private channels are enabled.
--
-- Reserved by OPS for HON-48. Apply needs its own exact-stage approval.
begin;
set local lock_timeout = '5s';

create sequence if not exists public.schedule_signal_failures_seq;
revoke all on sequence public.schedule_signal_failures_seq from public;
revoke all on sequence public.schedule_signal_failures_seq from anon;
revoke all on sequence public.schedule_signal_failures_seq from authenticated;
revoke all on sequence public.schedule_signal_failures_seq from service_role;

-- The only caller of realtime.send. Best effort, and every failure it can OBSERVE becomes a
-- counted WARNING. realtime.send itself swallows an error from its own insert and raises its
-- own 'ErrorSendingBroadcastMessage' WARNING (not counted); what this adds is the check that
-- the emitter's owner can insert at all, i.e. has INSERT on realtime.messages and bypasses RLS
-- (realtime.messages has RLS on and no INSERT policy). If it cannot, nothing could ever be
-- delivered, which is exactly the outage the counter exists to expose.
create or replace function public.schedule_signal_send(p_studio uuid)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_failures bigint;
begin
  if not pg_catalog.has_table_privilege('realtime.messages', 'insert')
     or not exists (
       select 1 from pg_catalog.pg_roles r
        where r.rolname = current_user and (r.rolbypassrls or r.rolsuper)
     ) then
    raise exception 'the emitter role % cannot write to realtime.messages (needs INSERT and BYPASSRLS)', current_user;
  end if;
  -- private => true is explicit and load-bearing: a PUBLIC channel on the same topic name
  -- must never receive this message (the project may have public channel access ON).
  perform realtime.send(
    payload => '{}'::pg_catalog.jsonb,
    event => 'changed',
    topic => 'schedule:' || p_studio::pg_catalog.text,
    private => true
  );
exception when others then
  -- Even the failure report must not fail the caller's write.
  begin
    v_failures := pg_catalog.nextval('public.schedule_signal_failures_seq');
    raise warning 'schedule_signal: send failed (failure % since the sequence began): %', v_failures, sqlerrm;
  exception when others then
    null;
  end;
end;
$$;

-- Transition tables are named new_rows / old_rows by every trigger below. INSERT reads
-- new_rows, DELETE reads old_rows, UPDATE compares the columns named by the trigger
-- arguments between the two and signals only the studios that changed.
create or replace function public.emit_schedule_signal()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_studio uuid;
begin
  if pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    return null;
  end if;
  if tg_op = 'INSERT' then
    for v_studio in select distinct studio_id from new_rows loop
      perform public.schedule_signal_send(v_studio);
    end loop;
  elsif tg_op = 'DELETE' then
    for v_studio in select distinct studio_id from old_rows loop
      perform public.schedule_signal_send(v_studio);
    end loop;
  else
    for v_studio in
      select distinct n.studio_id
        from new_rows n
        join old_rows o on o.id = n.id
       where (select jsonb_agg(to_jsonb(n) -> c order by c) from unnest(tg_argv) as c)
             is distinct from
             (select jsonb_agg(to_jsonb(o) -> c order by c) from unnest(tg_argv) as c)
    loop
      perform public.schedule_signal_send(v_studio);
    end loop;
  end if;
  return null;
end;
$$;

-- Supabase default privileges grant EXECUTE to anon, authenticated and service_role at
-- create time: revoke from all of them by name (CLAUDE.md section 5).
revoke all on function public.schedule_signal_send(uuid) from public;
revoke all on function public.schedule_signal_send(uuid) from anon;
revoke all on function public.schedule_signal_send(uuid) from authenticated;
revoke all on function public.schedule_signal_send(uuid) from service_role;
revoke all on function public.emit_schedule_signal() from public;
revoke all on function public.emit_schedule_signal() from anon;
revoke all on function public.emit_schedule_signal() from authenticated;
revoke all on function public.emit_schedule_signal() from service_role;

drop trigger if exists appointments_schedule_signal_ins_trg on public.appointments;
create trigger appointments_schedule_signal_ins_trg
  after insert on public.appointments
  referencing new table as new_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists appointments_schedule_signal_upd_trg on public.appointments;
create trigger appointments_schedule_signal_upd_trg
  after update on public.appointments
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.emit_schedule_signal('practitioner_id', 'client_id', 'service_id', 'starts_at', 'ends_at', 'duration_minutes', 'status', 'notes', 'blocked_ends_at', 'buffer_minutes_snapshot');

drop trigger if exists appointments_schedule_signal_del_trg on public.appointments;
create trigger appointments_schedule_signal_del_trg
  after delete on public.appointments
  referencing old table as old_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_timed_blocks_schedule_signal_ins_trg on public.studio_timed_blocks;
create trigger studio_timed_blocks_schedule_signal_ins_trg
  after insert on public.studio_timed_blocks
  referencing new table as new_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_timed_blocks_schedule_signal_upd_trg on public.studio_timed_blocks;
create trigger studio_timed_blocks_schedule_signal_upd_trg
  after update on public.studio_timed_blocks
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.emit_schedule_signal('starts_at', 'ends_at', 'category', 'practitioner_id', 'private_note');

drop trigger if exists studio_timed_blocks_schedule_signal_del_trg on public.studio_timed_blocks;
create trigger studio_timed_blocks_schedule_signal_del_trg
  after delete on public.studio_timed_blocks
  referencing old table as old_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_blockouts_schedule_signal_ins_trg on public.studio_blockouts;
create trigger studio_blockouts_schedule_signal_ins_trg
  after insert on public.studio_blockouts
  referencing new table as new_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_blockouts_schedule_signal_upd_trg on public.studio_blockouts;
create trigger studio_blockouts_schedule_signal_upd_trg
  after update on public.studio_blockouts
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.emit_schedule_signal('starts_on', 'ends_on', 'reason');

drop trigger if exists studio_blockouts_schedule_signal_del_trg on public.studio_blockouts;
create trigger studio_blockouts_schedule_signal_del_trg
  after delete on public.studio_blockouts
  referencing old table as old_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_recurring_break_occurrences_schedule_signal_ins_trg on public.studio_recurring_break_occurrences;
create trigger studio_recurring_break_occurrences_schedule_signal_ins_trg
  after insert on public.studio_recurring_break_occurrences
  referencing new table as new_rows
  for each statement execute function public.emit_schedule_signal();

drop trigger if exists studio_recurring_break_occurrences_schedule_signal_upd_trg on public.studio_recurring_break_occurrences;
create trigger studio_recurring_break_occurrences_schedule_signal_upd_trg
  after update on public.studio_recurring_break_occurrences
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.emit_schedule_signal('starts_at', 'ends_at');

drop trigger if exists studio_recurring_break_occurrences_schedule_signal_del_trg on public.studio_recurring_break_occurrences;
create trigger studio_recurring_break_occurrences_schedule_signal_del_trg
  after delete on public.studio_recurring_break_occurrences
  referencing old table as old_rows
  for each statement execute function public.emit_schedule_signal();

do $guard$
begin
  if pg_catalog.to_regprocedure('realtime.send(jsonb,text,text,boolean)') is null then
    raise notice '0271: realtime.send() is absent (Realtime has not initialised); signals are inert until it appears.';
  end if;
  if pg_catalog.to_regclass('realtime.messages') is null
     or pg_catalog.to_regprocedure('realtime.topic()') is null then
    raise notice '0271: realtime.messages / realtime.topic() are absent; the listen policy was NOT created. Re-run this file after Realtime has initialised.';
    return;
  end if;
  execute $p$
    create policy schedule_signal_member_read
      on realtime.messages
      for select
      to authenticated
      using (
        realtime.messages.extension = 'broadcast'
        and case
          when (select realtime.topic()) ~ '^schedule:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
            then public.is_studio_member(substr((select realtime.topic()), 10)::uuid)
          else false
        end
      )
  $p$;
  -- Defence in depth: anon and authenticated hold INSERT on realtime.messages, so the only
  -- thing keeping a browser from publishing a row is that no permissive INSERT policy
  -- exists. A RESTRICTIVE policy keeps that true even if someone later adds a permissive
  -- one (for example in the dashboard). The emitter (postgres, BYPASSRLS) ignores policies.
  execute $p$
    create policy schedule_signal_no_client_insert
      on realtime.messages
      as restrictive
      for insert
      to anon, authenticated
      with check (false)
  $p$;
end;
$guard$;

commit;
