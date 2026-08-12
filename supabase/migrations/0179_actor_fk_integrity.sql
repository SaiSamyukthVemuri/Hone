-- ===========================================================================
-- 0179 — ACTOR FK INTEGRITY
-- ===========================================================================
-- Genuine ACTOR / AUTHOR / CREATOR practitioner attribution is made
--   (a) structurally same-studio, and
--   (b) delete-safe for durable evidence.
--
-- SCOPE IS ACTOR-ONLY. This migration deliberately does NOT blanket-upgrade
-- every studio-bearing practitioner FK. The following are OUT of scope and are
-- left byte-for-byte alone:
--
--   ASSIGNEE                       sessions.practitioner_id,
--                                  appointments.practitioner_id,
--                                  studio_availability_*, service_practitioners,
--                                  studio_timed_blocks.practitioner_id,
--                                  studio_recurring_break_*.practitioner_id,
--                                  pending_booking_payment_sessions.practitioner_id
--   CLINICAL PERFORMER PROVENANCE  sessions.performed_by_practitioner_id,
--                                  sessions.aftercare_and_risks_explained_by
--   DOMAIN SUBJECT / OPERATOR      record_keeping_disinfectants.operator_practitioner_id
--                                  (proven a dropdown-picked staff member, not the
--                                   mutating actor — app/(app)/records/actions.ts:57)
--   RESOURCE / RECIPIENT           studio_calendar_reservations.practitioner_id,
--                                  practitioner_notifications.practitioner_id,
--                                  calendar_connections, google_oauth_states
--   AUTH-USER PROVENANCE           import_batches.created_by / voided_by,
--                                  imported_treatment_memories.imported_by / voided_by
--                                  (these reference auth.users, not practitioners)
--   POLYMORPHIC ACTOR NAMESPACE    appointment_audit.actor_id
--                                  (0174 actor_practitioner_id is the typed correlation)
--
-- ---------------------------------------------------------------------------
-- DELETE SEMANTICS
-- ---------------------------------------------------------------------------
-- 0174 established the Hone distinction:
--   DURABLE ACTOR / CREATOR ATTRIBUTION  -> ON DELETE RESTRICT
--   CURRENT OPERATIONAL ASSIGNMENT       -> may use ON DELETE SET NULL
--
-- 0119 section 6 already states the same contract in prose and enforces it with
-- a BEFORE DELETE trigger on practitioners: "historical attribution survives
-- account deletion". That trigger is still live at 0178.
--
-- This is not a new restriction on any live path: 0173 revoked DELETE on
-- public.practitioners from anon + authenticated and dropped the
-- "practitioners: owners delete" policy, and the team UI deactivates
-- (p_active := false) rather than deleting. There is no application path that
-- hard-deletes a practitioner row.
--
-- Four ACTOR columns intentionally KEEP ON DELETE SET NULL because the row they
-- sit on is current operational state rather than durable evidence. Each is
-- named with its reason at the point of change.
--
-- ---------------------------------------------------------------------------
-- VALIDATION STRATEGY — FAIL CLOSED, ALL OR NOTHING
-- ---------------------------------------------------------------------------
-- NOT VALID is used here ONLY as the ADD-CONSTRAINT lock strategy. It is NOT an
-- acceptable terminal state for 0179.
--
-- Every constraint is added NOT VALID so that no table is scanned while an
-- ACCESS EXCLUSIVE lock is held (NOT VALID still enforces the constraint on
-- every INSERT and UPDATE from the moment it is added — it only declines to
-- re-scan pre-existing rows). All 39 are then VALIDATED inside this SAME
-- transaction by section 5.
--
-- THE BINDING RULE:
--
--     0179 COMMITTING SUCCESSFULLY  IMPLIES  ALL 39 CONSTRAINTS ARE VALIDATED.
--
-- Zero 0179 constraints may remain convalidated = false after a successful
-- apply. A migration named ACTOR FK INTEGRITY must never be recorded as applied
-- while some of its in-scope historical actor relationships are structurally
-- unverified.
--
-- Section 5 therefore aborts the transaction if ANY constraint fails to
-- validate. It catches ONLY foreign_key_violation, and only so that it can
-- report EVERY dirty relationship in one pass instead of one per attempt; it
-- then raises and rolls the whole migration back. Every other error class —
-- lock timeout, deadlock, permission failure, catalog error — propagates
-- immediately and is never swallowed.
--
-- This migration is authored with ZERO production database access, so
-- production's historical rows cannot be inspected here. That is deliberately
-- NOT a reason to weaken the migration: dirty history is discovered by the
-- read-only preflight that precedes the production apply, and remediated
-- before this fail-closed migration is invoked.
--
-- ---------------------------------------------------------------------------
-- KNOWN DIRTY-HISTORY WINDOW — treatment_images
-- ---------------------------------------------------------------------------
-- The local development database carries 5 cross-studio rows on
-- treatment_images.uploaded_by and 1 on treatment_images.deleted_by. That
-- database has NO seed file: its contents are ACCUMULATED TEST STATE, not a
-- curated production-like fixture, so those counts measure nothing about
-- production. All other 65 practitioner FK columns were clean on it.
--
-- The window in which such values COULD have been produced ends at 0178, NOT
-- at 0168:
--
--   * 0168 introduced the treatment-image write commands, but its
--     public.treatment_image_actor() helper resolved the actor with
--         where p.user_id = auth.uid() and p.active = true limit 1
--     — NO studio scope. For a human who is an active practitioner in more than
--     one studio, the membership chosen was planner-dependent, so the actor
--     could be attributed to a studio other than the resource's.
--
--   * 0178 is the migration that fixed it, replacing that helper with
--     treatment_image_actor(p_studio_id uuid) and inverting the order to
--         RESOURCE -> RESOURCE'S STUDIO -> ACTIVE PRACTITIONER FOR auth.uid()
--         IN THAT STUDIO.
--
-- So cross-studio-invalid historical treatment-image actor values could have
-- been produced at any point BEFORE the 0178 fix, INCLUDING during 0168–0177.
-- No claim is made here about when the six local rows were actually written:
-- no timestamp or provenance evidence was gathered, so they are not asserted to
-- predate any particular migration.
--
-- ZERO business rows are mutated by this migration. No attribution backfill is
-- performed: every populated actor value already carries authoritative
-- evidence, and no NULL actor can be reconstructed without inference that the
-- backfill rule forbids.
-- ===========================================================================

