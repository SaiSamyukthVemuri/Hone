-- REHEARSAL - NEVER MERGE. STUB objects for the S0B-FIXES coverage: a foreign server, a publication, a subscription (never connects), a
-- non-platform event trigger, a trigger function whose source calls net.http_post and a trigger that runs it. Synthetic names; no real URL.
create foreign data wrapper rh_fdw;
create server rh_srv foreign data wrapper rh_fdw;
create publication rh_pub for table public.studios;
create subscription rh_sub connection 'host=127.0.0.1 port=1 dbname=none' publication rh_pub with (connect = false);
create function public.rh_evt() returns event_trigger language plpgsql as $f$ begin null; end $f$;
create event trigger rh_evt on ddl_command_end execute function public.rh_evt();
create function public.rh_callout_trg() returns trigger language plpgsql as $f$ begin perform net.http_post(url := 'https://example.invalid/x'); return new; end $f$;
create trigger rh_trg after insert on public.studios for each row execute function public.rh_callout_trg();
