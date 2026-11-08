-- ROLLBACK for 0323 (DRAFT; NOT a migration; never placed in supabase/migrations).
-- Restores the 0204 admission matrix byte for byte (invited_book refused under closed), drops the
-- marker and the counting function. No data is touched. The application treats an absent marker as
-- "rule not applied" and goes back to refusing invitations under Closed, and an absent counting
-- function as "count every live invitation", so this is safe at any time.
begin;
set local lock_timeout = '5s';

drop function if exists public.waitlist_closed_invited_booking_enabled();
drop function if exists public.count_competing_waitlist_invitations(uuid, date, date, integer[]);

-- The 0204 matrix, restored.
create or replace function public.assert_new_client_admission(
  p_studio_id               uuid,
  p_operation               text,
  p_legacy_bridge_waitlist  boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  v_mode text := public.effective_new_client_admission(
    p_studio_id, p_legacy_bridge_waitlist
  );
begin
  -- ONE refusal code for every refused state. `closed` and `unknown` differ in
  -- cause, not consequence, and a distinct answer for `unknown` would publish
  -- that a read failed. It is returned without consulting any credential, so it
  -- cannot be used to probe whether an invitation is valid.
  return case p_operation
    -- Ordinary new-client booking: `open` only.
    when 'book' then
      case when v_mode = 'open' then 'ok' else 'new_client_admission_refused' end
    -- Invitation booking: `waitlist` is the exception the WAIT lifecycle needs,
    -- and `open` is preserved because the ordinary path already permits a
    -- credentialed booking there. No new right is invented: `closed` and
    -- `unknown` refuse even with a valid invitation.
    when 'invited_book' then
      case
        when v_mode in ('open', 'waitlist') then 'ok'
        else 'new_client_admission_refused'
      end
    -- Durable waitlist join: `waitlist` only. `open` has nothing to join.
    when 'join_waitlist' then
      case when v_mode = 'waitlist' then 'ok' else 'new_client_admission_refused' end
    else 'new_client_admission_refused'
  end;
end;
$$;

revoke all on function public.assert_new_client_admission(uuid, text, boolean) from public, anon, authenticated, service_role;

commit;
