-- 0294: shared FIXED-WINDOW counter for the public limiter's outage fallback (DN-29).
--
-- DRAFT, HELD, PREPARE-ONLY. Never applied without Sam's per-change approval. Reservation: OPS, 0294.
--
-- WHY. When Upstash is unconfigured or down, the public limiters must not fail open (DN-29). The fallback needs a bound that
-- every app instance shares, so it lives in Postgres: lib/rate-limit/outage.ts calls rate_limit_fallback_hit() with the
-- service-role key BEFORE the work runs, so every attempt counts, failures included. Unreachable counter -> the app refuses.
--
-- WHAT.
--   * public.rate_limit_fallback_counters (scope, key_hash, window_start, n): one row per bucket per window. RLS on, no
--     policy, every browser role revoked: only the definer function below touches it.
--   * public.rate_limit_fallback_hit(scope, key_hash, window_seconds, limit) -> jsonb {allowed, count, retry_after_seconds}.
--     An atomic `insert ... on conflict do update set n = n + 1` (the row lock makes concurrent callers count exactly).
--     allowed = (count <= limit). It counts the attempt even when over the limit.
--   * FIXED windows: the bucket is floor(now / window) * window. A burst at the end of one window and the start of the next can
--     admit up to TWICE the limit. This is a bound, not a precise sliding limiter; it is documented here on purpose.
--   * Keys are SHA-256 hashes from the app, HMAC-keyed again by the app under a server-only secret before they get here (never a raw IP, email, token). Expired windows (window END more than an hour
--     ago; an active long window is never deleted) are removed opportunistically (about 1 call in 50, at most 500 rows) so the table
--     cannot grow without bound.
--
--   * Q-F: closes the anonymous DIRECT writes to public.waitlist (landing early access) and public.demo_requests. 0004 and 0006 let
--     anon and authenticated INSERT with `with check (true)`, so anyone holding the public key could post to PostgREST and walk
--     around every limiter. The two policies are dropped and all table privileges are revoked from public, anon and authenticated;
--     service_role keeps only what the application still needs: SELECT on both (the /admin pages) and UPDATE on demo_requests (the
--     admin 'contacted' status). It has NO direct INSERT: the only write path is the 0213 definer commands
--     record_platform_early_access_signup / record_platform_demo_request (service_role EXECUTE), which also raise the lead alert
--     in the same transaction. The app's two actions (app/actions/waitlist.ts, app/actions/demo.ts) call them AFTER the limiter.

-- DEPLOYMENT ORDER (matters): deploy the application BEFORE applying this migration. The new app writes through the 0213 commands,
--   which work with or without this migration; the OLD app inserts with the public key and would be refused the moment the policies drop.
--   Until the migration is applied, an Upstash outage meets no counter and the app REFUSES the bounded classes (fail closed), it
--   does not fail open.
-- ROLLBACK (break-glass, forward fix preferred; the order matters): once this is applied, rolling the app back BELOW the release that carries the 0213-command
--   actions makes every landing/demo submission fail and LOSES the lead (the old app inserts with the public key, which this
--   migration removed). Run supabase/rollbacks/0294_rate_limit_fallback_counter.down.sql FIRST, then roll the app back.
--   See docs/production/0294-rate-limit-fallback-activation-and-rollback.md.

-- GRANTS. service_role ONLY (counter function). Supabase default privileges grant EXECUTE to anon, authenticated and service_role at create
-- time, so all of public, anon, authenticated are revoked by name; service_role is granted explicitly (CLAUDE.md section 5).

begin;
set local lock_timeout = '5s';

create table if not exists public.rate_limit_fallback_counters (
  scope        text        not null check (scope ~ '^[a-z0-9_]{1,40}$'),
  key_hash     text        not null check (char_length(key_hash) between 1 and 200),
  window_start timestamptz not null,
  -- the window LENGTH, so cleanup can tell an expired window from an active long one (Privacy P2)
  window_seconds integer   not null check (window_seconds between 1 and 604800),
  n            integer     not null default 0,
  primary key (scope, key_hash, window_start)
);

create index if not exists rate_limit_fallback_counters_window_idx
  on public.rate_limit_fallback_counters (window_start);

alter table public.rate_limit_fallback_counters enable row level security;
alter table public.rate_limit_fallback_counters force row level security;
revoke all on table public.rate_limit_fallback_counters from public;
revoke all on table public.rate_limit_fallback_counters from anon;
revoke all on table public.rate_limit_fallback_counters from authenticated;

