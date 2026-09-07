-- =====================================================================
-- WAIT-03B — B1.5b PROOF GATE.  UNNUMBERED.  NOT A MIGRATION.
--
-- Closes review P0-1: at dc2d93ce the proof surface was ADVISORY. B1.5 built
-- `validate_waitlist_invitation_proof` and nothing called it, while the two
-- commands that actually mutate -- applied `redeem_(text)` and B2's
-- `decline_(text)` -- each took a BARE TOKEN and consulted no capability. The
-- oracle said `proof_required` and the mutation succeeded anyway.
--
-- The gate is now IN the mutation, inside the SAME locked transaction, so the
-- check cannot be skipped by calling a different entry point.
--
-- Accepted B1 is NOT edited by this file.
-- =====================================================================

begin;
set local lock_timeout = '5s';

-- ---------------------------------------------------------------------
-- P1-3. `complete_` must bound its TTL exactly as `begin_` does, and must
-- verify the recipient binding it froze (P1-2). Redefined whole so both the
-- guard and the comparison live in one reviewable body.
-- ---------------------------------------------------------------------
-- CAPABILITY TTL IS OWNED BY THE DATABASE at 30 minutes. The caller has no TTL
-- authority at all -- there is no argument to get wrong -- so a 31-minute
-- capability is not refused at runtime, it is UNREPRESENTABLE. Any stale
-- 3-argument signature is dropped, not left beside the new one as a second way in.
drop function if exists public.complete_waitlist_invitation_proof(text, text, integer);

