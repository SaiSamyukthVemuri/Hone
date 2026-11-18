-- Migration 0353. Waitlist single legal name.
--
-- ADDITIVE ONLY: one new column, one new CHECK, one new function version. The sealed 0202 completion command is not edited and
-- stays exactly as shipped (it keeps refusing a blank family name). No column is dropped. No data is changed or backfilled:
-- every existing row keeps single_legal_name = false. The new function body was diffed against the live 0202 body: the only
-- differences are the single-name rule and the new flag.
--
-- RULES:
-- 1. The join path is unchanged. A single name is offered at completion only; the join command still requires both names, always
--    writes the flag false, and composes the name from both parts.
-- 2. Once the app enables the option it calls the new function for every completion (flag true or false), because the old command
--    on a row that already has the flag true would hit the new CHECK and raise instead of returning a code.
-- 3. The conversion blocker applies: turning an entry into a client (booking conversion) must not invent a family name. A single-name
--    entry stays unconvertible until the client single-name representation is defined. This blocks enabling the option, not this
--    migration.
-- 4. Enabling is a separate reviewed change (capability, option and the read side that selects the new column), made after the apply.
-- Tests: tests/db/waitlist-single-legal-name.db.test.ts (behaviour) and tests/migrations/0353-waitlist-single-legal-name.test.ts
-- (source contract). Rollback: supabase/rollbacks/0353_waitlist_single_legal_name.down.sql.
begin;

set local lock_timeout = '5s';

-- Constant default false: catalog-only on current Postgres, no rewrite.
alter table public.new_client_waitlist_entries
  add column if not exists single_legal_name boolean not null default false;

-- A single legal name carries NO family name. Existing rows are all false, so this validates trivially.
alter table public.new_client_waitlist_entries
  drop constraint if exists new_client_waitlist_entries_single_name_check;
alter table public.new_client_waitlist_entries
  add constraint new_client_waitlist_entries_single_name_check
  check (not single_legal_name or last_name is null);

comment on column public.new_client_waitlist_entries.single_legal_name is
  'True only when the prospect said they have one legal name. last_name is then NULL; nothing is invented or split. False on every legacy row.';

-- NEW VERSION of the completion command (copy of 0202 with the single-name rule; diff reviewed line by line).
create or replace function public.complete_waitlist_profile_by_grant_v2(
  p_raw_token          text,
  p_first_name         text,
  p_last_name          text,
  p_treatment_area_ids text[],
  p_preference         text,
  p_mobile_candidate   text,
  p_sms_consent        boolean,
  p_single_name        boolean
)
returns text
language plpgsql
volatile
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  c_areas constant text[] := array[
    'upper_lip','chin','jawline','cheeks','sideburns','eyebrows','full_face',
    'neck','ears','chest','abdomen','back','underarms','forearms','hands',
    'thighs','lower_legs','feet','bikini','brazilian','buttocks'
  ];

  v_hash     text;
  v_entry    uuid;
  v_studio   uuid;
  v_grant    record;
  v_now      timestamptz;
  v_first    text := btrim(coalesce(p_first_name, ''));
  v_last     text := btrim(coalesce(p_last_name, ''));
  v_cand     text := nullif(btrim(coalesce(p_mobile_candidate, '')), '');
  v_in       text[] := coalesce(p_treatment_area_ids, array[]::text[]);
  v_areas    text[];
  v_distinct integer;
  v_entry_row record;
  v_pref     text;
  -- WHY THIS BOOLEAN EXISTS RATHER THAN A BARE `found`.
  -- `found` reflects the MOST RECENT statement, and two reads sit between the
  -- grant re-resolve and the branch below. Reading `found` there asked "does a
  -- preference row exist", which is a different question with the same spelling:
  -- a legacy entry (no preference row) took the replay branch and was refused,
  -- and an entry that HAD one skipped the replay branch on an expired, revoked
  -- or already-spent token and wrote anyway. Capturing the answer on the next
  -- line makes the branch independent of what is read after it.
  v_grant_found boolean;
