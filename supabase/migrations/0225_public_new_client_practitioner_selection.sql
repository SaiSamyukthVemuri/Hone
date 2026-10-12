-- ===========================================================================
-- 0225 — G1: the NEW-CLIENT public booking path becomes practitioner-aware
-- ===========================================================================
-- THE REACHABLE-SURFACE PROBLEM THIS CLOSES. 0222 made
-- `create_public_appointment` practitioner-aware, but that command is reached
-- from the public page only on the EXISTING-client branch — and that branch is
-- dead UI. `app/book/[slug]/PublicBookForm.tsx` says so itself: "the
-- existing-client branch of the form is intentionally unreachable from the
-- rendered surface", and choosing "I'm an existing client" renders a portal
-- sign-in card instead. Verified in a browser, not inferred: the rendered page
-- carries no service selector at all.
--
-- The RENDERED public booking form is the NEW-CLIENT form on a studio whose
-- admission mode is OPEN. It commits through
-- `create_public_appointment_for_new_client` (0204), which takes no
-- practitioner. So a picker mounted on the reachable surface had nothing
-- practitioner-aware to commit through. This adds it.
--
-- WHY THIS IS SMALL. 0204 DELEGATES: it decides admission, resolves-or-creates
-- the client, and then calls `create_public_appointment` (ordinary) or
-- `create_waitlist_public_appointment` (invited), returning the delegate's
-- columns. So v2 is 0204 carried VERBATIM with exactly two changes:
--   1. a trailing `p_practitioner_id uuid default null`;
--   2. the ORDINARY branch delegates to `create_public_appointment_v2` and
--      passes it through.
-- Every other line — the admission decision, the resolve-or-create, the
-- unique-violation re-read, the authoritative client fields — is 0204's.
--
-- SO EVERY GUARANTEE 0222 PROVED IS INHERITED, not re-implemented: the
-- practitioner is validated by the delegate (this studio's, active, treating,
-- service-eligible, free at that instant, inside that practitioner's own
-- availability), refused with `invalid_practitioner` / `not_eligible` /
-- `time_unavailable`, and `NULL` reproduces the active-owner derivation exactly.
--
-- THE ADMISSION GATES ARE UNTOUCHED, which is the point of delegating rather
-- than rewriting. WAITLIST and CLOSED are decided ABOVE the delegate, inside
-- the body carried verbatim, so a practitioner choice cannot carry a booking
-- past a closed studio and cannot bypass the waitlist. 0222's own test suite
-- plus this migration's tests pin that.
--
-- THE INVITED BRANCH IS DELIBERATELY NOT PRACTITIONER-AWARE.
-- `create_waitlist_public_appointment` takes no practitioner, and an invited
-- booking redeems a specific offer rather than choosing a clinician — the offer
-- named no practitioner. `p_practitioner_id` is therefore IGNORED on that
-- branch and the form does not offer the picker there. Making invited bookings
-- practitioner-aware is a WAIT-round question (v4 reserves the practitioner at
-- round launch), not a G1 one. This is a recorded product gap, not an
-- oversight.
--
-- 0204's `create_public_appointment_for_new_client` IS LEFT IN PLACE AND
-- UNCHANGED, so nothing live changes until the route is pointed at v2.
--
-- GRANTS. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon,
-- authenticated AND service_role at create time, so all four are revoked BY
-- NAME before EXECUTE is granted to service_role only — 0204's posture.
--
-- RENUMBERED 0223 -> 0225. It was authored as 0223 from a census that was
-- correct when taken and stale within the hour: MPX #860 pushed
-- `0223_machine_inventory_and_setup_readings.sql` and Audit #872 pushed
-- `0224_us_settlement_method_guard.sql`, both on refs, while this migration was
-- still unpushed. A PUSHED claim beats an UNPUSHED one, so this one moved. The
-- RBAC lane caught it; verified here against both refs rather than taken on
-- trust.
--
-- CONSEQUENCE FOR PROVING IT: a contiguous chain under 0225 now requires MPX's
-- 0223 and Audit's 0224 as well as 0211-0222, so the local proof needs those
-- two integrated. The contiguity guard is not weakened to avoid that.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

