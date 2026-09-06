-- =====================================================================
-- WAIT-03B — B2 DB DEPENDENCIES.  UNNUMBERED.  NOT A MIGRATION.
--
-- B1 (accepted, sha-pinned in the B1 handoff) is NOT modified by this file.
-- These are the two authorities the SERVER layer cannot be built without:
--
--   G4  resolve_new_client_waitlist_invitation  -- READ-ONLY. The applied
--       redeem_ command MUTATES (sets redeemed_at), so a GET, link preview or
--       crawler that reached it would consume the invitation. Rendering safe
--       offer metadata therefore needs a non-mutating resolver.
--
--   G3  decline_new_client_waitlist_invitation  -- TOKEN-authorised. The only
--       applied close path is release_new_client_waitlist_entry(..., actor),
--       which is OWNER authority a prospect must never borrow. Decline closes
--       the invitation and moves the entry invited -> released, an edge the
--       0188 transition guard already allows, so the accepted requeue_ path
--       returns it to waiting. No new lifecycle edge is invented.
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- G4. READ-ONLY resolver. STABLE, and it writes nothing.
-- ---------------------------------------------------------------------
create or replace function public.resolve_new_client_waitlist_invitation(
  p_raw_token text
)
returns table (
  result                 text,
  invitation_id          uuid,
  studio_id              uuid,
  entry_id               uuid,
  scope_service_id       uuid,
  scope_start_date       date,
  scope_end_date         date,
  scope_allowed_weekdays smallint[],
  expires_at             timestamptz,
  recipient_contact_hash text
)
language sql
stable                      -- cannot write; the planner and the reader both know it
security definer
set search_path = pg_catalog, pg_temp
as $$
  select
    case
      when i.id is null                                     then 'invalid_token'
      when i.redeemed_at is not null                        then 'already_redeemed'
      when i.declined_at is not null                        then 'declined'
      when i.released_at is not null                        then 'released'
      when i.expired_at  is not null                        then 'expired'
      when i.expires_at <= clock_timestamp()                then 'expired'
      when i.scope_service_id is null                       then 'unscoped'
      else 'live'
    end::text,
    i.id, i.studio_id, i.entry_id,
    i.scope_service_id, i.scope_start_date, i.scope_end_date, i.scope_allowed_weekdays,
    i.expires_at,
    -- The STORED contact, hashed. The raw address never leaves the database
    -- through this path, and the server compares hashes, so a substituted typed
    -- email cannot be made to match by echoing it back.
    encode(extensions.digest(lower(btrim(e.email)), 'sha256'), 'hex')
  from (select 1) dummy
  left join public.new_client_waitlist_invitations i
    on p_raw_token ~ '^[a-f0-9]{64}$'
   and i.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
  left join public.new_client_waitlist_entries e
    on e.id = i.entry_id and e.studio_id = i.studio_id;
$$;

-- ---------------------------------------------------------------------
-- G3. Token-authorised decline. No owner actor is recorded, and it refuses
--     unless this token IS the entry's current live invitation, so an old
--     link cannot decline a newer offer.
-- ---------------------------------------------------------------------
create or replace function public.decline_new_client_waitlist_invitation(
  p_raw_token text
)
returns table (result text, entry_id uuid)
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_inv    uuid;
  v_entry  uuid;
  v_studio uuid;
  v_now    timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_token'::text, null::uuid; return;
  end if;

  -- Lock the invitation first, then decide on the POST-LOCK clock, matching
  -- 0189's redemption discipline so a queued caller is judged at the time it
  -- actually acted rather than when it started waiting.
  select i.id, i.entry_id, i.studio_id
    into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token, 'sha256'), 'hex')
   for update;

  if v_inv is null then
    return query select 'invalid_token'::text, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  -- Must still be THE live invitation for its entry. A superseded link fails
  -- closed here rather than closing someone else's newer offer.
  if not exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.id = v_inv
       and i.redeemed_at is null and i.expired_at is null
       and i.released_at is null and i.declined_at is null
       and i.expires_at > v_now
  ) then
    return query select 'not_live'::text, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set declined_at = v_now
   where id = v_inv;

  -- invited -> released is an edge the applied 0188 guard already permits; the
  -- accepted requeue_ command then returns the entry to waiting.
  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = v_entry and studio_id = v_studio and status = 'invited';

  return query select 'declined'::text, v_entry;
end;
$$;

-- service_role ONLY, revoked from all four by name first (0129/0164 lesson).
revoke all privileges on function public.resolve_new_client_waitlist_invitation(text) from public;
revoke all privileges on function public.resolve_new_client_waitlist_invitation(text) from anon;
revoke all privileges on function public.resolve_new_client_waitlist_invitation(text) from authenticated;
revoke all privileges on function public.resolve_new_client_waitlist_invitation(text) from service_role;
grant  execute on function public.resolve_new_client_waitlist_invitation(text) to service_role;

revoke all privileges on function public.decline_new_client_waitlist_invitation(text) from public;
revoke all privileges on function public.decline_new_client_waitlist_invitation(text) from anon;
revoke all privileges on function public.decline_new_client_waitlist_invitation(text) from authenticated;
revoke all privileges on function public.decline_new_client_waitlist_invitation(text) from service_role;
grant  execute on function public.decline_new_client_waitlist_invitation(text) to service_role;

commit;
