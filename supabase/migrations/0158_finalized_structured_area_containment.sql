-- ---------------------------------------------------------------------------
-- Migration 0158: CONTAINMENT for P0 "finalized structured treatment areas are
-- mutable, unsigned and outside the correction lineage" (audit F-CLIN-000).
--
-- THE DEFECT (independently verified against production at migration 0157).
-- Migration 0128 made `session_block_areas` the AUTHORITATIVE structured
-- treatment-area + per-area laterality representation: `lib/sessions/block-areas.ts`
-- reads those rows in preference to the legacy `session_blocks.primary_area/side`
-- projection whenever any exist. But 0128 shipped the table OUTSIDE every
-- clinical-integrity mechanism introduced by 0119/0120:
--
--   * 0119 attached `guard_finalized_clinical_write` to sessions, session_blocks,
--     electrolysis_entries, laser_entries and treatment_images — NOT to
--     session_block_areas. The table's only trigger was the 0128 studio-derive
--     trigger, so a finalized parent imposed no restriction whatsoever.
--   * `authenticated` held EVERY table privilege on session_block_areas
--     (verified in production: SELECT/INSERT/UPDATE/DELETE/TRUNCATE/REFERENCES/
--     TRIGGER all true) under a single `FOR ALL` RLS policy, so any studio member's
--     browser JWT could POST/PATCH/DELETE the rows directly through PostgREST.
--     TRUNCATE in particular is not an RLS-checked operation at all.
--   * `build_session_snapshot` (0119) serializes only the LEGACY block projection
--     (`primary_area`, `side`, `custom_area_detail`). Structured area rows are not
--     in the signed document, so changing them does not change the content hash.
--   * The 0120 correction framework has appliers for sessions, session_blocks,
--     electrolysis_entries, laser_entries and treatment_images only. There is NO
--     applier, and no snapshot representation, for structured areas — so an area
--     change can be neither versioned nor restored.
--
-- Net effect: a finalized clinical record's authoritative treated areas and
-- laterality could be silently rewritten while `record_status`, `finalized_at`,
-- `record_version`, `current_snapshot_id` and the signed `content_hash` all
-- stayed byte-identical. That is a clinical-record integrity defect independent
-- of feature-flag state (flags affect exposure, not the defect).
--
-- WHAT THIS MIGRATION DOES — CONTAINMENT ONLY.
--   1. A DB-level finalized-parent guard on session_block_areas covering INSERT,
--      UPDATE, DELETE, block reassignment and reorder, for EVERY role reachable
--      from the application (anon, authenticated, service_role), with NO
--      correction-context bypass (there is no structured-area correction mechanism
--      yet, so a bypass would be a hole, not a feature).
--   2. The guard resolves the parent encounter SERVER-SIDE from the row's
--      session_block_id and takes a `FOR NO KEY UPDATE` row lock on public.sessions
--      — the strongest mode that still conflicts with the `FOR UPDATE` that
--      finalize_session/correct_finalized_session/copy_session_setup take while
--      remaining compatible with the FOR KEY SHARE an ordinary child insert needs.
--      An area write and a finalization therefore cannot interleave. (The one
--      unlocked path is the FK ON DELETE CASCADE cleanup, where the parent block —
--      and with it the only route to the session — is already gone. That path is
--      closed one level up by item 6, not by this lock.)
--   3. ONCE FINALIZED, ALWAYS FROZEN. The freeze keys on the finalization EVIDENCE
--      (finalized_at / current_snapshot_id / the existence of a signed snapshot),
--      not only on the current record_status — otherwise the 0120
--      hone.correction_session_id permit would let a direct-connection caller flip
--      a finalized session back to 'draft', rewrite areas, and flip it back with
--      every signed field untouched. clinical_record_snapshots is append-only for
--      every role (0119), so that evidence cannot be edited away.
--   4. Direct browser DML is revoked: PUBLIC/anon/authenticated lose every write
--      privilege on the table (TRUNCATE/REFERENCES/TRIGGER included — none of which
--      RLS protects), and service_role loses TRUNCATE/REFERENCES/TRIGGER too, since
--      TRUNCATE fires no row trigger and would otherwise empty a finalized record's
--      areas invisibly. authenticated keeps studio-scoped SELECT via a narrowed
--      SELECT-only policy. Every legitimate write already flows through the two
--      SECURITY DEFINER charting RPCs plus copy_session_setup (0157) — verified:
--      the application contains ZERO direct writes to this table.
--   5. `create_session_block_with_areas` / `update_session_block_with_areas` are
--      hardened to derive authority server-side, lock the parent session FIRST
--      (establishing a single global sessions -> blocks -> areas lock order that
--      matches copy_session_setup), require a non-deleted DRAFT encounter, validate
--      same-studio/same-session lineage, and preserve the existing
--      optimistic-concurrency contract and payload shape. Taking a session lock at
--      all is what forced the FOR NO KEY UPDATE choice above; both directions of
--      the resulting concurrency are covered by tests
--      (tests/db/finalized-structured-area-containment.db.test.ts): area-write-first
--      vs finalize-first, and area-save vs area-removal (the 0123 lock sequence).
--   6. A narrow guard on public.session_blocks (INSERT / reparent-UPDATE / DELETE)
--      refuses to touch a block when either endpoint session has EVER been signed.
--      Two routes change a finalized record's structured areas WITHOUT writing a
--      single session_block_areas row, so the area guard never fires on them:
--        * ERASE — hard-delete the parent block; the areas go with it by FK cascade,
--          and by the time the area trigger runs there is no session left to resolve.
--        * REPARENT — move a block carrying areas into the signed record (or move its
--          own block out). REPRODUCED as service_role: a signed record's area count
--          went 2 -> 4 with record_status, record_version, current_snapshot_id and
--          content_hash all byte-identical.
--      0119 permits both after the status round-trip in (3), because its child-table
--      branches compare only sessions.record_status. This guard keys on the
--      append-only snapshot instead. Inert for every legitimate flow.
--   7. The 0128 studio-derive trigger is widened to fire on an UPDATE of studio_id
--      as well as session_block_id, closing a re-tenanting gap (a studio_id-only
--      UPDATE previously escaped the anti-spoof derivation).
--
-- WHAT THIS MIGRATION DELIBERATELY DOES NOT DO.
--   * No backfill, no area rewrite, no snapshot regeneration, no record_status
--     change, no flag change, no historical-record modification. Purely additive
--     schema-level behaviour; ZERO data operations.
--   * It does NOT add structured areas to the signed snapshot and does NOT add a
--     structured-area correction applier. Those are "snapshot v2", a MANDATORY
--     follow-up: until it ships, a finalized record's signed artifact still does
--     not cover its authoritative areas, and a mis-recorded area cannot be
--     corrected — only frozen. Clinical finalization MUST NOT be enabled for any
--     studio before that follow-up lands. See
--     docs/runbooks/0158-finalized-structured-area-containment.md.
--
-- SAFETY AT APPLY TIME. Production currently has 8 structured-area rows across 8
-- draft blocks in one studio, 1 finalized session (a non-Willow test studio,
-- finalized 2026-07-11, ZERO structured-area rows), and clinical_finalization_enabled
-- = false for all 5 studios. Every guard is therefore inert against existing data,
-- and the deployed application (which never writes this table directly) is
-- unaffected by the grant revocation.
--
-- READ THOSE COUNTS WITH THE RIGHT LIMIT. session_block_areas has no updated_at, no
-- deleted_at and no history table, so they evidence CURRENT state only. They cannot
-- prove that no UPDATE or DELETE ever touched a finalized record's areas — a row
-- edited or deleted after finalization would have left no trace of any kind. That
-- baseline becomes reconstructible only once structured areas are inside the signed
-- snapshot (snapshot v2). Absence of evidence is not evidence of absence.
--
-- Migration max 0157 -> 0158.
-- ---------------------------------------------------------------------------