begin;
set local lock_timeout = '5s';

-- ===========================================================================
-- 1. DURABLE ACTOR ATTRIBUTION — same-studio + ON DELETE RESTRICT
-- ===========================================================================
-- Each of these replaces a simple practitioners(id) FK. The composite
-- (col, studio_id) -> practitioners (id, studio_id) strictly implies the simple
-- reference it replaces, because practitioners_id_studio_id_unique is a
-- superkey over the primary key — so dropping the simple FK loses nothing.

-- --- Audit / event evidence ------------------------------------------------

alter table public.audit_logs
  drop constraint if exists audit_logs_actor_id_fkey;
alter table public.audit_logs
  add constraint audit_logs_actor_same_studio_fk
  foreign key (actor_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.record_keeping_audit_events
  drop constraint if exists record_keeping_audit_events_actor_practitioner_id_fkey;
alter table public.record_keeping_audit_events
  add constraint rk_audit_events_actor_same_studio_fk
  foreign key (actor_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.imported_treatment_memory_audit_events
  drop constraint if exists imported_treatment_memory_audit_even_actor_practitioner_id_fkey;
alter table public.imported_treatment_memory_audit_events
  add constraint itm_audit_events_actor_same_studio_fk
  foreign key (actor_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- The client-visible portal access log. Every non-null writer is the acting
-- practitioner: portal_link_sent and portal_link_rate_limited pass
-- practitioner.id (app/(app)/clients/[id]/portal-link-actions.ts:42,80), and the
-- only other writer — portal_magic_link_consumed, a client-side event — passes
-- no practitioner at all and therefore stores NULL
-- (app/portal/verify/[token]/actions.ts:115). Named merely practitioner_id, but
-- an ACTOR column by every writer.
alter table public.client_portal_access_events
  drop constraint if exists client_portal_access_events_practitioner_id_fkey;
alter table public.client_portal_access_events
  add constraint client_portal_access_events_practitioner_same_studio_fk
  foreign key (practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Client record ---------------------------------------------------------

alter table public.clients
  drop constraint if exists clients_created_by_fkey;
alter table public.clients
  add constraint clients_created_by_same_studio_fk
  foreign key (created_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.clients
  drop constraint if exists clients_archived_by_fkey;
alter table public.clients
  add constraint clients_archived_by_same_studio_fk
  foreign key (archived_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.client_tags
  drop constraint if exists client_tags_created_by_fkey;
alter table public.client_tags
  add constraint client_tags_created_by_same_studio_fk
  foreign key (created_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.client_tags
  drop constraint if exists client_tags_deleted_by_fkey;
alter table public.client_tags
  add constraint client_tags_deleted_by_same_studio_fk
  foreign key (deleted_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.client_pinned_notes
  drop constraint if exists client_pinned_notes_created_by_practitioner_id_fkey;
alter table public.client_pinned_notes
  add constraint client_pinned_notes_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Intake / consent ------------------------------------------------------

alter table public.client_intake_forms
  drop constraint if exists client_intake_forms_requested_by_fkey;
alter table public.client_intake_forms
  add constraint client_intake_forms_requested_by_same_studio_fk
  foreign key (requested_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.client_intake_forms
  drop constraint if exists client_intake_forms_reviewed_by_fkey;
alter table public.client_intake_forms
  add constraint client_intake_forms_reviewed_by_same_studio_fk
  foreign key (reviewed_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.consent_form_templates
  drop constraint if exists consent_form_templates_created_by_practitioner_id_fkey;
alter table public.consent_form_templates
  add constraint consent_form_templates_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Clinical session evidence --------------------------------------------

alter table public.sessions
  drop constraint if exists sessions_deleted_by_fkey;
alter table public.sessions
  add constraint sessions_deleted_by_same_studio_fk
  foreign key (deleted_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.session_blocks
  drop constraint if exists session_blocks_deleted_by_fkey;
alter table public.session_blocks
  add constraint session_blocks_deleted_by_same_studio_fk
  foreign key (deleted_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- treatment_images.uploaded_by / deleted_by are never accepted from the caller:
-- both are derived from auth.uid() inside the 0168 write commands. Since 0178
-- that derivation is studio-scoped (resource -> studio -> active practitioner
-- there), so writes after 0178 are same-studio by construction. Rows written
-- BEFORE the 0178 fix — including throughout 0168–0177, whose helper had no
-- studio scope — may violate this. See the dirty-history note in the header.
alter table public.treatment_images
  drop constraint if exists treatment_images_uploaded_by_fkey;
alter table public.treatment_images
  add constraint treatment_images_uploaded_by_same_studio_fk
  foreign key (uploaded_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.treatment_images
  drop constraint if exists treatment_images_deleted_by_fkey;
alter table public.treatment_images
  add constraint treatment_images_deleted_by_same_studio_fk
  foreign key (deleted_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Treatment planning ----------------------------------------------------

alter table public.treatment_plans
  drop constraint if exists treatment_plans_created_by_practitioner_id_fkey;
alter table public.treatment_plans
  add constraint treatment_plans_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.treatment_plans
  drop constraint if exists treatment_plans_closed_by_practitioner_id_fkey;
alter table public.treatment_plans
  add constraint treatment_plans_closed_by_same_studio_fk
  foreign key (closed_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.treatment_goals
  drop constraint if exists treatment_goals_created_by_fkey;
alter table public.treatment_goals
  add constraint treatment_goals_created_by_same_studio_fk
  foreign key (created_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Regulatory record keeping --------------------------------------------

alter table public.record_keeping_sterile_items
  drop constraint if exists record_keeping_sterile_items_created_by_practitioner_id_fkey;
alter table public.record_keeping_sterile_items
  add constraint rk_sterile_items_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.record_keeping_disinfectants
  drop constraint if exists record_keeping_disinfectants_created_by_practitioner_id_fkey;
alter table public.record_keeping_disinfectants
  add constraint rk_disinfectants_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.record_keeping_exposure_incidents
  drop constraint if exists record_keeping_exposure_inciden_created_by_practitioner_id_fkey;
alter table public.record_keeping_exposure_incidents
  add constraint rk_exposure_incidents_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Financial actor evidence (dormant tables) ----------------------------
-- stripe_charge_attempts.initiated_by_practitioner_id,
-- stripe_refund_attempts.initiated_by_practitioner_id and
-- stripe_payment_audit.practitioner_id have ZERO application writers at 0178
-- and ZERO rows; the live payment actor path is payment_charge_attempts, whose
-- actor columns 0174 already made composite + RESTRICT. They are corrected here
-- so a revival cannot resurrect SET NULL actor attribution. Being empty, their
-- validation is free.

alter table public.stripe_charge_attempts
  drop constraint if exists stripe_charge_attempts_initiated_by_practitioner_id_fkey;
alter table public.stripe_charge_attempts
  add constraint stripe_charge_attempts_initiated_by_same_studio_fk
  foreign key (initiated_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.stripe_refund_attempts
  drop constraint if exists stripe_refund_attempts_initiated_by_practitioner_id_fkey;
alter table public.stripe_refund_attempts
  add constraint stripe_refund_attempts_initiated_by_same_studio_fk
  foreign key (initiated_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.stripe_payment_audit
  drop constraint if exists stripe_payment_audit_practitioner_id_fkey;
alter table public.stripe_payment_audit
  add constraint stripe_payment_audit_practitioner_same_studio_fk
  foreign key (practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- --- Ops -------------------------------------------------------------------
-- CAVEAT: ops_alerts.studio_id is the ONLY nullable studio_id among every table
-- touched here. A composite FK is MATCH SIMPLE, so on a global (studio-less)
-- alert the same-studio half is not enforced — only the delete semantics are.
-- MATCH FULL is deliberately NOT used: it would reject resolving a global alert
-- outright. Same-studio enforcement for ops_alerts is therefore partial by
-- construction and is recorded as such in the census.
alter table public.ops_alerts
  drop constraint if exists ops_alerts_resolved_by_practitioner_id_fkey;
alter table public.ops_alerts
  add constraint ops_alerts_resolved_by_same_studio_fk
  foreign key (resolved_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- ===========================================================================
-- 2. DURABLE ACTOR ATTRIBUTION — delete semantics ALREADY correct,
--    same-studio missing
-- ===========================================================================
-- These already carry ON DELETE RESTRICT. Only the tenant half is added, so
-- their delete behaviour is unchanged.

alter table public.clinical_audit_events
  drop constraint if exists clinical_audit_events_actor_fk;
alter table public.clinical_audit_events
  add constraint clinical_audit_events_actor_practitioner_id_same_studio_fk
  foreign key (actor_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.clinical_record_amendments
  drop constraint if exists clinical_record_amendments_author_fk;
alter table public.clinical_record_amendments
  add constraint clinical_record_amendments_authored_by_same_studio_fk
  foreign key (authored_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_finalized_by_fkey;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_finalized_by_same_studio_fk
  foreign key (finalized_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.clinical_record_snapshots
  drop constraint if exists clinical_record_snapshots_corrected_by_fk;
alter table public.clinical_record_snapshots
  add constraint clinical_record_snapshots_corrected_by_same_studio_fk
  foreign key (corrected_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.sessions
  drop constraint if exists sessions_finalized_by_fkey;
alter table public.sessions
  add constraint sessions_finalized_by_same_studio_fk
  foreign key (finalized_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.client_portal_messages
  drop constraint if exists client_portal_messages_created_by_practitioner_id_fkey;
alter table public.client_portal_messages
  add constraint client_portal_messages_created_by_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.manual_fee_charge_attempts
  drop constraint if exists manual_fee_charge_attempts_cancelled_by_practitioner_id_fkey;
alter table public.manual_fee_charge_attempts
  add constraint manual_fee_charge_attempts_cancelled_by_same_studio_fk
  foreign key (cancelled_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

alter table public.payment_charge_attempts
  drop constraint if exists payment_charge_attempts_cancelled_by_practitioner_id_fkey;
alter table public.payment_charge_attempts
  add constraint payment_charge_attempts_cancelled_by_same_studio_fk
  foreign key (cancelled_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- ===========================================================================
-- 3. AUTHOR ATTRIBUTION — same-studio ALREADY correct, delete semantics WRONG
-- ===========================================================================
-- client_clinical_notes.practitioner_id is the AUTHORING practitioner of an
-- append-only clinical note (written as practitioner.id at
-- app/(app)/clients/[id]/clinical-notes-actions.ts:193). It already had a
-- same-studio composite FK, but ON DELETE CASCADE — meaning deleting a
-- practitioner row would DESTROY their clinical notes outright. That directly
-- contradicts the 0119 retention contract ("historical attribution survives
-- account deletion") and is the reason "already composite same-studio" is not
-- treated as automatically frozen. Tenant half is unchanged; only the delete
-- action moves CASCADE -> RESTRICT.
alter table public.client_clinical_notes
  drop constraint if exists client_clinical_notes_practitioner_same_studio;
alter table public.client_clinical_notes
  add constraint client_clinical_notes_practitioner_same_studio
  foreign key (practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;

-- ===========================================================================
-- 4. OPERATIONAL ACTOR ATTRIBUTION — same-studio added, SET NULL KEPT
-- ===========================================================================
-- Each of these IS a real actor stamp, but the row it sits on is current
-- operational state rather than durable business, clinical or audit evidence.
-- Losing the practitioner correlation when the row's subject is gone is the
-- correct outcome, so ON DELETE SET NULL is preserved deliberately.

-- A team invitation is consumed on acceptance or expires unaccepted; it is a
-- pending-state row, never retained as evidence of anything.
alter table public.pending_invitations
  drop constraint if exists pending_invitations_invited_by_fkey;
alter table public.pending_invitations
  add constraint pending_invitations_invited_by_same_studio_fk
  foreign key (invited_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete set null
  not valid;

-- Live calendar configuration. Blocks and recurring break rules are created and
-- deleted freely as the schedule changes; created_by is provenance on mutable
-- config, not a retained record.
alter table public.studio_timed_blocks
  drop constraint if exists studio_timed_blocks_created_by_fkey;
alter table public.studio_timed_blocks
  add constraint studio_timed_blocks_created_by_same_studio_fk
  foreign key (created_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete set null
  not valid;

alter table public.studio_recurring_break_rules
  drop constraint if exists studio_recurring_break_rules_created_by_fkey;
alter table public.studio_recurring_break_rules
  add constraint studio_recurring_break_rules_created_by_same_studio_fk
  foreign key (created_by, studio_id)
  references public.practitioners (id, studio_id)
  on delete set null
  not valid;

-- A last-edited-by stamp that is OVERWRITTEN IN PLACE by every subsequent save
-- (app/(app)/clients/[id]/personal-notes-actions.ts:91). It records current
-- state, not history — there is no edit trail here for it to be evidence of.
alter table public.client_personal_notes
  drop constraint if exists client_personal_notes_updated_by_practitioner_id_fkey;
alter table public.client_personal_notes
  add constraint client_personal_notes_updated_by_same_studio_fk
  foreign key (updated_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete set null
  not valid;

-- ===========================================================================
-- 5. MANDATORY VALIDATION PASS — ALL 39 OR THE MIGRATION ABORTS
-- ===========================================================================
-- The 39 constraint names 0179 owns, pinned explicitly rather than discovered
-- by pattern. A LIKE '%_same_studio_fk' probe would also sweep up composites
-- created by 0174 and earlier, which is precisely the kind of imprecision that
-- lets a missed constraint pass unnoticed. Pinning the list means a renamed or
-- dropped constraint is a hard error, not a silent skip.
--
-- Only foreign_key_violation is caught, and only to report EVERY dirty
-- relationship in one pass. Any other error class — lock timeout, deadlock,
-- permission failure, catalog error — has no handler and propagates
-- immediately. If anything failed, the migration RAISES and rolls back.
do $$
declare
  owned constant text[][] := array[
    ['audit_logs',                            'audit_logs_actor_same_studio_fk'],
    ['record_keeping_audit_events',           'rk_audit_events_actor_same_studio_fk'],
    ['imported_treatment_memory_audit_events','itm_audit_events_actor_same_studio_fk'],
    ['client_portal_access_events',           'client_portal_access_events_practitioner_same_studio_fk'],
    ['clients',                               'clients_created_by_same_studio_fk'],
    ['clients',                               'clients_archived_by_same_studio_fk'],
    ['client_tags',                           'client_tags_created_by_same_studio_fk'],
    ['client_tags',                           'client_tags_deleted_by_same_studio_fk'],
    ['client_pinned_notes',                   'client_pinned_notes_created_by_same_studio_fk'],
    ['client_intake_forms',                   'client_intake_forms_requested_by_same_studio_fk'],
    ['client_intake_forms',                   'client_intake_forms_reviewed_by_same_studio_fk'],
    ['consent_form_templates',                'consent_form_templates_created_by_same_studio_fk'],
    ['sessions',                              'sessions_deleted_by_same_studio_fk'],
    ['session_blocks',                        'session_blocks_deleted_by_same_studio_fk'],
    ['treatment_images',                      'treatment_images_uploaded_by_same_studio_fk'],
    ['treatment_images',                      'treatment_images_deleted_by_same_studio_fk'],
    ['treatment_plans',                       'treatment_plans_created_by_same_studio_fk'],
    ['treatment_plans',                       'treatment_plans_closed_by_same_studio_fk'],
    ['treatment_goals',                       'treatment_goals_created_by_same_studio_fk'],
    ['record_keeping_sterile_items',          'rk_sterile_items_created_by_same_studio_fk'],
    ['record_keeping_disinfectants',          'rk_disinfectants_created_by_same_studio_fk'],
    ['record_keeping_exposure_incidents',     'rk_exposure_incidents_created_by_same_studio_fk'],
    ['stripe_charge_attempts',                'stripe_charge_attempts_initiated_by_same_studio_fk'],
    ['stripe_refund_attempts',                'stripe_refund_attempts_initiated_by_same_studio_fk'],
    ['stripe_payment_audit',                  'stripe_payment_audit_practitioner_same_studio_fk'],
    ['ops_alerts',                            'ops_alerts_resolved_by_same_studio_fk'],
    ['clinical_audit_events',                 'clinical_audit_events_actor_practitioner_id_same_studio_fk'],
    ['clinical_record_amendments',            'clinical_record_amendments_authored_by_same_studio_fk'],
    ['clinical_record_snapshots',             'clinical_record_snapshots_finalized_by_same_studio_fk'],
    ['clinical_record_snapshots',             'clinical_record_snapshots_corrected_by_same_studio_fk'],
    ['sessions',                              'sessions_finalized_by_same_studio_fk'],
    ['client_portal_messages',                'client_portal_messages_created_by_same_studio_fk'],
    ['manual_fee_charge_attempts',            'manual_fee_charge_attempts_cancelled_by_same_studio_fk'],
    ['payment_charge_attempts',               'payment_charge_attempts_cancelled_by_same_studio_fk'],
    ['client_clinical_notes',                 'client_clinical_notes_practitioner_same_studio'],
    ['pending_invitations',                   'pending_invitations_invited_by_same_studio_fk'],
    ['studio_timed_blocks',                   'studio_timed_blocks_created_by_same_studio_fk'],
    ['studio_recurring_break_rules',          'studio_recurring_break_rules_created_by_same_studio_fk'],
    ['client_personal_notes',                 'client_personal_notes_updated_by_same_studio_fk']
  ];
  v_table text;
  v_name  text;
  dirty   text[] := '{}';
  still_invalid text[];
  n_owned constant int := array_length(owned, 1);
begin
  if n_owned <> 39 then
    raise exception '0179: expected 39 owned constraints, found %.', n_owned;
  end if;

  for i in 1 .. n_owned loop
    v_table := owned[i][1];
    v_name  := owned[i][2];

    -- A missing constraint means an earlier section of this migration did not
    -- do what this list says it did. Hard error, never a skip.
    if not exists (
      select 1 from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid
      join pg_namespace n on n.oid = cl.relnamespace
      where n.nspname = 'public' and cl.relname = v_table
        and con.conname = v_name and con.contype = 'f'
    ) then
      raise exception '0179: constraint %.% was never created.', v_table, v_name;
    end if;

    begin
      execute format('alter table public.%I validate constraint %I', v_table, v_name);
    exception when foreign_key_violation then
      -- Collected, not tolerated. The migration aborts below.
      dirty := dirty || format('%s.%s', v_table, v_name);
    end;
  end loop;

  if array_length(dirty, 1) is not null then
    raise exception
      '0179 ABORTED: % of % actor FK constraint(s) have cross-studio historical rows: %. '
      'Remediate the offending rows, then re-apply. 0179 will not commit with unvalidated actor attribution.',
      array_length(dirty, 1), n_owned, array_to_string(dirty, ', ')
      using errcode = 'foreign_key_violation';
  end if;

  -- Belt and braces: prove the postcondition from the catalog rather than from
  -- the loop having appeared to succeed.
  select array_agg(con.conname order by con.conname) into still_invalid
  from pg_constraint con
  join pg_class cl on cl.oid = con.conrelid
  join pg_namespace n on n.oid = cl.relnamespace
  where con.contype = 'f' and n.nspname = 'public' and not con.convalidated
    and con.conname = any (array(select owned[i][2] from generate_series(1, n_owned) i));

  if still_invalid is not null then
    raise exception '0179 ABORTED: constraint(s) still NOT VALID after validation: %.',
      array_to_string(still_invalid, ', ');
  end if;

  raise notice '0179 actor FK integrity: all % constraints validated.', n_owned;
end $$;

-- ===========================================================================
-- 6. RESIDUAL LIMITATION (recorded, not closed here)
-- ===========================================================================
-- ACTOR FK INTEGRITY — PARENT-SCOPED ACTOR COLUMNS WITHOUT LOCAL STUDIO LINEAGE
--
--   electrolysis_entries.deleted_by
--   laser_entries.deleted_by
--   session_audit.edited_by_practitioner_id
--
-- All three are genuine actor stamps, but their tables carry no local studio_id,
-- so the standard same-studio composite cannot be expressed without inventing
-- tenant lineage. 0179 is not authorised to add studio_id to those tables, add
-- parent-derived shadow columns, add denormalisation triggers, or build a
-- parallel tenant-integrity model. They remain ordinary simple practitioner FKs
-- with their existing ON DELETE SET NULL and are UNCHANGED by this migration.
-- This is not a production severity: it is a known gap requiring a separately
-- designed parent-lineage integrity pass.
--
-- Also unclosed, deliberately: ops_alerts same-studio enforcement is partial
-- while ops_alerts.studio_id remains nullable (see section 1).

commit;
