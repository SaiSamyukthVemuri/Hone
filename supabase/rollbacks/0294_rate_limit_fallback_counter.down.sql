-- DOWN step for 0294 (HELD). NOT a migration: it lives outside supabase/migrations so no tool applies it automatically.
-- Run it FIRST, and only then roll the application back below the release that carries the 0213-command waitlist/demo actions
-- (docs/production/0294-rate-limit-fallback-activation-and-rollback.md). Reversed order loses leads: the old app inserts with the
-- public key, which 0294 removed.
-- Restores the 0004/0006 state exactly: both anonymous insert policies, and the Supabase default table privileges on the two tables
-- (anon, authenticated, service_role hold ALL; row level security still limits anon/authenticated to the INSERT policy). Then
-- removes the counter objects. Idempotent. Applies in one transaction.
begin;
set local lock_timeout = '5s';

grant all on table public.waitlist to anon, authenticated, service_role;
grant all on table public.demo_requests to anon, authenticated, service_role;

drop policy if exists "waitlist_anonymous_insert" on public.waitlist;
create policy "waitlist_anonymous_insert" on public.waitlist for insert to anon, authenticated with check (true);
drop policy if exists "demo_requests_anonymous_insert" on public.demo_requests;
create policy "demo_requests_anonymous_insert" on public.demo_requests for insert to anon, authenticated with check (true);

drop function if exists public.rate_limit_fallback_hit(text, text, integer, integer);
drop function if exists public.rate_limit_fallback_cleanup(integer);
drop table if exists public.rate_limit_fallback_counters;

commit;
