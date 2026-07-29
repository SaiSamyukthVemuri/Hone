-- ---------------------------------------------------------------------------
-- Migration 0159: PERMANENTLY RETIRE signed/finalized clinical records, and take
-- the privilege hardening that is safe to take today.
--
-- PRODUCT DECISION (authoritative). Hone will NOT offer signed or
-- cryptographically finalized clinical records. Practitioner-signed snapshots,
-- immutable finalized records, "snapshot v2", cryptographic clinical-record
-- hashes as a product feature, and a correction/amendment workflow built around
-- signed snapshots are all permanently off the roadmap. Treatment sessions remain
-- ORDINARY, EDITABLE operational records, and practitioners must be able to fix
-- ordinary charting mistakes through safe authorized editing.
--
-- What is NOT being given up: ordinary operational audit trails, actor
-- attribution, timestamps, treatment-history integrity, whole-session-copy
-- provenance, and tenant isolation. The retired thing is specifically the
-- signed/finalized snapshot system built by 0119 and 0120.
--
-- WHY THIS IS A MIGRATION AND NOT JUST A DELETED BUTTON. The capability is
-- reachable from the browser TODAY, without any UI:
--   * `authenticated` holds EXECUTE on finalize_session, correct_finalized_session,
--     amend_finalized_session and amend_finalized_session_with_image (verified in
--     production 2026-07-29);
--   * `public.studios` carries a `studios: owners update` RLS policy and
--     `authenticated` holds UPDATE on the table, with no column restriction — so a
--     studio owner can PATCH clinical_finalization_enabled = true through PostgREST
--     and then call the RPC.
-- Deleting the React components would leave that path wide open. The database has
-- to enforce the decision, not an operator remembering to leave a flag alone.
--
-- POSTURE: additive and non-destructive. Nothing is dropped, no row is written,
-- rewritten, deleted or rehashed. 0119/0120 remain in history exactly as applied;
-- their objects stay in place, and the ones that PROTECT the single legacy artifact
-- are deliberately left switched on.
--
-- THE ONE LEGACY ARTIFACT. Production holds exactly one finalized session — in the
-- NON-Willow controlled-test studio 9d37c51a-6237-42ef-b9d3-28a567c2bfa8, finalized
-- 2026-07-11T00:42:12Z — with one clinical_record_snapshots row whose content_hash
-- still re-derives to a byte-identical MATCH (re-verified read-only 2026-07-29).
-- Willow has zero non-draft sessions. That artifact is retained, readable and
-- unchanged. It is not deleted and its hash is not regenerated. The 0119
-- guard_finalized_clinical_write triggers already make it immutable to every
-- runtime role, and this migration keeps them.
--
-- WHAT THIS MIGRATION DOES.
--   1. Forces both retirement flags false with CHECK constraints, so no role — not
--      a studio owner through the owners-update policy, not service_role, not a
--      future settings screen — can turn the capability on. Every studio already
--      satisfies them, so they validate without touching a row.
--   2. Revokes EXECUTE on all four retired RPCs from every runtime role, and on
--      build_session_snapshot from service_role (browser roles were already
--      revoked by 0119).
--   3. Blocks any transition of sessions.record_status INTO 'finalized' or 'void'.
--      Nothing may newly enter the retired lifecycle. Existing rows are untouched:
--      this is a transition guard, not a value guard, so the one legacy finalized
--      row stays exactly as it is.
--   4. Blocks INSERT into the three signed-record ledgers
--      (clinical_record_snapshots, clinical_record_amendments,
--      clinical_audit_events). 0119/0120 already made them append-only against
--      UPDATE/DELETE for every role; closing INSERT completes the retirement, so no
--      new signed artifact can be produced even if a grant were restored later.
--   5. Takes the privilege hardening that breaks nothing today (see the PR-split
--      note below): removes every remaining `anon` privilege on the six clinical
--      tables, removes TRUNCATE/REFERENCES/TRIGGER from anon AND authenticated on
--      all six, and reduces browser access to public.session_block_areas to
--      studio-scoped SELECT — that table has ZERO direct application writes, so the
--      revocation is invisible to the deployed app.
--
-- WHAT IT DELIBERATELY DOES NOT DO.
--   * No snapshot v2. No structured-area signed-correction framework. Those are
--     retired, not deferred.
--   * No DROP of any table, column, function or trigger from 0119/0120. History
--     stays reproducible and the legacy artifact stays protected.
--   * No revocation of direct DML on public.sessions, session_blocks,
--     electrolysis_entries, laser_entries or treatment_images. The DEPLOYED
--     application still writes all five directly (verified by call-site inventory),
--     so revoking here would break Willow's live charting the moment the migration
--     applied, before any deploy. That work is staged into the follow-up PR, which
--     first moves those callers onto narrow reviewed commands.
--   * No change to appointment completion, payments, receipts, exports, print
--     views, whole-session-copy provenance, or any ordinary audit table.
--
-- WHAT record_status STILL MEANS, AND WHY IT IS KEPT. sessions.record_status is NOT
-- dropped, because two SHIPPED features read it on live paths: migration 0157's
-- whole-session copy (its source resolver excludes a 'void' source and its commit
-- requires a 'draft' target — and the source descriptor runs on every electrolysis
-- session page render), and migration 0123's soft_delete_session_area (it refuses to
-- remove an area from a 'finalized'/'void' record). The session detail page also
-- derives its editability from it. After this migration every real session is
-- 'draft' and stays 'draft', so all three keep behaving exactly as they do today —
-- but the column has to stay, and 'void' has to stay in its CHECK, for them to work.
--
-- SAFETY AT APPLY TIME. Production is LIVE and charting daily, so treat every number
-- below as a dated observation, not a standing fact. Re-derive the baseline
-- immediately before applying; the STOP conditions in the rollout notes, not the raw
-- counts, are what gate the apply.
--
--   as of 2026-07-29: migration max 0157; 5 studios; 76 sessions; 15 structured-area
--                     rows; 1 clinical_record_snapshots row; 0 amendments;
--                     0 clinical_audit_events
--
-- What has held on EVERY observation, and is what the apply actually depends on:
-- both flags false on every studio (so the new CHECKs validate without touching a
-- row); exactly ONE session outside 'draft' — the legacy artifact described above,
-- in a non-Willow test studio — so the transition guard is inert against existing
-- data; ZERO rows in the amendment and clinical-audit ledgers; and Willow with ZERO
-- non-draft sessions. If any of those is no longer true, stop and re-assess: the
-- guards are written to be inert against the state above, not against an arbitrary one.
--
-- MIXED-VERSION SAFETY.
--   old app + new DB: the deployed app's Finalize and Correction controls stop
--     working — that is the intent — and every error is a clean, stable server
--     error. Nothing else it does touches a revoked privilege: session_block_areas
--     is read-only to it already, and it never truncates anything.
--   new app + old DB: the new app simply no longer renders or calls the retired
--     surfaces. It requires nothing 0159 adds.
--   rollback: reverting 0159 restores the pre-retirement posture and would need its
--     own product decision. It performs no data operation, so there is nothing to
--     restore.
--
-- Migration max 0157 -> 0159. 0158 is deliberately skipped: DRAFT PR #481 carries a
-- different, superseded migration under that number on a branch that is being
-- retained for audit evidence, and two artifacts must never share a number.
-- ---------------------------------------------------------------------------