begin
  if p_raw_token is null or p_sms_consent is null or p_single_name is null then
    return 'refused';
  end if;

  v_hash := encode(extensions.digest(p_raw_token, 'sha256'), 'hex');

  -- STEP 1: an UNLOCKED read, for one purpose only -- to learn WHICH studio and
  -- entry this token belongs to, so the canonical locks can be taken in order.
  -- Nothing is decided here and no clock is read yet.
  select g.entry_id, g.studio_id into v_entry, v_studio
    from public.new_client_waitlist_preference_grants g
   where g.token_hash = v_hash;
  if v_entry is null then return 'refused'; end if;

  -- STEP 2: CANONICAL LOCK ORDER, STUDIO -> ENTRY, the same order
  -- admit_new_client_waitlist_entry, issue_ and redeem_ all take.
  perform 1 from public.studios s where s.id = v_studio for no key update;
  perform 1 from public.new_client_waitlist_entries e
   where e.id = v_entry for update;

  -- STEP 3: READ THE CLOCK ONLY NOW, AFTER THE LOCKS. This transaction can wait
  -- on the entry lock for an unbounded time, and a grant that was live when the
  -- wait began can expire during it. A pre-lock timestamp makes the expiry
  -- re-check pass on evidence that is already stale.
  v_now := clock_timestamp();

  -- Validate the submission. Never names which field: the surface renders one
  -- message for every refusal.
  -- SINGLE LEGAL NAME: an explicit flag, never inferred from a blank. With the flag the
  -- family name must be absent (nothing is invented or split), and without it the 0202 rule
  -- (both parts) is unchanged. v_last is stored as NULL for a single name.
  if v_first = '' or length(v_first) > 60
     or (p_single_name and v_last <> '')
     or (not p_single_name and (v_last = '' or length(v_last) > 60))
     or p_preference is null
     or p_preference not in ('weekdays', 'weekends', 'both') then
    return 'invalid_submission';
  end if;

  if v_cand is not null
     and (length(v_cand) > 40
          or length(regexp_replace(v_cand, '[^0-9]', '', 'g')) < 7) then
    return 'invalid_submission';
  end if;

  -- REFUSE RATHER THAN NARROW. `= any` silently drops a NULL member, so
  -- array['chin', null] would have been accepted AS array['chin'] -- a shorter
  -- treatment list than the person submitted, recorded as though it were theirs.
  if array_position(v_in, null) is not null then
    return 'invalid_submission';
  end if;

  select array_agg(c.id order by c.ord) into v_areas
    from unnest(c_areas) with ordinality as c(id, ord)
   where c.id = any (v_in);
  select count(distinct x) into v_distinct
    from unnest(v_in) as x where x is not null;
  if v_areas is null
     or cardinality(v_areas) = 0
     or cardinality(v_areas) <> v_distinct then
    return 'invalid_submission';
  end if;

  -- STEP 4: re-resolve the grant UNDER the locks, with the full validity
  -- predicate and the post-lock clock. THE ENTRY'S LIFECYCLE IS PART OF THAT
  -- PREDICATE: removal moves the entry to `removed` without touching the grant,
  -- whose own columns stay perfectly valid, so a link issued while the prospect
  -- was waiting would otherwise stay redeemable after the owner removed them.
  -- `removed` and `converted` are the two states with no outgoing transition.
  select g.id, g.entry_id, g.studio_id
    into v_grant
    from public.new_client_waitlist_preference_grants g
    join public.new_client_waitlist_entries e
      on e.id = g.entry_id and e.studio_id = g.studio_id
   where g.token_hash  = v_hash
     and g.redeemed_at is null
     and g.revoked_at  is null
     and g.expires_at  > v_now
     and e.status not in ('removed', 'converted')
   for update of g;
  v_grant_found := found;   -- MUST stay on the line after the select above.

  select e.first_name, e.last_name, e.single_legal_name, e.treatment_area_ids, e.phone,
         e.sms_consent_at
    into v_entry_row
    from public.new_client_waitlist_entries e
   where e.id = v_entry;

  select p.preference into v_pref
    from public.new_client_waitlist_entry_preferences p
   where p.entry_id = v_entry;

  if not v_grant_found then
    -- STEP 4a: IDEMPOTENT REPLAY, AND ONLY THAT.
    --
    -- 0193's grant is single-use, so a person who taps twice on a slow
    -- connection would otherwise get `accepted` then `refused` -- rendered as
    -- "not authorised", for doing nothing wrong. When the token resolves but
    -- the grant is spent, and the entry ALREADY HOLDS exactly what was
    -- submitted, this is that second tap.
    --
    -- IT WRITES NOTHING, which is the load-bearing half: a replay must not
    -- re-stamp `sms_consent_at`, must not move the preference row's
    -- `confirmed_at`, and must not bump `updated_at`. A DIFFERENT submission on
    -- a spent grant is refused exactly as an unknown token is.
    if exists (
      select 1 from public.new_client_waitlist_preference_grants g
       where g.token_hash  = v_hash
         and g.redeemed_at is not null
         and g.revoked_at  is null
    )
    and v_entry_row.first_name         is not distinct from v_first
    and v_entry_row.last_name          is not distinct from (case when p_single_name then null else v_last end)
    and v_entry_row.single_legal_name  is not distinct from p_single_name
    and v_entry_row.treatment_area_ids is not distinct from v_areas
    and v_pref                         is not distinct from p_preference
    and (v_cand is null or v_entry_row.phone is not distinct from v_cand)
    -- AND THE CONSENT ANSWER, which is the one field a replay can legitimately
    -- differ on: a person who ticked the box on the second tap has NOT already
    -- been recorded, so reporting `accepted` while writing nothing would claim a
    -- consent that does not exist. Ticking requires consent to be on the row;
    -- not ticking is a no-op under STEP 5 and is therefore always satisfied.
    and (not p_sms_consent or v_entry_row.sms_consent_at is not null) then
      return 'accepted';
    end if;
    return 'refused';
  end if;

  -- STEP 5: THE MOBILE ARM IS DECIDED BY THE ROW, NEVER BY THE SUBMISSION.
  -- A forged post can always claim the wrong one. An entry that already holds a
  -- number and a submission carrying a candidate is an attempted REPLACEMENT --
  -- the finding this shape closes -- and it is refused outright rather than
  -- ignored, because ignoring it would report success for a write that did not
  -- happen.
  if v_cand is not null and v_entry_row.phone is not null then
    return 'refused';
  end if;

  -- AND THE OTHER ARM: no candidate supplied and none on file. `mobile` is a
  -- required field of `assessProfileCompleteness`, so accepting this would spend
  -- the single-use grant on a write that leaves the profile PROFILE_INCOMPLETE
  -- and the prospect with no second link -- permanently unable to finish. It is
  -- a deficient SUBMISSION, so it is refused the way a deficient submission is,
  -- leaving the grant live for the retry.
  if v_cand is null and v_entry_row.phone is null then
    return 'invalid_submission';
  end if;

  update public.new_client_waitlist_entries e
     set first_name         = v_first,
         last_name          = case when p_single_name then null else v_last end,
         single_legal_name  = p_single_name,
         treatment_area_ids = v_areas,
         -- Written only when the entry held none. `mobile_verified_at` is NOT
         -- in this SET list: nothing a bearer link supplies may verify itself.
         phone              = case when v_cand is not null then v_cand else e.phone end,
         -- CONSENT IS EVIDENCE OF AN ACT AT A TIME, so this command may only
         -- ever ADD it. Writing the three columns unconditionally re-stamped
         -- `sms_consent_at` for someone who had already consented -- moving
         -- evidence the join command refuses to move -- and silently NULLED all
         -- three when the box was left unticked, erasing a consent through a
         -- surface that is not a withdrawal surface. Withdrawal has its own
         -- path: `sms_opted_out_at`, which the guard makes terminal.
         sms_consent_at           = case when p_sms_consent and e.sms_consent_at is null
                                         then v_now else e.sms_consent_at end,
         sms_consent_source       = case when p_sms_consent and e.sms_consent_at is null
                                         then 'prospect_link' else e.sms_consent_source end,
         sms_consent_text_version = case when p_sms_consent and e.sms_consent_at is null
                                         then 'waitlist_sms_operational_v1'
                                         else e.sms_consent_text_version end
   where e.id = v_entry;

  if v_pref is null then
    insert into public.new_client_waitlist_entry_preferences
      (entry_id, studio_id, preference, stated_at, confirmed_at, source,
       recorded_by_practitioner_id)
    values (v_entry, v_studio, p_preference, v_now, v_now, 'prospect_link', null);
  elsif v_pref = p_preference then
    update public.new_client_waitlist_entry_preferences
       set confirmed_at = v_now, source = 'prospect_link',
           recorded_by_practitioner_id = null
     where entry_id = v_entry;
  else
    update public.new_client_waitlist_entry_preferences
       set preference = p_preference, stated_at = v_now, confirmed_at = v_now,
           source = 'prospect_link', recorded_by_practitioner_id = null
     where entry_id = v_entry;
  end if;

  update public.new_client_waitlist_preference_grants
     set redeemed_at = v_now
   where id = v_grant.id;

  return 'accepted';
end;
$$;

revoke execute on function public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean) from public;
revoke execute on function public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean) from anon;
revoke execute on function public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean) from authenticated;
revoke execute on function public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean) from service_role;
grant execute on function public.complete_waitlist_profile_by_grant_v2(text, text, text, text[], text, text, boolean, boolean) to service_role;

commit;