create or replace function public.create_public_appointment_for_new_client_v2(
  p_studio_id               uuid,
  p_client_id               uuid,
  p_client_name             text,
  p_client_email            text,
  p_client_phone            text,
  p_sms_consent_at          timestamptz,
  p_service_id              uuid,
  p_starts_at               timestamptz,
  p_cancellation_token_hash text,
  p_legacy_bridge_waitlist  boolean,
  p_notes                   text default null,
  p_referral_source         text default null,
  -- SERVER-DERIVED, from the locked redemption that just spent the invitation.
  -- NULL is the ordinary path; non-null composes 0195's conversion instead, which
  -- is the same branch the application already made on `redeemedEntryId`.
  p_entry_id                uuid default null,
  -- G1. NULL preserves 0204 EXACTLY: the delegate derives assignment from the
  -- active-owner count. Non-NULL is the client's chosen practitioner, validated
  -- by the delegate rather than here.
  p_practitioner_id         uuid default null
)
returns table (
  result           text,
  appointment_id   uuid,
  starts_at        timestamptz,
  ends_at          timestamptz,
  duration_minutes integer,
  practitioner_id  uuid,
  created_at       timestamptz,
  client_id        uuid,
  -- THE WINNING CLIENT'S OWN CONTACT STATE, not the submission's.
  --
  -- The id alone was not enough. When another writer created the same-studio
  -- email first, this command adopts THAT row - and the caller went on using the
  -- values a visitor had typed, so a post-commit SMS could go to the submitted
  -- phone under submitted consent while the appointment belonged to a client
  -- whose stored phone or consent differed. The authoritative profile is
  -- returned so the caller never has to guess which it is holding.
  client_name            text,
  client_phone           text,
  client_sms_consent_at  timestamptz,
  client_sms_opted_out_at timestamptz
)
language plpgsql
volatile
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  -- The OPERATION, not just the mode: an invitation may admit under `waitlist`,
  -- an ordinary booking may not, and neither may under `closed` or `unknown`.
  v_gate      text := public.assert_new_client_admission(
    p_studio_id,
    case when p_entry_id is null then 'book' else 'invited_book' end,
    p_legacy_bridge_waitlist
  );
  v_client_id     uuid := p_client_id;
  v_archived      boolean;
  v_name          text;
  v_phone         text;
  v_consent_at    timestamptz;
  v_opted_out_at  timestamptz;
