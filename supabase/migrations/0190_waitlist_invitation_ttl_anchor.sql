-- ===========================================================================
-- WAIT-03 — THE REQUESTED TTL MUST START WHEN THE INVITATION IS ISSUED — 0190
-- ===========================================================================
--
-- 0188 AND 0189 ARE APPLIED AND FROZEN. Their bytes are production truth and
-- are NOT edited by this file. This migration is forward-only.
--
-- 0189 moved every TTL *decision* onto the post-lock wall clock. It deliberately
-- left the invitation's own `issued_at` and `expires_at` alone, and said so at
-- the line that computed them: no census path attributed an inversion to them,
-- and moving `expires_at` "would change the expiry window of every future
-- invitation". Review then showed that leaving them was itself the defect, and
-- changing that window is exactly the repair.
--
-- THE DEFECT, REPRODUCED BEFORE IT WAS REPAIRED
-- ---------------------------------------------------------------------------
-- `issue_new_client_waitlist_invitation` takes the entry mutex, reads
-- `v_decision_at := clock_timestamp()` -- the post-lock instant -- and stamps
-- `invited_at` from it. But it computed the window as
--
--     v_expires := now() + make_interval(hours => v_ttl)
--
-- and `now()` is `transaction_timestamp()`: the instant the transaction BEGAN,
-- which may be long before it reached the lock. The 0188 BEFORE INSERT trigger
-- then overwrote `issued_at` with the SAME stale `now()`, so the stored row was
-- internally consistent and nothing looked wrong -- while redemption, correctly
-- repaired by 0189, compares `expires_at` against the CURRENT post-lock wall
-- clock. The window a caller asked for was therefore shortened by however long
-- its transaction had already been alive.
--
-- MEASURED ON THIS TREE, at PostgreSQL microsecond precision, before the repair.
-- Both cases requested the RPC's MINIMUM TTL of 1 hour (3 600 000 000 us):
--
--   CASE A -- transaction begun and aged 3s before issuing:
--     issued_at  = transaction_timestamp()                        true
--     invited_at > transaction_timestamp()  (post-lock)           true
--     expires_at = transaction_timestamp() + ttl                  true
--     window measured from the real issuance instant     3 596 978 539 us
--     SHORTFALL                                              3 021 461 us
--     shortfall = the transaction's age at issuance               true
--
--   CASE B -- a holder kept the entry mutex, issue parked on it (observed in
--   pg_stat_activity as Lock/transactionid) for 3s:
--     same three equalities                                       true
--     SHORTFALL                                              3 122 452 us
--     shortfall = the transaction's age at issuance               true
--
-- The shortfall is not approximately the transaction's age; it IS the
-- transaction's age, to the microsecond, in both cases. A token whose issuing
-- transaction is older than its own TTL is therefore born already expired: it
-- is returned to the caller and redemption refuses it immediately. That end
-- state was NOT reproduced by waiting -- it needs an age of at least the
-- minimum TTL, one hour -- and is stated here as the arithmetic consequence of
-- the two measurements above, not as an observation.
--
-- THE REPAIR — ONE POST-LOCK INSTANT, NOT THREE CLOCK READS
-- ---------------------------------------------------------------------------
-- The entry mutex is the serialization point, so the instant taken immediately
-- after it is the only defensible issuance time. 0190 makes that single value
-- the authority for all three stamps:
--
--     entry lock
--       -> v_decision_at := clock_timestamp()      the canonical instant
--            -> invitations.issued_at  = v_decision_at
--            -> invitations.expires_at = v_decision_at + requested TTL
--            -> entries.invited_at     = v_decision_at
--
-- No second clock is read anywhere on that path. `issued_at` and `invited_at`
-- become the SAME instant rather than two readings a few hundred microseconds
-- apart, and `issued_at <= invited_at` -- the truthful order 0189 relied on --
-- still holds, now as equality.
--
-- WHY THE TRIGGER HAD TO CHANGE TOO, DETERMINED MECHANICALLY
-- ---------------------------------------------------------------------------
-- Repairing the command alone would have achieved nothing.
-- `new_client_waitlist_invitations_server_timestamps` is a BEFORE INSERT
-- trigger whose entire body was `new.issued_at := now()` -- an UNCONDITIONAL
-- overwrite that discards whatever the command supplied. Any value the repaired
-- command passed would have been thrown away and replaced by the stale
-- transaction timestamp again. The command and the trigger are the complete
-- set: `insert into public.new_client_waitlist_invitations` appears in exactly
-- two places in the whole migration history -- 0188's definition of this
-- command and 0189's replacement of it -- and nowhere else.
--
-- THE GUARD THE TRIGGER EXISTED FOR IS PRESERVED, NOT DROPPED. Its comment said
-- "issue time is the server's, never the caller's". That property is unchanged:
-- the trigger still refuses any instant this transaction has not actually
-- reached, so a supplied value can never be moved into the future, and a row
-- arriving without one is still stamped by the server. What it no longer does
-- is discard a post-lock instant that the server itself established.
--
-- The clobber was, in any case, defending a door no caller can open: on the
-- invitations table only the owner `postgres` holds INSERT. `anon`,
-- `authenticated` and `service_role` hold no table privilege at all, RLS is
-- enabled, and the sole INSERT path is this SECURITY DEFINER command, owned by
-- `postgres`. "The caller" cannot reach the table to supply anything.
--
-- WHAT IS NOT TOUCHED
-- ---------------------------------------------------------------------------
-- No table, column, index, default, constraint, policy or trigger DEFINITION
-- changes; only two function bodies are replaced. No backfill: rows already
-- issued keep the windows they were issued with, because rewriting a stored
-- expiry would move an evidence column that the append-only trigger exists to
-- freeze. Signatures, result vocabulary, SECURITY DEFINER, search_path, token
-- hashing and the one-live-per-entry partial unique index are all unchanged.
--
-- ACLs ARE RE-ASSERTED BY NAME. Supabase's ALTER DEFAULT PRIVILEGES grants
-- EXECUTE to anon, authenticated AND service_role at function-create time, and
-- this repository has been bitten twice by trusting otherwise (0129 missed
-- anon, 0164 missed service_role). Both functions are re-asserted explicitly.
--
-- APPLICATION CALLER. `issue_new_client_waitlist_invitation` is reached from
-- the settings waitlist queue. This migration changes the LENGTH of the window
-- a caller receives -- it now genuinely starts at issuance -- and changes no
-- signature, no result word and no error vocabulary, so no application change
-- is required by it.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- THE INVITATION TIMESTAMP TRIGGER — validate the server's instant, do not
-- replace it with a second, staler one.
-- ---------------------------------------------------------------------------
create or replace function public.new_client_waitlist_invitations_server_timestamps()
returns trigger
language plpgsql
set search_path = pg_catalog, pg_temp
as $$
begin
  -- Issue time is still the SERVER's, never the caller's. What changed is WHICH
  -- server instant: the row may now carry the post-lock canonical instant that
  -- its issuing command established, and this trigger only refuses a value the
  -- transaction has not actually reached. The previous body was an
  -- unconditional `new.issued_at := now()`, which discarded that instant and
  -- put transaction-start back in its place.
  if new.issued_at is null or new.issued_at > clock_timestamp() then
    new.issued_at := clock_timestamp();
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- COMMAND — ISSUE. One post-lock instant stamps the invitation, its window and
-- the entry's transition.
-- ---------------------------------------------------------------------------
create or replace function public.issue_new_client_waitlist_invitation(
  p_studio_id     uuid,
  p_entry_id      uuid,
  p_actor_user_id uuid,
  p_ttl_hours     integer default 72
)
returns table (result text, raw_token text, expires_at timestamptz)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_decision_at timestamptz;
  v_actor   uuid;
  v_code    text;
  v_status  text;
  v_raw     text;
  v_hash    text;
  v_ttl     integer := coalesce(p_ttl_hours, 72);
  v_expires timestamptz;
