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
-- VALIDATION STRATEGY
-- ---------------------------------------------------------------------------
-- Every new constraint is added NOT VALID first. NOT VALID still enforces the
-- constraint on every INSERT and UPDATE from the moment it is added — it only
-- declines to re-scan pre-existing rows — so forward integrity is unconditional
-- and no table is scanned under an ACCESS EXCLUSIVE lock at apply time.
--
-- History is then validated OPPORTUNISTICALLY by the guarded pass at the end.
-- A constraint whose historical rows do not satisfy it stays NOT VALID and
-- raises a WARNING instead of aborting the apply. This is deliberate: this
-- migration is authored with ZERO production database access, so production's
-- historical rows cannot be inspected beforehand, and an unguarded VALIDATE
-- would turn unknown legacy data into a failed apply.
--
-- Known-dirty history on the local fixture database (886 studios / 1168
-- practitioners): treatment_images.uploaded_by has 5 cross-studio rows and
-- treatment_images.deleted_by has 1. Those rows predate migration 0168, which
-- moved treatment image metadata behind create_treatment_image_metadata and
-- derives studio_id and the actor from the SAME practitioner row via auth.uid()
-- — so writes since 0168 are structurally same-studio by construction. All
-- other 65 practitioner FK columns were clean on that fixture.
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

-- treatment_images.uploaded_by / deleted_by are both derived from auth.uid()
-- inside create_treatment_image_metadata / the delete command (0168), which
-- resolves studio_id and the practitioner from the same row. Pre-0168 rows may
-- still violate this — see the validation note in the header.
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
-- 5. GUARDED VALIDATION PASS
-- ===========================================================================
-- Validate history where it is already clean; leave the constraint NOT VALID
-- (still enforced forward) and warn where it is not. Never aborts the apply.
do $$
declare
  c record;
  validated int := 0;
  deferred  int := 0;
begin
  for c in
    select con.conname, n.nspname, cl.relname
    from pg_constraint con
    join pg_class cl on cl.oid = con.conrelid
    join pg_namespace n on n.oid = cl.relnamespace
    where con.contype = 'f'
      and not con.convalidated
      and n.nspname = 'public'
      and (con.conname like '%\_same\_studio\_fk'
           or con.conname = 'client_clinical_notes_practitioner_same_studio')
    order by cl.relname, con.conname
  loop
    begin
      execute format('alter table %I.%I validate constraint %I',
                     c.nspname, c.relname, c.conname);
      validated := validated + 1;
    exception when others then
      deferred := deferred + 1;
      raise warning
        '0179: % on %.% left NOT VALID (still enforced for new and updated rows); historical rows violate it: %',
        c.conname, c.nspname, c.relname, sqlerrm;
    end;
  end loop;

  raise notice '0179 actor FK integrity: % constraint(s) validated, % left NOT VALID.',
    validated, deferred;
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
