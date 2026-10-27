-- REHEARSAL - NEVER MERGE. STUB objects standing in for the optional production features the PRE-RESTORE check looks for.
-- Synthetic: three cron jobs, two queued pg_net requests, one database webhook record, two vault secrets. No real URL, no real secret.
create schema cron;
create table cron.job (jobid serial primary key, schedule text, command text, active boolean not null default true);
insert into cron.job (schedule, command, active) values
  ('0 * * * *', 'select 1', true),
  ('*/5 * * * *', 'select net.http_post(url := ''https://example.invalid/hook'')', true),
  ('0 0 * * *', 'select functions.rehearsal()', false);
create schema net;
create table net.http_request_queue (id serial primary key, url text);
create table net._http_response (id serial primary key, status_code int);
insert into net.http_request_queue (url) values ('https://example.invalid/a'), ('https://example.invalid/b');
insert into net._http_response (status_code) values (200);
create schema supabase_functions;
create table supabase_functions.hooks (id serial primary key, hook_name text);
insert into supabase_functions.hooks (hook_name) values ('rehearsal_hook');
create schema vault;
create table vault.secrets (id uuid primary key default gen_random_uuid(), name text);
insert into vault.secrets (name) values ('rehearsal-secret-1'), ('rehearsal-secret-2');
