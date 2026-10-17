-- ===========================================================================
-- 0234 — INITIAL SAVE: answer a lost retry key by matching the claim's digest
-- ===========================================================================
--
-- *** DRAFT. PENDING SAM'S DECISION. NOT TO BE APPLIED AS-IS. ***
--
-- WHAT THIS IS. The recommended option from the proposal on #860
-- (issuecomment-6233739314), answering Codex #860 4302218408: the initial
-- save's retry key lives in React state, so a reload, tab close, browser Back
-- or route change discards it, and a committed save then becomes a DUPLICATE
-- treatment area when she re-enters the same settings. Rounds 14 and 20 froze
-- every control that could discard the key; none of them can intercept
-- navigation.
--
-- IT SUPERSEDES 0223'S `create_block_with_initial_setup`. This file carries a
-- faithful copy of that function plus exactly one hunk — the matched-claim
-- branch. It is GENERATED from 0223's text, not hand-copied, and
-- `tests/migrations/0234-initial-save-matched-claim.test.ts` asserts that the
-- two bodies differ ONLY by that hunk, so an independent edit to 0223 cannot
-- be silently overridden by this copy.
--
-- IF APPROVED, FOLD IT INTO 0223 BEFORE ANY APPLY. 0223 is unapplied, so the
-- right end state is one function in one migration and this number returned
-- to the pool. Carrying it separately is a DRAFT posture, chosen so that
-- 0223 stays byte-identical on every branch while it is being propagated.
--
-- WHY THE MATCH IS IN THE COMMAND rather than in a client prompt: the digest
-- is computed here, over the whole payload. Matching anywhere else would mean
-- a second implementation of it, and one rule in two places is the defect
-- class this lane has repaired most often. Server-side it also survives a
-- crash, a killed tab and finishing on another device.
-- ===========================================================================

begin;

set local lock_timeout = '5s';

-- THE LOOKUP THIS ADDS. The existing indexes are the (session_id,
-- idempotency_key) unique and one on block_id; neither serves a match by
-- digest.
create index if not exists treatment_area_create_claims_session_digest_idx
  on public.treatment_area_create_claims (session_id, payload_digest);

