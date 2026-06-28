-- Migration 0094: Tenant consistency constraints for sensitive child tables (PR #278).
--
-- Several clinical/import child tables enforced studio_id via RLS but did NOT
-- prove their PARENT rows belong to the same studio: at the DB layer a row could
-- carry studio_id=A while pointing at a client_id / session_id / appointment_id /
-- import_batch_id from studio B. (UUID parent ids are unguessable and RLS scopes
-- reads, so the practical attack surface is small — but multi-tenant
-- defense-in-depth wants this enforced in the schema.) The PAYMENT subsystem
-- (appointment_payments, payment_charge_attempts) and treatment_images (0093
-- trigger) already enforce same-studio parents; this migration extends the SAME
-- composite-FK pattern to the remaining member-writable clinical/import tables.
--
-- Mechanism: COMPOSITE same-studio foreign keys (the project's existing tenant
-- pattern), NOT triggers — which avoids the independent ON DELETE SET NULL
-- cascade pitfall hit in PR #276. On Postgres 17 the column-list
-- `ON DELETE SET NULL (col)` nulls ONLY the parent id (never the NOT NULL
-- studio_id), so SET-NULL parents work cleanly. Each composite FK REPLACES the
-- prior single-column FK and MIRRORS its ON DELETE action.
--
-- IMPORTANT (PR #278 fix): the composite FK REPLACES the existing single-column
-- FK rather than sitting beside it. Two FKs between the same table pair make
-- PostgREST embedded selects ambiguous ("Could not embed because more than one
-- relationship was found"), which breaks app reads like
-- `sessions.select("... session_blocks(...)")`. The composite joins on the same
-- key (studio_id is always consistent), so embeds return identical rows via the
-- single remaining relationship. The payment subsystem uses this composite-only
-- shape for the same reason.
--
-- PREFLIGHT (run read-only BEFORE applying; production verified 0 on 2026-06-28).
-- A non-zero count is a real cross-tenant row -> STOP and investigate; do NOT apply.
--   select count(*) from sessions s join clients c on c.id=s.client_id where c.studio_id<>s.studio_id;                         -- 0
--   select count(*) from sessions s join appointments a on a.id=s.appointment_id where a.studio_id<>s.studio_id;              -- 0
--   select count(*) from session_blocks b join sessions s on s.id=b.session_id where s.studio_id<>b.studio_id;                -- 0
--   select count(*) from client_intake_forms f join clients c on c.id=f.client_id where c.studio_id<>f.studio_id;            -- 0
--   select count(*) from imported_treatment_memories m join clients c on c.id=m.client_id where c.studio_id<>m.studio_id;     -- 0
--   select count(*) from imported_treatment_memories m join import_batches b on b.id=m.import_batch_id where b.studio_id<>m.studio_id; -- 0
--   select count(*) from treatment_plans p join clients c on c.id=p.client_id where c.studio_id<>p.studio_id;                 -- 0
--   select count(*) from electrolysis_entries e join session_blocks b on b.id=e.block_id where b.session_id<>e.session_id;   -- 0
--
-- Idempotent (drop-if-exists throughout; composite FKs dropped before the parent
-- uniques they depend on). No RLS weakened. No payment / live-mode change.
-- Soft-delete + cascade semantics preserved (each composite mirrors the old
-- single FK's ON DELETE). Tables are small (validation scan is trivial). DO NOT
-- apply to production until explicitly approved after merge.

-- 1. Drop any prior 0094 composite FKs (re-run safety: a unique cannot be dropped
--    while an FK still references it, so composites come off first).
alter table public.sessions                    drop constraint if exists sessions_client_same_studio_fk;
alter table public.sessions                    drop constraint if exists sessions_appointment_same_studio_fk;
alter table public.session_blocks              drop constraint if exists session_blocks_session_same_studio_fk;
alter table public.client_intake_forms         drop constraint if exists client_intake_forms_client_same_studio_fk;
alter table public.imported_treatment_memories drop constraint if exists imported_memories_client_same_studio_fk;
alter table public.imported_treatment_memories drop constraint if exists imported_memories_batch_same_studio_fk;
alter table public.treatment_plans             drop constraint if exists treatment_plans_client_same_studio_fk;
alter table public.electrolysis_entries        drop constraint if exists electrolysis_block_same_session_fk;

-- 2. Drop the prior SINGLE-column FKs that the composites replace (so each table
--    pair keeps exactly ONE relationship -> no PostgREST embed ambiguity). NOTE:
--    electrolysis_entries_session_id_fkey is INTENTIONALLY KEPT (it is the
--    electrolysis->sessions link; the composite below is electrolysis->session_blocks,
--    a different pair, so it does not duplicate it).
alter table public.sessions                    drop constraint if exists sessions_client_id_fkey;
alter table public.sessions                    drop constraint if exists sessions_appointment_id_fkey;
alter table public.session_blocks              drop constraint if exists session_blocks_session_id_fkey;
alter table public.client_intake_forms         drop constraint if exists client_intake_forms_client_id_fkey;
alter table public.imported_treatment_memories drop constraint if exists imported_treatment_memories_client_id_fkey;
alter table public.imported_treatment_memories drop constraint if exists imported_treatment_memories_import_batch_id_fkey;
alter table public.treatment_plans             drop constraint if exists treatment_plans_client_id_fkey;
alter table public.electrolysis_entries        drop constraint if exists electrolysis_entries_block_id_fkey;

-- 3. Parent unique constraints the composite FKs need. id is the PK, so these are
--    trivially unique (additive; no row rewrite). clients(id,studio_id) and
--    appointments(id,studio_id) already exist (payment subsystem).
alter table public.sessions       drop constraint if exists sessions_studio_id_uniq;
alter table public.sessions       add  constraint sessions_studio_id_uniq unique (studio_id, id);
alter table public.session_blocks drop constraint if exists session_blocks_session_id_id_uniq;
alter table public.session_blocks add  constraint session_blocks_session_id_id_uniq unique (session_id, id);
alter table public.import_batches drop constraint if exists import_batches_studio_id_uniq;
alter table public.import_batches add  constraint import_batches_studio_id_uniq unique (studio_id, id);

-- 4. Composite same-studio FKs (replace the dropped single FKs; one relationship
--    per table pair). Each ON DELETE mirrors the single FK it replaces.

-- sessions: client + appointment must be same-studio.
alter table public.sessions add constraint sessions_client_same_studio_fk
  foreign key (studio_id, client_id) references public.clients (studio_id, id)
  on delete cascade;
alter table public.sessions add constraint sessions_appointment_same_studio_fk
  foreign key (studio_id, appointment_id) references public.appointments (studio_id, id)
  on delete set null (appointment_id);

-- session_blocks: session must be same-studio.
alter table public.session_blocks add constraint session_blocks_session_same_studio_fk
  foreign key (studio_id, session_id) references public.sessions (studio_id, id)
  on delete cascade;

-- client_intake_forms: client must be same-studio.
alter table public.client_intake_forms add constraint client_intake_forms_client_same_studio_fk
  foreign key (studio_id, client_id) references public.clients (studio_id, id)
  on delete cascade;

-- imported_treatment_memories: client + import batch must be same-studio.
alter table public.imported_treatment_memories add constraint imported_memories_client_same_studio_fk
  foreign key (studio_id, client_id) references public.clients (studio_id, id)
  on delete cascade;
alter table public.imported_treatment_memories add constraint imported_memories_batch_same_studio_fk
  foreign key (studio_id, import_batch_id) references public.import_batches (studio_id, id)
  on delete restrict;

-- treatment_plans: client must be same-studio.
alter table public.treatment_plans add constraint treatment_plans_client_same_studio_fk
  foreign key (studio_id, client_id) references public.clients (studio_id, id)
  on delete cascade;

-- electrolysis_entries: the attached block must belong to the SAME session as the
-- entry (no studio_id column here; tenancy flows via session_id -> sessions + RLS
-- session scoping). Replaces electrolysis_entries_block_id_fkey. block_id is
-- nullable -> MATCH SIMPLE skips when null; ON DELETE SET NULL (block_id) mirrors
-- the dropped single FK.
alter table public.electrolysis_entries add constraint electrolysis_block_same_session_fk
  foreign key (session_id, block_id) references public.session_blocks (session_id, id)
  on delete set null (block_id);
