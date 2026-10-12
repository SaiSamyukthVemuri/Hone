-- ===========================================================================
-- 0226 — SMS-SENDER-CONTROL-01 (#824, #863): LET AN OWNER CHOOSE AGAIN AFTER A
-- DEFINITIVE PRE-PURCHASE FAILURE
-- ===========================================================================
--
-- 0191 makes a sender claim's number write-once, and `error` may only retry
-- (the SAME number) or release; it may never return to `off`, because "reset
-- and start over" is the gesture that abandons a possibly-purchased number
-- and buys a second one. But 0191 ships no release command, so a claim that
-- failed BEFORE anything was bought -- the chosen number was taken by someone
-- else between search and claim, or an adoption was refused -- wedges the
-- studio's setup for good (Codex P2 4251989009).
--
-- This migration adds that release, for exactly the claims that provably own
-- nothing, and nothing else:
--
--   1. get_releasable_studio_sms_claim(studio, actor) -- read: the studio's
--      live claim and its key, IF it is releasable. The caller then asks the
--      PROVIDER what exists under that key (a read): the database alone cannot
--      prove nothing was bought, because a purchase whose answer was lost is
--      recorded nowhere here until reconciled.
--   2. release_unpurchased_studio_sms_claim(studio, actor, sender, key) --
--      compare-and-set on that sender and key, every condition re-checked under
--      the row lock, then `error` -> `releasing` -> `released` through 0191's
--      own transition guard. The released row stays as history; the next claim
--      opens a new row with a new key.
--   3. studio_sms_resource_recorded(studio, number, service) -- whether any
--      sender row other than this studio's CURRENT LIVE attempt records this
--      number (as its number in any state, or as a live claim) or this
--      Messaging Service. Released history counts: 0191's unique indexes cover
--      it. Asking first gives a precise refusal before a write-once claim.
--      Existence only.
--   4. A unique index on the CLAIMED number across live rows: the atomic
--      reservation (Codex P2 4252928398). Two studios racing for one number
--      can both pass a read; only one can hold the claim. 0191's claim insert
--      is `on conflict do nothing`, so the loser gets `not_claimable` BEFORE
--      any provider work. Production holds no sender rows, so the index
--      builds against an empty table.
--
-- RELEASABLE means ALL of:
--   * the actor is an active OWNER of the studio (derived here, never trusted);
--   * the row is the studio's live sender and is in `error`;
--   * it records NO provider resource: phone_number, phone_number_sid,
--     messaging_service_sid and provisioned_at are all null;
--   * its last error is a DEFINITIVE pre-purchase refusal:
--       number_no_longer_available  -- the availability re-check said no,
--                                      before any purchase was attempted;
--       provider_resource_mismatch  -- an adoption refusal (adoption never
--                                      buys) or a provider answer about a
--                                      different resource;
--       finalize_conflict           -- 0191's uniqueness refused recording a
--                                      resource another row already holds.
--                                      Releasable ONLY because the provider
--                                      check below must also find nothing
--                                      under the claim key: a provisioning
--                                      attempt that bought a number always
--                                      leaves it there, and is refused.
--     Any timeout, network or unavailable code is NOT definitive: the attempt
--     may own something, and only a retry (which reconciles first) may proceed.
--
-- NUMBERING: 0226, allocated after a fresh census on 2026-10-12 (recorded in
-- /home/sam/hone-migration-coordination.md). Applies after 0225.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- 1. Is the studio's live claim releasable?
-- ---------------------------------------------------------------------------
create or replace function public.get_releasable_studio_sms_claim(
  p_studio_id     uuid,
  p_actor_user_id uuid
) returns table (result text, sender_id uuid, claim_key text, claimed_phone_number text)
language plpgsql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_role text;
  v_row  public.studio_sms_senders%rowtype;
begin
  if p_studio_id is null or p_actor_user_id is null then
    return query select 'invalid_input'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select p.role into v_role
    from public.practitioners p
   where p.studio_id = p_studio_id and p.user_id = p_actor_user_id and p.active = true
   limit 1;
  if v_role is null then
    return query select 'not_a_member'::text, null::uuid, null::text, null::text;
    return;
  end if;
  if v_role <> 'owner' then
    return query select 'not_owner'::text, null::uuid, null::text, null::text;
    return;
  end if;

  select * into v_row
    from public.studio_sms_senders s
   where s.studio_id = p_studio_id and s.status <> 'released';
  if v_row.id is null then
    return query select 'no_live_sender'::text, null::uuid, null::text, null::text;
    return;
  end if;

  if v_row.status <> 'error'
     or v_row.phone_number is not null
     or v_row.phone_number_sid is not null
     or v_row.messaging_service_sid is not null
     or v_row.provisioned_at is not null
     or v_row.provisioning_claim_key is null
     or coalesce(v_row.last_error_code, '') not in ('number_no_longer_available', 'provider_resource_mismatch', 'finalize_conflict') then
    return query select 'not_releasable'::text, v_row.id, null::text, v_row.claimed_phone_number;
    return;
  end if;

  return query select 'releasable'::text, v_row.id, v_row.provisioning_claim_key, v_row.claimed_phone_number;
end;
$$;

-- ---------------------------------------------------------------------------
-- 2. Release it: compare-and-set, every condition re-checked under the lock
-- ---------------------------------------------------------------------------
create or replace function public.release_unpurchased_studio_sms_claim(
  p_studio_id          uuid,
  p_actor_user_id      uuid,
  p_expected_sender_id uuid,
  p_claim_key          text
) returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
set lock_timeout = '5s'
as $$
declare
  v_role text;
  v_row  public.studio_sms_senders%rowtype;
begin
  if p_studio_id is null or p_actor_user_id is null
     or p_expected_sender_id is null or p_claim_key is null then
    return 'invalid_input';
  end if;

  select p.role into v_role
    from public.practitioners p
   where p.studio_id = p_studio_id and p.user_id = p_actor_user_id and p.active = true
   limit 1;
  if v_role is null then
    return 'not_a_member';
  end if;
  if v_role <> 'owner' then
    return 'not_owner';
  end if;

  select * into v_row
    from public.studio_sms_senders s
   where s.studio_id = p_studio_id and s.status <> 'released'
   for update;
  if v_row.id is null then
    return 'no_live_sender';
  end if;
  -- COMPARE-AND-SET: the claim the provider was asked about, and no other.
  if v_row.id <> p_expected_sender_id
     or v_row.provisioning_claim_key is distinct from p_claim_key then
    return 'sender_changed';
  end if;
  if v_row.status <> 'error'
     or v_row.phone_number is not null
     or v_row.phone_number_sid is not null
     or v_row.messaging_service_sid is not null
     or v_row.provisioned_at is not null
     or coalesce(v_row.last_error_code, '') not in ('number_no_longer_available', 'provider_resource_mismatch', 'finalize_conflict') then
    return 'not_releasable';
  end if;

  -- Through 0191's own transition guard: error -> releasing -> released.
  update public.studio_sms_senders set status = 'releasing' where id = v_row.id;
  update public.studio_sms_senders
     set status = 'released', released_at = now()
   where id = v_row.id;
  return 'released';
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Is this number or Messaging Service already recorded anywhere?
-- ---------------------------------------------------------------------------
create or replace function public.studio_sms_resource_recorded(
  p_studio_id             uuid,
  p_phone_number          text,
  p_messaging_service_sid text
) returns boolean
language sql
stable
security definer
set search_path = pg_catalog, pg_temp
as $$
  select exists (
    select 1
      from public.studio_sms_senders s
     -- Every row EXCEPT this studio's current live attempt (its own retry).
     -- This studio's RELEASED history still holds 0191's uniqueness on the
     -- number and the service, so it counts (Codex P2 4252928388).
     where not (s.studio_id = p_studio_id and s.status <> 'released')
       and (
           (p_phone_number is not null and s.phone_number = p_phone_number)
        -- A LIVE claim on the number (released history does not hold it).
        or (p_phone_number is not null and s.claimed_phone_number = p_phone_number and s.status <> 'released')
        or (p_messaging_service_sid is not null and s.messaging_service_sid = p_messaging_service_sid)
       )
  );
$$;

-- ---------------------------------------------------------------------------
-- 4. The atomic reservation: one LIVE claim per number, across all studios
-- ---------------------------------------------------------------------------
create unique index studio_sms_senders_live_claimed_number_unique
  on public.studio_sms_senders (claimed_phone_number)
  where claimed_phone_number is not null and status <> 'released';

-- ---------------------------------------------------------------------------
-- Privileges: service_role only
-- ---------------------------------------------------------------------------
revoke execute on function public.get_releasable_studio_sms_claim(uuid, uuid) from public;
revoke execute on function public.get_releasable_studio_sms_claim(uuid, uuid) from anon;
revoke execute on function public.get_releasable_studio_sms_claim(uuid, uuid) from authenticated;
revoke execute on function public.get_releasable_studio_sms_claim(uuid, uuid) from service_role;
grant execute on function public.get_releasable_studio_sms_claim(uuid, uuid) to service_role;

revoke execute on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) from public;
revoke execute on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) from anon;
revoke execute on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) from authenticated;
revoke execute on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) from service_role;
grant execute on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) to service_role;

