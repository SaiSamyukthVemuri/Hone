-- =====================================================================
-- WAIT-03B — B1.5 RECIPIENT-PROOF AUTHORITY.  UNNUMBERED.  NOT A MIGRATION.
--
-- B1 (accepted) is not modified. This file depends on B1 and on the B2
-- resolver/decline commands (wait03b-b2-server-authority.PROTOTYPE.sql).
--
-- WHY INVITATION-OWNED STATE RATHER THAN A PROOF TABLE
-- The choice is not about fewer lines. Holding proof on the invitation row makes
-- four required invariants STRUCTURAL instead of checked:
--   * a challenge cannot address another invitation -- there is nowhere else to
--     put it (invariants 3 and 5);
--   * a newer challenge REPLACES the older in the same columns, so a stale
--     challenge stops matching the moment one is reissued (invariant 1);
--   * validation requires the invitation to be live, so revoke, release,
--     decline, expiry and reissue invalidate proof automatically -- reissue
--     creates a NEW row, and the old proof dies with the old one
--     (invariants 6 and 7).
-- A separate table would need a partial unique index, explicit cross-invitation
-- checks, and a live-join on every validate to reach the same guarantees.
--
-- TWO SEPARATE CAPABILITIES, and the schema keeps them apart:
--   A. POSSESSION of the invitation URL -> may view scope, may REQUEST proof.
--   B. VERIFIED RECIPIENT capability    -> may book or decline THIS invitation.
-- Nothing here grants clinical-record access or future booking rights.
-- =====================================================================

begin;
set local lock_timeout = '5s';

alter table public.new_client_waitlist_invitations
  add column if not exists proof_challenge_hash        text,
  add column if not exists proof_challenge_expires_at  timestamptz,
  add column if not exists proof_challenge_sent_to_hash text,
  add column if not exists proof_challenge_attempts    integer not null default 0,
  add column if not exists proof_capability_hash       text,
  add column if not exists proof_capability_expires_at timestamptz;

-- Only hashes are ever stored. The raw challenge and the raw capability exist
-- in one server response and are never persisted, so a leaked database row
-- cannot be replayed into either capability.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_proof_hash_shape_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_proof_hash_shape_check
  check (
    (proof_challenge_hash is null or proof_challenge_hash ~ '^[a-f0-9]{64}$')
    and (proof_capability_hash is null or proof_capability_hash ~ '^[a-f0-9]{64}$')
    and (proof_challenge_sent_to_hash is null or proof_challenge_sent_to_hash ~ '^[a-f0-9]{64}$')
  );

-- A hash is meaningless without its expiry; storing one without the other would
-- create a credential with no server-clock bound.
alter table public.new_client_waitlist_invitations
  drop constraint if exists new_client_waitlist_invitations_proof_pairing_check;
alter table public.new_client_waitlist_invitations
  add constraint new_client_waitlist_invitations_proof_pairing_check
  check (
    (proof_challenge_hash is null) = (proof_challenge_expires_at is null)
    and (proof_capability_hash is null) = (proof_capability_expires_at is null)
    and proof_challenge_attempts >= 0
  );

comment on column public.new_client_waitlist_invitations.proof_challenge_sent_to_hash is
  'WAIT-03B B1.5: hash of the STORED invited contact, frozen when the challenge '
  'was issued. Editing the entry afterwards cannot retarget an outstanding '
  'challenge, and no browser-supplied address is ever compared.';

