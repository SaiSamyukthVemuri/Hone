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
--   * Keys are already SHA-256 hashes from the app (never a raw IP, email, token). Rows older than two days are deleted
--     opportunistically (about 1 call in 50, at most 500 rows) so the table cannot grow without bound.
--
-- GRANTS. service_role ONLY. Supabase default privileges grant EXECUTE to anon, authenticated and service_role at create
-- time, so all of public, anon, authenticated are revoked by name; service_role is granted explicitly (CLAUDE.md section 5).

begin;
set local lock_timeout = '5s';

create table if not exists public.rate_limit_fallback_counters (
  scope        text        not null check (scope ~ '^[a-z0-9_]{1,40}$'),
  key_hash     text        not null check (char_length(key_hash) between 1 and 200),
  window_start timestamptz not null,
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

  insert into public.rate_limit_fallback_counters as c (scope, key_hash, window_start, n)
  values (p_scope, p_key_hash, v_window_start, 1)
  on conflict (scope, key_hash, window_start) do update set n = c.n + 1
  returning c.n into v_count;

  -- Opportunistic cleanup of long-expired windows (bounded work per call).
  if random() < 0.02 then
    delete from public.rate_limit_fallback_counters
     where ctid in (
       select ctid from public.rate_limit_fallback_counters
        where window_start < v_now - interval '2 days'
        limit 500
     );
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

commit;
