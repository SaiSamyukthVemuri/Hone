-- ---------------------------------------------------------------------------
-- 0174 — APPOINTMENT BOUNDARY B5: attribution + durable audit integrity
--
-- WHY THIS EXISTS
-- ===========================================================================
-- B3 (0172) revoked direct anon/authenticated DML on `public.appointments` and
-- `public.appointment_audit`. B4 (0173) supplied the governed repair commands
-- and closed L23. Both worked on AUTHORITY: who may write.
--
-- Neither one improved the RECORD that is written behind that authority, and
-- neither one protected the record once written. Three facts survived 0173:
--
--   1. `public.appointments` has NO creator column at all (0010:174-190) and no
--      later ALTER adds one. WHO booked an appointment exists only inside an
--      `appointment_audit` row.
--   2. That audit row is deleted with its parent — `appointment_audit
--      .appointment_id` is NOT NULL with ON DELETE CASCADE (0010:219). Delete
--      the appointment and the only evidence of who created it, who cancelled
--      it and who authorised an outside-hours override disappears with it.
--   3. `appointment_audit.created_at` is caller-supplied (it has a DEFAULT, not
--      a trigger). `app/(app)/calendar/[id]/page.tsx:131-139` selects the
--      newest `details` under `order by created_at desc limit 1` and renders it
--      at :566/:580-584/:588-591/:599 — so a row inserted with a chosen
--      timestamp wins that ordering deterministically. PR #521 §16.8 row 7
--      escalated this from "durable-record forgery" to "UI-reachable content
--      control".
--
-- This migration closes all three, and then removes the last ordinary role that
-- could still rewrite appointment lifecycle state directly.
--
-- THE ARCHITECTURAL RULE THIS FILE ESTABLISHES
-- ===========================================================================
--     legitimate appointment business mutation
--       -> reviewed SECURITY DEFINER command
--       -> mutation
--       -> exactly ONE semantic appointment_audit event
--
--     raw service_role lifecycle DML
--       -> DENIED
--
-- What this file deliberately does NOT do, because it was considered and
-- REJECTED: it does not add a generic `appointments` UPDATE trigger that
-- infers a business action from an arbitrary row change and writes an audit
-- event from it. That design produces low-quality, duplicated events ("status
-- changed to cancelled" with no reason, no actor and no source) and it would
-- make the semantic command layer non-authoritative. The commands remain the
-- only writers of appointment_audit ACTIONS. This file adds triggers to
-- `appointment_audit` only, and they derive/protect FIELDS — they never invent
-- an event.
--
-- WHAT THIS FILE DELIBERATELY DOES NOT DO
-- ===========================================================================
-- * It does NOT touch `snapshot_appointment_buffer()` or ANY existing trigger
--   function on `public.appointments`. Production carries an out-of-band GUC
--   behaviour in that function which exists in NO migration in this repository
--   (0172:212-218, 0173:32-38), so emitting `create or replace function` for it
--   from repo source would silently delete a live production behaviour.
-- * It does NOT retire the three caller-less legacy RPCs (`reschedule_
--   appointment`, `practitioner_move_appointment`, `create_internal_
--   appointment`). That is B6 / 0175. Both installed legacy shims delegate to
--   the modern commands (verified on the live catalog: `create_internal_
--   appointment` calls `create_internal_appointment_v2` and forwards
--   `p_actor_practitioner_id`; `practitioner_move_appointment` calls
--   `move_or_reassign_appointment`), so they INHERIT this migration's
--   attribution rather than being able to produce a malformed row.
-- * It does NOT add a status-transition guard, `set_updated_at`, or the
--   `capacity_enabled` trigger fix. B6 / 0175.
-- * It does NOT make public cancellation acknowledgement atomic. B7 / 0176.
-- * It does NOT replace the seven direct postcare writers. B8 / 0177 — and the
--   TEMPORARY six-column grant in GROUP 10.2 is the exact thing B8 removes.
-- * It does NOT weaken B3: no table privilege is granted to `anon` or
--   `authenticated` anywhere below, and `revoke all` is never used (the 0169
--   doctrine — every verb is named).
-- * It does NOT change any B4 public RPC signature or product semantic.
--
-- Own transaction + armed lock_timeout: `supabase db push` does not wrap a
-- migration file in a transaction, so a bare SET LOCAL emits 25P01 and never
-- arms (the 0159 lesson, recorded verbatim at 0169:70-76). `statement_timeout`
-- is deliberately not set — no migration in this repository sets it (0170:40-42)
-- and the backfills below touch a production scale of ~139 appointments and
-- ~220 audit rows.
--
-- Migration max 0173 -> 0174. 0175 stays reserved for B6.
-- ---------------------------------------------------------------------------

begin;

set local lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- GROUP 1 — ATTRIBUTION COLUMNS ON public.appointments (additive, nullable)
--
-- All five are added nullable with no default. NULL is a first-class, MEANINGFUL
-- value in every one of them: it means "no practitioner actor", which is the
-- TRUE state for a public/client booking and for a client-token cancellation.
-- Nothing below ever manufactures a practitioner for a client actor.
--
-- The existing `cancelled_by` ROLE WORD (0010, written by
-- practitioner_cancel_appointment at 0033:294 from the live practitioner row)
-- is RETAINED and untouched. PR #521 §16.8 row 4 corrected PR #520's premise on
-- this: `cancelled_by` is server-derived, not browser-supplied, and it
-- correctly distinguishes client- from practitioner-initiated cancellation.
-- `cancelled_by_practitioner_id` COMPLEMENTS it by recording WHICH practitioner;
-- it does not replace the truthful role/category state.
-- ---------------------------------------------------------------------------

alter table public.appointments
  add column if not exists created_by_practitioner_id   uuid,
  add column if not exists cancelled_by_practitioner_id uuid,
  add column if not exists outside_availability_authorized_by_practitioner_id uuid,
  add column if not exists outside_availability_authorized_role               text,
  add column if not exists outside_availability_authorized_at                 timestamptz;

comment on column public.appointments.created_by_practitioner_id is
  'B5/0174. The practitioner who CREATED this appointment through an internal command. NULL for public/client bookings, where appointment_audit.actor_type=''client'' already carries the fact — a public actor is never given a manufactured practitioner identity. Composite same-studio FK, ON DELETE RESTRICT.';

comment on column public.appointments.cancelled_by_practitioner_id is
  'B5/0174. The practitioner who CANCELLED this appointment. NULL for client-token and public cancellations (including the predecessor leg of a public reschedule, whose real actor is the client). Complements — never replaces — the `cancelled_by` role word. Composite same-studio FK, ON DELETE RESTRICT.';

comment on column public.appointments.outside_availability_authorized_by_practitioner_id is
  'B5/0174 (PR #520 D3). The practitioner who authorised booking/moving this appointment outside working hours. Both commands that can set booked_outside_availability refuse unless the actor is an OWNER, so this column is only ever written together with the role snapshot below. Composite same-studio FK, ON DELETE RESTRICT.';

comment on column public.appointments.outside_availability_authorized_role is
  'B5/0174 (PR #520 D3). The authorising practitioner''s role AT THE TIME of the override, snapshotted so a later role change cannot rewrite history. Always ''owner'' when written by a command — the override is owner-gated (0152 create_internal_appointment_v2 and move_or_reassign_appointment both refuse a non-owner).';

comment on column public.appointments.outside_availability_authorized_at is
  'B5/0174 (PR #520 D3). When the outside-hours override was authorised.';

-- ---------------------------------------------------------------------------
-- GROUP 2 — DURABILITY COLUMNS ON public.appointment_audit (additive, nullable)
--
-- `studio_id` is added NULLABLE here and made NOT NULL in GROUP 4.3, after the
-- backfill in GROUP 3.1. It cannot be added NOT NULL in one statement: the
-- table has rows.
--
-- `actor_practitioner_id` COMPLEMENTS the existing bare `actor_id uuid`
-- (0010:221), which has no FK and carries the client/system namespaces. It is
-- NOT dropped, renamed or re-typed — B5 adds a durable, tenant-checked
-- practitioner correlation next to it and leaves the historical actor namespace
-- exactly as it is.
-- ---------------------------------------------------------------------------

alter table public.appointment_audit
  add column if not exists studio_id             uuid,
  add column if not exists actor_practitioner_id uuid;

comment on column public.appointment_audit.studio_id is
  'B5/0174. Tenant of the audited appointment, derived at INSERT by appointment_audit_derive_trusted_fields() — never accepted from the caller. This is what lets an audit row remain tenant-authorizable (and RLS-readable) after its appointment row no longer exists.';

comment on column public.appointment_audit.actor_practitioner_id is
  'B5/0174. Durable practitioner correlation for actor_type=''practitioner'' rows, derived and same-studio-validated at INSERT. NULL for client and system actors — this column never invents a practitioner for a non-practitioner actor. Complements the historical bare actor_id.';

-- ---------------------------------------------------------------------------
-- GROUP 3 — BACKFILL. EVIDENCE ONLY; AMBIGUITY STAYS NULL.
--
-- The governing rule, applied to every statement in this group:
--
--     if attribution can be PROVEN from surviving authoritative evidence,
--     populate it; otherwise leave it NULL.
--
-- Specifically NOT done anywhere below, because each would be a guess dressed
-- as a record:
--   * actor is never inferred from `appointments.practitioner_id` — the
--     ASSIGNED practitioner is not evidence of who created or cancelled;
--   * `actor_type='client'` is never converted into a practitioner;
--   * an outside-hours actor is never fabricated;
--   * a practitioner id that does not resolve IN THE SAME STUDIO is discarded
--     rather than written, so a stale/cross-tenant id cannot enter the column
--     and then be validated by GROUP 4's FKs.
-- ---------------------------------------------------------------------------

-- GROUP 3.1 — audit tenancy. Fully provable today: `appointment_id` is still
-- NOT NULL at this point in the file (it becomes nullable in GROUP 5), so every
-- existing row has exactly one parent and exactly one studio.
update public.appointment_audit aa
   set studio_id = a.studio_id
  from public.appointments a
 where a.id = aa.appointment_id
   and aa.studio_id is distinct from a.studio_id;

-- GROUP 3.2 — audit actor correlation. Populated ONLY where the row already
-- claims a practitioner actor AND that actor still resolves inside the row's
-- own studio. A `system`/`client` row, a NULL actor_id, and a practitioner id
-- belonging to a different studio all stay NULL.
update public.appointment_audit aa
   set actor_practitioner_id = aa.actor_id
 where aa.actor_type = 'practitioner'
   and aa.actor_id is not null
   and aa.actor_practitioner_id is null
   and exists (
     select 1 from public.practitioners pr
      where pr.id = aa.actor_id
        and pr.studio_id = aa.studio_id
   );

-- GROUP 3.3 — appointment creator. The evidence is the surviving 'created'
-- audit row for that appointment written by a PRACTITIONER actor.
--
-- `count(*) = 1` is load-bearing, not decoration: if an appointment somehow
-- carries two distinct practitioner-created rows the creator is AMBIGUOUS, and
-- an ambiguous creator is left NULL rather than resolved by an arbitrary
-- ordering. Same-studio is re-checked here even though 3.2 already filtered —
-- 3.2 wrote a column, this reads the raw historical actor_id.
update public.appointments a
   set created_by_practitioner_id = ev.actor_id
  from (
    select aa.appointment_id,
           min(aa.actor_id::text)::uuid as actor_id,
           count(*)                     as n
      from public.appointment_audit aa
      join public.practitioners pr
        on pr.id = aa.actor_id
       and pr.studio_id = aa.studio_id
     where aa.action = 'created'
       and aa.actor_type = 'practitioner'
       and aa.actor_id is not null
     group by aa.appointment_id
  ) ev
 where ev.appointment_id = a.id
   and ev.n = 1
   and a.created_by_practitioner_id is null;

-- GROUP 3.4 — appointment canceller. Same evidence rule, plus a state gate: an
-- appointment that is not currently cancelled has no canceller, whatever its
-- history contains (a cancelled-then-reverted appointment must not keep a
-- canceller — B4's revert_appointment_outcome exists precisely for that case).
update public.appointments a
   set cancelled_by_practitioner_id = ev.actor_id
  from (
    select aa.appointment_id,
           min(aa.actor_id::text)::uuid as actor_id,
           count(*)                     as n
      from public.appointment_audit aa
      join public.practitioners pr
        on pr.id = aa.actor_id
       and pr.studio_id = aa.studio_id
     where aa.action = 'cancelled'
       and aa.actor_type = 'practitioner'
       and aa.actor_id is not null
     group by aa.appointment_id
  ) ev
 where ev.appointment_id = a.id
   and ev.n = 1
   and a.status = 'cancelled'
   and a.cancelled_by_practitioner_id is null;

-- GROUP 3.5 — outside-hours override actor, INCLUDING the role snapshot.
--
-- The role is DERIVED, not guessed, and this is the whole justification for
-- writing it: BOTH commands that can set `booked_outside_availability = true`
-- refuse outright unless the acting practitioner's live role is 'owner' —
-- `create_internal_appointment_v2` (0152; `if v_actor_role <> 'owner' and
-- (p_duration_override_minutes is not null or p_allow_outside_availability)
-- then return 'not_authorized'`) and `move_or_reassign_appointment` (0152;
-- `if p_allow_outside_availability and v_actor_role <> 'owner' then return
-- 'not_authorized'`). So an audit row carrying `details->>'outside_availability'
-- = 'true'` with a practitioner actor is PROOF that that actor held 'owner' at
-- that moment. Reading the practitioner's role TODAY would be the guess; the
-- literal below is the recovered fact.
--
-- `_at` comes from the audit row's own created_at — the authorising event's
-- timestamp, which is the thing being recorded.
--
-- Only rows that still carry the flag are touched, and ambiguity (more than one
-- distinct authorising event) stays NULL exactly as in 3.3/3.4.
update public.appointments a
   set outside_availability_authorized_by_practitioner_id = ev.actor_id,
       outside_availability_authorized_role               = 'owner',
       outside_availability_authorized_at                 = ev.at
  from (
    select aa.appointment_id,
           min(aa.actor_id::text)::uuid as actor_id,
           min(aa.created_at)           as at,
           count(distinct aa.actor_id)  as n
      from public.appointment_audit aa
      join public.practitioners pr
        on pr.id = aa.actor_id
       and pr.studio_id = aa.studio_id
     where aa.actor_type = 'practitioner'
       and aa.actor_id is not null
       and aa.details ->> 'outside_availability' = 'true'
     group by aa.appointment_id
  ) ev
 where ev.appointment_id = a.id
   and ev.n = 1
   and a.booked_outside_availability = true
   and a.outside_availability_authorized_by_practitioner_id is null;

-- ---------------------------------------------------------------------------
-- GROUP 4 — CONSTRAINTS AND FOREIGN KEYS
--
-- Every practitioner-attribution FK is COMPOSITE `(column, studio_id)` ->
-- `practitioners (id, studio_id)`, which is the established same-studio shape
-- in this schema: `appointments_practitioner_same_studio_fk`,
-- `manual_fee_charge_attempts_confirmed_by_practitioner_id_st_fkey`,
-- `client_clinical_notes_practitioner_same_studio`, and six others. It resists
-- cross-studio identity corruption structurally: a practitioner id from another
-- tenant cannot satisfy it, so no attribution column can ever name a foreign
-- practitioner. The supporting unique key `practitioners_id_studio_id_unique`
-- already exists (0151) — this file adds no unique index.
--
-- Deletion posture is ON DELETE RESTRICT for every ACTOR/CREATOR column, which
-- is the durable-attribution convention already used by
-- `clinical_audit_events_actor_fk`, `clinical_record_amendments_author_fk`,
-- `clinical_record_snapshots_corrected_by_fk`,
-- `client_portal_messages_created_by_practitioner_id_fkey` and
-- `payment_charge_attempts_cancelled_by_practitioner_id_fkey`. It deliberately
-- makes deleting a practitioner who has created or cancelled an appointment
-- FAIL rather than silently nulling the attribution — historical attribution is
-- not weakened to make practitioner deletion convenient. Note that after 0173
-- GROUP 5.1 no browser role can delete a practitioner at all; the product
-- deactivates (`practitioners.active`, 0001:25) and never hard-deletes.
--
-- This is a deliberate DIFFERENCE from `appointments_practitioner_same_studio_fk`
-- (ON DELETE SET NULL on the ASSIGNED practitioner), and the asymmetry is the
-- point: the assignment is current operational state and may be vacated; the
-- attribution is history and may not.
--
-- The FKs are added NOT VALID and then VALIDATEd in the same transaction. The
-- two steps are not cosmetic: ADD CONSTRAINT ... NOT VALID takes a weaker lock
-- and skips the scan, and VALIDATE then confirms the GROUP 3 backfill really is
-- clean rather than this migration ASSUMING it. If any row were dirty the
-- VALIDATE fails and the whole transaction rolls back — which is the correct
-- outcome, and is why production cleanliness is never guessed here.
-- ---------------------------------------------------------------------------

-- GROUP 4.1 — appointments attribution FKs.
alter table public.appointments
  drop constraint if exists appointments_created_by_practitioner_same_studio_fk;
alter table public.appointments
  add constraint appointments_created_by_practitioner_same_studio_fk
  foreign key (created_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;
alter table public.appointments
  validate constraint appointments_created_by_practitioner_same_studio_fk;

alter table public.appointments
  drop constraint if exists appointments_cancelled_by_practitioner_same_studio_fk;
alter table public.appointments
  add constraint appointments_cancelled_by_practitioner_same_studio_fk
  foreign key (cancelled_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;
alter table public.appointments
  validate constraint appointments_cancelled_by_practitioner_same_studio_fk;

alter table public.appointments
  drop constraint if exists appointments_outside_availability_authorizer_same_studio_fk;
alter table public.appointments
  add constraint appointments_outside_availability_authorizer_same_studio_fk
  foreign key (outside_availability_authorized_by_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;
alter table public.appointments
  validate constraint appointments_outside_availability_authorizer_same_studio_fk;

-- GROUP 4.2 — override-attribution coherence.
--
-- Enforced direction: an appointment that is NOT flagged outside-availability
-- may carry NO override attribution at all. That is the forgery-relevant
-- direction and it is provably clean (the columns were created empty in GROUP 1
-- and GROUP 3.5 only writes rows where the flag is true), so it VALIDATEs.
--
-- The converse — flag true IMPLIES an authoriser — is deliberately NOT
-- enforced: historical override rows whose authorising audit event did not
-- survive (or was ambiguous) legitimately carry the flag with a NULL
-- authoriser, and inventing one to satisfy a constraint is exactly what GROUP 3
-- refuses to do.
--
-- The role/at columns are bound to the id: no role snapshot without an actor.
alter table public.appointments
  drop constraint if exists appointments_outside_availability_attribution_ck;
alter table public.appointments
  add constraint appointments_outside_availability_attribution_ck
  check (
    (
      booked_outside_availability = true
      or (
        outside_availability_authorized_by_practitioner_id is null
        and outside_availability_authorized_role is null
        and outside_availability_authorized_at is null
      )
    )
    and (
      outside_availability_authorized_by_practitioner_id is not null
      or (
        outside_availability_authorized_role is null
        and outside_availability_authorized_at is null
      )
    )
  )
  not valid;
alter table public.appointments
  validate constraint appointments_outside_availability_attribution_ck;

-- GROUP 4.3 — audit tenancy is now mandatory. GROUP 3.1 proved every existing
-- row derivable, and GROUP 6's INSERT trigger derives it for every future row,
-- so NOT NULL is reachable rather than aspirational.
alter table public.appointment_audit
  alter column studio_id set not null;

-- ON DELETE RESTRICT is this repository's convention for the studio key of an
-- append-only history table — `clinical_audit_events_studio_fk`,
-- `clinical_record_amendments_studio_fk` and
-- `clinical_record_snapshots_studio_fk` are all RESTRICT. CASCADE was
-- considered and rejected: it would be the one path that can still ERASE audit
-- history (delete the tenant, lose the trail), and GROUP 9's append-only DELETE
-- arm would have to carve out an exception for it — turning a clean referential
-- error into a confusing trigger error while opening the exact hole this
-- migration exists to close.
alter table public.appointment_audit
  drop constraint if exists appointment_audit_studio_fk;
alter table public.appointment_audit
  add constraint appointment_audit_studio_fk
  foreign key (studio_id) references public.studios (id)
  on delete restrict
  not valid;
alter table public.appointment_audit
  validate constraint appointment_audit_studio_fk;

-- GROUP 4.4 — audit actor correlation FK, same composite same-studio shape.
alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_practitioner_same_studio_fk;
alter table public.appointment_audit
  add constraint appointment_audit_actor_practitioner_same_studio_fk
  foreign key (actor_practitioner_id, studio_id)
  references public.practitioners (id, studio_id)
  on delete restrict
  not valid;
alter table public.appointment_audit
  validate constraint appointment_audit_actor_practitioner_same_studio_fk;

-- GROUP 4.5 — the actor model, correlated but NOT retro-enforced.
--
-- `appointment_audit_actor_practitioner_type_ck` is the invariant that matters
-- going forward: only a practitioner row may carry a practitioner correlation.
-- It VALIDATEs because GROUP 3.2 wrote the column only for practitioner rows.
--
-- `appointment_audit_actor_id_type_ck` correlates the HISTORICAL bare actor_id
-- with actor_type and is left NOT VALID ON PURPOSE. Production may hold rows
-- written by commands that no longer exist — `finalize_card_required_public_
-- booking` was dropped at 0091:174 — and this migration does not probe
-- production to find out. NOT VALID enforces the rule for every new row while
-- refusing to assert something about history that has not been measured. A
-- later migration may VALIDATE it once a read-only production probe says it is
-- clean; nothing here guesses.
alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_practitioner_type_ck;
alter table public.appointment_audit
  add constraint appointment_audit_actor_practitioner_type_ck
  check (
    actor_practitioner_id is null
    or actor_type = 'practitioner'
  )
  not valid;
alter table public.appointment_audit
  validate constraint appointment_audit_actor_practitioner_type_ck;

alter table public.appointment_audit
  drop constraint if exists appointment_audit_actor_id_type_ck;
alter table public.appointment_audit
  add constraint appointment_audit_actor_id_type_ck
  check (
    (actor_type = 'practitioner' and actor_id is not null)
    or (actor_type in ('client', 'system') and actor_id is null)
  )
  not valid;

comment on constraint appointment_audit_actor_id_type_ck on public.appointment_audit is
  'B5/0174. Correlates the historical bare actor_id with actor_type. Deliberately NOT VALID: production may hold rows written by since-dropped commands (e.g. finalize_card_required_public_booking, dropped 0091:174) and B5 performed no production probe. Enforced for every new row. VALIDATE only after a read-only production probe proves history clean.';

-- GROUP 4.6 — supporting index for the rewritten tenant read policy (GROUP 8)
-- and for per-tenant retention/export of orphaned history. The existing
-- `appointment_audit_appointment_idx` cannot serve either once appointment_id
-- may be NULL.
create index if not exists appointment_audit_studio_created_idx
  on public.appointment_audit (studio_id, created_at desc);

-- ---------------------------------------------------------------------------
-- GROUP 5 — PARENT-DELETE SURVIVAL: appointment_id nullable, FK CASCADE -> SET NULL
--
-- This is the structural answer that no privilege revoke can give: history that
-- OUTLIVES its parent row. After this group, deleting an appointment through an
-- actually-authorized privileged path leaves its audit trail in place with
-- `appointment_id = NULL` and `studio_id`, `actor_*`, `action`, `details` and
-- `created_at` all intact — and GROUP 8 makes that orphaned row still readable
-- by its own studio's members and still invisible to everyone else.
--
-- ORDERING IS LOAD-BEARING. This group MUST precede GROUP 9. Installed the
-- other way round, the append-only DELETE arm would be live while the FK still
-- cascaded, and every appointment DELETE in the tree would fail — including
-- tests/db/practitioner-move-appointment.db.test.ts:117,124,
-- tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:285,294,415 and
-- tests/db/google-calendar-c1-link-transition.db.test.ts:297,324, all of which
-- delete appointments and relied on the 0010:219 cascade. (The `tests/db` lane
-- is CONDITIONAL in CI — .github/workflows/ci.yml — so a PR touching no
-- supabase/** path would not even reveal it. This one touches supabase/**.)
-- ---------------------------------------------------------------------------

alter table public.appointment_audit
  alter column appointment_id drop not null;

alter table public.appointment_audit
  drop constraint if exists appointment_audit_appointment_id_fkey;
alter table public.appointment_audit
  add constraint appointment_audit_appointment_id_fkey
  foreign key (appointment_id) references public.appointments (id)
  on delete set null;

comment on column public.appointment_audit.appointment_id is
  'B5/0174. NULLABLE since 0174. ON DELETE SET NULL (was CASCADE, 0010:219): deleting an appointment through an authorized privileged path DETACHES its audit history instead of erasing it. An orphaned row keeps studio_id, actor_type, actor_id, actor_practitioner_id, action, details and created_at, and remains readable by its own studio under appointment_audit_member_read.';

-- ---------------------------------------------------------------------------
-- GROUP 6 — TRUSTED INSERT DERIVATION
--
-- The audit boundary DERIVES its trusted fields instead of accepting caller
-- authority for them. Three fields, three reasons:
--
--   created_at            was caller-supplied and therefore forgeable, and PR
--                         #521 §16.8 row 7 showed a forged timestamp wins the
--                         `order by created_at desc limit 1` that drives the
--                         cancellation-insight card. It is now ALWAYS
--                         overwritten with the database clock. Back-dating is
--                         not rejected — it is silently overwritten, which is
--                         strictly safer: a caller cannot even detect the
--                         difference between "my timestamp was used" and "mine
--                         was discarded" by observing an error.
--
--                         This also protects B4: revert_appointment_outcome's
--                         72-hour repair window is measured from
--                         `appointment_audit.created_at DESC` (0173), so a
--                         caller-chosen timestamp was a way to widen or forge
--                         that security-sensitive window.
--
--   studio_id             is read from the LOCKED-BY-FK parent appointment, not
--                         accepted from the caller. A service caller cannot
--                         file an audit row into an arbitrary tenant that
--                         merely happens to satisfy a weak FK.
--
--   actor_practitioner_id is DERIVED from (actor_type, actor_id) and validated
--                         against the DERIVED studio. It is never accepted from
--                         the caller: the assignment below overwrites whatever
--                         was passed. A client/system actor gets NULL. A
--                         practitioner actor whose id does not resolve in the
--                         derived studio gets NULL rather than a cross-tenant
--                         correlation (and the GROUP 4.4 FK would refuse it
--                         anyway — this makes the refusal unnecessary rather
--                         than relying on it).
--
-- SECURITY INVOKER, hardened empty search_path, every object schema-qualified —
-- matching guard_snapshot_append_only (0119:168-179) and
-- guard_finalized_clinical_write (0120:238-243). It needs no elevated rights:
-- it only reads two tables the inserting command already reads.
--
-- This trigger derives FIELDS. It never invents an EVENT. The commands remain
-- the sole authors of appointment_audit actions.
-- ---------------------------------------------------------------------------

create or replace function public.appointment_audit_derive_trusted_fields()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_studio_id uuid;
begin
  -- 1. Tenancy: always derived from the parent when there is one.
  if new.appointment_id is not null then
    select a.studio_id into v_studio_id
      from public.appointments a
     where a.id = new.appointment_id;

    if v_studio_id is null then
      raise exception
        'appointment_audit: appointment % does not exist; cannot derive studio_id.',
        new.appointment_id
        using errcode = 'foreign_key_violation';
    end if;

    new.studio_id := v_studio_id;
  end if;

  -- A parentless INSERT is not a normal path (GROUP 5 creates orphans by
  -- DETACHING existing rows, never by inserting new ones). It is permitted only
  -- when the caller supplies a tenant explicitly, and the NOT NULL from
  -- GROUP 4.3 refuses it otherwise.
  if new.studio_id is null then
    raise exception
      'appointment_audit: studio_id could not be derived and none was supplied.'
      using errcode = 'not_null_violation';
  end if;

  -- 2. Time: ALWAYS the database clock. Caller input is discarded, not trusted,
  --    not merely defaulted.
  new.created_at := now();

  -- 3. Actor correlation: derived and same-studio validated. Overwrites any
  --    caller-supplied value unconditionally.
  if new.actor_type = 'practitioner'
     and new.actor_id is not null
     and exists (
       select 1 from public.practitioners pr
        where pr.id = new.actor_id
          and pr.studio_id = new.studio_id
     )
  then
    new.actor_practitioner_id := new.actor_id;
  else
    new.actor_practitioner_id := null;
  end if;

  return new;
end;
$$;

comment on function public.appointment_audit_derive_trusted_fields() is
  'B5/0174. BEFORE INSERT on appointment_audit. Derives studio_id from the parent appointment, forces created_at to the database clock (closing the caller-chosen-timestamp forgery that drives the cancellation-insight ordering and B4''s 72-hour repair window), and derives/validates actor_practitioner_id against the derived studio. Derives FIELDS only — never writes an audit EVENT.';

revoke all on function public.appointment_audit_derive_trusted_fields() from public, anon, authenticated, service_role;

drop trigger if exists appointment_audit_derive_trusted_fields_trg on public.appointment_audit;
create trigger appointment_audit_derive_trusted_fields_trg
  before insert on public.appointment_audit
  for each row execute function public.appointment_audit_derive_trusted_fields();

-- ---------------------------------------------------------------------------
-- GROUP 7 — COMMAND WRITERS GAIN ATTRIBUTION
--
-- Three functions are re-emitted. Each body below is the EXACT current
-- definition read from the live catalog on a fresh 0001->0173 chain, with only
-- the attribution statements added; no gate, no lock order, no return contract
-- and no audit action is altered. The re-emission is unavoidable — PostgreSQL
-- has no partial function-body patch — and is the same mechanism 0146, 0148 and
-- 0152 used for these very functions.
--
-- The three NOT re-emitted, and why, since "why is this one missing" is the
-- first review question:
--   * create_public_appointment / reschedule_appointment_v2 /
--     public_cancel_appointment_with_token — all three write `actor_type
--     'client', actor_id null`, verified on the live catalog. Their REAL actor
--     is the client, so the correct value for every practitioner-attribution
--     column is NULL, which is what the columns already hold. Writing anything
--     else would manufacture a practitioner for a public actor. In particular
--     the public reschedule's PREDECESSOR cancellation (`cancelled_by =
--     'client'`) and its SUCCESSOR creation are BOTH client-actor events; B5
--     preserves those semantics exactly rather than assuming a practitioner.
--   * mark_appointment_complete / mark_appointment_no_show — practitioner
--     actors, but they neither create nor cancel nor override. Their audit
--     actor correlation is supplied by GROUP 6's trigger with no code change,
--     which is precisely why that derivation lives in a trigger.
--   * revert_appointment_outcome / set_appointment_notes (B4) — unchanged. They
--     audit through write_appointment_audit and inherit GROUP 6 identically.
--     Their signatures, gates, 72-hour window and sentinels are untouched.
--   * create_internal_appointment / practitioner_move_appointment (legacy,
--     installed, caller-less) — pure delegating shims over the two functions
--     re-emitted below, forwarding the actor argument. They inherit attribution
--     with no change and cannot produce a malformed row. B6 owns their
--     retirement.
-- ---------------------------------------------------------------------------

-- GROUP 7.1 — create_internal_appointment_v2: record the CREATOR, and the
-- outside-hours authoriser when the override was actually exercised.
--
-- The body below is the EXACT definition read from the live catalog on a fresh
-- 0001->0173 chain, transformed programmatically so that the ONLY difference is
-- the added column list and value list in the appointments INSERT. Every gate,
-- the studios FOR UPDATE + capacity-lock order, the service FOR UPDATE, the
-- eligibility check, the 15/360/%15 duration bounds and every sentinel string
-- ('studio_not_found', 'booking_paused', 'not_authorized', 'invalid_practitioner',
-- 'invalid_client', 'invalid_service', 'not_eligible', 'invalid_duration',
-- 'invalid_time') are byte-identical to what 0152 left installed.
CREATE OR REPLACE FUNCTION public.create_internal_appointment_v2(p_studio_id uuid, p_actor_practitioner_id uuid, p_target_practitioner_id uuid, p_client_id uuid, p_service_id uuid, p_starts_at timestamp with time zone, p_cancellation_token_hash text, p_notes text DEFAULT NULL::text, p_duration_override_minutes integer DEFAULT NULL::integer, p_allow_outside_availability boolean DEFAULT false)
 RETURNS TABLE(result text, appointment_id uuid, starts_at timestamp with time zone, ends_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_cap          boolean;
  v_book         boolean;
  v_actor_role   text;
  v_service_dur  integer;
  v_duration     integer;
  v_ends_at      timestamptz;
  v_avail        text;
  v_appt_id      uuid;
  v_now          timestamptz := now();
begin
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  if v_cap and not v_book then
    return query select 'booking_paused'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_actor_role <> 'owner'
     and p_target_practitioner_id is distinct from p_actor_practitioner_id then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  if v_actor_role <> 'owner'
     and (p_duration_override_minutes is not null or p_allow_outside_availability) then
    return query select 'not_authorized'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.practitioners pr
     where pr.id = p_target_practitioner_id and pr.studio_id = p_studio_id and pr.active = true
  ) then
    return query select 'invalid_practitioner'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if not exists (
    select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id
  ) then
    return query select 'invalid_client'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  select sv.default_duration_minutes into v_service_dur
    from public.services sv
   where sv.id = p_service_id and sv.studio_id = p_studio_id and sv.active = true
   for update;
  if not found then
    return query select 'invalid_service'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if v_cap and not exists (
    select 1 from public.service_practitioners sp
     where sp.service_id = p_service_id and sp.practitioner_id = p_target_practitioner_id
  ) then
    return query select 'not_eligible'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_duration_override_minutes is not null then
    if p_duration_override_minutes < 15 or p_duration_override_minutes > 360
       or (p_duration_override_minutes % 15) <> 0 then
      return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
      return;
    end if;
    v_duration := p_duration_override_minutes;
  else
    v_duration := v_service_dur;
  end if;
  if v_duration is null or v_duration <= 0 then
    return query select 'invalid_duration'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  if p_starts_at is null or p_starts_at <= v_now then
    return query select 'invalid_time'::text, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;
  v_ends_at := p_starts_at + make_interval(mins => v_duration);

  v_avail := public.validate_appointment_availability(
    p_studio_id, p_target_practitioner_id, p_service_id,
    p_starts_at, v_ends_at, null, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, null::uuid, null::timestamptz, null::timestamptz;
    return;
  end if;

  insert into public.appointments
    (studio_id, practitioner_id, client_id, service_id, starts_at, ends_at,
     duration_minutes, status, notes, cancellation_token_hash,
     booked_outside_availability,
     -- B5/0174 attribution. The creator is the SERVER-RESOLVED actor (v_actor_role
     -- above already proved p_actor_practitioner_id is an ACTIVE practitioner in
     -- p_studio_id, returning 'not_authorized' otherwise), never a passed-through
     -- display value. The override columns are written ONLY when the override was
     -- actually exercised, and v_actor_role is provably 'owner' at that point
     -- because the gate above refuses every non-owner override.
     created_by_practitioner_id,
     outside_availability_authorized_by_practitioner_id,
     outside_availability_authorized_role,
     outside_availability_authorized_at)
  values
    (p_studio_id, p_target_practitioner_id, p_client_id, p_service_id, p_starts_at, v_ends_at,
     v_duration, 'confirmed', p_notes, p_cancellation_token_hash,
     p_allow_outside_availability,
     p_actor_practitioner_id,
     case when p_allow_outside_availability then p_actor_practitioner_id end,
     case when p_allow_outside_availability then v_actor_role end,
     case when p_allow_outside_availability then v_now end)
  returning id into v_appt_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt_id, 'practitioner', p_actor_practitioner_id, 'created',
    jsonb_build_object(
      'source', 'internal_booking_command_v2',
      'target_practitioner_id', p_target_practitioner_id,
      'duration_minutes', v_duration,
      'duration_overridden', (p_duration_override_minutes is not null),
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select 'created'::text, v_appt_id, p_starts_at, v_ends_at;
  return;
end;
$function$;;

-- GROUP 7.2 — practitioner_cancel_appointment: record WHICH practitioner
-- cancelled, alongside the RETAINED `cancelled_by` role word.
--
-- Same method: the exact 0033 definition with one assignment added to the
-- existing UPDATE. The terminal-safe guard, the ordering of the status checks
-- and all four sentinels ('not_authorized', 'not_cancelable',
-- 'already_cancelled', 'cancelled') are unchanged.
CREATE OR REPLACE FUNCTION public.practitioner_cancel_appointment(p_appointment_id uuid, p_studio_id uuid, p_practitioner_id uuid, p_reason text)
 RETURNS text
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_role text;
  v_appt public.appointments%rowtype;
begin
  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_practitioner_id
     and pr.studio_id = p_studio_id
     and pr.active = true;
  if not found then
    return 'not_authorized';
  end if;

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id
     and a.studio_id = p_studio_id
   for update;
  if not found then
    return 'not_cancelable';
  end if;

  if v_appt.status = 'cancelled' then
    return 'already_cancelled';
  end if;

  if v_appt.status <> 'confirmed' then
    return 'not_cancelable';
  end if;

  -- Terminal-safe guard: once an appointment has started, the legitimate
  -- practitioner outcomes are Mark Complete or Mark No-Show. Cancellation
  -- is no longer correct because the treatment either happened or did
  -- not happen; either way the row's outcome should not be 'cancelled'.
  -- This refuses both an in-progress appointment and one that ended in
  -- the past but was never marked complete / no-show.
  if v_appt.starts_at <= now() then
    return 'not_cancelable';
  end if;

  update public.appointments
     set status              = 'cancelled',
         cancelled_at        = now(),
         cancelled_by        = v_role,
         -- B5/0174. The ROLE WORD above is retained unchanged (it is server-derived
         -- from the live practitioner row and correctly distinguishes client- from
         -- practitioner-initiated). This records WHICH practitioner, which nothing
         -- on the row previously did.
         cancelled_by_practitioner_id = p_practitioner_id,
         cancellation_reason = p_reason,
         updated_at          = now()
   where id = p_appointment_id;

  insert into public.appointment_audit (
    appointment_id, actor_type, actor_id, action, details
  ) values (
    p_appointment_id, 'practitioner', p_practitioner_id, 'cancelled',
    jsonb_build_object(
      'reason', coalesce(p_reason, ''),
      'role',   v_role,
      'source', 'practitioner_action'
    )
  );

  return 'cancelled';
end;
$function$;;

-- GROUP 7.3 — move_or_reassign_appointment: carry the outside-hours override
-- authoriser across a move, and CLEAR it when the move no longer needs one.
--
-- Same method: the exact 0152 definition with three assignments added to the
-- existing UPDATE. The optimistic-concurrency check on
-- (p_expected_starts_at, p_expected_ends_at), the owner gates, the capacity
-- branch, the availability validator call and every sentinel are unchanged.
CREATE OR REPLACE FUNCTION public.move_or_reassign_appointment(p_appointment_id uuid, p_studio_id uuid, p_actor_practitioner_id uuid, p_target_practitioner_id uuid, p_expected_starts_at timestamp with time zone, p_expected_ends_at timestamp with time zone, p_new_starts_at timestamp with time zone, p_allow_outside_availability boolean DEFAULT false)
 RETURNS TABLE(result text, appointment_id uuid, previous_starts_at timestamp with time zone, previous_ends_at timestamp with time zone, new_starts_at timestamp with time zone, new_ends_at timestamp with time zone, previous_practitioner_id uuid, new_practitioner_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'pg_temp'
AS $function$
declare
  v_cap        boolean;
  v_book       boolean;
  v_actor_role text;
  v_appt       public.appointments%rowtype;
  v_target     uuid;
  v_new_ends   timestamptz;
  v_reassign   boolean;
  v_time_move  boolean;
  v_avail      text;
  v_now        timestamptz := now();
begin
  select coalesce(s.practitioner_capacity_enabled, false),
         coalesce(s.practitioner_capacity_booking_enabled, false)
    into v_cap, v_book
    from public.studios s
   where s.id = p_studio_id
   for update;
  if not found then
    return query select 'studio_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;
  perform public.acquire_studio_capacity_lock(p_studio_id);

  select * into v_appt
    from public.appointments a
   where a.id = p_appointment_id and a.studio_id = p_studio_id
   for update;
  if not found then
    return query select 'appointment_not_found'::text, null::uuid, null::timestamptz, null::timestamptz,
      null::timestamptz, null::timestamptz, null::uuid, null::uuid;
    return;
  end if;

  v_target := coalesce(p_target_practitioner_id, v_appt.practitioner_id);

  if v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now then
    return query select 'appointment_not_movable'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if v_appt.starts_at is distinct from p_expected_starts_at
     or v_appt.ends_at is distinct from p_expected_ends_at then
    return query select 'stale_appointment'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if p_new_starts_at is null or p_new_starts_at <= v_now then
    return query select 'invalid_time'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_reassign  := v_target is distinct from v_appt.practitioner_id;
  v_time_move := p_new_starts_at is distinct from v_appt.starts_at;

  select pr.role into v_actor_role
    from public.practitioners pr
   where pr.id = p_actor_practitioner_id and pr.studio_id = p_studio_id and pr.active = true;
  if v_actor_role is null then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  if v_actor_role <> 'owner'
     and (v_appt.practitioner_id is distinct from p_actor_practitioner_id or v_reassign) then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;
  if p_allow_outside_availability and v_actor_role <> 'owner' then
    return query select 'not_authorized'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  if v_cap then
    if not exists (
      select 1 from public.practitioners pr
       where pr.id = v_target and pr.studio_id = p_studio_id and pr.active = true
    ) then
      return query select
        case when v_reassign then 'invalid_practitioner' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
    if v_appt.service_id is not null and not exists (
      select 1 from public.service_practitioners sp
       where sp.service_id = v_appt.service_id and sp.practitioner_id = v_target
    ) then
      return query select
        case when v_reassign then 'not_eligible' else 'practitioner_reassignment_required' end,
        v_appt.id, v_appt.starts_at, v_appt.ends_at,
        null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
      return;
    end if;
  end if;

  if not v_time_move and not v_reassign then
    return query select 'no_change'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      v_appt.starts_at, v_appt.ends_at, v_appt.practitioner_id, v_appt.practitioner_id;
    return;
  end if;

  if v_cap and not v_book then
    return query select 'booking_paused'::text, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  v_new_ends := p_new_starts_at + make_interval(mins => v_appt.duration_minutes);

  v_avail := public.validate_appointment_availability(
    p_studio_id, v_target, v_appt.service_id,
    p_new_starts_at, v_new_ends, v_appt.id, p_allow_outside_availability
  );
  if v_avail <> 'ok' then
    return query select v_avail, v_appt.id, v_appt.starts_at, v_appt.ends_at,
      null::timestamptz, null::timestamptz, v_appt.practitioner_id, null::uuid;
    return;
  end if;

  update public.appointments
     set starts_at                   = p_new_starts_at,
         ends_at                     = v_new_ends,
         practitioner_id             = v_target,
         booked_outside_availability = p_allow_outside_availability,
         -- B5/0174. Re-attribute the override to the practitioner who authorised
         -- THIS move, or CLEAR it entirely when this move needs no override. The
         -- clearing arm is load-bearing: booked_outside_availability is assigned
         -- unconditionally here, so a move back inside working hours flips the flag
         -- to false, and a stale authoriser left behind would both violate
         -- appointments_outside_availability_attribution_ck and attribute an
         -- override that no longer exists (PR #520 A-P2-01: "a later move preserves
         -- it silently"). v_actor_role is provably 'owner' whenever the flag is set,
         -- because the gate above refuses every non-owner override.
         outside_availability_authorized_by_practitioner_id =
           case when p_allow_outside_availability then p_actor_practitioner_id end,
         outside_availability_authorized_role =
           case when p_allow_outside_availability then v_actor_role end,
         outside_availability_authorized_at =
           case when p_allow_outside_availability then v_now end,
         updated_at                  = v_now
   where id = v_appt.id and studio_id = p_studio_id;

  insert into public.appointment_audit (appointment_id, actor_type, actor_id, action, details)
  values (
    v_appt.id, 'practitioner', p_actor_practitioner_id,
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    jsonb_build_object(
      'source', 'internal_move_reassign_command',
      'previous_starts_at', v_appt.starts_at,
      'previous_ends_at', v_appt.ends_at,
      'new_starts_at', p_new_starts_at,
      'new_ends_at', v_new_ends,
      'previous_practitioner_id', v_appt.practitioner_id,
      'new_practitioner_id', v_target,
      'outside_availability', p_allow_outside_availability
    )
  );

  return query select
    case when v_reassign and v_time_move then 'moved_and_reassigned'
         when v_reassign then 'reassigned'
         else 'moved' end,
    v_appt.id, v_appt.starts_at, v_appt.ends_at, p_new_starts_at, v_new_ends,
    v_appt.practitioner_id, v_target;
  return;
end;
$function$;;

-- Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon, authenticated AND
-- service_role at function-create time. CREATE OR REPLACE preserves an existing
-- ACL, so the three above keep exactly the grants 0033/0152 left them
-- (postgres + service_role). These REVOKEs are belt-and-braces against a
-- create-path that did not preserve them, and are the doctrine CLAUDE.md §5
-- records after the 0129 and 0164 misses. service_role EXECUTE is INTENTIONALLY
-- retained on all three: they are the governed command layer.
revoke execute on function public.create_internal_appointment_v2(
  uuid, uuid, uuid, uuid, uuid, timestamptz, text, text, integer, boolean
) from public, anon, authenticated;
revoke execute on function public.practitioner_cancel_appointment(
  uuid, uuid, uuid, text
) from public, anon, authenticated;
revoke execute on function public.move_or_reassign_appointment(
  uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz, boolean
) from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- GROUP 8 — RLS: MEMBER READ MOVES ONTO studio_id
--
-- 0010:280-288 reached the tenant THROUGH the appointment:
--     using (appointment_id in (select id from appointments where is_studio_member(studio_id)))
-- After GROUP 5 that predicate silently drops every orphaned row — NULL is not
-- IN anything — so the durability this migration just bought would be invisible
-- to the only role that should see it.
--
-- The rewrite uses the SAME tenant authority, `public.is_studio_member`, applied
-- to the row's OWN studio_id. is_studio_member is NOT modified, re-derived or
-- widened. Behaviour for live rows is identical (studio_id was derived from the
-- appointment); behaviour for orphaned rows is the point.
--
-- SELECT only. No write policy is added for any browser role — B3's posture is
-- unchanged, and `appointment_audit_member_insert` (dropped by 0172) is not
-- resurrected.
-- ---------------------------------------------------------------------------

drop policy if exists appointment_audit_member_read on public.appointment_audit;
create policy appointment_audit_member_read
  on public.appointment_audit for select to authenticated
  using (public.is_studio_member(studio_id));

-- ---------------------------------------------------------------------------
-- GROUP 9 — STRUCTURAL APPEND-ONLY, WITH ONE EXACT REFERENTIAL EXCEPTION
--
-- B3 removed UPDATE/DELETE from the browser roles and GROUP 10.3 removes them
-- from service_role. That is AUTHORITY, and it is not enough: a privilege can
-- be re-granted out of band by platform tooling or an `auto_expose_new_tables`
-- regression (0172:150-152 records exactly that risk). This trigger is the
-- STRUCTURAL layer that survives such a re-grant.
--
-- THE INTERACTION THIS GROUP EXISTS TO GET RIGHT
-- ===========================================================================
-- PostgreSQL referential actions do NOT bypass user triggers. GROUP 5 changed
-- the parent FK to ON DELETE SET NULL, which the RI machinery implements as an
-- ordinary `UPDATE ... SET appointment_id = NULL` against this table — and a
-- BEFORE UPDATE row trigger fires for it. A naive "reject every UPDATE" guard,
-- which is what guard_snapshot_append_only (0119:168) and
-- reject_payment_audit_mutation (0032:1400) do for their tables, would
-- therefore make every appointment DELETE fail and would defeat GROUP 5
-- entirely.
--
-- So the UPDATE arm permits EXACTLY ONE shape, and it is defined by the data,
-- never by the role:
--
--   (a) appointment_id transitions NOT NULL -> NULL, and
--   (b) EVERY other column is byte-identical (whole-row jsonb comparison with
--       appointment_id removed from both sides — not a hand-written column
--       list, which would silently permit any column added after today), and
--   (c) the parent appointment is ALREADY GONE.
--
-- (c) is what stops this from being a general "detach the row" bypass. During a
-- genuine ON DELETE SET NULL the parent row is deleted before the RI action
-- runs, so the check passes; a caller trying to orphan a LIVE audit row to hide
-- it from the appointment detail view finds the parent still present and is
-- refused. Nothing in the rule consults current_user, so it is NOT a
-- service_role escape hatch — service_role holds no UPDATE privilege here at
-- all after GROUP 10.3, and would still be refused by this trigger if it did.
--
-- The DELETE arm has NO exception. The studio FK is RESTRICT (GROUP 4.3), so
-- there is no cascade that needs to delete an audit row, and therefore no
-- second carve-out to reason about.
--
-- ORDERING: this group MUST come after GROUP 5. See the note there.
-- ---------------------------------------------------------------------------

create or replace function public.guard_appointment_audit_append_only()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  if tg_op = 'UPDATE'
     and old.appointment_id is not null
     and new.appointment_id is null
     and (to_jsonb(new) - 'appointment_id') = (to_jsonb(old) - 'appointment_id')
     and not exists (
       select 1 from public.appointments a where a.id = old.appointment_id
     )
  then
    -- The ON DELETE SET NULL detach, and nothing else.
    return new;
  end if;

  raise exception
    'appointment_audit is append-only: rows cannot be updated or deleted. The only permitted change is the ON DELETE SET NULL detach performed when the parent appointment is deleted.'
    using errcode = 'insufficient_privilege';
end;
$$;

comment on function public.guard_appointment_audit_append_only() is
  'B5/0174. BEFORE UPDATE OR DELETE on appointment_audit. Refuses every mutation except the exact referential detach performed by appointment_audit_appointment_id_fkey ON DELETE SET NULL: appointment_id NOT NULL -> NULL, all other columns byte-identical, and the parent appointment already deleted. The rule is defined by data shape only and never consults the calling role, so it is not a service_role bypass.';

revoke all on function public.guard_appointment_audit_append_only() from public, anon, authenticated, service_role;

drop trigger if exists appointment_audit_append_only on public.appointment_audit;
create trigger appointment_audit_append_only
  before update or delete on public.appointment_audit
  for each row execute function public.guard_appointment_audit_append_only();

-- ---------------------------------------------------------------------------
-- GROUP 10 — SERVICE_ROLE NARROWING (the "Option E" posture)
--
-- Before this group, `service_role` held arwdDxtm on BOTH tables — the full set
-- — so the entire command layer was advisory for anything running with the
-- service key. Every lifecycle field on `public.appointments` (status,
-- starts_at, ends_at, practitioner_id, the cancellation fields) could be
-- rewritten directly, with no audit row, no lock protocol, no gate. That is the
-- last ordinary bypass of the architectural rule at the top of this file, and
-- this group closes it.
--
-- SELECT is retained on both tables: every server read path depends on it, and
-- `revoke all` is never used here (0169 doctrine — verbs are named one by one).
-- ---------------------------------------------------------------------------

-- GROUP 10.1 — appointments: every write and maintenance verb goes.
-- MAINTAIN exists from PostgreSQL 17 (this project runs 17.x) and is included
-- so a REFRESH/CLUSTER/VACUUM-class grant cannot be the residue that reads as
-- intentional.
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.appointments from service_role;

-- GROUP 10.2 — THE TEMPORARY B8 EXCEPTION. READ THIS BEFORE CHANGING IT.
--
-- Seven direct writers remain in the application, all on the service-role
-- client, all confined to postcare email bookkeeping — frozen by B1's census
-- guard at tests/security/appointment-direct-dml-guard.test.ts:
--
--   app/(app)/calendar/actions.ts:1115, 1156, 1212, 1243
--   app/(app)/calendar/postcare-auto-send.ts:151, 186, 200
--
-- They touch exactly these SIX columns and no others. A column-level UPDATE
-- grant is the narrowest privilege that keeps them working while denying every
-- lifecycle field, and it is enforced by PostgreSQL rather than by convention:
-- naming ANY seventh column in the same UPDATE statement fails the whole
-- statement with 42501.
--
-- *** B8 / 0177 OWNS THE REMOVAL OF THIS GRANT. ***
-- B8's contract, stated here so it cannot be lost:
--   1. replace all seven direct postcare writes with a governed command;
--   2. drive B1's direct-writer count from 7 to 0;
--   3. `revoke update (…the six columns…) on table public.appointments
--       from service_role;`
--   4. leave ZERO ordinary service_role DML on public.appointments.
-- Until all four happen, this grant is load-bearing and removing it breaks
-- postcare email. It is pinned by name in the B5 test suite so B8 knows exactly
-- what to delete and CI notices if it is widened.
grant update (
  postcare_email_claimed_at,
  postcare_email_failed_at,
  postcare_email_last_attempt_at,
  postcare_email_last_error,
  postcare_email_send_attempts,
  postcare_email_sent_at
) on table public.appointments to service_role;

-- GROUP 10.3 — appointment_audit: service_role writes nothing, directly.
--
-- Authorised by measurement, not by assumption: B1's census reports
-- `appointment_audit direct writers: 0` across the whole tree. Every audit row
-- is written by a postgres-owned SECURITY DEFINER command, which runs as its
-- OWNER and therefore needs no grant to service_role at all. SELECT is retained
-- for server reads (the cancellation-insight card).
revoke insert, update, delete, truncate, references, trigger, maintain
  on table public.appointment_audit from service_role;

-- GROUP 10.4 — write_appointment_audit becomes INTERNAL PLUMBING.
--
-- 0173 created it with service_role EXECUTE. Measured on the live catalog: it
-- has ZERO application callers, and exactly two callers anywhere — B4's
-- `revert_appointment_outcome` and `set_appointment_notes`, both postgres-owned
-- SECURITY DEFINER commands that reach it as their owner.
--
-- Left executable by service_role it is a forgery primitive that survives
-- everything else in this file: it takes actor_type, actor_id, action and
-- details as PARAMETERS and inserts them, so a service caller could mint an
-- audit event naming any colleague as the actor of any action — precisely the
-- P1-3 capability GROUP 6 and GROUP 9 exist to remove. Revoking direct EXECUTE
-- costs nothing (no caller loses anything) and closes it.
--
-- B4's two commands are UNAFFECTED: EXECUTE is checked against the caller, and
-- their caller is postgres by way of SECURITY DEFINER. Their signatures,
-- behaviour and service_role EXECUTE are untouched.
revoke execute on function public.write_appointment_audit(uuid, text, uuid, text, jsonb)
  from public, anon, authenticated, service_role;

commit;
