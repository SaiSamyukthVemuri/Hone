-- 0292: Custom Access Token hook that DENIES every token issued through a PASSWORD.
--
-- DRAFT, HELD, PREPARE-ONLY. Never applied without Sam's per-change approval. Reservation: OPS, 0292.
--
-- WHY. Hone is passwordless by design (Google and magic link only; the app never sets a password), yet Supabase's email provider
-- keeps the GoTrue password endpoints open (/signup with a password, /token?grant_type=password). Anyone can pre-register a
-- victim's address with a password (an account the real owner later signs into by link, with the attacker's password still
-- working). Blocking the password route removes that class without modifying a single account.
--
-- WHAT. public.custom_access_token_hook(event jsonb) runs for every token GoTrue is about to issue and receives
-- `authentication_method`. It returns an error (token refused, HTTP 403) for:
--   * authentication_method = 'password'  (a password sign-in never yields a token), and
--   * authentication_method = 'token_refresh' when the session's own `amr` contains a password entry (a password-origin
--     session dies at its next refresh, within the access-token lifetime).
-- It allows exactly: otp, magiclink, recovery, oauth (the proof set measured on real GoTrue, plus oauth), and a token_refresh of a session with no password
-- origin. Any other / unknown method is refused (fail closed). It changes no row and reads no table.
--
-- NOT ENABLED BY THIS FILE. The hook must also be switched on in the auth config (hosted: Authentication > Hooks, Custom Access
-- Token, Postgres function public.custom_access_token_hook; local: [auth.hook.custom_access_token]). That is a separate,
-- separately approved configuration change. Until then this function is inert.
--
-- GRANTS. Supabase docs: supabase_auth_admin executes it; anon, authenticated and PUBLIC may not. service_role is revoked by
-- name too (default privileges grant EXECUTE to it at create time; CLAUDE.md section 5).

begin;
set local lock_timeout = '5s';

create or replace function public.custom_access_token_hook(event jsonb)
returns jsonb
language plpgsql
stable
set search_path = ''
as $$
declare
  method text := coalesce(event ->> 'authentication_method', '');
  password_origin boolean;
begin
  -- A session created by password carries a `password` amr entry in the claims GoTrue is about to re-sign.
  password_origin := exists (
    select 1
      from jsonb_array_elements(
             case when jsonb_typeof(event -> 'claims' -> 'amr') = 'array' then event -> 'claims' -> 'amr' else '[]'::jsonb end
           ) as a
     where a ->> 'method' = 'password'
  );

  if method = 'token_refresh' then
    if password_origin then
      return jsonb_build_object('error', jsonb_build_object(
        'http_code', 403,
        'message', 'Password sign-in is not available. Sign in with an email link or Google.'));
    end if;
    return jsonb_build_object('claims', event -> 'claims');
  end if;

  if method in ('otp', 'magiclink', 'recovery', 'oauth') then
    return jsonb_build_object('claims', event -> 'claims');
  end if;

  -- 'password', 'email/signup' (a PKCE password sign-up confirmation, which Hone never uses), 'invite' (measured as otp, never as
  -- invite) and every unknown method: refused. The list equals the app's proof set plus oauth (tests/migrations parity guard).
  return jsonb_build_object('error', jsonb_build_object(
    'http_code', 403,
    'message', 'Password sign-in is not available. Sign in with an email link or Google.'));
end;
$$;

comment on function public.custom_access_token_hook(jsonb) is
  '0292: Custom Access Token hook. Refuses tokens issued by password (and refresh of password-origin sessions). Inert until enabled in the auth config.';

grant usage on schema public to supabase_auth_admin;
grant execute on function public.custom_access_token_hook(jsonb) to supabase_auth_admin;
revoke execute on function public.custom_access_token_hook(jsonb) from public;
revoke execute on function public.custom_access_token_hook(jsonb) from anon;
revoke execute on function public.custom_access_token_hook(jsonb) from authenticated;
revoke execute on function public.custom_access_token_hook(jsonb) from service_role;

commit;
