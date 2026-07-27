-- 0157: whole-session "Copy areas and settings from last session" — atomic,
-- idempotent, source-authoritative batch commit + provenance ledger (Chloe).
--
-- The preview a practitioner reviews is EPHEMERAL (component memory only — it
-- creates nothing). Exactly one explicit action ("Add these areas to today's
-- chart") reaches the server, which validates canonically and calls the RPC
-- below. In ONE transaction the RPC creates the reviewed destination records
-- (per spec: a session_block + its structured areas + a first electrolysis
-- entry) and records a provenance ledger row so a retry/double-submit is an
-- at-most-once no-op.
--
-- SECURITY POSTURE (defense in depth; each layer independently sufficient):
--   * copy_session_setup is executable ONLY by service_role — the browser can
--     NOT call it directly (revoked from anon + authenticated). It is invoked
--     solely by the authenticated Next.js server action, which resolves studio +
--     active practitioner from the session and passes a SERVER-DERIVED
--     practitioner id. Because service_role bypasses RLS (auth.uid() is null),
--     the RPC itself re-verifies the practitioner is an active member of the
--     studio — it never trusts the caller for authorization.
--   * SOURCE is server-authoritative: the RPC DERIVES the canonical eligible
--     previous session itself (_whole_session_copy_source_id); it does not
--     accept an arbitrary browser-chosen previous session as the authority. The
--     preview descriptor uses the SAME derivation, so preview and commit agree.
--   * STALE source is fail-closed: the RPC recomputes the source fingerprint
--     (_whole_session_copy_fingerprint) inside the txn and rejects if it differs
--     from the fingerprint the preview was built on, or if the canonical source
--     changed — creating ZERO destination rows.
--   * TARGET is verified inside the txn under a row lock (FOR UPDATE): belongs to
--     the studio, is electrolysis, is a draft (not finalized/void), is not
--     deleted, and is EMPTY (no active blocks, no live entries). The lock
--     serializes ALL copy commits for one target session independently of the
--     idempotency key, so two DIFFERENT-key requests cannot both create a batch.
--   * SETUP-ONLY BY CONSTRUCTION: the INSERT column allow-lists carry only the
--     reusable machine/probe setup + the treated area. Outcomes (comments,
--     observation_chips, hairs_treated, tolerance/reaction/caution/numbing,
--     probe_lot_*/probe_inventory_item_id, block_name/notes, started/ended) are
--     NEVER read from the payload. minutes_performed is DELIBERATELY NOT copied
--     (see policy note below) so today's treatment-time/procedure surfaces do not
--     report performed minutes before those minutes occur.
--
-- ERRORS: the RPC raises with stable custom SQLSTATEs (class 'HN') the server
-- action maps to fixed, non-leaky business messages. No raw DB text, UUIDs,
-- constraint names or SQLSTATE reach the browser.
--
-- ADDITIVE + SAFE: one new ledger table + four new functions. NO change to any
-- existing table, column, index, policy, grant, or the 0129/0155/0156 block/area
-- RPCs. NO backfill. probe_lots + electrolysis_entries.probe_lot_id stay
-- dormant/untouched.
--
-- ROLLOUT = MIGRATION-FIRST (DB-first). The new application reads/writes these
-- objects, so this migration MUST be applied to production BEFORE the app PR
-- merges/deploys — app-first is NOT safe. DB-first IS safe: these are brand-new
-- objects the old application never references. Full order + verification:
-- docs/runbooks/0157-whole-session-copy-rollout.md
--
-- minutes_performed POLICY (whole-session bulk prefill only): this workflow
-- prefills today's chart before/at the start of a visit. Previous-session
-- minutes_performed is HISTORICAL time actually spent last visit; copying it into
-- today's live block/entry would make today's metrics report performed minutes
-- that have not happened. So the bulk copy copies machine pulse DURATIONS
-- (thermolysis/galvanic duration, pulse delay) but NOT minutes_performed;
-- destination minutes start NULL and reflect only what the practitioner records
-- today. The unrelated in-form "Copy settings" affordance is unchanged.

-- ===========================================================================
-- A. Provenance ledger — one row per committed whole-session copy batch.
-- ===========================================================================
create table if not exists public.session_copy_operations (
  id                         uuid primary key default gen_random_uuid(),
  studio_id                  uuid not null references public.studios(id) on delete cascade,
  target_session_id          uuid not null,
  source_session_id          uuid not null,
  created_by_practitioner_id uuid not null,
  idempotency_key            text not null,
  request_hash               text not null,
  source_fingerprint         text not null,
  copied_block_count         integer not null,
  created_block_ids          uuid[] not null default '{}',
  created_at                 timestamptz not null default now(),
  constraint session_copy_operations_target_same_studio_fk
    foreign key (studio_id, target_session_id)
    references public.sessions (studio_id, id) on delete cascade,
  constraint session_copy_operations_source_same_studio_fk
    foreign key (studio_id, source_session_id)
    references public.sessions (studio_id, id) on delete cascade,
  -- Same-studio composite FK for the committing practitioner (practitioners has
  -- unique (id, studio_id) from 0032), so a row can never attribute a copy to a
  -- practitioner from another studio.
  constraint session_copy_operations_practitioner_same_studio_fk
    foreign key (created_by_practitioner_id, studio_id)
    references public.practitioners (id, studio_id) on delete restrict,
  constraint session_copy_operations_idem_uniq unique (target_session_id, idempotency_key),
  constraint session_copy_operations_idem_len check (char_length(idempotency_key) between 1 and 200),
  constraint session_copy_operations_count_nonneg check (copied_block_count >= 0)
);

comment on table public.session_copy_operations is
  '0157: at-most-once provenance ledger for whole-session "Copy areas and settings" batches. One row per committed copy (unique on target_session_id + idempotency_key). Records source + target sessions, the committing practitioner, the request hash, the source fingerprint at commit, and what was created. Written ONLY by copy_session_setup (service_role-only, security definer). Stores no clinical payload.';

alter table public.session_copy_operations enable row level security;

-- Members may READ their own studio's copy-operation rows. Rows are WRITTEN only
-- by the service-role RPC (no browser insert/update/delete policy). Grants are
-- explicit (not left to Supabase defaults): SELECT for authenticated, and no
-- INSERT/UPDATE/DELETE for the browser roles.
create policy "session_copy_operations: members select"
  on public.session_copy_operations for select to authenticated
  using (public.is_studio_member(studio_id));

revoke all on public.session_copy_operations from anon;
revoke insert, update, delete on public.session_copy_operations from authenticated;
grant select on public.session_copy_operations to authenticated;

-- ===========================================================================
-- B. Core source fingerprint (private). A deterministic hash of the EXACT
--    active source material a copy reproduces (block setup + probe + areas +
--    first-entry setup readings), so any committed change/deletion to the
--    source is detectable at commit. Ordered aggregation → canonical bytes;
--    mirrors the clinical-snapshot hash idiom (0119). minutes_performed is
--    intentionally excluded (it is not copied, so it must not invalidate a
--    preview). No external grant: only owner-context callers (the functions
--    below) invoke it.
-- ===========================================================================
create or replace function public._whole_session_copy_fingerprint(p_session_id uuid)
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select encode(
    extensions.digest(
      coalesce(
        (
          select jsonb_agg(blk order by ord, blk_id)
          from (
            select
              b.sort_order as ord,
              b.id::text   as blk_id,
              jsonb_build_object(
                'mode', b.mode,
                'apilus_modality', b.apilus_modality,
                'energy_level', b.energy_level,
                'machine_frequency', b.machine_frequency,
                'probe_key', b.probe_key,
                'probe_brand', b.probe_brand,
                'probe_material', b.probe_material,
                'probe_piece_type', b.probe_piece_type,
                'probe_shank', b.probe_shank,
                'probe_size_value', b.probe_size_value,
                'probe_length', b.probe_length,
                'probe_label', b.probe_label,
                'primary_area', b.primary_area,
                'side', b.side,
                'custom_area_detail', b.custom_area_detail,
                'areas', (
                  select coalesce(
                    jsonb_agg(
                      jsonb_build_object('area', a.area, 'laterality', a.laterality, 'display_order', a.display_order)
                      order by a.display_order, a.area, a.laterality
                    ), '[]'::jsonb)
                  from public.session_block_areas a
                  where a.session_block_id = b.id
                ),
                'entry', (
                  select jsonb_build_object(
                    'mode', e.mode,
                    'apilus_modality', e.apilus_modality,
                    'energy_level', e.energy_level,
                    'machine_frequency', e.machine_frequency,
                    'thermolysis_intensity_percent', e.thermolysis_intensity_percent,
                    'thermolysis_duration_seconds', e.thermolysis_duration_seconds,
                    'galvanic_ma', e.galvanic_ma,
                    'galvanic_duration_seconds', e.galvanic_duration_seconds,
                    -- galvanic_intensity_percent is a RETIRED reading (Phase A):
                    -- it is NOT reusable setup, so it is excluded from the source
                    -- fingerprint. A historical change to ONLY that field must not
                    -- invalidate a preview built on the reusable setup.
                    'units_of_lye', e.units_of_lye,
                    'pulse_count', e.pulse_count,
                    'pulse_delay_seconds', e.pulse_delay_seconds
                  )
                  from public.electrolysis_entries e
                  where e.block_id = b.id and e.deleted_at is null
                  order by e.created_at, e.id
                  limit 1
                )
              ) as blk
            from public.session_blocks b
            where b.session_id = p_session_id and b.deleted_at is null
            order by b.sort_order, b.id
          ) t
        ),
        '[]'::jsonb
      )::text,
      'sha256'
    ),
    'hex'
  );
$$;

revoke all on function public._whole_session_copy_fingerprint(uuid) from public, anon, authenticated;

-- ===========================================================================
-- C. Core canonical-source derivation (private). Given a target session,
--    returns the studio's latest ELIGIBLE previous electrolysis session for the
--    same client (not deleted, started before the target, containing >=1 active
--    block that has >=1 structured area). This — not any browser value — is the
--    authority for WHICH session is copied. No external grant.
-- ===========================================================================
create or replace function public._whole_session_copy_source_id(
  p_studio_id uuid,
  p_target_session_id uuid
)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_client  uuid;
  v_started timestamptz;
  v_source  uuid;
begin
  select s.client_id, s.started_at
    into v_client, v_started
    from public.sessions s
   where s.id = p_target_session_id
     and s.studio_id = p_studio_id
     and s.deleted_at is null;
  if not found then
    return null;
  end if;

  -- The latest eligible prior ELECTROLYSIS session for this client that is not
  -- deleted and not VOID (draft + finalized are both valid historical sources —
  -- finalization may be disabled for a studio). A voided newer session is skipped
  -- so it can never mask an older valid source. A session is eligible only if it
  -- has >=1 active block that is COPYABLE: it has a resolvable area (>=1
  -- structured area OR a nonblank legacy primary_area) AND a valid electrolysis
  -- mode (on the block, or on its earliest live entry) — matching buildCopyDrafts.
  select ps.id
    into v_source
    from public.sessions ps
   where ps.studio_id = p_studio_id
     and ps.client_id = v_client
     and ps.id <> p_target_session_id
     and ps.deleted_at is null
     and ps.modality = 'electrolysis'
     and ps.record_status is distinct from 'void'
     and ps.started_at < coalesce(v_started, now())
     and exists (
       select 1 from public.session_blocks b
        where b.session_id = ps.id
          and b.deleted_at is null
          and (
            exists (select 1 from public.session_block_areas a where a.session_block_id = b.id)
            or coalesce(btrim(b.primary_area), '') <> ''
          )
          and coalesce(
                b.mode,
                (select e.mode from public.electrolysis_entries e
                  where e.block_id = b.id and e.deleted_at is null
                  order by e.created_at, e.id limit 1)
              ) in ('thermo', 'galv', 'blend')
     )
   order by ps.started_at desc, ps.id desc
   limit 1;

  return v_source;
end;
$$;

revoke all on function public._whole_session_copy_source_id(uuid, uuid) from public, anon, authenticated;

-- ===========================================================================
-- D. Preview source descriptor (membership-gated). The read path uses this to
--    obtain the SERVER-derived source id + fingerprint the preview is built on,
--    and to learn whether the target is currently eligible. Returns only a hash
--    + ids (never other studios' data), and is gated by is_studio_member, so it
--    is safe to grant to authenticated.
-- ===========================================================================
create or replace function public.whole_session_copy_source_descriptor(
  p_studio_id uuid,
  p_target_session_id uuid
)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_modality text;
  v_status   text;
  v_deleted  timestamptz;
  v_blocks   integer;
  v_entries  integer;
  v_source   uuid;
  v_started  timestamptz;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized' using errcode = 'HN001';
  end if;

  select s.modality, s.record_status, s.deleted_at
    into v_modality, v_status, v_deleted
    from public.sessions s
   where s.id = p_target_session_id and s.studio_id = p_studio_id;
  if not found or v_deleted is not null then
    return jsonb_build_object('eligible', false, 'reason', 'target');
  end if;
  if v_modality is distinct from 'electrolysis' or v_status is distinct from 'draft' then
    return jsonb_build_object('eligible', false, 'reason', 'target');
  end if;

  select count(*) into v_blocks
    from public.session_blocks
   where session_id = p_target_session_id and deleted_at is null;
  select count(*) into v_entries
    from public.electrolysis_entries
   where session_id = p_target_session_id and deleted_at is null;
  if v_blocks > 0 or v_entries > 0 then
    return jsonb_build_object('eligible', false, 'reason', 'not_empty');
  end if;

  v_source := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source is null then
    return jsonb_build_object('eligible', false, 'reason', 'no_source');
  end if;
  select started_at into v_started from public.sessions where id = v_source;

  return jsonb_build_object(
    'eligible', true,
    'source_session_id', v_source,
    'source_started_at', v_started,
    'source_fingerprint', public._whole_session_copy_fingerprint(v_source)
  );
end;
$$;

revoke all on function public.whole_session_copy_source_descriptor(uuid, uuid) from public, anon;
grant execute on function public.whole_session_copy_source_descriptor(uuid, uuid) to authenticated, service_role;

-- ===========================================================================
-- E. The atomic, idempotent, source-authoritative commit RPC. service_role
--    ONLY. p_specs is a JSON array of { block:{...setup...},
--    areas:[{area,laterality,display_order}], entry:{...setup readings...}|null }
--    already normalized/validated by the server action.
-- ===========================================================================
create or replace function public.copy_session_setup(
  p_studio_id                   uuid,
  p_target_session_id           uuid,
  p_practitioner_id             uuid,
  p_specs                       jsonb,
  p_idempotency_key             text,
  p_expected_source_fingerprint text,
  p_expected_source_session_id  uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client       uuid;
  v_started      timestamptz;
  v_modality     text;
  v_status       text;
  v_blocks       integer;
  v_entries      integer;
  v_source       uuid;
  v_source2      uuid;
  v_fp           text;
  v_req_hash     text;
  v_prior_ids    uuid[];
  v_prior_hash   text;
  v_ids          uuid[] := '{}';
  v_sort         integer := 0;
  v_block_id     uuid;
  spec           jsonb;
  b              public.session_blocks%rowtype;
  e              public.electrolysis_entries%rowtype;
begin
  -- 1. Authorization: the passed practitioner must be an ACTIVE member of the
  --    studio (service_role bypasses RLS, so we check explicitly here).
  perform 1 from public.practitioners
    where id = p_practitioner_id and studio_id = p_studio_id and active = true;
  if not found then
    raise exception 'not authorized' using errcode = 'HN001';
  end if;

  -- 2. Input shape (defense in depth). The source identity + fingerprint are
  --    REQUIRED — a commit cannot proceed without the preview's source.
  if p_idempotency_key is null or char_length(trim(p_idempotency_key)) = 0
     or p_expected_source_session_id is null
     or p_expected_source_fingerprint is null then
    raise exception 'invalid request' using errcode = 'HN007';
  end if;
  if jsonb_typeof(coalesce(p_specs, 'null'::jsonb)) is distinct from 'array'
     or jsonb_array_length(p_specs) = 0
     or jsonb_array_length(p_specs) > 50 then
    raise exception 'invalid request' using errcode = 'HN007';
  end if;

  -- Request hash over the BROWSER-provided request (target + source identity +
  -- source fingerprint + specs), SHA-256 via pgcrypto. Stable per preview so a
  -- genuine retry matches; a different payload or source does not.
  v_req_hash := encode(extensions.digest(
    p_target_session_id::text || '|' ||
    p_expected_source_session_id::text || '|' ||
    p_expected_source_fingerprint || '|' ||
    p_specs::text, 'sha256'), 'hex');

  -- 3. Lock the TARGET session row (serializes all copies for one target,
  --    key-independent). Correctness relies on READ COMMITTED (PostgREST default):
  --    after the lock releases, the loser's emptiness recount takes a fresh
  --    snapshot and sees the winner's rows. Do NOT run under REPEATABLE READ.
  select s.client_id, s.started_at, s.modality, s.record_status
    into v_client, v_started, v_modality, v_status
    from public.sessions s
   where s.id = p_target_session_id
     and s.studio_id = p_studio_id
     and s.deleted_at is null
   for update;
  if not found then
    raise exception 'target not found' using errcode = 'HN002';
  end if;

  -- 4. Idempotency: an already-committed batch (same key) short-circuits BEFORE
  --    the emptiness/source work. Same request → replay; different payload/source
  --    (different hash) → reject as ambiguous.
  select created_block_ids, request_hash
    into v_prior_ids, v_prior_hash
    from public.session_copy_operations
   where target_session_id = p_target_session_id
     and idempotency_key = p_idempotency_key;
  if found then
    if v_prior_hash is distinct from v_req_hash then
      raise exception 'ambiguous idempotency key' using errcode = 'HN006';
    end if;
    return jsonb_build_object(
      'created_block_ids', to_jsonb(v_prior_ids),
      'copied_block_count', coalesce(array_length(v_prior_ids, 1), 0),
      'idempotent_replay', true
    );
  end if;

  -- 5. Target must be an editable, empty electrolysis draft.
  if v_modality is distinct from 'electrolysis' or v_status is distinct from 'draft' then
    raise exception 'target not eligible' using errcode = 'HN002';
  end if;
  select count(*) into v_blocks
    from public.session_blocks
   where session_id = p_target_session_id and deleted_at is null;
  select count(*) into v_entries
    from public.electrolysis_entries
   where session_id = p_target_session_id and deleted_at is null;
  if v_blocks > 0 or v_entries > 0 then
    raise exception 'target not empty' using errcode = 'HN003';
  end if;

  -- 6. Derive the canonical source (server-authoritative); the browser's id must
  --    match it exactly.
  v_source := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source is null then
    raise exception 'no eligible source' using errcode = 'HN004';
  end if;
  if p_expected_source_session_id <> v_source then
    raise exception 'source changed' using errcode = 'HN005';
  end if;

  -- 6b. Pin the SOURCE against concurrent edits for the rest of the txn, in a
  --     deterministic order (session → blocks → areas → entries, by id) to avoid
  --     deadlocks. FOR UPDATE on the session + block rows also blocks concurrent
  --     child INSERTs (their FK validation needs FOR KEY SHARE, which conflicts),
  --     so no phantom block/area/entry can be attached mid-commit. Re-derive after
  --     the session lock; reject if the canonical source changed.
  perform 1 from public.sessions where id = v_source for update;
  v_source2 := public._whole_session_copy_source_id(p_studio_id, p_target_session_id);
  if v_source2 is distinct from v_source then
    raise exception 'source changed' using errcode = 'HN005';
  end if;
  -- Aliases sb/sba/se avoid colliding with the declared rowtype vars b/e.
  perform sb.id from public.session_blocks sb
    where sb.session_id = v_source and sb.deleted_at is null
    order by sb.id for update;
  perform sba.id from public.session_block_areas sba
    where sba.session_block_id in (
      select sb.id from public.session_blocks sb
       where sb.session_id = v_source and sb.deleted_at is null)
    order by sba.id for update;
  perform se.id from public.electrolysis_entries se
    where se.session_id = v_source and se.deleted_at is null
    order by se.id for update;

  -- 7. Now that the source is pinned, compute the fingerprint and reject if it
  --    differs from the one the preview was built on (zero rows on mismatch).
  v_fp := public._whole_session_copy_fingerprint(v_source);
  if v_fp is distinct from p_expected_source_fingerprint then
    raise exception 'source changed' using errcode = 'HN005';
  end if;

  -- 8. Create the reviewed records. SETUP columns only (no outcomes, no
  --    minutes_performed). jsonb_populate_record parses the payload into the
  --    rowtype; we then read only the allow-listed setup fields.
  for spec in select value from jsonb_array_elements(p_specs) loop
    b := jsonb_populate_record(null::public.session_blocks, spec->'block');
    if jsonb_array_length(coalesce(spec->'areas', '[]'::jsonb)) = 0
       or jsonb_array_length(coalesce(spec->'areas', '[]'::jsonb)) > 25 then
      raise exception 'invalid request' using errcode = 'HN007';
    end if;
    v_sort := v_sort + 1;
    insert into public.session_blocks (
      studio_id, session_id, sort_order,
      mode, apilus_modality, energy_level, machine_frequency,
      probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
      probe_size_value, probe_length, probe_label,
      primary_area, side, custom_area_detail
    ) values (
      p_studio_id, p_target_session_id, v_sort,
      b.mode, b.apilus_modality, b.energy_level, b.machine_frequency,
      b.probe_key, b.probe_brand, b.probe_material, b.probe_piece_type, b.probe_shank,
      b.probe_size_value, b.probe_length, b.probe_label,
      b.primary_area, b.side, b.custom_area_detail
    )
    returning id into v_block_id;
    v_ids := v_ids || v_block_id;

    insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
    select v_block_id, p_studio_id, (a->>'area'), (a->>'laterality'),
           coalesce((a->>'display_order')::int, (ord - 1)::int)
      from jsonb_array_elements(spec->'areas') with ordinality as t(a, ord);

    if (spec ? 'entry') and (spec->'entry') is not null and jsonb_typeof(spec->'entry') = 'object' then
      e := jsonb_populate_record(null::public.electrolysis_entries, spec->'entry');
      insert into public.electrolysis_entries (
        session_id, block_id, area, areas,
        mode, apilus_modality, energy_level, machine_frequency,
        thermolysis_intensity_percent, thermolysis_duration_seconds,
        galvanic_ma, galvanic_duration_seconds, galvanic_intensity_percent,
        units_of_lye, pulse_count, pulse_delay_seconds
      ) values (
        p_target_session_id, v_block_id, e.area, coalesce(e.areas, array[e.area]::text[]),
        e.mode, e.apilus_modality, e.energy_level, e.machine_frequency,
        e.thermolysis_intensity_percent, e.thermolysis_duration_seconds,
        -- galvanic_intensity_percent is a RETIRED reading (Phase A): a NEW copied
        -- entry ALWAYS stores a literal NULL. The spec never carries it (canonical
        -- normalization drops it), and this literal makes the RPC authoritative —
        -- even a forged spec containing galvanic_intensity_percent=42 stores NULL.
        e.galvanic_ma, e.galvanic_duration_seconds, NULL,
        -- pulse_count is NOT NULL (default single-pulse); coalesce when the
        -- reviewed source had none so the copy matches the column default.
        e.units_of_lye, coalesce(e.pulse_count, 1), e.pulse_delay_seconds
      );
    end if;
  end loop;

  -- 9. Provenance ledger.
  insert into public.session_copy_operations (
    studio_id, target_session_id, source_session_id, created_by_practitioner_id,
    idempotency_key, request_hash, source_fingerprint, copied_block_count, created_block_ids
  ) values (
    p_studio_id, p_target_session_id, v_source, p_practitioner_id,
    p_idempotency_key, v_req_hash, v_fp, coalesce(array_length(v_ids, 1), 0), v_ids
  );

  return jsonb_build_object(
    'created_block_ids', to_jsonb(v_ids),
    'copied_block_count', coalesce(array_length(v_ids, 1), 0),
    'idempotent_replay', false
  );
end;
$$;

revoke all on function public.copy_session_setup(uuid, uuid, uuid, jsonb, text, text, uuid) from public, anon, authenticated;
grant execute on function public.copy_session_setup(uuid, uuid, uuid, jsonb, text, text, uuid) to service_role;

-- Verification SQL (operator runs after apply):
--   select conname from pg_constraint where conname in ('session_copy_operations_idem_uniq','session_copy_operations_target_same_studio_fk','session_copy_operations_source_same_studio_fk');
--   select proname, prosecdef from pg_proc where proname in ('copy_session_setup','whole_session_copy_source_descriptor','_whole_session_copy_fingerprint','_whole_session_copy_source_id');
--   select has_function_privilege('authenticated','public.copy_session_setup(uuid,uuid,uuid,jsonb,text,text,uuid)','execute');  -- false
--   select has_function_privilege('anon','public.whole_session_copy_source_descriptor(uuid,uuid)','execute');                    -- false
--   select has_function_privilege('authenticated','public.whole_session_copy_source_descriptor(uuid,uuid)','execute');           -- true