-- Bounded wait rather than a stall: the grant/constraint work below needs short
-- exclusive locks on live clinical tables. A contended apply aborts in seconds and
-- can simply be retried; the whole file is one transaction and performs zero data
-- operations, so a failed attempt leaves nothing behind.
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. The flags can never be turned on again.
-- ===========================================================================
-- A CHECK constraint, not a trigger: it is declarative, it cannot be bypassed by
-- any role or any RLS posture, and it makes the retirement visible in the schema
-- itself. Both columns are `not null default false` (0119 §2, 0120 §5) and every
-- studio is already false, so these validate with no row rewrite.
--
-- The columns are KEPT rather than dropped so 0119/0120 stay replayable and the
-- historical record of what was built remains legible.
alter table public.studios
  drop constraint if exists studios_clinical_finalization_retired;
alter table public.studios
  add constraint studios_clinical_finalization_retired
  check (clinical_finalization_enabled = false);

alter table public.studios
  drop constraint if exists studios_clinical_corrections_retired;
alter table public.studios
  add constraint studios_clinical_corrections_retired
  check (clinical_corrections_enabled = false);

comment on column public.studios.clinical_finalization_enabled is
  'RETIRED (0159). Signed/finalized clinical records are not a Hone product capability. Pinned false by constraint studios_clinical_finalization_retired; the column is kept only so migrations 0119/0120 stay replayable. See docs/decisions/clinical-finalization-retired.md.';