comment on table public.rate_limit_fallback_counters is
  '0294: fixed-window attempt counters for the public limiter outage fallback (DN-29). Written only by rate_limit_fallback_hit(). Holds hashed keys only.';

-- Privacy P2: delete by window END, never by window start. A row is removable only when its whole window
-- (window_start + window_seconds) ended more than an hour ago, so an active long window is never deleted (a 7-day window that
-- started 3 days ago is still counting). Bounded work per call. Internal: called by rate_limit_fallback_hit and by tests as
-- the table owner; no browser or service role may call it directly.
create or replace function public.rate_limit_fallback_cleanup(p_max integer default 500)
returns integer
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_deleted integer;
begin
  with doomed as (
    select ctid as row_id
      from public.rate_limit_fallback_counters
     where window_start < clock_timestamp() - interval '1 hour'
       and window_start + make_interval(secs => window_seconds) < clock_timestamp() - interval '1 hour'
     limit greatest(1, least(coalesce(p_max, 500), 5000))
  )
  delete from public.rate_limit_fallback_counters c
   using doomed
   where c.ctid = doomed.row_id;
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

revoke execute on function public.rate_limit_fallback_cleanup(integer) from public;
revoke execute on function public.rate_limit_fallback_cleanup(integer) from anon;
revoke execute on function public.rate_limit_fallback_cleanup(integer) from authenticated;
revoke execute on function public.rate_limit_fallback_cleanup(integer) from service_role;

create or replace function public.rate_limit_fallback_hit(
  p_scope text,
  p_key_hash text,
  p_window_seconds integer,
  p_limit integer
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_now          timestamptz := clock_timestamp();
  v_window_start timestamptz;
  v_count        integer;
begin
  if p_scope is null or p_scope !~ '^[a-z0-9_]{1,40}$'
     or p_key_hash is null or char_length(p_key_hash) not between 1 and 200
     or p_window_seconds is null or p_window_seconds not between 1 and 604800
     or p_limit is null or p_limit not between 1 and 1000000 then
    raise exception 'invalid rate limit arguments' using errcode = '22023';
  end if;

  v_window_start := to_timestamp(floor(extract(epoch from v_now) / p_window_seconds) * p_window_seconds);

  insert into public.rate_limit_fallback_counters as c (scope, key_hash, window_start, window_seconds, n)
  values (p_scope, p_key_hash, v_window_start, p_window_seconds, 1)
  on conflict (scope, key_hash, window_start) do update set n = c.n + 1
  returning c.n into v_count;

  -- Opportunistic cleanup of EXPIRED windows (bounded work per call).
  if random() < 0.02 then
    perform public.rate_limit_fallback_cleanup(500);
  end if;

  return jsonb_build_object(
    'allowed', v_count <= p_limit,
    'count', v_count,
    'retry_after_seconds',
      greatest(1, ceil(extract(epoch from (v_window_start + make_interval(secs => p_window_seconds) - v_now)))::integer)
  );
end;
$$;

comment on function public.rate_limit_fallback_hit(text, text, integer, integer) is
  '0294: count one attempt in a fixed window and say whether it is within the limit. service_role only.';

revoke execute on function public.rate_limit_fallback_hit(text, text, integer, integer) from public;
revoke execute on function public.rate_limit_fallback_hit(text, text, integer, integer) from anon;
revoke execute on function public.rate_limit_fallback_hit(text, text, integer, integer) from authenticated;
grant execute on function public.rate_limit_fallback_hit(text, text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- Q-F: retire the anonymous direct writes (0004 waitlist, 0006 demo_requests)
-- ---------------------------------------------------------------------------
drop policy if exists "waitlist_anonymous_insert" on public.waitlist;
drop policy if exists "demo_requests_anonymous_insert" on public.demo_requests;

revoke all on table public.waitlist from public;
revoke all on table public.waitlist from anon;
revoke all on table public.waitlist from authenticated;
revoke all on table public.demo_requests from public;
revoke all on table public.demo_requests from anon;
revoke all on table public.demo_requests from authenticated;
revoke all on table public.waitlist from service_role;
revoke all on table public.demo_requests from service_role;
grant select on table public.waitlist to service_role;
grant select, update on table public.demo_requests to service_role;

commit;
