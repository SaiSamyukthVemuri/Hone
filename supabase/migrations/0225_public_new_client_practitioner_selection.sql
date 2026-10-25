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
  -- Did THIS transaction insert the client row? Only then is there anything of
  -- ours to undo when the delegate refuses.
  v_created_client boolean := false;
  -- The delegate's verdict, CAPTURED rather than streamed. `return query
  -- select … from <delegate>()` sends the refusal straight to the caller and
  -- leaves nothing to inspect, which is why the leak was invisible from here.
  v_result        text;
  v_appt_id       uuid;
  v_starts        timestamptz;
  v_ends          timestamptz;
  v_dur           integer;
  -- PRE-INSERT availability check only. Deliberately NOT v_starts/v_ends/v_dur:
  -- those three are the DELEGATE'S OUTPUT, written by the `into` clauses below,
  -- and must not hold a value before it runs.
  v_pre_dur       integer;
  v_pre_ends      timestamptz;
  v_pre_avail     text;
  v_pract         uuid;
  v_appt_created  timestamptz;
begin
  if v_gate <> 'ok' then
    -- BEFORE the insert, so a refused request writes no client row.
    return query select v_gate, null::uuid, null::timestamptz, null::timestamptz,
                        null::integer, null::uuid, null::timestamptz, null::uuid,
                        null::text, null::text, null::timestamptz, null::timestamptz;
    return;
  end if;

  -- =====================================================================
  -- G1 / CODEX P1 + P2 — THE PRACTITIONER IS SETTLED BEFORE ANY CLIENT ROW
  -- EXISTS, AND UNDER THE LOCK `assert_new_client_admission` ALREADY HOLDS.
  -- =====================================================================
  --
  -- TWO DEFECTS SHARED ONE CAUSE: this wrapper forwarded `p_practitioner_id`
  -- to the delegate without ever examining it, and it created the client
  -- FIRST.
  --
  -- P1, the switch race. The delegate checked only structural capacity, so an
  -- operator disabling `practitioner_capacity_booking_enabled` (0136) after
  -- the TypeScript check but before this transaction won the studio lock left
  -- the practitioner accepted and the booking committed. An application check
  -- cannot close that window; only a check inside this transaction can.
  --
  -- P2, the orphan client. The delegate RETURNS `invalid_practitioner` or
  -- `not_eligible` rather than raising -- deliberately, because the invited
  -- path needs a definite answer rather than an aborted transaction. But a
  -- returned refusal does not undo work already done, so a client row
  -- (contact details, and possibly SMS consent) committed while no appointment
  -- was created and the visitor saw an error.
  --
  -- Both are answered by refusing HERE, before the resolve-or-create below,
  -- which is the same placement and the same reason as the admission gate
  -- immediately above.
  --
  -- WHY THIS IS AIRTIGHT RATHER THAN MERELY NARROWER: the mutations that could
  -- invalidate a practitioner mid-transaction both serialise on the studios
  -- row. `set_practitioner_active` and the service-eligibility writer each
  -- begin with `lock_studio_and_assert_owner`, which is
  -- `perform 1 from public.studios where id = $1 for update` (0150:47). This
  -- transaction already holds that row, so no deactivation and no unpin can
  -- commit between this gate and the delegate's own re-check. The delegate
  -- cannot reach a different verdict, so it cannot reject after the insert.
  --
  -- The checks are the delegate's own, deliberately duplicated rather than
  -- reworded: `validate_public_booking_slot_v2` (0222) uses exactly this
  -- active-practitioner test and exactly this list-exists-then-membership
  -- eligibility rule. Two engines answering one question must answer it the
  -- same way.
  --
  -- The invited branch passes NULL (the caller nulls it; an offer already names
  -- its practitioner), so applying this unconditionally changes nothing there
  -- while keeping the refusal total rather than branch-dependent.
  if p_practitioner_id is not null then
    if not coalesce(
      (select s.practitioner_capacity_booking_enabled
         from public.studios s where s.id = p_studio_id), false) then
      return query select 'practitioner_assignment_disabled'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid,
                          null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    if not exists (
      select 1 from public.practitioners pr
       where pr.id = p_practitioner_id
         and pr.studio_id = p_studio_id
         and pr.active = true
    ) then
      return query select 'invalid_practitioner'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid,
                          null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    -- Eligibility is enforced only when the service HAS a list, matching 0222
    -- and 0170: a studio that never configured `service_practitioners` keeps
    -- working.
    if p_service_id is not null
       and exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = p_service_id
       )
       and not exists (
         select 1 from public.service_practitioners sp
          where sp.service_id = p_service_id
            and sp.practitioner_id = p_practitioner_id
       )
    then
      return query select 'not_eligible'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid,
                          null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;

    -- P3, THE ORPHAN CLIENT FROM AN UNAVAILABLE SLOT.
    --
    -- The three checks above prove the practitioner is ASSIGNABLE. None of them
    -- says their slot is still FREE. If it is taken between the action's
    -- re-verification and this transaction winning the studio lock, the
    -- delegate answers `time_unavailable` — RETURNED, not raised — so the
    -- insert below would already have committed a client row with its contact
    -- details and any SMS consent, and no appointment would exist. That is the
    -- same orphan the P2 gate closed for identity and eligibility, reached
    -- through availability instead.
    --
    -- The authority is the delegate's OWN validator, duplicated here exactly as
    -- the identity and eligibility checks are, and the end instant is derived
    -- the way the command derives it: the service's duration from p_starts_at.
    -- A missing or non-positive duration is left to the delegate rather than
    -- invented into a refusal here.
    select sv.default_duration_minutes
      into v_pre_dur
      from public.services sv
     where sv.id = p_service_id
       and sv.studio_id = p_studio_id;

    if v_pre_dur is not null and v_pre_dur > 0 then
      v_pre_ends := p_starts_at + make_interval(mins => v_pre_dur);
      v_pre_avail := public.validate_public_booking_slot_v2(
        p_studio_id, p_practitioner_id, p_service_id, p_starts_at, v_pre_ends
      );
      if v_pre_avail is distinct from 'ok' then
        return query select v_pre_avail,
                            null::uuid, null::timestamptz, null::timestamptz,
                            null::integer, null::uuid, null::timestamptz, null::uuid,
                            null::text, null::text, null::timestamptz, null::timestamptz;
        return;
      end if;
    end if;
  elsif p_entry_id is null
    and coalesce(
      (select s.practitioner_capacity_booking_enabled
         from public.studios s where s.id = p_studio_id), false)
  then
    -- G1 / CODEX P2 — "ANY AVAILABLE" IS RESOLVED BEFORE THE CLIENT EXISTS.
    --
    -- The delegate now resolves an unspecified practitioner to someone
    -- eligible and actually free, and REFUSES with
    -- `no_practitioner_available` when nobody is. That refusal is returned
    -- rather than raised, so reaching it after the resolve-or-create below
    -- would commit a client row -- contact details, possibly SMS consent --
    -- for a booking that never happened. That is the same orphan this gate
    -- was built to prevent, arriving by a path the gate did not cover,
    -- because the gate only looked at a SUBMITTED id.
    --
    -- Asking the shared resolver here is safe and not merely narrower: this
    -- transaction already holds the studios row lock via
    -- `assert_new_client_admission`, and every writer that could change the
    -- answer -- `set_practitioner_active` and the service-eligibility writer --
    -- takes that same row (0150:47). The appointment writers serialise on the
    -- studio capacity advisory lock the delegate itself acquires. So the
    -- delegate cannot reach a different verdict than this check.
    --
    -- The ANSWER is deliberately discarded: only its existence is needed here.
    -- The delegate resolves again and re-validates at the transaction
    -- boundary, which is where the authority belongs; caching the id across
    -- that boundary would be trusting a value read before the delegate's own
    -- locks.
    if public.resolve_public_any_available_practitioner(
         p_studio_id,
         p_service_id,
         p_starts_at,
         p_starts_at + make_interval(mins => coalesce(
           (select sv.default_duration_minutes from public.services sv
             where sv.id = p_service_id and sv.studio_id = p_studio_id), 0))
       ) is null
    then
      return query select 'no_practitioner_available'::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz, null::uuid,
                          null::text, null::text, null::timestamptz, null::timestamptz;
      return;
    end if;
  end if;

  -- ===================================================================
  -- ONE SUBTRANSACTION AROUND THE CLIENT INSERT **AND** THE DELEGATE.
  -- ===================================================================
  --
  -- Codex P2 4266252488, measured before it was fixed: a refused booking
  -- committed a client row -- contact details AND `sms_consent_at` /
  -- `sms_consent_source` -- for an appointment that never happened.
  --
  --   PROBE         result=time_unavailable client_id=non-null
  --   CONSENT-PROBE result=time_unavailable client_id=non-null
  --                 has_consent=true source=public_booking
  --
  -- The mechanism is that every refusal in this tree is RETURNED as a result
  -- row rather than raised. A returned refusal is not an error, so the
  -- transaction commits whatever was written before it -- and the insert below
  -- happens before the delegate that refuses.
  --
  -- WHY THE BLOCK HAS TO START HERE AND NOT AT THE DELEGATE. A plpgsql
  -- exception block rolls back only to the start of ITS OWN block. Wrapping
  -- just the delegate call would catch the refusal and undo NOTHING, because
  -- the client row was inserted earlier in the function. That is the tempting
  -- patch, it looks correct, and it would pass every test that existed when
  -- this was written. The insert and the delegate must be inside the same
  -- block.
  --
  -- A PRE-CHECK WAS REJECTED as the fix. At this point the transaction holds
  -- the studios row lock but NOT the studio capacity advisory lock, which the
  -- delegate acquires; so a pre-check could still be overtaken between here and
  -- there, turning a deterministic leak into a race. Undo is total; a pre-check
  -- has to enumerate what to undo, and the next column added to the insert
  -- below is the one it forgets.
  begin
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
        -- ONLY HERE. A row the caller supplied, or one the lookup above or the
        -- unique-violation re-read below adopted, was NOT created by this
        -- transaction -- and undoing a pre-existing client would be a worse bug
        -- than the leak this fixes.
        v_created_client := true;
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
    select c.result, c.appointment_id, c.starts_at, c.ends_at,
           c.duration_minutes, c.practitioner_id, c.created_at
      into v_result, v_appt_id, v_starts, v_ends, v_dur, v_pract, v_appt_created
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
    select c.result, c.appointment_id, c.starts_at, c.ends_at,
           c.duration_minutes, c.practitioner_id, c.created_at
      into v_result, v_appt_id, v_starts, v_ends, v_dur, v_pract, v_appt_created
      from public.create_waitlist_public_appointment(
             p_studio_id, v_client_id, p_service_id, p_starts_at,
             p_cancellation_token_hash, p_entry_id, p_notes, p_referral_source
           ) c;
  end if;

  -- THE ROLLBACK. A refusal that arrives after THIS transaction created the
  -- client row must undo it, and raising is how a plpgsql subtransaction is
  -- told to. The verdict rides out in the message so the refusal is still
  -- RETURNED and this function's signature is unchanged -- callers keep reading
  -- a result row, not catching an exception.
  --
  -- A PRE-EXISTING client plus a refusal is NOT rolled back: there is nothing
  -- of ours to undo, and the caller still gets today's answer with the client
  -- fields intact. That is what `v_created_client` buys.
  -- THE REFUSAL TEST IS "NO APPOINTMENT", NOT A SUCCESS STRING.
  --
  -- This first read `v_result <> 'created'`, which silently treated every
  -- successful INVITED booking as a refusal: `create_public_appointment_v2`
  -- signals success as 'created' but `create_waitlist_public_appointment`
  -- (0195) signals it as 'created_and_converted'. So the raise fired on
  -- success, rolled back the conversion, and the invitation ended 'closed'
  -- instead of 'booked' -- caught by
  -- tests/db/waitlist-recipient-journey.db.test.ts, on exactly the path this
  -- file's own atomicity tests record as uncovered for want of a waitlist
  -- fixture. Enumerating success strings is what broke; asking the delegates'
  -- shared output is what cannot.
  --
  -- Both delegates return a non-null `appointment_id` if and only if they
  -- created one, and 0195 guards explicitly against a success with no id. So
  -- "no appointment" is the delegate-agnostic statement of "nothing was
  -- booked", and it is what decides whether a client row this transaction
  -- created has to be undone.
  if v_appt_id is null and v_created_client then
    raise exception 'hone_refused:%', v_result using errcode = 'HB225';
  end if;
  exception
    when sqlstate 'HB225' then
      -- The subtransaction is rolled back, so the client row and its consent
      -- columns no longer exist. Every client field is therefore NULL:
      -- returning the profile read a few lines above would describe a row that
      -- is gone.
      return query select split_part(sqlerrm, ':', 2)::text,
                          null::uuid, null::timestamptz, null::timestamptz,
                          null::integer, null::uuid, null::timestamptz,
                          null::uuid, null::text, null::text,
                          null::timestamptz, null::timestamptz;
      return;
  end;

  return query select v_result, v_appt_id, v_starts, v_ends, v_dur, v_pract,
                      v_appt_created, v_client_id, v_name, v_phone,
                      v_consent_at, v_opted_out_at;
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
