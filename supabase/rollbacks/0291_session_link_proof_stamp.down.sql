-- DOWN for the 0291 CODEX-P2 additions (session proof stamp). HELD: 0291 is applied nowhere. NOT a migration: supabase never
-- runs this directory. Run by an operator, once, only if the stamp must be withdrawn after 0291 has been applied.
--
-- WHAT IT DOES: restores public.session_link_proof_is_current() to its pre-CODEX-P2 body (the credential window only, no stamp
-- lookup; byte-for-byte the function at 55cf93031), then drops public.stamp_session_link_proof() and the table
-- public.auth_session_link_proofs. The rest of 0291 (session_proves_mailbox, the two invitation functions, their grants) is untouched.
--
-- EFFECT ON PEOPLE: an account whose address never changed: none. A CHANGED account: its stamped sessions fall back to the window
-- rule, so a later link request on another device can un-prove them again (the Codex P2 behaviour; fail closed, never a wrong
-- proof). The app's /auth/callback calls stamp_session_link_proof; after this down that call errors, which the app treats as
-- "not proven" (databaseLinkProof), so a changed account's sign-in at the callback is unproven until the page-level check proves it.
--
-- DATA-LOSS REFUSAL: the stamps are derived proof records, but dropping them changes who is proven, so this file REFUSES while any
-- stamp row exists unless the operator opts in, in the SAME transaction, with:
--     set local hone.rollback_0291_discard_stamps = 'discard';
-- (put that line right after `begin;` below). The refusal raises before anything is changed; the whole file is one transaction.
begin;
set local lock_timeout = '5s';

do $$
declare
  v_rows bigint;
begin
  if to_regclass('public.auth_session_link_proofs') is not null then
    execute 'select count(*) from public.auth_session_link_proofs' into v_rows;
    if v_rows > 0 and coalesce(current_setting('hone.rollback_0291_discard_stamps', true), '') <> 'discard' then
      raise exception '0291 stamp rollback refused: % session proof stamp row(s) exist; set local hone.rollback_0291_discard_stamps = ''discard'' in this transaction to drop them', v_rows
        using errcode = 'P0001';
    end if;
  end if;
end $$;

-- 1. The link check stops reading the table (pre-CODEX-P2 body).
create or replace function public.session_link_proof_is_current()
returns boolean
language plpgsql stable security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_uid uuid := auth.uid();
  v_sent timestamptz;
  v_recovery timestamptz;
  v_confirmation timestamptz;
  v_changed boolean;
  v_last_update timestamptz;
  v_anchor timestamptz;
  v_session_id text := auth.jwt() ->> 'session_id';
  v_session_created timestamptz;
begin
  if v_uid is null then
    return false;
  end if;
  select u.email_change_sent_at, u.recovery_sent_at, u.confirmation_sent_at
    into v_sent, v_recovery, v_confirmation
    from auth.users u
   where u.id = v_uid;
  if not found then
    return false;
  end if;
  -- changed = some email identity was updated after it was created, or cannot be read.
  select coalesce(bool_or(i.created_at is null or i.updated_at is null or i.updated_at <> i.created_at), false),
         max(i.updated_at)
    into v_changed, v_last_update
    from auth.identities i
   where i.user_id = v_uid and i.provider = 'email';

  -- AW1(b) (Privacy): a NEVER-CHANGED account is decided from auth.users and auth.identities ONLY. PL/pgSQL plans and
  -- permission-checks each statement when it first runs, so the auth.sessions read below is never reached for these accounts:
  -- if the owner could not read auth.sessions on hosted, only CHANGED accounts would be refused (fail closed), never everyone.
  if v_sent is null and not v_changed then
    return true;
  end if;

  -- CHANGED: the JWT's session must exist for the caller, and a sign-in credential must have been issued strictly after the last
  -- change activity and strictly before that session was created (microseconds). The uuid cast runs only on a well-formed id.
  if v_session_id is null
     or v_session_id !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' then
    return false;
  end if;
  select s.created_at into v_session_created
    from auth.sessions s
   where s.id = v_session_id::uuid and s.user_id = v_uid;
  if not found then
    return false;
  end if;
  v_anchor := greatest(v_sent, v_last_update);
  return coalesce(
    (v_recovery > v_anchor and v_recovery < v_session_created)
    or (v_confirmation > v_anchor and v_confirmation < v_session_created),
    false);
end;
$$;

comment on function public.session_link_proof_is_current() is
  '0291 S-2b: true when the account address never changed (decided without reading auth.sessions), or when the caller''s JWT session still exists and a sign-in credential (recovery_sent_at, confirmation_sent_at) was issued strictly after the last email-change activity and strictly before the session was created (microseconds). Callable by authenticated only; reads only the caller''s own rows.';

-- create or replace keeps the grants; restated so the end state is explicit.
revoke execute on function public.session_link_proof_is_current() from public;
revoke execute on function public.session_link_proof_is_current() from anon;
revoke execute on function public.session_link_proof_is_current() from authenticated;
revoke execute on function public.session_link_proof_is_current() from service_role;
grant execute on function public.session_link_proof_is_current() to authenticated;

-- 2. The recorder, then the table.
drop function if exists public.stamp_session_link_proof();
drop table if exists public.auth_session_link_proofs;

commit;
