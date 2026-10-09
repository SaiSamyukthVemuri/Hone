-- 0207 — SMS-01 invitation claim: claimers of one invitation run one at a time.
--
-- WHAT THIS CHANGES. One function, redefined in place:
-- public.claim_waitlist_invitation_sms(uuid, uuid), created by 0206 (applied
-- 2026-10-09). Same signature, same return table, same body, except the
-- invitation row lock: FOR SHARE becomes FOR NO KEY UPDATE.
--
-- WHY (Codex P2 4225516723 on #812). FOR SHARE is a shared lock, so two
-- claims of one live invitation could both pass the liveness and clock check.
-- The second then waited at the per-invitation unique index on the first's
-- uncommitted row. If the first rolled back after expires_at, the second's
-- insert went ahead without re-deciding and returned 'claimed' for an expired
-- invitation, so SMS-01 could text a dead link.
--
-- THE CONTRACT (architecture review under Roadmap v1.25's convergence rule,
-- docs: handoff SMS_01_INVITATION_CLAIM_CONCURRENCY_REVIEW_2026-10-09):
--   C1 decision and effect are one critical section per invitation;
--   C2 claimers and lifecycle commands serialize on the invitation row;
--   C3 a refused claim writes nothing;
--   C4 at most one ledger row per invitation (unique index, unchanged);
--   C5 the clock is read inside the critical section.
-- Every insert of a waitlist-invitation ledger row goes through this one
-- function (the table is revoked from every role), so with the row lock
-- exclusive the unique index can no longer make a lock-holder wait.
--
-- NOT HERE. 0206 is applied and stays byte-identical; this is the forward
-- correction. No table, column, index, constraint or trigger changes, no
-- data is written, and no other function is touched. The revokes and the
-- service_role grant are re-asserted by name, and the catalog comment, which
-- still says FOR SHARE, is corrected.

begin;
set local lock_timeout = '5s';

create or replace function public.claim_waitlist_invitation_sms(
  p_studio_id     uuid,
  p_invitation_id uuid
) returns table (
  result             text,
  message_id         uuid,
  phone              text,
  sms_consent_at     timestamptz,
  sms_opted_out_at   timestamptz,
  mobile_verified_at timestamptz,
  expires_at         timestamptz
)
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv     record;
  v_entry   record;
  v_enabled boolean;
  v_id      uuid;
begin
  if p_studio_id is null or p_invitation_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- FOR NO KEY UPDATE, held to commit (0207). Exclusive among claimers AND
  -- lifecycle commands (redeem, decline, release, expire, close all UPDATE
  -- this row): a mid-flight one is waited for and then seen, and one that
  -- arrives later waits for this claim. Claimers of one invitation run one at
  -- a time, so liveness and the clock below are decided while holding the
  -- only right to insert this invitation's row -- nothing can wait between
  -- that decision and the insert. 0206's FOR SHARE let two claimers decide at
  -- once; the second then waited at the unique index and, if the first rolled
  -- back after expiry, inserted without re-deciding. KEY SHARE (foreign-key
  -- checks) is not blocked.
  select i.id, i.entry_id, i.expires_at, i.redeemed_at, i.expired_at,
         i.released_at, i.declined_at, i.closed_at
    into v_inv
    from public.new_client_waitlist_invitations i
   where i.id = p_invitation_id
     and i.studio_id = p_studio_id
     for no key update;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- The 0192 liveness predicate, plus 0201's closed_at, plus the clock: an
  -- invitation that has lapsed but not yet been swept is not live either.
  if v_inv.redeemed_at is not null or v_inv.expired_at is not null
     or v_inv.released_at is not null or v_inv.declined_at is not null
     or v_inv.closed_at is not null
     or v_inv.expires_at <= clock_timestamp() then
    return query select 'not_live'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select s.send_waitlist_invitation_sms into v_enabled
    from public.studios s
   where s.id = p_studio_id;

  if v_enabled is distinct from true then
    return query select 'studio_disabled'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  select e.phone, e.sms_consent_at, e.sms_opted_out_at, e.mobile_verified_at
    into v_entry
    from public.new_client_waitlist_entries e
   where e.id = v_inv.entry_id
     and e.studio_id = p_studio_id;

  if not found then
    return query select 'not_found'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.sms_outbound_messages (studio_id, purpose, waitlist_invitation_id)
  values (p_studio_id, 'waitlist_invitation', p_invitation_id)
  on conflict (waitlist_invitation_id) where waitlist_invitation_id is not null
  do nothing
  returning id into v_id;

  if v_id is null then
    return query select 'already_claimed'::text, null::uuid, null::text,
      null::timestamptz, null::timestamptz, null::timestamptz, null::timestamptz;
    return;
  end if;

  return query select 'claimed'::text, v_id, v_entry.phone,
    v_entry.sms_consent_at, v_entry.sms_opted_out_at,
    v_entry.mobile_verified_at, v_inv.expires_at;
end;
$$;

revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from public;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from anon;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from authenticated;
revoke execute on function public.claim_waitlist_invitation_sms(uuid, uuid) from service_role;
grant execute on function public.claim_waitlist_invitation_sms(uuid, uuid) to service_role;

comment on function public.claim_waitlist_invitation_sms(uuid, uuid) is
  'The once-per-invitation SMS claim (SMS-01). Holds the invitation row FOR NO KEY UPDATE to commit (0207): claimers of one invitation run one at a time and lifecycle commands are waited for or wait, so liveness and the clock are decided while holding the only right to insert this invitation''s row. Checks tenancy, invitation liveness and the studio switch, and returns the prospect''s phone, consent, opt-out and verification fields for the application''s prospectMayReceiveSms decision. Returns claimed | already_claimed | not_found | not_live | studio_disabled | invalid_input; only claimed writes a row. service_role only.';

commit;