create or replace function public.create_block_with_initial_setup(
  p_session_id                     uuid,
  p_client_id                      uuid,
  p_block                          jsonb,
  p_block_extra                    jsonb,
  p_areas                          jsonb,
  p_with_entry                     boolean,
  p_area                           text,
  p_areas_list                     text[],
  p_probe_size                     text,
  p_probe_lot_id                   uuid,
  p_mode                           text,
  p_pulse_count                    integer,
  p_pulse_delay_seconds            numeric,
  p_comments                       text,
  p_observation_chips              jsonb,
  p_apilus_modality                text,
  p_energy_level                   integer,
  p_minutes_performed              integer,
  p_probe_type                     text,
  p_machine_frequency              text,
  p_hairs_treated                  integer,
  p_galvanic_ma                    numeric,
  p_galvanic_duration_seconds      integer,
  p_thermolysis_intensity_percent  integer,
  p_thermolysis_duration_seconds   numeric,
  p_units_of_lye                   numeric,
  -- The machine settings half. Null/empty means "no settings to record",
  -- which is a valid save.
  p_studio_machine_id              uuid,
  p_setup_mode_key                 text,
  p_setup_idempotency_key          text,
  p_setup_groups                   jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_block_id uuid;
  v_entry_id uuid;
  v_setup jsonb := null;
  v_studio uuid;
  v_key text;
  v_digest text;
  v_claim record;
  -- The claim matched by DIGEST rather than by key. See the hunk below.
  v_matched record;
  v_submission_id uuid;
  v_groups integer;
  v_readings integer;
begin
  -- PAYLOAD SHAPE FIRST, BEFORE THE CLAIM AND BEFORE THE BLOCK EXISTS
  -- (Codex, #860 4301531156).
  --
  -- The settings write below was guarded by `jsonb_typeof(...) = 'array'`,
  -- so a non-null payload of any other shape - an object, a string, a
  -- number, JSON `null` - SILENTLY SKIPPED the settings and still committed
  -- the treatment area. That is exactly the half-saved state this atomic
  -- command exists to remove, reached by a malformed call rather than by a
  -- failure. The standalone submission command refuses the same shape
  -- (`p_groups is null or jsonb_typeof(p_groups) <> 'array'`), so the two
  -- write paths disagreed about the same payload.
  --
  -- IT IS CHECKED HERE, not at the write, for a second reason: the claim's
  -- digest a few statements down coerces a non-array to '[]'. Left alone,
  -- a malformed call would also have RECORDED a create claim whose digest
  -- stood for a payload the command then ignored - so a later retry
  -- carrying the correct settings would match the claim and be told it had
  -- already succeeded.
  --
  -- NULL AND '[]' STILL MEAN NO SETUP, which is the one shape distinction
  -- that matters: this command legitimately creates an area with no
  -- settings, whereas the standalone submission has nothing to do without
  -- them and refuses '[]' too.
  if p_setup_groups is not null
     and jsonb_typeof(p_setup_groups) <> 'array' then
    raise exception
      'Settings must be sent as a list of groups.'
      using errcode = 'check_violation';
  end if;

  v_key := btrim(coalesce(p_setup_idempotency_key, ''));

  -- -----------------------------------------------------------------------
  -- THE CLAIM, when the caller supplied a key.
  -- -----------------------------------------------------------------------
  --
  -- NO KEY, NO CLAIM, and that is deliberate rather than a gap: a caller that
  -- supplies none gets exactly the forwarding behaviour this command had
  -- before, which is what `create_block_with_entry` has always done. Only a
  -- caller that can mint one key per save and REUSE it on a retry can be given
  -- idempotence; minting a fresh key per attempt would make every retry a new
  -- save and this table a log of nothing.
  if v_key <> '' then
    -- SHAPE FIRST, because it costs no I/O. The same bound as the
    -- submission's key, for the same reason - a short key collides, and a
    -- colliding key makes a DIFFERENT save look like a retry of this one.
    if length(v_key) < 8 or length(v_key) > 100 then
      raise exception
        'A save needs its own retry key of at least 8 characters.'
        using errcode = 'check_violation';
    end if;

    -- AUTHORIZATION BEFORE DISCLOSURE, exactly as in the submission command.
    -- Answering "does this key already exist on this session" first would tell
    -- a caller with no membership of this studio something about its records.
    -- `create_block_with_entry` asserts this again on its own account; the
    -- duplicate read is the price of not reaching into it, and 0166 stays
    -- frozen.
    v_studio := public.assert_session_writable(p_session_id, p_client_id);

    -- THE WHOLE PAYLOAD, canonicalised then hashed. Every argument the save
    -- would record is in it: a retry that differs in ANY of them is a
    -- different save and must not be answered with this one's ids.
    --
    -- THE KEYS ARE THE PARAMETER NAMES, prefix included, so the digest's
    -- coverage can be checked against the declaration above by reading down
    -- the two lists. It also keeps the model-activation guard satisfied for
    -- the right reason: that guard bans the bare string "apilus" anywhere in
    -- this migration except as `p_apilus_modality`, and a digest key called
    -- 'apilus_modality' tripped it. Naming the key after the parameter is the
    -- fix; carving out an exception in the guard would not have been.
    --
    -- NUMERIC SCALE IS TRIMMED so 120 and 120.0 are the same save. They are
    -- the same number; refusing a retry over a scale difference would be a
    -- definite refusal of a legitimate repeat.
    --
    -- THE SETUP GROUPS ARE ORDERED BY GROUP KEY, the same canonicalisation
    -- `record_treatment_setup_submission` uses, so the same save listed in a
    -- different order still matches.
    v_digest := md5(
      jsonb_build_object(
        'p_block', coalesce(p_block, 'null'::jsonb),
        'p_block_extra', coalesce(p_block_extra, 'null'::jsonb),
        'p_areas', coalesce(p_areas, 'null'::jsonb),
        'p_with_entry', p_with_entry,
        'p_area', p_area,
        'p_areas_list', to_jsonb(p_areas_list),
        'p_probe_size', p_probe_size,
        'p_probe_lot_id', p_probe_lot_id::text,
        'p_mode', p_mode,
        'p_pulse_count', p_pulse_count,
        'p_pulse_delay_seconds', to_jsonb(trim_scale(p_pulse_delay_seconds)),
        'p_comments', p_comments,
        'p_observation_chips', coalesce(p_observation_chips, 'null'::jsonb),
        'p_apilus_modality', p_apilus_modality,
        'p_energy_level', p_energy_level,
        'p_minutes_performed', p_minutes_performed,
        'p_probe_type', p_probe_type,
        'p_machine_frequency', p_machine_frequency,
        'p_hairs_treated', p_hairs_treated,
        'p_galvanic_ma', to_jsonb(trim_scale(p_galvanic_ma)),
        'p_galvanic_duration_seconds', p_galvanic_duration_seconds,
        'p_thermolysis_intensity_percent', p_thermolysis_intensity_percent,
        'p_thermolysis_duration_seconds',
          to_jsonb(trim_scale(p_thermolysis_duration_seconds)),
        'p_units_of_lye', to_jsonb(trim_scale(p_units_of_lye)),
        'p_studio_machine_id', p_studio_machine_id::text,
        'p_setup_mode_key', p_setup_mode_key,
        'p_setup_groups', coalesce(
          (select jsonb_agg(g.value order by btrim(coalesce(g.value->>'group_key', ''))) from jsonb_array_elements(case when jsonb_typeof(p_setup_groups) = 'array' then p_setup_groups else '[]'::jsonb end) g),
          '[]'::jsonb
        )
      )::text
    );

    -- SERIALISE THIS SAVE AGAINST ITS OWN RETRIES, keyed on (session, key) so
    -- unrelated saves never wait on each other. Taken BEFORE the lookup, which
    -- is the whole point: the check, the create and the claim have to be one
    -- indivisible step. Without it two concurrent retries both find no claim,
    -- both create an area, and the second dies on the unique constraint - a
    -- 23505 the caller cannot distinguish from a genuine conflict, after the
    -- duplicate area has already been written and rolled back.
    perform pg_advisory_xact_lock(
      hashtextextended(p_session_id::text || ':area-create:' || v_key, 0)
    );

    select c.payload_digest, c.block_id, c.entry_id, c.submission_id
      into v_claim
      from public.treatment_area_create_claims c
     where c.session_id = p_session_id
       and c.idempotency_key = v_key;

    if found then
      -- A KEY REUSED FOR A DIFFERENT SAVE IS A BUG, NOT A RETRY. Its own
      -- sentence, distinguishable from the submission command's, because the
      -- remedy differs: this one means a second treatment area was about to be
      -- created under a used key.
      if v_claim.payload_digest <> v_digest then
        raise exception
          'That retry key was already used to create a different treatment area.'
          using errcode = 'unique_violation';
      end if;

      -- THE ORIGINAL IDS, so a retry after a lost answer can continue rather
      -- than having to be told to go and look. The settings half is rebuilt in
      -- the SAME SHAPE a fresh save returns, counted from what is actually
      -- stored, so a caller cannot tell an absorbed retry from the original
      -- except by `reused`.
      if v_claim.submission_id is null then
        v_setup := null;
      else
        select count(*)::integer into v_groups
          from public.treatment_setup_captures c
         where c.setup_submission_id = v_claim.submission_id;
        select count(*)::integer into v_readings
          from public.treatment_setup_readings r
          join public.treatment_setup_captures c on c.id = r.capture_id
         where c.setup_submission_id = v_claim.submission_id;
        v_setup := jsonb_build_object(
          'submission_id', v_claim.submission_id,
          'groups', v_groups,
          'readings', v_readings,
          'reused', true
        );
      end if;

      return jsonb_build_object(
        'block_id', v_claim.block_id,
        'entry_id', v_claim.entry_id,
        'setup', v_setup,
        -- THE AREA ITSELF was not created by this call, which the caller needs
        -- to know: a confirmation built from this is honest either way, but a
        -- caller counting creations would otherwise count one too many.
        'reused', true
      );
    end if;

    -- ===================================================================
    -- THE MATCHED CLAIM — the only difference between this function and
    -- 0223's. DRAFT, PENDING SAM'S DECISION.
    -- ===================================================================
    --
    -- NO CLAIM FOR THIS KEY, BUT ONE FOR THIS PAYLOAD.
    --
    -- The retry key lives in React state. A reload, a tab close, browser
    -- Back or any route change discards it, and nothing in the application
    -- guards unload. So she re-enters the same settings, a NEW key is
    -- minted, the lookup above finds nothing, and a second treatment area
    -- is created carrying a duplicate copy of the settings — permanently,
    -- because captures are immutable (Codex, #860 4302218408).
    --
    -- THE KEY IS LOST; THE DIGEST IS NOT. `v_digest` above is computed from
    -- the whole payload, and she re-entered the same payload, so the
    -- earlier save's claim is findable by digest alone.
    --
    -- IT REUSES `v_digest` RATHER THAN RECOMPUTING. There is exactly one
    -- digest implementation, in this function, which is why the match is
    -- here and not in a read path a caller could get subtly different.
    --
    -- SHE IS TOLD, not silently answered: `reused` is true and the caller
    -- surfaces it. The command does not decide on her behalf that this was
    -- the same save; it reports that it was.
    --
    -- WHAT THIS LEAVES: a deliberate second area with a byte-identical
    -- payload in the same session is answered with the first one. The
    -- digest covers the area name, the areas list, every charting scalar
    -- and the settings, so that is implausible as an intent — and
    -- recoverable by altering anything. A silent duplicate clinical record
    -- is not recoverable.
    select c.block_id, c.entry_id, c.submission_id
      into v_matched
      from public.treatment_area_create_claims c
     where c.session_id = p_session_id
       and c.payload_digest = v_digest
     -- THE EARLIEST, so repeated losses converge on one area rather than
     -- chaining onto whichever was most recent.
     order by c.claimed_at, c.id
     limit 1;

    if found then
      if v_matched.submission_id is null then
        v_setup := null;
      else
        select count(*)::integer into v_groups
          from public.treatment_setup_captures c
         where c.setup_submission_id = v_matched.submission_id;
        select count(*)::integer into v_readings
          from public.treatment_setup_readings r
          join public.treatment_setup_captures c on c.id = r.capture_id
         where c.setup_submission_id = v_matched.submission_id;
        v_setup := jsonb_build_object(
          'submission_id', v_matched.submission_id,
          'groups', v_groups,
          'readings', v_readings,
          'reused', true
        );
      end if;

      return jsonb_build_object(
        'block_id', v_matched.block_id,
        'entry_id', v_matched.entry_id,
        'setup', v_setup,
        'reused', true
      );
    end if;
  end if;

  -- THE AREA FIRST, through the one command that creates one.
  select c.block_id, c.entry_id
    into v_block_id, v_entry_id
    from public.create_block_with_entry(
    p_session_id                    => p_session_id,
    p_client_id                     => p_client_id,
    p_block                         => p_block,
    p_block_extra                   => p_block_extra,
    p_areas                         => p_areas,
    p_with_entry                    => p_with_entry,
    p_area                          => p_area,
    p_areas_list                    => p_areas_list,
    p_probe_size                    => p_probe_size,
    p_probe_lot_id                  => p_probe_lot_id,
    p_mode                          => p_mode,
    p_pulse_count                   => p_pulse_count,
    p_pulse_delay_seconds           => p_pulse_delay_seconds,
    p_comments                      => p_comments,
    p_observation_chips             => p_observation_chips,
    p_apilus_modality               => p_apilus_modality,
    p_energy_level                  => p_energy_level,
    p_minutes_performed             => p_minutes_performed,
    p_probe_type                    => p_probe_type,
    p_machine_frequency             => p_machine_frequency,
    p_hairs_treated                 => p_hairs_treated,
    p_galvanic_ma                   => p_galvanic_ma,
    p_galvanic_duration_seconds     => p_galvanic_duration_seconds,
    p_thermolysis_intensity_percent => p_thermolysis_intensity_percent,
    p_thermolysis_duration_seconds  => p_thermolysis_duration_seconds,
    p_units_of_lye                  => p_units_of_lye
    ) c;

  if v_block_id is null then
    raise exception 'The treatment area could not be created.'
      using errcode = 'no_data_found';
  end if;

  -- THEN THE SETTINGS, IN THE SAME TRANSACTION. No exception handler, which
  -- is what makes this atomic: a refusal below aborts the whole call and the
  -- block created above rolls back with it. Catching anything here would
  -- reintroduce precisely the half-saved state the command exists to remove.
  if p_setup_groups is not null
     and jsonb_typeof(p_setup_groups) = 'array'
     and jsonb_array_length(p_setup_groups) > 0 then
    v_setup := public.record_treatment_setup_submission(
      v_block_id,
      p_studio_machine_id,
      p_setup_mode_key,
      p_setup_idempotency_key,
      p_setup_groups,
      -- THE ROUTE THIS COMMAND WAS ALREADY GIVEN. It created the block in
      -- `p_session_id` a few statements ago, and the client is the session's
      -- own, so the binding is satisfied by construction here rather than
      -- taken on trust from a caller - this path never had the hole
      -- (Codex, #860 4297032712). It is passed explicitly all the same,
      -- because the callee requires it and a derived value that disagreed
      -- with the block would be a bug worth failing on.
      -- `assert_session_writable(p_session_id, p_client_id)` has already
      -- validated this pair at the top of this command, so these are the
      -- AUTHORIZED ids rather than a re-derivation that could disagree with
      -- the authorization just performed.
      p_session_id,
      p_client_id
    );
  end if;

  -- THE RECEIPT, written LAST and inside this same transaction.
  --
  -- LAST because `block_id` is NOT NULL and a claim that cannot name its block
  -- answers nothing on a retry. Safe because the advisory lock above - not
  -- this insert - is what serialises a save against its own retries: no other
  -- caller can be between the lookup and here with the same (session, key).
  --
  -- AND IF ANYTHING ABOVE RAISED, THIS NEVER RUNS AND THE CLAIM DOES NOT
  -- EXIST, which is correct rather than unfortunate: nothing was recorded, so
  -- a later attempt with the same key SHOULD be a fresh save rather than being
  -- answered with ids that no longer point at anything.
  if v_key <> '' then
    insert into public.treatment_area_create_claims (
      studio_id, session_id, idempotency_key, payload_digest,
      block_id, entry_id, submission_id, claimed_by_practitioner_id
    )
    values (
      v_studio, p_session_id, v_key, v_digest,
      v_block_id, v_entry_id,
      nullif(v_setup->>'submission_id', '')::uuid,
      (select p.id from public.practitioners p
        where p.studio_id = v_studio and p.user_id = auth.uid()
          and p.active = true
        limit 1)
    );
  end if;

  return jsonb_build_object(
    'block_id', v_block_id,
    'entry_id', v_entry_id,
    -- NULL when nothing was entered, which the caller must be able to tell
    -- apart from a save that recorded zero readings.
    'setup', v_setup,
    -- FALSE, not absent: a caller reading this field must not have to treat
    -- "missing" as "fresh", because the absorbed branch above returns true.
    'reused', false
  );
end;
$$;

-- The grants 0223 sets for this function, restated verbatim because `create
-- or replace` re-runs Supabase's ALTER DEFAULT PRIVILEGES and re-grants
-- EXECUTE to anon, authenticated AND service_role at create time. Missing one
-- of them by name is the defect 0129 and 0164 each shipped once.
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from public;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from anon;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from authenticated;
revoke execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) from service_role;
grant execute on function public.create_block_with_initial_setup(uuid, uuid, jsonb, jsonb, jsonb, boolean, text, text[], text, uuid, text, integer, numeric, text, jsonb, text, integer, integer, text, text, integer, numeric, integer, integer, numeric, numeric, uuid, text, text, jsonb) to authenticated;

commit;
