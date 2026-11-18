-- ROLLBACK for 0323 (DRAFT; NOT a migration; never placed in supabase/migrations).
-- Restores the 0204 admission matrix byte for byte (invited_book refused under closed), drops the
-- marker and the counting function. No table or row is touched. The application treats an absent marker
-- as "rule not applied" and goes back to refusing invitations under Closed, and an absent counting
-- function as "count every live invitation".
--
-- THIS ROLLBACK IS NOT BEHAVIOUR-NEUTRAL WHILE A CLOSED STUDIO HOLDS A LIVE INVITATION. After it,
-- that invitation's link is refused again:
--   * flag-on path (WAITLIST_BOOKING_COMMAND=1, the launch configuration): the redemption happens
--     inside the booking command, so a refused booking rolls the redemption back and the invitation
--     stays live until it expires (48h). Nobody is stranded, but nobody can book.
--   * legacy flag-off path: the invitation is redeemed first and the booking second, so a booking
--     refused after the redemption can leave a redeemed-but-unbooked invitation.
-- READ-ONLY CHECK to run BEFORE applying this file (it changes nothing; service role or SQL editor):
--
--   select s.id as studio_id, count(*) as live_invitations
--     from public.new_client_waitlist_invitations i
--     join public.studios s on s.id = i.studio_id
--    where s.new_client_admission_mode = 'closed'
--      and i.redeemed_at is null and i.expired_at is null
--      and i.released_at is null and i.declined_at is null
--      and i.expires_at > now()
--    group by s.id;
--
-- CLASS R, a second READ-ONLY query: invitations already REDEEMED whose person is not yet booked
-- (the entry is still `invited`). A legacy-path rollback strands exactly these, because the redemption
-- is not undone when a later booking is refused:
--
--   select s.id as studio_id, count(distinct e.id) as redeemed_unbooked
--     from public.new_client_waitlist_invitations i
--     join public.new_client_waitlist_entries e on e.id = i.entry_id and e.studio_id = i.studio_id
--     join public.studios s on s.id = i.studio_id
--    where s.new_client_admission_mode = 'closed'
--      and i.redeemed_at is not null
--      and e.status = 'invited'
--    group by s.id;
--
-- count(distinct e.id) counts people, not invitations, but it is still an UPPER BOUND: a raw count here can
-- include a person who is handled outside the app, so read each row before acting on the number.
--
-- Zero rows from BOTH queries: the rollback changes nothing anyone can see. Any row: decide first
-- (wait out the 48h lifetime, or ask the owner to release those invitations; for class R, wait for the
-- booking or have the owner close the row without booking); do not roll back over them unannounced.
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