-- ---------------------------------------------------------------------
-- COMMAND 1 — BEGIN. Mints a high-entropy challenge (the same 64-hex
-- primitive the invitation token uses; deliberately not a short reusable PIN).
-- Returns the raw challenge and the STORED delivery contact to the SERVER only.
-- ---------------------------------------------------------------------
create or replace function public.begin_waitlist_invitation_proof(
  p_raw_token   text,
  p_ttl_minutes integer default 15
)
returns table (result text, raw_challenge text, delivery_contact text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare v_inv uuid; v_entry uuid; v_studio uuid; v_now timestamptz;
        v_raw text; v_email text;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_ttl_minutes is null or p_ttl_minutes <= 0 or p_ttl_minutes > 60 then
    return query select 'invalid_input'::text, null::text, null::text, null::timestamptz; return;
  end if;

  select i.id, i.entry_id, i.studio_id into v_inv, v_entry, v_studio
    from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if v_inv is null then
    return query select 'invalid_token'::text, null::text, null::text, null::timestamptz; return;
  end if;

  v_now := clock_timestamp();          -- POST-LOCK clock, as 0189 established

  -- POSSESSION may request proof, but only while the invitation is LIVE.
  if not exists (
    select 1 from public.new_client_waitlist_invitations i
     where i.id = v_inv and i.redeemed_at is null and i.expired_at is null
       and i.released_at is null and i.declined_at is null and i.expires_at > v_now
  ) then
    return query select 'not_live'::text, null::text, null::text, null::timestamptz; return;
  end if;

  select e.email into v_email
    from public.new_client_waitlist_entries e
   where e.id = v_entry and e.studio_id = v_studio;

  v_raw := encode(extensions.gen_random_bytes(32), 'hex');

  -- A NEW challenge REPLACES the old one in place. That is invariant 1: the
  -- previous hash is gone, so an older challenge can never verify afterwards.
  -- Any capability already minted is cleared too -- requesting proof again
  -- must not leave an older capability alive.
  update public.new_client_waitlist_invitations
     set proof_challenge_hash         = encode(extensions.digest(v_raw,'sha256'),'hex'),
         proof_challenge_expires_at   = v_now + make_interval(mins => p_ttl_minutes),
         proof_challenge_sent_to_hash = encode(extensions.digest(lower(btrim(v_email)),'sha256'),'hex'),
         proof_challenge_attempts     = 0,
         proof_capability_hash        = null,
         proof_capability_expires_at  = null
   where id = v_inv;

  return query select 'challenge_issued'::text, v_raw, v_email,
                      v_now + make_interval(mins => p_ttl_minutes);
end;
$$;

-- ---------------------------------------------------------------------
-- COMMAND 2 — COMPLETE. Verifies the challenge and mints a short-lived
-- capability bound to THIS invitation.
-- ---------------------------------------------------------------------
-- CAPABILITY TTL IS OWNED BY THE DATABASE: 30 minutes, no caller argument.
create or replace function public.complete_waitlist_invitation_proof(
  p_raw_token     text,
  p_raw_challenge text
)
returns table (result text, raw_capability text, expires_at timestamptz)
language plpgsql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
declare r record; v_now timestamptz; v_cap text; v_max constant integer := 5;
begin
  if p_raw_token is null or p_raw_token !~ '^[a-f0-9]{64}$'
     or p_raw_challenge is null or p_raw_challenge !~ '^[a-f0-9]{64}$' then
    return query select 'invalid_input'::text, null::text, null::timestamptz; return;
  end if;

  select * into r from public.new_client_waitlist_invitations i
   where i.token_hash = encode(extensions.digest(p_raw_token,'sha256'),'hex')
   for update;
  if r.id is null then
    return query select 'invalid_token'::text, null::text, null::timestamptz; return;
  end if;

  v_now := clock_timestamp();

  -- Invitation lifecycle gates the proof. A concurrent revoke that commits
  -- first makes this fail closed rather than minting a capability.
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

  if r.proof_challenge_hash <> encode(extensions.digest(p_raw_challenge,'sha256'),'hex') then
    update public.new_client_waitlist_invitations
       set proof_challenge_attempts = proof_challenge_attempts + 1 where id = r.id;
    return query select 'wrong_challenge'::text, null::text, null::timestamptz; return;
  end if;

  v_cap := encode(extensions.gen_random_bytes(32), 'hex');

  -- Single use: the challenge is consumed as the capability is minted, so a
  -- successful verification cannot be replayed -- here or at another invitation.
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
-- COMMAND 4 — INVALIDATE, for lifecycle transitions. Structural invalidation
-- already holds (validate requires a live invitation); this makes the clearing
-- explicit so a released row does not retain a dead credential at rest.
-- ---------------------------------------------------------------------
create or replace function public.invalidate_waitlist_invitation_proof(
  p_invitation_id uuid
)
returns void
language sql volatile security definer
set search_path = pg_catalog, pg_temp
as $$
  update public.new_client_waitlist_invitations
     set proof_challenge_hash = null, proof_challenge_expires_at = null,
         proof_challenge_sent_to_hash = null, proof_challenge_attempts = 0,
         proof_capability_hash = null, proof_capability_expires_at = null
   where id = p_invitation_id;
$$;

-- service_role ONLY on all four. Nothing for anon or authenticated: the browser
-- never executes these and never writes these columns.
do $$
declare f text;
begin
  foreach f in array array[
    'public.begin_waitlist_invitation_proof(text, integer)',
    'public.complete_waitlist_invitation_proof(text, text)',
    'public.invalidate_waitlist_invitation_proof(uuid)'
  ] loop
    execute format('revoke all privileges on function %s from public', f);
    execute format('revoke all privileges on function %s from anon', f);
    execute format('revoke all privileges on function %s from authenticated', f);
    execute format('revoke all privileges on function %s from service_role', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end $$;

commit;