-- Fail fast instead of stalling live charting. Every DROP/CREATE TRIGGER,
-- DROP/CREATE POLICY and REVOKE/GRANT below needs ACCESS EXCLUSIVE on
-- public.session_block_areas, and a queued ACCESS EXCLUSIVE request makes every
-- NEW reader queue behind it — so an apply contending with an in-flight charting
-- read would otherwise block reads for as long as that read runs. With a bounded
-- lock_timeout the whole migration aborts in seconds and can simply be retried;
-- it is fully replayable (every create is OR REPLACE, every drop IF EXISTS) and
-- performs zero data operations, so a failed attempt leaves nothing behind.
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. Shared server-side authority check for structured-area writes.
--    Locks the parent encounter and asserts it is an editable draft.
-- ===========================================================================
-- SECURITY DEFINER so the check always sees the TRUE parent row regardless of the
-- caller's RLS visibility: a guard that could be made to see "no parent" by an
-- RLS-invisible row would be trivially defeatable. search_path is pinned to ''
-- and every reference is schema-qualified.
create or replace function public.assert_session_chartable(
  p_session_id uuid,
  p_studio_id  uuid default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_studio  uuid;
  v_status  text;
  v_deleted timestamptz;
  v_final   timestamptz;
  v_snap    uuid;
begin
  if p_session_id is null then
    raise exception 'a session id is required' using errcode = 'check_violation';
  end if;

  -- Lock the encounter aggregate root BEFORE any child row is touched. This both
  -- serializes against finalization and fixes the global lock order at
  -- sessions -> session_blocks -> session_block_areas (the order
  -- copy_session_setup already uses).
  --
  -- WHY `for no key update` AND NOT `for update`. It is the strongest mode that
  -- is still COMPATIBLE with FOR KEY SHARE, the lock Postgres takes on a parent
  -- row when a child row referencing it is inserted. soft_delete_session_area
  -- (0123) locks a session_blocks row FIRST and only then inserts its
  -- session_audit row — which needs FOR KEY SHARE on this very session. With
  -- `for update` here, that is a genuine cycle: a concurrent area save and a
  -- concurrent area removal deadlock (reproduced: SQLSTATE 40P01). FOR NO KEY
  -- UPDATE still conflicts with the FOR UPDATE that finalize_session (0119 §7),
  -- correct_finalized_session (0120) and copy_session_setup (0157) take, and with
  -- itself — so an area write and a finalization still cannot interleave, and two
  -- concurrent area writes on one encounter are still serialized. It simply stops
  -- blocking ordinary child inserts that were never in conflict with us.
  select s.studio_id, s.record_status, s.deleted_at, s.finalized_at, s.current_snapshot_id
    into v_studio, v_status, v_deleted, v_final, v_snap
    from public.sessions s
   where s.id = p_session_id
   for no key update;
  if not found then
    raise exception 'session % not found', p_session_id using errcode = 'check_violation';
  end if;

  -- Tenancy is derived from the STORED row, never from the caller's argument; a
  -- forged p_studio_id can only ever narrow, never re-tenant.
  if p_studio_id is not null and v_studio is distinct from p_studio_id then
    raise exception 'session % not found in studio %', p_session_id, p_studio_id
      using errcode = 'check_violation';
  end if;

  if v_deleted is not null then
    raise exception 'This session is deleted and can no longer be charted.'
      using errcode = 'check_violation';
  end if;

  if v_status is distinct from 'draft' then
    raise exception
      'This clinical record is finalized and read-only. Treatment areas and laterality cannot be changed after finalization (structured-area corrections are a later phase).'
      using errcode = 'check_violation';
  end if;

  -- ONCE-FINALIZED IS ALWAYS FROZEN. Keying the freeze on record_status alone
  -- would leave a status round-trip open: the 0120 correction permit
  -- (hone.correction_session_id) lets a direct-connection caller flip a finalized
  -- session back to 'draft', mutate, and flip it back — with record_version,
  -- current_snapshot_id and the signed content_hash untouched. So we also reject
  -- on the finalization EVIDENCE, and the last check is the tamper-resistant one:
  -- clinical_record_snapshots is append-only for EVERY role (0119
  -- guard_snapshot_append_only), so a signed snapshot cannot be edited away to
  -- reopen the window. Nothing legitimate regresses — the product has no
  -- un-finalize path, and a session with a snapshot is never chartable again.
  if v_final is not null or v_snap is not null
     or exists (select 1 from public.clinical_record_snapshots cs
                 where cs.session_id = p_session_id) then
    raise exception
      'This clinical record has been finalized and signed. Its treatment areas are permanently frozen (structured-area corrections are a later phase).'
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function public.assert_session_chartable(uuid, uuid) is
  '0158: locks the parent encounter FOR NO KEY UPDATE — conflicting with the FOR UPDATE finalize_session takes, but compatible with a child insert''s FOR KEY SHARE — and asserts it is a non-deleted, never-signed DRAFT owned by the given studio. Server-authoritative: tenancy comes from the stored row. Called by the structured-area guard trigger and by the charting RPCs.';

revoke all on function public.assert_session_chartable(uuid, uuid) from public, anon, authenticated, service_role;

-- ===========================================================================
-- 2. Finalized-parent guard on public.session_block_areas.
-- ===========================================================================
-- Lifecycle assertion used by the guard below. Split out from
-- assert_session_chartable because DELETE must stay possible for a SOFT-DELETED
-- draft (ordinary cleanup), while INSERT/UPDATE require a live draft. Both
-- variants reject finalized/void.
create or replace function public.assert_structured_area_parent_mutable(
  p_session_id     uuid,
  p_allow_deleted  boolean
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_status  text;
  v_deleted timestamptz;
  v_final   timestamptz;
  v_snap    uuid;
begin
  -- Same encounter lock, same mode and same reasoning as assert_session_chartable:
  -- FOR NO KEY UPDATE conflicts with finalization's FOR UPDATE but not with the
  -- FOR KEY SHARE that ordinary child inserts take.
  select s.record_status, s.deleted_at, s.finalized_at, s.current_snapshot_id
    into v_status, v_deleted, v_final, v_snap
    from public.sessions s
   where s.id = p_session_id
   for no key update;
  if not found then
    raise exception 'the parent session of this treatment area no longer exists'
      using errcode = 'check_violation';
  end if;

  if v_status is distinct from 'draft' then
    raise exception
      'This clinical record is finalized and read-only. Treatment areas and laterality cannot be added, changed, reordered, moved or removed after finalization (structured-area corrections are a later phase).'
      using errcode = 'check_violation';
  end if;

  -- Once-finalized is always frozen, even if record_status was flipped back —
  -- see the identical reasoning in assert_session_chartable. The snapshot
  -- existence probe is the tamper-resistant leg: clinical_record_snapshots is
  -- append-only for every role (0119), so the evidence cannot be edited away.
  if v_final is not null or v_snap is not null
     or exists (select 1 from public.clinical_record_snapshots cs
                 where cs.session_id = p_session_id) then
    raise exception
      'This clinical record has been finalized and signed. Its treatment areas are permanently frozen (structured-area corrections are a later phase).'
      using errcode = 'check_violation';
  end if;

  if not p_allow_deleted and v_deleted is not null then
    raise exception 'This session is deleted and can no longer be charted.'
      using errcode = 'check_violation';
  end if;
end;
$$;

comment on function public.assert_structured_area_parent_mutable(uuid, boolean) is
  '0158: locks the parent encounter FOR NO KEY UPDATE (see assert_session_chartable) and rejects the write when it is finalized, void, or has ever been signed (and, unless p_allow_deleted, when it is soft-deleted). No correction-context bypass exists: structured areas have no correction representation yet.';

revoke all on function public.assert_structured_area_parent_mutable(uuid, boolean)
  from public, anon, authenticated, service_role;

-- The guard itself. Fires for EVERY role (triggers are not bypassed by
-- service_role or by RLS exemption) on INSERT, UPDATE and DELETE. UPDATE checks
-- BOTH the old and the new parent block, so reassigning an area row into or out
-- of a finalized record is rejected; reorder (display_order) and re-labelling are
-- ordinary UPDATEs and are therefore covered by the same check.
create or replace function public.guard_finalized_structured_area_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session_id uuid;
begin
  if tg_op = 'DELETE' then
    -- Resolve the parent through OLD.session_block_id.
    select b.session_id into v_session_id
      from public.session_blocks b where b.id = old.session_block_id;
    if not found then
      -- The parent block is ALREADY gone, so there is no session left to resolve.
      -- The only way a row trigger runs in that state is the FK ON DELETE CASCADE
      -- chain (studios -> sessions -> session_blocks -> session_block_areas), so
      -- allow the cleanup rather than wedging ordinary draft/tenant deletion.
      --
      -- BE PRECISE ABOUT WHY THAT IS SAFE. It is NOT because 0119 makes every
      -- snapshot-carrying session undeletable — 0119's child-table DELETE branch
      -- only inspects sessions.record_status, and the "carrying a snapshot" test
      -- exists solely on its `sessions` branch. A caller who flipped record_status
      -- back to 'draft' through the 0120 permit could therefore hard-delete the
      -- parent BLOCK and erase a signed record's areas by cascade, right past this
      -- early return. That hole is closed one level up, by
      -- guard_signed_record_block_delete below, which refuses to delete any
      -- session_blocks row belonging to a session that has EVER been signed —
      -- regardless of its current record_status. With that in place, a cascade
      -- reaching here provably descends from a never-signed encounter.
      return old;
    end if;
    perform public.assert_structured_area_parent_mutable(v_session_id, true);
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Old parent: covers value edits, reorder, and moving a row OUT of a record.
    select b.session_id into v_session_id
      from public.session_blocks b where b.id = old.session_block_id;
    if not found then
      raise exception
        'session_block_areas.session_block_id % does not reference an existing settings block',
        old.session_block_id using errcode = 'check_violation';
    end if;
    perform public.assert_structured_area_parent_mutable(v_session_id, false);

    -- New parent, when the row is being reassigned: covers moving a row INTO a
    -- finalized record.
    if new.session_block_id is distinct from old.session_block_id then
      select b.session_id into v_session_id
        from public.session_blocks b where b.id = new.session_block_id;
      if not found then
        raise exception
          'session_block_areas.session_block_id % does not reference an existing settings block',
          new.session_block_id using errcode = 'check_violation';
      end if;
      perform public.assert_structured_area_parent_mutable(v_session_id, false);
    end if;
    return new;
  end if;

  -- INSERT.
  select b.session_id into v_session_id
    from public.session_blocks b where b.id = new.session_block_id;
  if not found then
    raise exception
      'session_block_areas.session_block_id % does not reference an existing settings block',
      new.session_block_id using errcode = 'check_violation';
  end if;
  perform public.assert_structured_area_parent_mutable(v_session_id, false);
  return new;
end;
$$;

drop trigger if exists session_block_areas_guard_finalized on public.session_block_areas;
create trigger session_block_areas_guard_finalized
  before insert or update or delete on public.session_block_areas
  for each row execute function public.guard_finalized_structured_area_write();

-- Close the two routes that change a finalized record's structured areas WITHOUT
-- writing a single session_block_areas row, which the area guard above therefore
-- cannot see:
--   * ERASE  — hard-delete the parent block; the areas follow by FK cascade, and by
--              the time the area trigger fires the only route to the session is gone.
--   * REPARENT — move a block (and its whole area set) into the signed record, or
--              move the signed record's own block out.
-- 0119 does not close either: its child-table DELETE and UPDATE branches compare
-- only sessions.record_status, and the "has a snapshot" test lives exclusively on
-- its `sessions` branch — so both are permitted after the record_status round-trip
-- described above. The reparent was REPRODUCED as service_role during review: a
-- signed record's authoritative area count went 2 -> 4 with record_status,
-- record_version, current_snapshot_id and content_hash all byte-identical.
--
-- This guard keys on the APPEND-ONLY snapshot instead of record_status, so a status
-- round-trip buys nothing. It is INERT for every legitimate flow:
-- clinical_record_snapshots_session_fk is RESTRICT (a snapshot-carrying session
-- cannot be deleted at all), blocks of a finalized/void record are already frozen by
-- 0119, and ordinary charting UPDATEs never touch session_id. Soft-delete — the
-- product's actual removal path (soft_delete_session_area, 0123) — is an UPDATE that
-- leaves session_id alone and is unaffected.
create or replace function public.guard_signed_record_block_write()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_msg constant text :=
    'This clinical record has been finalized and signed. Its treatment areas cannot be added, moved or deleted (structured-area corrections are a later phase).';
begin
  if tg_op = 'DELETE' then
    -- Closes the CASCADE-ERASE route: deleting the block deletes its areas.
    if exists (select 1 from public.clinical_record_snapshots cs
                where cs.session_id = old.session_id) then
      raise exception '%', v_msg using errcode = 'check_violation';
    end if;
    return old;
  end if;

  if tg_op = 'UPDATE' then
    -- Closes the REPARENT route. Moving a block carries its whole structured-area
    -- set with it, and writes NO session_block_areas row — so the area guard never
    -- fires. 0119's child UPDATE branch only compares record_status at the two
    -- endpoints, which the 0120 permit can round-trip to 'draft'; reproduced as
    -- service_role, a signed record's area count went 2 -> 4 with its content_hash
    -- byte-identical. Only a genuine move is checked, so ordinary charting UPDATEs
    -- (which never touch session_id) are untouched.
    if new.session_id is distinct from old.session_id then
      if exists (select 1 from public.clinical_record_snapshots cs
                  where cs.session_id in (old.session_id, new.session_id)) then
        raise exception '%', v_msg using errcode = 'check_violation';
      end if;
    end if;
    return new;
  end if;

  -- INSERT: no new settings block may be attached to a record that has been signed.
  if exists (select 1 from public.clinical_record_snapshots cs
              where cs.session_id = new.session_id) then
    raise exception '%', v_msg using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_signed_record_block_write() is
  '0158: refuses to insert, reparent or hard-delete a session_blocks row when either endpoint session has EVER been signed. Closes the two routes that change a finalized record''s structured treatment areas WITHOUT writing session_block_areas — the ON DELETE CASCADE erase and the block reparent — both of which the 0119 guard permits after a record_status round-trip through the 0120 correction permit. Keyed on the append-only snapshot, not on record_status. Inert for every legitimate flow.';

drop trigger if exists session_blocks_guard_signed_delete on public.session_blocks;
drop trigger if exists session_blocks_guard_signed_write on public.session_blocks;
create trigger session_blocks_guard_signed_write
  before insert or update or delete on public.session_blocks
  for each row execute function public.guard_signed_record_block_write();

-- Close a gap in the 0128 anti-spoof trigger while we are here. It was declared
-- `before insert or update OF session_block_id`, so an UPDATE that touched ONLY
-- studio_id never re-derived it — leaving a row whose denormalized studio_id
-- disagreed with its parent block, readable by the WRONG studio through the
-- studio-scoped SELECT policy and invisible to its real owner. Adding studio_id
-- to the column list makes the derive fire on exactly the writes that could
-- re-tenant a row. The column list is kept narrow deliberately: an unrestricted
-- UPDATE clause would make this INVOKER trigger resolve the parent block on every
-- edit, which fails for any role without a direct SELECT grant on
-- public.session_blocks. The function itself is unchanged.
drop trigger if exists session_block_areas_derive_studio on public.session_block_areas;
create trigger session_block_areas_derive_studio
  before insert or update of session_block_id, studio_id on public.session_block_areas
  for each row execute function public.session_block_areas_derive_studio();

-- ===========================================================================
-- 3. Least privilege: no direct browser DML on the authoritative area table.
-- ===========================================================================
-- Mirrors the 0119 clinical_record_snapshots / 0157 session_copy_operations
-- posture. `revoke all` first because RLS does NOT protect TRUNCATE, REFERENCES or
-- TRIGGER, and Supabase's ALTER DEFAULT PRIVILEGES had granted authenticated the
-- FULL privilege set on this table (verified in production before this migration).
revoke all on table public.session_block_areas from public;
revoke all on table public.session_block_areas from anon;
revoke all on table public.session_block_areas from authenticated;

-- Studio members keep read access; the RLS policy below still scopes it per studio.
grant select on table public.session_block_areas to authenticated;

-- service_role keeps row DML — the guard trigger binds it exactly as it binds
-- everyone else — but LOSES the three privileges a row trigger cannot see.
-- TRUNCATE is the important one: it is statement-level, fires no BEFORE ROW
-- trigger and consults no policy, so `truncate public.session_block_areas` as
-- service_role would empty a finalized record's authoritative areas while
-- record_status, finalized_at, record_version, current_snapshot_id and the signed
-- content_hash all stayed byte-identical — precisely the failure this migration
-- exists to eliminate. Nothing in the product truncates this table, so revoking
-- costs nothing. REFERENCES and TRIGGER go with it: both let a caller attach new
-- behaviour to the table without owning it.
revoke all on table public.session_block_areas from service_role;
grant select, insert, update, delete on table public.session_block_areas to service_role;

-- RESIDUAL, stated rather than hidden: the table OWNER can still TRUNCATE it, can
-- ALTER TABLE ... DISABLE TRIGGER, and can `set session_replication_role =
-- 'replica'` (which suppresses every ENABLE ORIGIN trigger). Verified on a
-- CI-parity database: that GUC is rejected for BOTH `authenticated` and
-- `service_role` ("permission denied to set parameter"), so it is an owner-only
-- lever. The trigger is deliberately left ENABLE ORIGIN rather than ENABLE ALWAYS:
-- ALWAYS would buy nothing against an owner who can simply drop the trigger, and
-- it would make a logical restore (`pg_restore --disable-triggers`) of a finalized
-- record's area rows fail. This residual is true of every trigger-enforced
-- guarantee in this schema (0115, 0119, 0120, 0157) and is not something a
-- migration can close — owner access IS the migration channel.
--
-- The containment claim is therefore precise: no ROLE REACHABLE FROM THE
-- APPLICATION — anon, authenticated, or service_role — can add, change, reorder,
-- move, reparent, delete or erase the structured areas of a finalized (or
-- ever-signed) record. The freeze keys on the append-only snapshot, so a
-- record_status round-trip through the 0120 permit reopens none of those routes.
-- It does NOT claim tamper-EVIDENCE: the signed content_hash still does not cover
-- these rows, so a change made by the table owner, a future migration or a restore
-- would leave the snapshot unchanged. That is snapshot v2.

-- Narrow the 0128 `FOR ALL` policy to SELECT. Writes are already privilege-denied
-- for browser roles; making the policy read-only means a future accidental
-- re-grant cannot silently reopen direct DML.
drop policy if exists "session_block_areas_member_all" on public.session_block_areas;
drop policy if exists "session_block_areas_member_select" on public.session_block_areas;
create policy "session_block_areas_member_select"
  on public.session_block_areas for select to authenticated
  using (public.is_studio_member(studio_id));

comment on table public.session_block_areas is
  '0128 + 0158: AUTHORITATIVE structured treatment areas + per-area laterality for a settings block. Read-only to browser roles (studio-scoped SELECT); every write goes through create_session_block_with_areas / update_session_block_with_areas / copy_session_setup. A parent encounter that is finalized, void, or has EVER been signed freezes these rows for every application-reachable role (0158 trigger + grants). NOT YET part of the signed clinical snapshot and NOT YET correctable — snapshot v2 is a mandatory prerequisite for enabling clinical finalization.';

-- ===========================================================================
-- 4. Harden the trusted charting RPCs.
--    Signatures, payload shape, allow-listed column set and the
--    optimistic-concurrency contract are UNCHANGED (0155/0156 behaviour is
--    preserved verbatim); only the authority/lifecycle preamble is added.
-- ===========================================================================
create or replace function public.create_session_block_with_areas(
  p_studio_id  uuid,
  p_session_id uuid,
  p_block      jsonb,
  p_areas      jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  v_id   uuid;
  v_sort integer;
  r      public.session_blocks%rowtype;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;

  -- 0158: server-authoritative lifecycle gate. Locks the parent encounter FIRST
  -- (sessions -> blocks -> areas order), proves it belongs to p_studio_id from the
  -- STORED row, and rejects finalized / void / soft-deleted records. Also
  -- serializes concurrent block creation for one session, so the sort_order
  -- max()+1 below can no longer race.
  perform public.assert_session_chartable(p_session_id, p_studio_id);

  select coalesce(max(sort_order), 0) + 1 into v_sort
    from public.session_blocks
   where session_id = p_session_id and deleted_at is null;

  r := jsonb_populate_record(null::public.session_blocks, p_block);

  insert into public.session_blocks (
    studio_id, session_id, sort_order, block_name,
    mode, apilus_modality, energy_level, minutes_performed, machine_frequency,
    probe_lot_number, probe_lot_confirmed, probe_inventory_item_id,
    primary_area, side, custom_area_detail,
    probe_key, probe_brand, probe_material, probe_piece_type, probe_shank,
    probe_size_value, probe_length, probe_label,
    tolerance_rating, reaction_type, reaction_notes,
    caution_for_next_session, caution_note, numbing_status, numbing_notes
  ) values (
    p_studio_id, p_session_id, v_sort, r.block_name,
    r.mode, r.apilus_modality, r.energy_level, r.minutes_performed, r.machine_frequency,
    r.probe_lot_number, coalesce(r.probe_lot_confirmed, false), r.probe_inventory_item_id,
    r.primary_area, r.side, r.custom_area_detail,
    r.probe_key, r.probe_brand, r.probe_material, r.probe_piece_type, r.probe_shank,
    r.probe_size_value, r.probe_length, r.probe_label,
    r.tolerance_rating, r.reaction_type, r.reaction_notes,
    coalesce(r.caution_for_next_session, false), r.caution_note, r.numbing_status, r.numbing_notes
  )
  returning id into v_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select v_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);

  return v_id;
end;
$$;

create or replace function public.update_session_block_with_areas(
  p_studio_id           uuid,
  p_session_id          uuid,
  p_block_id            uuid,
  p_block               jsonb,
  p_areas               jsonb,
  p_expected_updated_at timestamptz default null
)
returns void
language plpgsql
security definer
set search_path = pg_catalog, pg_temp
as $$
declare
  r        public.session_blocks%rowtype;
  v_current timestamptz;
begin
  if not public.is_studio_member(p_studio_id) then
    raise exception 'not authorized for studio %', p_studio_id;
  end if;

  -- 0158: lock + validate the parent encounter BEFORE the block row lock, so the
  -- lock order is always sessions -> session_blocks -> session_block_areas (the
  -- order copy_session_setup uses). Rejects finalized / void / soft-deleted
  -- records and same-studio-wrong-session lineage.
  perform public.assert_session_chartable(p_session_id, p_studio_id);

  select updated_at into v_current
    from public.session_blocks
   where id = p_block_id
     and studio_id = p_studio_id
     and session_id = p_session_id
     and deleted_at is null
   for update;
  if not found then
    raise exception 'session block % not found in studio %/session %', p_block_id, p_studio_id, p_session_id;
  end if;
  if p_expected_updated_at is not null and v_current <> p_expected_updated_at then
    raise exception 'stale_block_version: this settings block was changed elsewhere';
  end if;

  -- ONLY the allow-listed columns below are ever written. studio_id, session_id,
  -- sort_order, id, deleted_at, created_at, block_name/block_notes, and every
  -- other column are NOT read from p_block, so a caller cannot re-tenant or
  -- mutate unrelated fields.
  r := jsonb_populate_record(null::public.session_blocks, p_block);

  update public.session_blocks b set
    mode = r.mode, apilus_modality = r.apilus_modality, energy_level = r.energy_level,
    minutes_performed = r.minutes_performed, machine_frequency = r.machine_frequency,
    probe_lot_number = r.probe_lot_number,
    probe_lot_confirmed = coalesce(r.probe_lot_confirmed, false),
    probe_inventory_item_id = r.probe_inventory_item_id,
    primary_area = r.primary_area, side = r.side, custom_area_detail = r.custom_area_detail,
    probe_key = r.probe_key, probe_brand = r.probe_brand, probe_material = r.probe_material,
    probe_piece_type = r.probe_piece_type, probe_shank = r.probe_shank,
    probe_size_value = r.probe_size_value, probe_length = r.probe_length, probe_label = r.probe_label,
    tolerance_rating = r.tolerance_rating, reaction_type = r.reaction_type,
    reaction_notes = r.reaction_notes,
    caution_for_next_session = coalesce(r.caution_for_next_session, false),
    caution_note = r.caution_note, numbing_status = r.numbing_status,
    numbing_notes = r.numbing_notes
  where b.id = p_block_id;

  delete from public.session_block_areas where session_block_id = p_block_id;

  insert into public.session_block_areas (session_block_id, studio_id, area, laterality, display_order)
  select p_block_id, p_studio_id, (e->>'area'), (e->>'laterality'),
         coalesce((e->>'display_order')::int, (ord - 1)::int)
    from jsonb_array_elements(coalesce(p_areas, '[]'::jsonb)) with ordinality as t(e, ord);
end;
$$;

-- Grants are re-asserted (idempotent) so the privilege posture is fully described
-- by this file even if it is replayed on a fresh database.
revoke all on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb) from public, anon;
revoke all on function public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb, timestamptz) from public, anon;
grant execute on function public.create_session_block_with_areas(uuid, uuid, jsonb, jsonb) to authenticated, service_role;
grant execute on function public.update_session_block_with_areas(uuid, uuid, uuid, jsonb, jsonb, timestamptz) to authenticated, service_role;

-- ===========================================================================
-- 5. Operator verification (READ-ONLY; run after apply).
-- ===========================================================================
--   -- trigger present
--   select tgname from pg_trigger
--    where tgrelid = 'public.session_block_areas'::regclass and not tgisinternal;
--   -- browser roles hold SELECT only
--   select r, p, has_table_privilege(r, 'public.session_block_areas', p)
--     from unnest(array['anon','authenticated']) r,
--          unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p;
--   -- one SELECT-only policy
--   select polname, polcmd from pg_policy
--    where polrelid = 'public.session_block_areas'::regclass;
--   -- no data operation: row count unchanged (8 at the time of authoring)
--   select count(*) from public.session_block_areas;
--   -- no finalized record gained or lost areas
--   select count(*) from public.session_block_areas a
--     join public.session_blocks b on b.id = a.session_block_id
--     join public.sessions s on s.id = b.session_id
--    where s.record_status <> 'draft';