create or replace function public.complete_waitlist_invitation_proof(
  p_raw_token     text,
  p_raw_challenge text
)
returns table (result text, raw_capability text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz; v_cap text; v_live_hash text;
        v_max constant integer := 5;
begin
  -- P1-3: the same bound `begin_` applies. Previously absent here, so a caller
  -- typo could mint a YEAR-long capability on a credential whose whole purpose
  -- is to be short-lived, and a NULL surfaced as a raw 23514 rather than a
  -- typed refusal.
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_challenge is null or p_raw_challenge !~ '^[a-f0-9]{64}$'
     then
    return query select 'invalid_input'::text, null::text, null::timestamptz; return;
  end if;

  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::text, null::timestamptz; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_hash is null then
    return query select 'no_challenge'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_expires_at <= v_now then
    return query select 'challenge_expired'::text, null::text, null::timestamptz; return;
  end if;
  if r.proof_challenge_attempts >= v_max then
    return query select 'too_many_attempts'::text, null::text, null::timestamptz; return;
  end if;

  -- P1-2: the FROZEN recipient hash is now READ. Previously `begin_` wrote it
  -- and nothing compared it, so the column advertised an anti-retargeting
  -- control it did not provide. If the entry's contact changed after the
  -- challenge was issued, the challenge is refused rather than silently
  -- verifying against a different address.
  select encode(extensions.digest(lower(btrim(e.email)),'sha256'),'hex')
    into v_live_hash
    from public.new_client_waitlist_entries e
   where e.id = r.entry_id and e.studio_id = r.studio_id;

  if r.proof_challenge_sent_to_hash is distinct from v_live_hash then
    return query select 'recipient_changed'::text, null::text, null::timestamptz; return;
  end if;

  if r.proof_challenge_hash <> encode(extensions.digest(p_raw_challenge,'sha256'),'hex') then
    update public.new_client_waitlist_invitations
       set proof_challenge_attempts = proof_challenge_attempts + 1 where id = r.id;
    return query select 'wrong_challenge'::text, null::text, null::timestamptz; return;
  end if;

  v_cap := encode(extensions.gen_random_bytes(32), 'hex');

  update public.new_client_waitlist_invitations
     set proof_challenge_hash        = null,
         proof_challenge_expires_at  = null,
         proof_challenge_attempts    = 0,
         proof_capability_hash       = encode(extensions.digest(v_cap,'sha256'),'hex'),
         proof_capability_expires_at = v_now + interval '30 minutes'
   where id = r.id;

  return query select 'verified'::text, v_cap, v_now + interval '30 minutes';
end;
$$;

-- ---------------------------------------------------------------------
-- P0-1a. GATED REDEEM. Proof and mutation in ONE locked transaction.
-- The applied 0188/0189 `redeem_(text)` is frozen and not edited; this is a
-- forward command, and the ungated one is made unreachable below.
-- ---------------------------------------------------------------------
create or replace function public.redeem_new_client_waitlist_invitation_verified(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text, studio_id uuid, entry_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::uuid, null::uuid; return;
  end if;

  -- ONE lock, held across the proof check AND the mutation. A concurrent
  -- revoke either commits first (and we fail closed below) or waits.
  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::uuid, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::uuid, null::uuid; return;
  end if;

  -- THE GATE. Bearer possession got this far and stops here.
  if r.proof_capability_hash is null then
    return query select 'proof_required'::text, null::uuid, null::uuid; return;
  end if;
  if r.proof_capability_expires_at <= v_now then
    return query select 'proof_expired'::text, null::uuid, null::uuid; return;
  end if;
  if r.proof_capability_hash <> encode(extensions.digest(p_raw_capability,'sha256'),'hex') then
    return query select 'proof_invalid'::text, null::uuid, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set redeemed_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  return query select 'redeemed'::text, r.studio_id, r.entry_id;
end;
$$;

-- ---------------------------------------------------------------------
-- P0-1b. GATED DECLINE. The bare-token signature is DROPPED, not left
-- alongside: a bearer entry point that still exists is still a bearer path.
-- ---------------------------------------------------------------------
drop function if exists public.decline_new_client_waitlist_invitation(text);

create or replace function public.decline_new_client_waitlist_invitation(
  p_raw_token      text,
  p_raw_capability text
)
returns table (result text, entry_id uuid)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_capability is null or p_raw_capability !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::uuid; return;
  end if;

  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::uuid; return;
  end if;

  v_now := clock_timestamp();

  if r.redeemed_at is not null or r.expired_at is not null
     or r.released_at is not null or r.declined_at is not null
     or r.expires_at <= v_now then
    return query select 'not_live'::text, null::uuid; return;
  end if;

  if r.proof_capability_hash is null then
    return query select 'proof_required'::text, null::uuid; return;
  end if;
  if r.proof_capability_expires_at <= v_now then
    return query select 'proof_expired'::text, null::uuid; return;
  end if;
  if r.proof_capability_hash <> encode(extensions.digest(p_raw_capability,'sha256'),'hex') then
    return query select 'proof_invalid'::text, null::uuid; return;
  end if;

  update public.new_client_waitlist_invitations
     set declined_at = v_now,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = r.id;

  update public.new_client_waitlist_entries
     set status = 'released', released_at = v_now
   where id = r.entry_id and studio_id = r.studio_id and status = 'invited';

  return query select 'declined'::text, r.entry_id;
end;
$$;

-- ---------------------------------------------------------------------
-- P0-1c. Make the UNGATED path unreachable. The applied 0188/0189 command is
-- not edited -- its EXECUTE is withdrawn. It has zero runtime callers, so
-- nothing in the application loses a capability it was using.
-- ---------------------------------------------------------------------
-- The mutation owns capability validation inside its own locked transaction,
-- so the separate read-only oracle is no longer a caller path. A surviving
-- check-then-act API is exactly the surface B2 was told not to build against,
-- so it is dropped rather than deprecated.
drop function if exists public.validate_waitlist_invitation_proof(text, text);

revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from public;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from anon;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from authenticated;
revoke all privileges on function public.redeem_new_client_waitlist_invitation(text) from service_role;

do $$
declare f text;
begin
  foreach f in array array[
    'public.redeem_new_client_waitlist_invitation_verified(text, text)',
    'public.decline_new_client_waitlist_invitation(text, text)',
    'public.complete_waitlist_invitation_proof(text, text)'
  ] loop
    execute format('revoke all privileges on function %s from public', f);
    execute format('revoke all privileges on function %s from anon', f);
    execute format('revoke all privileges on function %s from authenticated', f);
    execute format('revoke all privileges on function %s from service_role', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
