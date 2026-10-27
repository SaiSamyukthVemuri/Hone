-- REHEARSAL - NEVER MERGE. Synthetic rows only (random hashes and counters; no real data) for the S0B rehearsal.
-- psql variables: :phase = pre | post, :t = the recovery timestamp T (UTC literal).
-- Runs as the superuser with session_replication_role = replica (no triggers, no foreign-key checks): the rows exist to be COUNTED, not to be valid
-- bookings. Required columns are filled by type; the key columns and timestamps are set explicitly. updated_at is set equal to created_at.
set session_replication_role = replica;
set rh.t = :'t';
set rh.phase = :'phase';

-- the rehearsal inserts bypass checks the same way: drop every CHECK / EXCLUDE constraint on the eight tables, BEFORE the first insert, in both phases
-- (a no-op in the post phase). The same happens before the dump, so production and the restored copy still carry the same catalog.
do $d$
declare r record;
begin
  for r in select c.conrelid::regclass as tbl, c.conname from pg_constraint c
           where c.contype in ('c', 'x') and c.conrelid in ('public.studios'::regclass, 'public.clients'::regclass, 'public.appointments'::regclass, 'public.sessions'::regclass,
             'public.client_consent_signatures'::regclass, 'public.client_intake_forms'::regclass, 'public.payment_charge_attempts'::regclass, 'public.appointment_payments'::regclass)
  loop execute format('alter table %s drop constraint %I', r.tbl, r.conname); end loop;
end $d$;

do $d$
declare
  t timestamptz := current_setting('rh.t')::timestamptz;
  phase text := current_setting('rh.phase');
  o int; k int; ts timestamptz; sid uuid; cid uuid; aid uuid; first_aid uuid;
  nst int := case when phase = 'pre' then 3 else 4 end;
  lo int := case when phase = 'pre' then 1 else 1 end;
  n_clients int; n_appts int; n_sess int;
begin
  for o in lo..nst loop
    -- pre: studios 1..3 exist at T. post: studio 4 is created after T; studios 1..2 receive rows after T.
    if phase = 'pre' then ts := t - make_interval(days => 10 - o); sid := md5('studio' || o)::uuid;
    else
      continue when o = 3;
      ts := t + interval '10 minutes'; sid := md5('studio' || o)::uuid;
    end if;
    if phase = 'pre' or o = 4 then
      perform pg_temp.rh_ins('public.studios', jsonb_build_object('id', sid, 'created_at', ts, 'updated_at', ts));
    end if;
    n_clients := case when phase = 'pre' then 2 + o else 1 end;
    n_appts := case when phase = 'pre' then 2 + o else 1 end;
    n_sess := case when phase = 'pre' then o else 1 end;
    for k in 1..n_clients loop
      cid := md5(phase || 'client' || o || '-' || k)::uuid;
      perform pg_temp.rh_ins('public.clients', jsonb_build_object('id', cid, 'studio_id', sid, 'created_at', ts + make_interval(mins => k), 'updated_at', ts + make_interval(mins => k)));
    end loop;
    cid := md5(phase || 'client' || o || '-1')::uuid;
    for k in 1..n_appts loop
      aid := md5(phase || 'appt' || o || '-' || k)::uuid;
      if k = 1 then first_aid := aid; end if;
      perform pg_temp.rh_ins('public.appointments', jsonb_build_object('id', aid, 'studio_id', sid, 'client_id', cid, 'created_at', ts + make_interval(mins => k), 'updated_at', ts + make_interval(mins => k)));
    end loop;
    for k in 1..n_sess loop
      perform pg_temp.rh_ins('public.sessions', jsonb_build_object('id', md5(phase || 'sess' || o || '-' || k)::uuid, 'studio_id', sid, 'client_id', cid, 'created_at', ts + make_interval(mins => k)));
    end loop;
    perform pg_temp.rh_ins('public.client_consent_signatures', jsonb_build_object('studio_id', sid, 'client_id', cid, 'created_at', ts + interval '1 minute'));
    perform pg_temp.rh_ins('public.client_intake_forms', jsonb_build_object('studio_id', sid, 'client_id', cid, 'created_at', ts + interval '1 minute', 'updated_at', ts + interval '1 minute'));
    perform pg_temp.rh_ins('public.payment_charge_attempts', jsonb_build_object('id', md5(phase || 'charge' || o)::uuid, 'studio_id', sid, 'client_id', cid, 'appointment_id', first_aid, 'created_at', ts + interval '2 minutes', 'updated_at', ts + interval '2 minutes'));
    perform pg_temp.rh_ins('public.appointment_payments', jsonb_build_object('appointment_id', first_aid, 'studio_id', sid, 'client_id', cid, 'created_at', ts + interval '2 minutes', 'updated_at', ts + interval '2 minutes'));
  end loop;
  -- storage object metadata (synthetic bucket names)
  if phase = 'pre' then
    insert into storage.buckets (id, name) values ('rehearsal-a', 'rehearsal-a'), ('rehearsal-b', 'rehearsal-b');
    for k in 1..3 loop insert into storage.objects (bucket_id, name, metadata, created_at) values ('rehearsal-a', md5('o' || k), jsonb_build_object('size', 100), t - interval '1 day'); end loop;
    insert into storage.objects (bucket_id, name, metadata, created_at) values ('rehearsal-b', md5('ob'), jsonb_build_object('size', 7), t - interval '2 days');
  else
    insert into storage.objects (bucket_id, name, metadata, created_at) values ('rehearsal-a', md5('late1'), jsonb_build_object('size', 100), t + interval '10 minutes'), ('rehearsal-a', md5('late2'), jsonb_build_object('size', 100), t + interval '11 minutes');
  end if;
end $d$;