revoke execute on function public.studio_sms_resource_recorded(uuid, text, text) from public;
revoke execute on function public.studio_sms_resource_recorded(uuid, text, text) from anon;
revoke execute on function public.studio_sms_resource_recorded(uuid, text, text) from authenticated;
revoke execute on function public.studio_sms_resource_recorded(uuid, text, text) from service_role;
grant execute on function public.studio_sms_resource_recorded(uuid, text, text) to service_role;

comment on function public.get_releasable_studio_sms_claim(uuid, uuid) is
  'SMS-SENDER-CONTROL-01 (0226): the studio''s live sender claim and its key IF it is releasable (owner actor; error; no recorded number, SID, service or provisioned_at; last error number_no_longer_available or provider_resource_mismatch). The caller must confirm with the provider that nothing exists under the key before releasing. service_role only.';
comment on function public.release_unpurchased_studio_sms_claim(uuid, uuid, uuid, text) is
  'SMS-SENDER-CONTROL-01 (0226): releases a never-purchased, never-activated errored claim (compare-and-set on sender and key, every condition re-checked under the row lock) via error -> releasing -> released, so the owner can choose another number. service_role only.';
comment on function public.studio_sms_resource_recorded(uuid, text, text) is
  'SMS-SENDER-CONTROL-01 (0226): whether any sender row in any studio or state already records this number or Messaging Service (0191 unique indexes). Existence only. service_role only.';

commit;