begin
  if v_gate <> 'ok' then
    -- BEFORE the insert, so a refused request writes no client row.
    return query select v_gate, null::uuid, null::timestamptz, null::timestamptz,
                        null::integer, null::uuid, null::timestamptz, null::uuid,
                        null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_client_id is null then
    -- RE-RESOLVE UNDER THE LOCK. The caller's own lookup ran before this
    -- transaction, so another booking could have created this client since. The
    -- studios row lock taken above serialises same-studio bookings, which is why
    -- a plain lookup-then-insert is safe here and the application's 23505
    -- unique-violation race cannot occur inside this command.
    --
    -- `normalized_email` is the generated column the uniqueness is built on, so
    -- matching on it is matching on exactly what would collide.
    select c.id, c.archived_at is not null
      into v_client_id, v_archived
      from public.clients c
     where c.studio_id = p_studio_id
       and c.normalized_email = case
             when p_client_email is null or btrim(p_client_email) = '' then null
             else lower(btrim(p_client_email))
           end
     limit 1;

    -- An ARCHIVED client is the application's existing refusal, kept verbatim so
    -- the caller can log it exactly as it does today rather than resurrecting a
    -- client nobody asked to restore.
    if coalesce(v_archived, false) then
      return query select 'archived_client_collision'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid,
                          null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    if v_client_id is null then
      -- THE RACE IS REAL, BECAUSE NOT EVERY CLIENT WRITER TAKES THIS LOCK.
      --
      -- The studios row lock serialises this command against other transactions
      -- that acquire it - and the practitioner "Add Client" surface
      -- (app/(app)/clients/new/actions.ts) does not. It inserts straight into
      -- `clients`, so it can land between the lookup above and the insert below
      -- and raise 23505 on the unique email index.
      --
      -- An uncaught exception here would abort the whole RPC, and on the
      -- invitation path the redemption is ALREADY COMMITTED from an earlier
      -- request - leaving an invitation spent with no booking outcome from the
      -- transaction that owns it. So the collision is caught and answered.
      begin
        insert into public.clients (
          studio_id, name, email, phone, sms_consent_at, sms_consent_source
        )
        values (
          p_studio_id, p_client_name, p_client_email, p_client_phone,
          p_sms_consent_at,
          case when p_sms_consent_at is null then null else 'public_booking' end
        )
        returning id into v_client_id;
      exception
        when unique_violation then
          -- RE-READ THE WINNER, and distinguish active from archived exactly as
          -- the application contract did before this moved into the database.
          select c.id, c.archived_at is not null
            into v_client_id, v_archived
            from public.clients c
           where c.studio_id = p_studio_id
             and c.normalized_email = case
                   when p_client_email is null or btrim(p_client_email) = '' then null
                   else lower(btrim(p_client_email))
                 end
           limit 1;

          if coalesce(v_archived, false) then
            return query select 'archived_client_collision'::text,
                                null::uuid, null::timestamptz, null::timestamptz,
                                null::integer, null::uuid, null::timestamptz, null::uuid,
                                null::text, null::text, null::timestamptz, null::timestamptz;
            return;
          end if;

          -- The index said a row exists and the re-read cannot see it, so the
          -- collision was on something this command does not own. Answer
          -- definitely rather than raising: the caller must be able to tell a
          -- spent invitation apart from an unknown failure.
          if v_client_id is null then
            return query select 'client_not_created'::text,
                                null::uuid, null::timestamptz, null::timestamptz,
                                null::integer, null::uuid, null::timestamptz, null::uuid,
                                null::text, null::text, null::timestamptz, null::timestamptz;
            return;
          end if;
      end;
    end if;
  end if;

  -- THE AUTHORITATIVE PROFILE of whichever row won, read after the id settles:
  -- the one the caller resolved, the one the pre-insert lookup found, the one the
  -- unique-violation re-read adopted, or the one this command created. The caller
  -- must not keep using the submission's values for a row it did not create.
  select c.name, c.phone, c.sms_consent_at, c.sms_opted_out_at
    into v_name, v_phone, v_consent_at, v_opted_out_at
    from public.clients c
   where c.id = v_client_id;

  if p_entry_id is null then
    return query
      select c.result, c.appointment_id, c.starts_at, c.ends_at,
             c.duration_minutes, c.practitioner_id, c.created_at, v_client_id,
             v_name, v_phone, v_consent_at, v_opted_out_at
        from public.create_public_appointment_v2(
               p_studio_id, v_client_id, p_service_id, p_starts_at,
               p_cancellation_token_hash, p_notes, p_referral_source,
               -- THE ONE CHANGE THAT MATTERS. Everything above this line is
               -- 0204 verbatim: the admission decision, the resolve-or-create,
               -- the unique-violation re-read and the authoritative client
               -- fields. Only the delegate changes, and only on this branch.
               p_practitioner_id
             ) c;
  else
    -- 0195 already takes the studios row lock and converts the entry in the same
    -- transaction, so the admission decision above simply precedes it.
    --
    -- THE INVITED BRANCH IS DELIBERATELY NOT PRACTITIONER-AWARE.
    -- `create_waitlist_public_appointment` takes no practitioner, and an
    -- invited booking is a redemption of a specific offer rather than a free
    -- choice of clinician — the offer did not name one. Passing a practitioner
    -- here would be silently discarded, so the form does not offer the picker
    -- on an invited booking and `p_practitioner_id` is ignored on this path.
    -- Making invited bookings practitioner-aware is a WAIT-round question
    -- (v4 reserves the practitioner at round launch), not a G1 one.
    return query
      select c.result, c.appointment_id, c.starts_at, c.ends_at,
             c.duration_minutes, c.practitioner_id, c.created_at, v_client_id,
             v_name, v_phone, v_consent_at, v_opted_out_at
        from public.create_waitlist_public_appointment(
               p_studio_id, v_client_id, p_service_id, p_starts_at,
               p_cancellation_token_hash, p_entry_id, p_notes, p_referral_source
             ) c;
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- GRANTS — revoke from all four roles BY NAME, then service_role only.
-- ---------------------------------------------------------------------------
revoke execute on function public.create_public_appointment_for_new_client_v2(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid) from public;
revoke execute on function public.create_public_appointment_for_new_client_v2(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid) from anon;
revoke execute on function public.create_public_appointment_for_new_client_v2(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid) from authenticated;
revoke execute on function public.create_public_appointment_for_new_client_v2(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid) from service_role;
grant execute on function public.create_public_appointment_for_new_client_v2(uuid, uuid, text, text, text, timestamptz, uuid, timestamptz, text, boolean, text, text, uuid, uuid) to service_role;

commit;