comment on column public.studios.clinical_corrections_enabled is
  'RETIRED (0159). Signed-record corrections/amendments are not a Hone product capability. Pinned false by constraint studios_clinical_corrections_retired. Ordinary charting stays editable through the normal charting commands. See docs/decisions/clinical-finalization-retired.md.';

-- ===========================================================================
-- 2. No runtime role can invoke the retired RPCs.
-- ===========================================================================
-- 0119/0120 granted EXECUTE on these to `authenticated` (and Supabase's default
-- privileges gave service_role the same), which is what made the capability
-- browser-reachable. The functions are left in place — dropping them would break
-- the replay of 0119/0120 — but nothing that serves a request can call them.
revoke all on function public.finalize_session(uuid, integer)
  from public, anon, authenticated, service_role;
revoke all on function public.correct_finalized_session(uuid, integer, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.amend_finalized_session(uuid, uuid, text, text, text, jsonb)
  from public, anon, authenticated, service_role;
revoke all on function public.amend_finalized_session_with_image(
    uuid, uuid, text, text, text, text, bigint, text, uuid, text)
  from public, anon, authenticated, service_role;

-- The snapshot BUILDER is read-only and harmless, but it exists only to serve the
-- retired capability and to let an operator re-derive the legacy hash. Browser
-- roles were already revoked by 0119; take service_role too. The table owner
-- retains it, which is what the read-only integrity audit script uses.
revoke all on function public.build_session_snapshot(uuid)
  from public, anon, authenticated, service_role;

comment on function public.finalize_session(uuid, integer) is
  'RETIRED (0159): signed clinical records are not a Hone product capability. EXECUTE is revoked from every runtime role and public.studios.clinical_finalization_enabled is pinned false, so this cannot run. Retained unchanged so migration 0119 stays replayable.';
comment on function public.correct_finalized_session(uuid, integer, text, jsonb) is
  'RETIRED (0159): signed-record corrections are not a Hone product capability. EXECUTE revoked from every runtime role. Retained unchanged so migration 0120 stays replayable.';
comment on function public.amend_finalized_session(uuid, uuid, text, text, text, jsonb) is
  'RETIRED (0159): signed-record amendments are not a Hone product capability. EXECUTE revoked from every runtime role. Retained unchanged so migration 0120 stays replayable.';
comment on function public.build_session_snapshot(uuid) is
  'RETIRED (0159): builds a signed-snapshot document for a capability Hone no longer offers. EXECUTE revoked from every runtime role; the owner keeps it so the ONE legacy artifact''s content_hash can still be re-derived for read-only integrity checks.';

-- ===========================================================================
-- 3. No session may newly enter the retired finalized/signed lifecycle.
-- ===========================================================================
-- A TRANSITION guard, deliberately: it fires only when record_status actually
-- changes into a retired value, so the one legacy finalized row is untouched and
-- every ordinary UPDATE on it (there are none permitted anyway, see the 0119
-- guard) is unaffected. An INSERT that arrives already-finalized is refused too —
-- the column defaults to 'draft', so nothing legitimate does that.
--
-- 'void' is included. It is part of the same retired lifecycle and is UNREACHABLE
-- today: 0119 shipped it as a reserved value with no path into it, and a source
-- sweep confirms nothing in any migration or in app/lib/components ever assigns
-- it (verified 2026-07-29; production holds zero void rows). Blocking it therefore
-- disables nothing that works, and prevents the retired read-only state being
-- reached by the back door.
create or replace function public.guard_retired_finalization_transition()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_msg constant text :=
    'Signed/finalized clinical records are retired: a session cannot be finalized or voided. Treatment records stay editable — correct them directly. See docs/decisions/clinical-finalization-retired.md.';
begin
  if tg_op = 'INSERT' then
    if new.record_status is distinct from 'draft' then
      raise exception '%', v_msg using errcode = 'check_violation';
    end if;
    return new;
  end if;

  -- UPDATE: only a genuine transition INTO a retired state is refused. Leaving the
  -- legacy row's status as it already is, is not a transition.
  if new.record_status is distinct from old.record_status
     and new.record_status in ('finalized', 'void') then
    raise exception '%', v_msg using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.guard_retired_finalization_transition() is
  '0159: refuses any transition of sessions.record_status into the retired ''finalized''/''void'' lifecycle, and any INSERT that is not ''draft''. A transition guard, so the one legacy finalized row is preserved untouched.';

-- Fires BEFORE the 0119 guard (`sessions_guard_finalized`) by name order, which is
-- irrelevant to correctness — either raising is fatal — but keeps the retirement
-- message as the one a practitioner would see.
drop trigger if exists sessions_guard_retired_finalization on public.sessions;
create trigger sessions_guard_retired_finalization
  before insert or update of record_status on public.sessions
  for each row execute function public.guard_retired_finalization_transition();

-- ===========================================================================
-- 4. No new signed artifact may be produced.
-- ===========================================================================
-- 0119/0120 already block UPDATE and DELETE on all three ledgers for every role
-- (guard_snapshot_append_only). Closing INSERT is what makes the retirement
-- complete and fail-closed: even if a future migration restored an EXECUTE grant
-- by accident, there would still be no way to write a snapshot, an amendment or a
-- signed-correction audit event. Existing rows stay readable and byte-identical.
create or replace function public.guard_retired_signed_ledger_insert()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  raise exception
    'Signed clinical records are retired: no new % row can be created. Existing rows are preserved read-only as legacy evidence. See docs/decisions/clinical-finalization-retired.md.',
    tg_table_name
    using errcode = 'check_violation';
end;
$$;

comment on function public.guard_retired_signed_ledger_insert() is
  '0159: refuses INSERT into the retired signed-record ledgers (clinical_record_snapshots, clinical_record_amendments, clinical_audit_events). Complements the 0119/0120 append-only UPDATE/DELETE guards, so those tables become fully immutable legacy evidence.';

drop trigger if exists clinical_record_snapshots_retired_no_insert on public.clinical_record_snapshots;
create trigger clinical_record_snapshots_retired_no_insert
  before insert on public.clinical_record_snapshots
  for each row execute function public.guard_retired_signed_ledger_insert();

drop trigger if exists clinical_record_amendments_retired_no_insert on public.clinical_record_amendments;
create trigger clinical_record_amendments_retired_no_insert
  before insert on public.clinical_record_amendments
  for each row execute function public.guard_retired_signed_ledger_insert();

drop trigger if exists clinical_audit_events_retired_no_insert on public.clinical_audit_events;
create trigger clinical_audit_events_retired_no_insert
  before insert on public.clinical_audit_events
  for each row execute function public.guard_retired_signed_ledger_insert();

comment on table public.clinical_record_snapshots is
  'RETIRED (0159), legacy evidence only. Signed clinical snapshots are not a Hone product capability. Fully immutable: INSERT refused by clinical_record_snapshots_retired_no_insert, UPDATE/DELETE by the 0119 append-only guard. Production holds exactly one row, from a controlled non-Willow test studio, retained unchanged with its original content_hash.';
comment on table public.clinical_record_amendments is
  'RETIRED (0159), legacy evidence only (currently zero rows). Signed-record amendments are not a Hone product capability. Fully immutable — see clinical_record_snapshots.';
comment on table public.clinical_audit_events is
  'RETIRED (0159), legacy evidence only (currently zero rows). This ledger recorded signed-record corrections/amendments ONLY; it is not the ordinary operational audit trail. session_audit, record_keeping_audit_events, session_copy_operations, admin_action_events and client_portal_access_events are all ACTIVE and untouched.';

-- ===========================================================================
-- 5. Privilege hardening that is safe to take right now.
-- ===========================================================================
-- Everything in this section removes a privilege that NO application code path
-- exercises, so it cannot break the deployed app. The remaining direct-DML
-- revocations (sessions, session_blocks, electrolysis_entries, laser_entries,
-- treatment_images) are staged into the follow-up PR because the deployed app
-- still writes those tables directly.

-- 5a. `anon` has no business writing clinical data at all. RLS already denies it
-- rows (every clinical policy is `to authenticated`), but a privilege it holds is a
-- privilege that survives an RLS mistake — and TRUNCATE is not RLS-checked at all,
-- so a grant is the only thing standing between an anon key and an emptied table.
revoke insert, update, delete, truncate, references, trigger
  on public.sessions            from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.session_blocks      from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.session_block_areas from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.electrolysis_entries from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.laser_entries       from anon;
revoke insert, update, delete, truncate, references, trigger
  on public.treatment_images    from anon;

-- 5b. `authenticated` keeps the row DML the deployed app still needs, but loses the
-- three privileges no application ever uses and RLS never checks. TRUNCATE is the
-- one that matters: it is statement-level, consults no policy and fires no row
-- trigger, so it is a whole-table clinical data-loss primitive.
revoke truncate, references, trigger
  on public.sessions            from authenticated;
revoke truncate, references, trigger
  on public.session_blocks      from authenticated;
revoke truncate, references, trigger
  on public.session_block_areas from authenticated;
revoke truncate, references, trigger
  on public.electrolysis_entries from authenticated;
revoke truncate, references, trigger
  on public.laser_entries       from authenticated;
revoke truncate, references, trigger
  on public.treatment_images    from authenticated;

-- 5c. public.session_block_areas becomes read-only to the browser. It is the
-- AUTHORITATIVE structured treatment-area + per-area laterality record
-- (lib/sessions/block-areas.ts prefers it over the legacy primary_area/side
-- projection), and the application contains ZERO direct writes to it — every write
-- already goes through create_session_block_with_areas /
-- update_session_block_with_areas (0129/0155/0156) or copy_session_setup (0157),
-- all SECURITY DEFINER. So this closes a real direct-PostgREST write surface while
-- being completely invisible to the deployed app.
revoke all on table public.session_block_areas from public;
revoke all on table public.session_block_areas from anon;
revoke all on table public.session_block_areas from authenticated;
grant select on table public.session_block_areas to authenticated;

-- service_role keeps row DML (server-only, and the trusted commands run as owner
-- anyway) but not the statement-level privileges.
revoke all on table public.session_block_areas from service_role;
grant select, insert, update, delete on table public.session_block_areas to service_role;

-- Narrow the 0128 `FOR ALL` policy to SELECT. Writes are already privilege-denied
-- for browser roles; a read-only policy means a future accidental re-grant cannot
-- silently reopen direct DML.
drop policy if exists "session_block_areas_member_all" on public.session_block_areas;
drop policy if exists "session_block_areas_member_select" on public.session_block_areas;
create policy "session_block_areas_member_select"
  on public.session_block_areas for select to authenticated
  using (public.is_studio_member(studio_id));

-- 5d. Close the 0128 anti-spoof gap. Its studio-derive trigger was declared
-- `before insert or update OF session_block_id`, so an UPDATE touching only
-- studio_id never re-derived it — leaving a row whose denormalized studio_id
-- disagreed with its parent, readable by the WRONG studio through the
-- studio-scoped SELECT policy and invisible to its real owner. The column list is
-- kept narrow on purpose: an unrestricted UPDATE clause would make this INVOKER
-- trigger resolve the parent block on every edit, which fails for any role without
-- a direct SELECT grant on public.session_blocks. The function is unchanged.
drop trigger if exists session_block_areas_derive_studio on public.session_block_areas;
create trigger session_block_areas_derive_studio
  before insert or update of session_block_id, studio_id on public.session_block_areas
  for each row execute function public.session_block_areas_derive_studio();

comment on table public.session_block_areas is
  '0128 + 0159: AUTHORITATIVE structured treatment areas + per-area laterality for a settings block. Read-only to browser roles (studio-scoped SELECT); every write goes through create_session_block_with_areas / update_session_block_with_areas / copy_session_setup. Ordinary sessions stay fully editable — signed/finalized records are retired (0159), so there is no finalization freeze on new charting.';

-- ===========================================================================
-- 6. Operator verification (READ-ONLY; run after apply).
-- ===========================================================================
--   -- the flags cannot be turned on (expect: both raise 23514)
--   -- (do NOT run these against production; they are for a scratch database)
--
--   -- retirement objects exist
--   select conname from pg_constraint
--    where conrelid = 'public.studios'::regclass and conname like '%_retired';
--   select tgname, tgrelid::regclass from pg_trigger
--    where tgname in ('sessions_guard_retired_finalization',
--                     'clinical_record_snapshots_retired_no_insert',
--                     'clinical_record_amendments_retired_no_insert',
--                     'clinical_audit_events_retired_no_insert');
--
--   -- no runtime role can invoke the retired RPCs (expect all false)
--   select r, f, has_function_privilege(r, f, 'EXECUTE')
--     from unnest(array['anon','authenticated','service_role']) r,
--          unnest(array['public.finalize_session(uuid,integer)',
--                       'public.correct_finalized_session(uuid,integer,text,jsonb)',
--                       'public.amend_finalized_session(uuid,uuid,text,text,text,jsonb)',
--                       'public.build_session_snapshot(uuid)']) f;
--
--   -- anon holds nothing but SELECT; authenticated holds no statement-level privilege
--   select t, r, p, has_table_privilege(r, t, p)
--     from unnest(array['public.sessions','public.session_blocks','public.session_block_areas',
--                       'public.electrolysis_entries','public.laser_entries',
--                       'public.treatment_images']) t,
--          unnest(array['anon','authenticated']) r,
--          unnest(array['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p;
--
--   -- ZERO DATA OPERATION: every number must equal the pre-apply baseline
--   select (select count(*) from public.sessions)                    as sessions,
--          (select count(*) from public.sessions
--            where record_status <> 'draft')                         as non_draft,
--          (select count(*) from public.clinical_record_snapshots)   as snapshots,
--          (select count(*) from public.clinical_record_amendments)  as amendments,
--          (select count(*) from public.clinical_audit_events)       as clinical_audit_events,
--          (select count(*) from public.session_block_areas)         as area_rows;
--
--   -- the legacy artifact is unchanged and still re-derives (expect 1 / MATCH)
--   select count(*) from public.clinical_record_snapshots cs
--    where encode(extensions.digest(
--            public.build_session_snapshot(cs.session_id)::text, 'sha256'), 'hex')
--          = cs.content_hash;