begin
  select r.practitioner_id, r.code into v_actor, v_code
    from public.new_client_waitlist_resolve_owner(p_studio_id, p_actor_user_id) r;
  if v_code <> 'ok' then
    return query select v_code, null::text, null::timestamptz; return;
  end if;
  if p_entry_id is null then
    return query select 'invalid_input'::text, null::text, null::timestamptz; return;
  end if;
  -- 1 hour .. 7 days. Out of range is REFUSED, never silently clamped: a
  -- clamped TTL is a window the caller did not ask for and cannot see.
  if v_ttl < 1 or v_ttl > 168 then
    return query select 'invalid_ttl'::text, null::text, null::timestamptz; return;
  end if;

  select e.status into v_status
    from public.new_client_waitlist_entries e
   where e.id = p_entry_id and e.studio_id = p_studio_id
   for update;

  -- THE CANONICAL ISSUANCE INSTANT, READ AFTER THE MUTEX. This single value is
  -- the authority for the invitation's issued_at, the window it opens, and the
  -- entry's invited_at. Nothing on this path reads a clock again: two reads
  -- microseconds apart would put the row's own stamps out of step, which is the
  -- defect class 0189 removed one layer up.
  v_decision_at := clock_timestamp();

  if v_status is null then
    return query select 'not_found'::text, null::text, null::timestamptz; return;
  end if;
  if v_status <> 'claimed' then
    return query select 'not_claimed'::text, null::text, null::timestamptz; return;
  end if;

  if exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.entry_id = p_entry_id
       and i.redeemed_at is null and i.expired_at is null and i.released_at is null
  ) then
    return query select 'already_invited'::text, null::text, null::timestamptz; return;
  end if;

  v_raw     := encode(extensions.gen_random_bytes(32), 'hex');
  v_hash    := encode(extensions.digest(v_raw, 'sha256'), 'hex');
  -- The window starts when the invitation is ISSUED, not when this transaction
  -- happened to begin. Previously `now() + ttl`, which handed back a window
  -- already shortened by the transaction's age.
  v_expires := v_decision_at + make_interval(hours => v_ttl);

  insert into public.new_client_waitlist_invitations
    (studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id)
  values
    (p_studio_id, p_entry_id, v_hash, v_decision_at, v_expires, v_actor);

  update public.new_client_waitlist_entries
     set status = 'invited', invited_at = v_decision_at
   where id = p_entry_id and studio_id = p_studio_id and status = 'claimed';

  return query select 'invited'::text, v_raw, v_expires;
end;
$$;

-- ---------------------------------------------------------------------------
-- ACLs — re-asserted by name, for both replaced functions.
-- ---------------------------------------------------------------------------
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from public;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from anon;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from authenticated;
revoke execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) from service_role;
grant  execute on function public.issue_new_client_waitlist_invitation(uuid, uuid, uuid, integer) to service_role;

-- The timestamp trigger function is granted to NO application role: it runs as
-- the table owner through the trigger, never by direct call.
revoke execute on function public.new_client_waitlist_invitations_server_timestamps() from public;
revoke execute on function public.new_client_waitlist_invitations_server_timestamps() from anon;
revoke execute on function public.new_client_waitlist_invitations_server_timestamps() from authenticated;
revoke execute on function public.new_client_waitlist_invitations_server_timestamps() from service_role;

commit;
