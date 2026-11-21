-- One live appointment per client, service and exact start.
-- A repeat or double submit of one booking must never become a second appointment, whichever path wrote it and however the requests interleave.
-- Today the only guard is per practitioner, so a booking asked for with no practitioner named can be given to a second free practitioner: one client,
-- one service, one start, two appointments. This is the one rule that closes it for every writer, in the database, with no change to any command.
-- Nothing else is touched. No function, grant, policy or row changes.
begin;
set local lock_timeout = '5s';

-- Refuse with a plain count (not a raw constraint error) if the rule is already broken by existing rows, so the apply says what to fix.
do $$
declare v_groups integer;
begin
  select count(*)::integer into v_groups
    from (
      select 1
        from public.appointments a
       where a.status = 'confirmed' and a.service_id is not null
       group by a.client_id, a.service_id, a.starts_at
      having count(*) > 1
    ) d;
  if v_groups > 0 then
    raise exception 'appointments_one_live_per_client_service_start: % existing group(s) of live appointments share one client, service and start; resolve them first', v_groups;
  end if;
end
$$;

-- LIVE means confirmed: a cancelled, completed or no-show appointment is history, so booking the same time again after a cancellation is an ordinary new
-- booking. A row with no service is outside the rule (a null never equals a null). The key carries the service on purpose: one client may legitimately
-- hold two different services at the same start; only the same service at the same start is a repeat.
create unique index appointments_one_live_per_client_service_start
  on public.appointments (client_id, service_id, starts_at)
  where status = 'confirmed' and service_id is not null;

comment on index public.appointments_one_live_per_client_service_start is
  'One live (confirmed) appointment per client, service and exact start. A repeat or double submit raises a unique violation on this index; the application answers it as the booking that already exists.';

commit;
