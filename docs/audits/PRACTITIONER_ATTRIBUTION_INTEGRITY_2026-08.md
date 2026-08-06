# Practitioner attribution integrity — exact production `03e7deaa38a7646a1f19a3d883c0a2b07894cec0`, migration max 0171

Fresh, skeptical, **source-only** audit of who Hone records as the actor, performer, author, reviewer,
operator, preparer and executor of every clinically, operationally or financially meaningful action.

**Baseline**

| Field | Value | Verification |
|---|---|---|
| Repository | `SaiSamyukthVemuri/Hone` | source-verified |
| Production SHA | `03e7deaa38a7646a1f19a3d883c0a2b07894cec0` (merge of PR #516) | source-verified |
| Branch | `audit/practitioner-attribution-integrity` | source-verified |
| Worktree | `~/Hone-Actor-Audit` (not Supabase-linked; `supabase/.temp/project-ref` absent) | source-verified |
| Migration files | 170 files spanning `0001`–`0171`; **`0158` permanently skipped** | source-verified |
| Database evidence | **NONE.** No hosted query, no local stack, no browser. Every claim is source-only. | see §0.1 |
| Repository change | one file — this document | source-verified |

**House-style note.** The established convention is `docs/audits/<YYYY-MM-DD>/SCREAMING_SNAKE_CASE.md`
(one dated directory per audit, no index file — `docs/audits/2026-07-30/` holds 13 such files). The
commissioning brief for this audit specified the flat path `docs/audits/PRACTITIONER_ATTRIBUTION_INTEGRITY_2026-08.md`
explicitly and named it the only permitted repository change, so that path is used verbatim. If the
convention is preferred, this file should move to `docs/audits/2026-08-06/PRACTITIONER_ATTRIBUTION_INTEGRITY.md`
in a follow-up; nothing in the content depends on the location.

---

## 0. How to read this document

### 0.1 Evidence classes

Following `docs/audits/2026-07-30/EVIDENCE_LIMITATIONS.md:7-11`, every claim carries one of:

* **source-verified** — read directly in the tree at `03e7dea`, cited `file:line` with the line quoted.
* **NOT VERIFIED IN PRODUCTION** — true of the source; the corresponding live database state was
  **not** queried. This audit performed **zero** database reads. Where the 2026-07-30 audit relied on
  hosted facts, those facts are quoted as *supplied, not independently verified by this audit*.
* **UNKNOWN** — could not be settled from source alone; listed in §7.5.

The single most important limitation: **no attribution defect in this document has been reproduced.**
Reproduction requires the `npm run test:db` lane (`vitest.db.config.ts:19-26`) against a local stack,
which the brief excluded. Every "an attacker can…" statement below is a **source-derived reachability
claim**, not an observed one. §12 specifies the tests that would convert them.

### 0.2 Reachability vocabulary

PostgREST exposes `SELECT/INSERT/UPDATE/DELETE` and `RPC`. It does **not** expose `TRUNCATE`.
`anon`, `authenticated` and `service_role` are `NOLOGIN`; only `authenticator` connects. Therefore:

* **REACHABLE_IN_PRODUCTION** — a signed-in practitioner, or an anonymous token holder, can do it
  today with their own credentials.
* **REACHABLE_ONLY_WITH_SERVICE_ROLE** — needs the service-role key, which a browser never holds.
  Never scored above P2 on that basis alone.
* **LATENT** — the DDL permits it but no shipped code path performs it. Scored on what would arm it.

A `TRUNCATE` grant is a defence-in-depth gap, **not** a browser-reachable defect. This document does
not score any finding P1 on a `TRUNCATE` grant alone. That is a deliberate correction to two agent
findings that did.

---

## 1. Executive verdict

**Hone records *what happened* far better than it records *who did it*.**

Of **205 traced writers** across the 37 required workflows, **94 record no actor column at all**,
**110 write no audit event**, and **52 have an actor a later ordinary write can silently rewrite**.
Roughly **150 actor-bearing columns** exist across **61 tables** — but they follow at least five
mutually incompatible patterns, and only a handful are bound to the authenticated caller by the
database itself.

The roadmap requirement — *Hone must never trust a practitioner ID merely because the browser
submitted it* — is **met in the clinical write path and broken almost everywhere else.**

Three structural facts explain nearly every finding:

**(1) Two command styles coexist, with opposite actor guarantees.**

* **Style A — actor-derived (correct).** Migrations 0164–0168 route every clinical write through
  `SECURITY DEFINER` functions that resolve the actor from `auth.uid()` *inside the function*, refuse
  when `auth.uid()` is null, and are granted to `authenticated` with `service_role` **revoked**
  (`0167:89-92`, `0165` revokes `service_role` on the laser-entry command). The database itself
  vouches for the actor.
* **Style B — actor-asserted (the gap).** The appointment, schedule and payment commands (0075, 0133,
  0142–0152, 0150, 0157) are granted to **`service_role` only** and take the actor as a parameter
  (`p_actor_practitioner_id`). Because they run as service-role, `auth.uid()` is null inside them and
  the database **cannot** re-derive or verify the actor. It validates only that the asserted
  practitioner is an active member of the studio. **Membership is not identity.** `0133:49-52` says so
  in its own header.

  Style B is not itself exploitable from a browser — every such function is
  `revoke execute … from public, anon, authenticated` (verified for `claim_session_payment_charge_attempt`
  at `0075:246-249` and for the eight 0150 commands at `0150:322-342`). The defect is that the
  database's guarantee about *who acted* is only as good as the app layer, and there is no DB-level
  backstop of the kind Style A already demonstrates in the same codebase.

**(2) The identity table itself is rewritable and deletable by any studio owner.** This is the
audit's most consequential finding (**A-P1-01**). `practitioners` has **no table-level `GRANT`/`REVOKE`
anywhere in the 170 migrations**, and its only four policies are still the 0001 originals. `practitioners: owners update`
(`0001_init.sql:244-247`) pins **the studio and nothing else** — not `user_id`, not `role`, not
`active`. `practitioners: owners delete` (`0001_init.sql:249-251`) permits a hard `DELETE`. Since every
Style-A guarantee resolves `practitioners WHERE user_id = auth.uid()`, an owner who can rewrite
`user_id` can make the database vouch for a forged clinical actor. The clinical command layer is
sound; the table it trusts is not.

**(3) `appointments` remains outside the command boundary.** `appointments_member_all`
(`0010_booking_v1.sql:272-277`) is `FOR ALL` on `is_studio_member(studio_id)`, and no migration
contains a table-level `GRANT` or `REVOKE` naming `public.appointments`. Both 0170 and 0171 defer the
revocation in writing (`0170:1018-1019` — *"this migration revokes NOTHING; the appointment DML
revocation is a LATER PR"*). Meanwhile `appointments` has **no creator column at all**, `cancelled_by`
is a **role word** not an identity, and the only creator record — `appointment_audit` — is
`INSERT`-able by any member with an arbitrary `actor_id` and `CASCADE`-deletes with its appointment.

**What is genuinely well built** — and must not be regressed:

* `client_clinical_notes` (0126/0127) is the reference implementation: append-only trigger, RLS
  `WITH CHECK` binding the author to *the caller's own active practitioner in that studio*, composite
  same-studio FK, `UPDATE/DELETE/TRUNCATE` revoked, `anon` revoked.
* `session_audit` (0117:38-58) pins both the actor **and** the target session's studio.
* `client_intake_forms.reviewed_by` (0162:219-232) is DB-enforced to be the reviewing practitioner,
  and immutable afterwards.
* The 0164–0168 clinical commands derive `uploaded_by` / `deleted_by` from `auth.uid()` and refuse a
  caller-supplied practitioner id.
* `payment_charge_attempts` uses composite same-studio FKs with `ON DELETE RESTRICT` throughout
  (`0073:203-206`, `0078:65-69`) — the strongest attribution FKs in the schema.

**Verdict: no P0.** Every actor-forgery path found is confined to a single studio by
`is_studio_member` / `is_studio_owner` or by a composite same-studio FK. The audit found **no
cross-tenant actor or performer forgery** reachable at `03e7dea`. The P1 set is dominated by
*within-studio* forgery, missing mandatory actors, and destructive attribution rewrites.

---

## 2. Actor terminology

Hone has no shared vocabulary for identity, and the schema shows it: `practitioner_id` means at least
four different things across 351 occurrences in the migrations. This section fixes the vocabulary; §10
maps it onto the schema.

| Term | Definition | The question it answers | Canonical example at `03e7dea` |
|---|---|---|---|
| **actor** | The authenticated person who initiated the command. Always derived server-side from `auth.uid()`; **never** accepted from the browser. | "Who did this?" | `treatment_images.uploaded_by`, derived in-DB by `treatment_image_actor()` (`0168:79-88`) |
| **assigned practitioner** | The person responsible for an appointment. A scheduling assignment, not an act. | "Whose column is this on the calendar?" | `appointments.practitioner_id` (`0010:177`), studio-pinned by `0151:97-99` |
| **performer** | The person who actually performed the treatment. May legitimately differ from the actor. | "Who treated this client?" | `sessions.performed_by_practitioner_id` (`0003:12`) |
| **author** | The person who authored a clinical narrative. Immutable once written; corrections are new rows. | "Who wrote this?" | `client_clinical_notes.practitioner_id` (`0126:59`), RLS-bound to `auth.uid()` |
| **reviewer** | The person who reviewed an intake or record. A distinct clinical attestation. | "Who signed off?" | `client_intake_forms.reviewed_by` (`0015:35`), DB-enforced by `0162:219-232` |
| **operator** | The person who performed a regulated record-keeping action. May be a non-Hone-user, so the model must admit an unverified operator **explicitly**. | "Who prepared this batch / handled this instrument?" | `record_keeping_disinfectants.operator_practitioner_id` + `.operator_name` (`0085:91-93`) |
| **preparer** | The person who staged a financial action but did not move money. | "Who set up this charge?" | `payment_charge_attempts.created_by_practitioner_id` (`0073:203-206`) |
| **executor** | The person whose action caused money to move. | "Who ran the charge?" | **Does not exist.** See **A-P1-06**. |
| **system actor** | A reviewed background process (cron, webhook, worker). Must be *nameable*, not merely null. | "Did a human do this, or did we?" | Declared in `appointment_audit.actor_type` (`0010:220`) — and **never written** by any of ~30 insert sites |

**Where Hone collapses these today** (each expanded in §7):

| Collapse | Where | Consequence |
|---|---|---|
| actor ≡ assignee | `appointments` has no creator; the calendar renders `practitioner_id` as if it answered "who booked this" | The booking actor is unrecoverable from the row |
| actor ≡ performer | `start_session` writes `practitioner_id` **and** `performed_by_practitioner_id` to the same value (`0167:270-274`) | An assistant-charted session looks self-performed until someone edits it |
| actor ≡ preparer | `payment_charge_attempts` records only the preparer | The executor of a real charge is not in the ledger |
| actor ≡ role class | `appointments.cancelled_by` stores `'client'`/`'practitioner'`/`'owner'` (`0010:187`) | *Which* practitioner cancelled is unknown |
| author ≡ first author | Pinned notes and treatment plans keep `created_by_practitioner_id` across edits with no `updated_by` | Edited content stays bylined to someone who did not write it |
| operator ≡ typed name | `resolveOperator` falls through to free-text `operator_name` (`records/actions.ts:73-76`) | A regulated logbook cannot distinguish verified from typed attribution |
| system ≡ practitioner/null | `actor_type='system'` is never written; automated writes use `null` or a borrowed practitioner | An automated write is indistinguishable from a lost one |

---

## 3. Actor-bearing schema census

**≈150 identity-bearing columns across 61 tables.** The full column-by-column census with FK target,
nullability, default, introducing migration, write/update restriction and RLS implication is long; this
section states the structural conclusions and the exceptions that matter. Frequencies across the 170
migration files: `practitioner_id` 351, `user_id` 63, `reviewed_by` 33, `actor_type` 30, `actor_id` 30,
`deleted_by` 27, `performed_by_practitioner_id` 20, `created_by_practitioner_id` 17, `finalized_by` 15,
`created_by` 15, `cancelled_by` 15, `actor_practitioner_id` 13, `actor_display_name` 12,
`actor_user_id` 11, `corrected_by` 5, `uploaded_by` 3, `updated_by_practitioner_id` 1, `invited_by` 1.

> ⚠️ `lib/types/database.ts` is **hand-rolled and partial** — its own header says
> *"Hand-rolled minimal database types. Regenerate from Supabase later"*. It is **not** authoritative
> schema and was not used as evidence anywhere in this audit. `supabase/migrations/*.sql` is the sole
> schema authority.

### 3.1 The identity spine is thin

`practitioners.user_id` (`0001_init.sql:21`, `uuid references auth.users(id) on delete set null`) is
the **only** bridge from an authentication identity to a domain actor. It is **nullable**, it is
`ON DELETE SET NULL`, and its uniqueness is `(studio_id, user_id)` (`0001_init.sql:27`) — so one auth
user legitimately holds practitioner rows in several studios. Every `auth.uid()`-derived actor
resolution in the codebase passes through this one column. §7 **A-P1-01** is about who may write it.

`studios.owner_email` (`0001_init.sql:14`) is free text with no FK; ownership is derived from
`practitioners.role`, never from `studios`.

### 3.2 Composite same-studio pinning is applied to 16 FKs and omitted from 49

`practitioners_id_studio_id_unique (id, studio_id)` exists (`0032:273`), and **16** foreign keys use it
to pin a practitioner to a studio structurally:

`0032:656`, `0032:998`, `0064:159`, `0073:206`, `0078:68`, `0121:108`, `0122:60`, `0126:59`,
`0134:632`, `0135:45`, `0135:81`, `0137:49`, `0137:55`, `0137:61`, `0151:98`, `0157:91`.

**64 foreign keys reference `public.practitioners` in total**, so **48 are single-column** and carry no
studio component. Among the actor columns left unpinned:

| Table.column | Introduced | ON DELETE | Consequence |
|---|---|---|---|
| `sessions.practitioner_id` | `0001:82` | `RESTRICT` | the session creator FK does not constrain studio |
| `sessions.performed_by_practitioner_id` | `0003:12` | `SET NULL` | the performer FK does not constrain studio |
| `client_intake_forms.reviewed_by` | `0015:35` | `SET NULL` | reviewer attribution nulls on practitioner delete |
| `treatment_images.uploaded_by` / `.deleted_by` | `0092:62`, `0092:67` | `SET NULL` | uploader/deleter attribution nulls |
| `treatment_plans.created_by_practitioner_id` / `.closed_by_practitioner_id` | `0024:17-18` | `SET NULL` | plan authorship nulls |
| `client_pinned_notes.created_by_practitioner_id` | `0022:14` | `SET NULL` | note authorship nulls |
| `record_keeping_*.created_by_practitioner_id`, `.operator_practitioner_id` | `0085:41`, `0085:91`, `0085:95` | `SET NULL` | regulated logbook attribution nulls |
| `record_keeping_audit_events.actor_practitioner_id` | `0086:69` | `SET NULL` | the **audit trail's own actor** nulls |

This matters only when a practitioner row is deleted — which §7 **A-P1-01** shows is permitted at the
DB layer by `practitioners: owners delete`.

**ON DELETE distribution across actor FKs:** ~40 `SET NULL` (attribution destroyed), ~16 `RESTRICT`
(attribution preserved, delete blocked), ~7 `CASCADE` (**the record itself destroyed**). The
`CASCADE` set includes `client_clinical_notes_practitioner_same_studio` (`0126:59`) — deleting a
practitioner deletes their append-only clinical notes. The practitioner-deletion guard written to
prevent exactly this (`0119:429-437`) fires **only for FINALIZED records**, and finalization was
permanently retired by 0159, so **the guard is inert**.

### 3.3 `appointment_audit.actor_id` — the weakest actor column in the schema

```sql
-- supabase/migrations/0010_booking_v1.sql:217-225
create table if not exists public.appointment_audit (
  id uuid primary key default gen_random_uuid(),
  appointment_id uuid references public.appointments(id) on delete cascade not null,
  actor_type text not null check (actor_type in ('practitioner','client','system')),
  actor_id uuid,          -- nullable, NO foreign key, no studio component
  action text not null,
  details jsonb,
  created_at timestamptz not null default now()
);
```

Four defects in seven lines: **nullable**, **no FK**, **no studio component**, and
**`ON DELETE CASCADE`** — deleting the appointment destroys its entire actor trail. Its INSERT policy
(`0010:290-299`) constrains only that the `appointment_id` belongs to the caller's studio; neither
`actor_type` nor `actor_id` is constrained at all. There is no `UPDATE` or `DELETE` policy, so RLS
denies those (default-deny) — but `appointments_member_all` is `FOR ALL`, so deleting the *parent*
achieves the same erasure. `'system'` is declared and never written.

### 3.4 The audit-table family has five incompatible actor shapes

| Table | Actor columns | NOT NULL? | Actor FK ON DELETE | Table-level REVOKE |
|---|---|---|---|---|
| `clinical_audit_events` | `actor_practitioner_id` | **YES** (`0120:164`) | `RESTRICT` (`0120:191-193`) | `anon`+`authenticated` INSERT/UPDATE/DELETE/TRUNCATE revoked (`0120:206`) |
| `session_copy_operations` | `created_by_practitioner_id` | **YES** (`0157:73`) | `RESTRICT` (`0157:91`, composite) | service-role-only RPC |
| `session_audit` | `edited_by_practitioner_id` | no (`0008:19`) | `SET NULL` | **none** |
| `record_keeping_audit_events` | `actor_practitioner_id`, `actor_user_id`, `actor_display_name` | no (`0086:69-72`) | `SET NULL` | **none** (SELECT-only policy; no INSERT/UPDATE/DELETE policy) |
| `appointment_audit` | `actor_type`, `actor_id` | `actor_type` yes, `actor_id` no | no FK | **none** |
| `audit_logs` | `actor_id` | no | — | **none** |
| `admin_action_events` | `actor_user_id`, `actor_email`, `actor_role` | — | — | service-role-locked (0113) |

The only **NOT NULL** actor column in the schema is `clinical_audit_events.actor_practitioner_id`
— and that table is **retired with zero rows** (`0159:324`). The best *live* model is
`session_copy_operations.created_by_practitioner_id`: NOT NULL + composite same-studio FK +
`ON DELETE RESTRICT`. **§10 proposes generalising exactly that shape.**

`admin_action_events` uses `actor_user_id`/`actor_email`/`actor_role` — an **auth-user** identity where
every other trail uses a **practitioner** identity. Four import-subsystem actor columns do the same
(`0089:71,77,131,136` FK to `auth.users`) while the sibling import audit table records a practitioner
id (`0089:176`). This is the "user ID used where practitioner ID is required" pattern; it is a
consistency defect (P2/P3), not a security one.

### 3.5 Attribution is not covered by any immutability trigger

The 0160 clinical-lineage trigger freezes **parentage only** — `client_id`, `studio_id`, `session_id`,
`block_id` (`0160:173-202`). **No attribution column anywhere in the clinical record is frozen.**
`sessions.performed_by_practitioner_id`, `deleted_by`, `aftercare_and_risks_explained_by` and
`treatment_images.uploaded_by` are all rewritable by any writer holding `UPDATE` on the row — which,
after 0169, means the commands and `service_role`.

---

## 4. Complete workflow matrix — the 37 required workflows

Legend for **Actor**: **DERIVED** = resolved from `auth.uid()` in-DB · **SERVER** = resolved by
`getCurrentPractitionerWithStudio()` and passed to a service-role command · **ASSERTED** = written from
a value the browser could influence · **NONE** = no actor recorded anywhere.

| # | Workflow | Final DB write | Actor | Performer / assignee | Audit event | Actor rewritable later | Finding |
|---|---|---|---|---|---|---|---|
| 1 | Appointment creator | `create_internal_appointment_v2` → `INSERT appointments` + `INSERT appointment_audit` (`0152:378,515-525`) | SERVER (`p_actor_practitioner_id`) | `p_target_practitioner_id` → `appointments.practitioner_id` | ✅ `appointment_audit.actor_id` | ✅ audit row is member-INSERT-able and CASCADEs | **A-P1-02**, **A-P1-03** |
| 2 | Assigned appointment practitioner | same | SERVER | ✅ studio-pinned by `0151:97-99`; owner+capacity gate at `calendar/actions.ts:187-193` | ✅ | ✅ direct `PATCH` bypasses entirely | **A-P1-02** |
| 3 | Appointment mover / rescheduler | `move_or_reassign_appointment` (`0152:540,694-704`); public path `reschedule_appointment_v2` (`0171:797`) | SERVER / token-bearer | reassignment target re-validated in-DB | ✅ (`'moved'`/`'reassigned'`) | ✅ | **A-P1-02** |
| 4 | Appointment canceller | `UPDATE appointments SET cancelled_by = <role word>` (`0033:294`; public `= 'client'` `0171:1304`) | **NONE on the row** — role class only | n/a | ✅ audit row (`actor_id` NULL on client paths) | ✅ | **A-P1-03** · `cancelled_by` role word (§2) |
| 5 | Appointment completer | `mark_appointment_complete` | SERVER | n/a | ✅ | ✅ | **A-P1-02** |
| 6 | No-show marker | `mark_appointment_complete` / cron route is non-mutating | SERVER | n/a | ✅ | ✅ | **A-P1-02** |
| 7 | Outside-hours override actor | `appointments.booked_outside_availability` boolean (`0152:66`) | **NONE on the row**; recorded only in `appointment_audit.details.outside_availability` (`0152:523`) | n/a | ✅ in `details` | ✅ — and the flag is directly `PATCH`-able, which disarms the buffer trigger (`0152:226-227`) | **A-P1-02** · **A-P2-01** |
| 8 | Session performer | `set_session_performer` → `sessions.performed_by_practitioner_id` (`0167:341-367`) | n/a — command records **no actor** | ✅ same-studio checked; ❌ **no `active` check, no role gate** | ❌ **none** | ✅ freely | **A-P2-03** |
| 9 | Session creator | `start_session` → `INSERT sessions` (`0167:270-274`) | **DERIVED** ✅ | writes creator **and** performer to the same value | ❌ none | ✅ via `set_session_performer` | **A-P2-02** |
| 10 | Charting author | `create_session_block_with_areas` / `update_…` | **NONE** — no author column on `session_blocks` | n/a | ❌ | n/a | **A-P2-25** |
| 11 | Treatment-block author | `create_block_with_entry` / `update_block_with_entry` (`0166:390,463`) | **NONE** | n/a | ❌ | n/a | **A-P2-25** |
| 12 | Electrolysis-entry author | `add_electrolysis_pass` (`0166:561`) | **NONE** (only `deleted_by` on removal, `0114:35`) | n/a | ❌ | n/a | **A-P2-25** |
| 13 | Laser-entry author | `create_laser_entry` (`0164:103`) | **NONE** (only `deleted_by`, `0114:40`) | n/a | ❌ | n/a | **A-P2-25** |
| 14 | Intake reviewer | `UPDATE client_intake_forms SET reviewed_by` (`intake/actions.ts:104-138`) | **DERIVED + DB-enforced** ✅ (`0162:219-232`) | n/a | ❌ | ❌ immutable (`0162:337-341`) | ✅ **reference** |
| 15 | Clinical-note author | `INSERT client_clinical_notes` (`clinical-notes-actions.ts:193`) | **DERIVED + RLS-bound** ✅ (`0127:37-51`) | n/a | append-only by trigger (`0126:125-138`) | ❌ | ✅ **reference** |
| 16 | Consultation-note author | same table, `kind='consultation'` | ✅ same | n/a | ✅ | ❌ | ✅ **reference** |
| 17 | Skin/hair-analysis author | same table | ✅ same | n/a | ✅ | ❌ | ✅ **reference** |
| 18 | Client-profile editor | direct `UPDATE public.clients` (`clients/[id]/actions.ts`) | **NONE** — `clients` has only `created_by` (`0001:48`) and `archived_by` (`0050:55-57`); no `updated_by`, no `updated_at` | n/a | fail-soft `audit_logs` row with a **forgeable** `actor_id` | ✅ | **A-P1-05** |
| 19 | Treatment-plan author | `INSERT/UPDATE treatment_plans` (`treatment-plans-actions.ts:230,302`) | ASSERTED — RLS `WITH CHECK` names only `is_studio_member`; the `UPDATE` policy has **no `WITH CHECK` at all** (`0024:54-62`) | n/a | ❌ | ✅ | **A-P1-04** |
| 20 | Pinned-note author | `INSERT client_pinned_notes`; edit via **service-role** `UPDATE { text }` (`pinned-notes-actions.ts:85-101`) | ASSERTED at insert; **no editor recorded at all** on edit | n/a | ❌ | author deliberately preserved across body rewrites | **A-P1-04** · **A-P2-15** |
| 21 | Treatment-photo uploader | `create_treatment_image_metadata` → `uploaded_by` (`0168:191`) | **DERIVED** ✅ | n/a | ❌ | ✅ (not frozen) | **A-P2-04** |
| 22 | Treatment-photo deleter | `archive_treatment_image` → `deleted_by` (`0168:281`) | **DERIVED** ✅ | n/a | ❌ | ✅ | **A-P2-04** |
| 23 | Record-keeping operator | `INSERT/UPDATE record_keeping_*` via the RLS client (`records/actions.ts:102-372`) | ASSERTED (`created_by_practitioner_id`) under a membership-only `WITH CHECK` | `operator_practitioner_id` **or** free-text `operator_name` | ✅ trigger-written, SELECT-only table (`0086:83-95`) | ✅ row is member-`UPDATE`-able | **A-P2-16** · **A-P2-17** |
| 24 | Sterile-item disposer | — | **NO COLUMN AND NO EVENT EXIST** | — | — | — | **A-P2-05** |
| 25 | Disinfectant preparer / replacer | `record_keeping_disinfectants` | preparer = operator (above); **replacer/discarder unattributed** — `date_discarded` records only *when* (`0085:90`) | — | ✅ update audited | ✅ | **A-P2-16** · **A-P2-05** |
| 26 | Postcare sender | 3 direct `UPDATE`s on `appointments` via `createAdminClient()` (`calendar/actions.ts:1114-1120,1243-1249`) | **NONE** — and the email is signed with the appointment **assignee's** name | n/a | ❌ | n/a | **A-P2-06** |
| 27 | Aftercare acknowledgement actor | `sessions.aftercare_and_risks_explained_by` | recorded, audited by `0086:211-250` | n/a | ✅ | ✅ not frozen | **A-P2-04** |
| 28 | Payment preparer | `INSERT payment_charge_attempts.created_by_practitioner_id` (`payment-actions.ts:267`) | SERVER ✅ composite FK + `RESTRICT` | n/a | ❌ | ❌ (`RESTRICT`) | ✅ good |
| 29 | Payment executor | `claim_session_payment_charge_attempt` (`0075:57,148-153`) then terminal `UPDATE … status='succeeded'` | **NONE PERSISTED** — `p_practitioner_id` authorises and is discarded | n/a | terminal row has no human actor | n/a | **A-P1-06** |
| 30 | Refund actor | `refund_initiated_by_practitioner_id` (`payment-refund.ts:375`; `0078:68`) | SERVER ✅ composite FK + `RESTRICT`; owner-gated (`payment-actions.ts:618`) | n/a | ❌ | ❌ | ✅ good |
| 31 | Manual fee preparer / executor | `manual_fee_charge_attempts` (`0064:138,158`) | preparer SERVER ✅; **executor not persisted** (same shape as 29) | n/a | ❌ | ❌ | **A-P1-06** |
| 32 | Studio settings editor | direct `UPDATE public.studios` ×7 surfaces | **NONE** — including `late_cancel_fee_cents` and `cancellation_policy_text`, which justify a real charge | n/a | ❌ | n/a | **A-P2-07** |
| 33 | Practitioner invite / activation / removal | `set_practitioner_active_locked` (`0150:283-319`); `pending_invitations.invited_by` | actor passed to the gate and **discarded**; nothing written | n/a | ❌ | ✅ `invited_by` is caller-declared and later rewritable | **A-P1-01** · **A-P2-08** |
| 34 | Google Calendar connection actor | `calendar_connections` (`0121:100-108`) | **DERIVED, self-only** ✅ composite same-studio FK | n/a | ❌ | ❌ | ✅ good |
| 35 | SMS enablement / test message | `UPDATE studios.send_*_sms` | **NONE** | n/a | ❌ | n/a | **A-P2-07** |
| 36 | Export actor | `exportStudioDataAction` (`settings/data/actions.ts:30-41`) | owner-gated; `audit_logs` row with a **forgeable** `actor_id` (`0001:294-296`) | n/a | fail-soft only | ✅ forgeable | **A-P2-14** · **A-P2-21** |
| 37 | Administrative / service-role actor | `admin_action_events` (0113) + service-role commands | `actor_user_id`/`actor_email`; **fail-soft** — three of five admin write paths are unattributable if it misses | n/a | fail-soft | — | **A-P2-09** |

**Coverage:** all 37 workflows traced to a final database write. Four had a sub-modality initially
missed and recovered by the completeness critic: **#10** (structured-area destruction — **A-P2-10**),
**#14** (`deleted_at` is member-`PATCH`-able and unguarded — **A-P2-11**), **#2** (`service_practitioners`
booking eligibility has no `created_by` — **A-P3**), **#26** (the reminder cron re-issues intake
credentials through the same actor-less helper as the UI, so `intake_link_send_count` conflates
automated and named sends — **A-P3**).

---

## 5. Browser-forgery matrix

Two surfaces exist: values submitted to a **server action**, and direct **PostgREST** requests signed
with the user's own JWT. The second needs no application code at all.

### 5.1 Server-action input paths

Classification totals: **10 SAFE_SELECTION · 16 SAFE_AFTER_REVALIDATION · 1 VULNERABLE_ACTOR_FORGERY · 6 AMBIGUOUS.**

| # | Input path | Re-resolves membership? | Target in active studio? | Target `active`? | May pick another practitioner? | Written as | Class |
|---|---|---|---|---|---|---|---|
| A1–A6 | `formData.get("practitioner_id")` → availability scope RPCs (`settings/availability/actions.ts:431,469,500,555,583,623`) | ✅ `assertOwnerWithStudio()` | ✅ | ✅ | owner-only + capacity ON | ASSIGNEE | SAFE_AFTER_REVALIDATION |
| A7–A10 | same field → `studio_timed_blocks` / recurring-break rules (`:836,931,1112,1206`) | owner gate only in app | **DB only** — composite FK `0137:44-48` | **DB only** — `guard_scoped_source_capacity` raises `23514` | owner-only | ASSIGNEE | SAFE_AFTER_REVALIDATION *(DB layer)* |
| B1 | `practitioner_id` → `create_internal_appointment_v2(p_target_practitioner_id)` | ✅ | ✅ in-DB | ✅ in-DB | owner + capacity ON only, else silently replaced by `practitioner.id` (`calendar/actions.ts:187-193`) | ASSIGNEE | SAFE_SELECTION |
| B2–B3 | `targetPractitionerId` → `move_or_reassign_appointment` | ✅ | ✅ | ✅ | owner + capacity ON | ASSIGNEE | SAFE_AFTER_REVALIDATION |
| **C1** | **`formData.get("performer_id")` → `set_session_performer(p_performer_id)`** | ✅ actor resolved — **but never compared to the target** | ✅ `p.studio_id = v_studio_id` (`0167:356-358`) | ❌ **not checked** | ✅ **any active member, no role gate** | **PERFORMER** | **VULNERABLE_ACTOR_FORGERY** |
| D1 | `operator_practitioner_id` → `record_keeping_disinfectants` | ✅ | ✅ `.eq("studio_id")` | ✅ `.eq("active", true)` | ✅ any member (intended dropdown) | PERFORMER | SAFE_AFTER_REVALIDATION |
| D2 | `operator_name` free text, used when the id is absent **or unresolvable** (`records/actions.ts:73-76`) | n/a | n/a | n/a | arbitrary string | PERFORMER as text | **AMBIGUOUS** |
| E1 | `studio_id` → `hone_selected_studio` cookie | ✅ `.eq("user_id").eq("studio_id").eq("active", true)` | ✅ | ✅ | self only | cookie, never a column | SAFE_AFTER_REVALIDATION |
| E2–E3 | team `id`/`role` → `set_practitioner_active_locked` / `pending_invitations.role` | ✅ `assertOwner()` | ✅ in-DB | n/a | owner-only; self-removal blocked | state change | SAFE |
| F1 | OAuth `state`+`code` → `calendar_connections.practitioner_id` | ✅ `consumeOAuthState({userId})` + `.eq("user_id", user.id)` + `active` reject | ✅ | ✅ | **no — self only** | credential owner | SAFE_AFTER_REVALIDATION |
| G1–G9 | image/intake/pinned-note/clinical-note/plan/copy/payment/import sinks | ✅ | ✅ | ✅ | **no — all hard-coded to `practitioner.id`** | ACTOR / AUTHOR | SAFE_SELECTION |
| G4 | pinned-note **edit** → service-role `UPDATE { text }` | ✅ studio | ✅ | ✅ | n/a | **rewrites body, preserves original author** | **AMBIGUOUS** |
| H0/H0b | public booking / token flows | n/a (anonymous) | n/a | n/a | n/a | client-actor, unrecorded | AMBIGUOUS |

> **Client-side `capacityOn` / `showSelector` conditions are not guards.** They only decide whether a
> field is *sent* (`RecurringBreaksSection.tsx:151`, `TimedBlocksSection.tsx:151`,
> `BookAppointment.tsx:194`, `QuickBookDrawer.tsx:587`). A7–A10 are safe because of the DB trigger and
> composite FK; B1/B2 because of the server-side `role === "owner"` re-check.

**Exhaustiveness.** A `formData.get(` sweep over `app/ lib/ components/` filtered on
practitioner/user/studio/client/actor/author/operator/uploaded/reviewed/created_by keys matched only the
rows above; the `type="hidden"` sweep returned one hit (`no-access/page.tsx:108`, row E1); the
assignment sweep for `created_by*/actor_id/uploaded_by/reviewed_by/deleted_by/initiated_by*/confirmed_by*/cancelled_by*/resolved_by*`
returned **zero** sinks fed by anything other than `practitioner.id` / `practitionerId` / `ctx.userId`,
with two null-literal exceptions (`api/twilio/inbound-sms/route.ts:300`, `admin/ops-alerts/actions.ts:88`).

### 5.2 Direct PostgREST surfaces — no server action involved

These are the ones that matter. The browser signs the request with its own JWT; the app is not in the path.

| # | Table + column | RLS `WITH CHECK` | Actor bound to `auth.uid()`? | Class |
|---|---|---|---|---|
| H1 | `client_pinned_notes.created_by_practitioner_id` (`0022:38-45`) | studio only | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `treatment_plans.created_by_practitioner_id` / `.closed_by_practitioner_id` (`0024:44-51` insert, **`:54-62` update has `using` and NO `with check`**) | studio only | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `treatment_goals.created_by` (`0087:189-196`) | `is_studio_member` | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `client_tags.created_by` / `.deleted_by` (`0087:171-178`) | `is_studio_member` | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `client_personal_notes.updated_by_practitioner_id` (`0087:208-215`) | `is_studio_member` | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `consent_form_templates.created_by_practitioner_id` (`0057:128-134`) | studio only | **NO** | VULNERABLE_ACTOR_FORGERY |
| H1 | `client_portal_messages.created_by_practitioner_id` — NOT NULL + `RESTRICT` (`0055:83-86,97-101`) | `is_studio_member` | **NO** | VULNERABLE_ACTOR_FORGERY |
| H2 | `audit_logs.actor_id` (`0001:294-296`) | `is_studio_member` | **NO** | VULNERABLE_ACTOR_FORGERY |
| H3 | `appointment_audit.actor_type` + `actor_id` (`0010:290-299`) | only that the appointment is in-studio | **NO** | VULNERABLE_ACTOR_FORGERY |
| H4 | `record_keeping_*` actor/operator columns (`0085:71-80,125-134,179-190`; `0088:55-58`) | `is_studio_member` on **INSERT and UPDATE** | **NO** | VULNERABLE_ACTOR_FORGERY |
| H5 | `session_audit.field`/`.old_value`/`.new_value` (`0117:38-58`) | actor **and** session studio bound ✅ | ✅ for the actor, ✗ for the asserted content | AMBIGUOUS |
| H6 | `create_session_block_with_areas` / `update_…` — `authenticated` EXECUTE retained (`0129:168-169`), **zero app callers**, only `anon` revoked (`0130:31-43`) | `is_studio_member(p_studio_id)` inside | no author column exists | AMBIGUOUS |

**Grant reality check.** A repo-wide grep for a table-level `GRANT`/`REVOKE` returns **nothing at all**
for `audit_logs`, `session_audit`, `appointment_audit`, `client_pinned_notes`, `treatment_plans`,
`treatment_goals`, `client_tags`, `client_personal_notes`, `consent_form_templates`,
`client_portal_messages`, `practitioners`, `appointments`, or any `record_keeping_*` table.
`0169:82-87` covers only the six clinical **data** tables — `sessions`, `session_blocks`,
`session_block_areas`, `electrolysis_entries`, `laser_entries`, `treatment_images`. None of the tables
above is one of them.

---

## 6. Historical-truthfulness matrix

**Y** = truthfully answerable · **N** = not · **P** = partial (true in the DB, lost or degraded on the
surface a practitioner actually reads).

| # | Record type | Created | Performed | Last-changed | Reviewed | DB blocks post-boundary edit | Delete retains actor | Export | UI shows recorded actor | Wrong author possible |
|---|---|---|---|---|---|---|---|---|---|
| 1 | Appointment | P | Y (assignee) | N | n/a | N | P | Y | **Y** | N |
| 2 | Session | Y | P | P | n/a | N | P | **N** | **P** | N |
| 3 | Session block (settings) | **N** | N | **N** | n/a | P | P | **N** | **N** | n/a |
| 4 | Electrolysis entry | **N** | N | **N** | n/a | P | P | **N** | **N** | n/a |
| 5 | Laser entry | **N** | N | **N** | n/a | P | P | **N** | **N** | n/a |
| 6 | Clinical note (consultation) | **Y** | n/a | **Y** (revision) | n/a | **Y** | **N** (CASCADE) | **N** | **P** ("You") | **Y** |
| 7 | Clinical note (skin/hair) | **Y** | n/a | **Y** (revision) | n/a | **Y** | **N** (CASCADE) | **N** | **P** ("You") | **Y** |
| 8 | Intake submission + review | P | n/a | P | **Y** (DB-enforced) | **Y** | P | **N** | **P** (name vanishes) | N |
| 9 | Treatment plan | Y | n/a | **N** | n/a | N | P | **P** (id only) | **P** | N |
| 10 | Pinned note | Y | n/a | **N** | n/a | N | P | **N** | **N** (never shown) | **Y** |
| 11 | Treatment photo | Y | n/a | N | n/a | P | P | **N** | **N** (never shown) | N |
| 12 | Record-keeping event | **Y** | Y (operator) | **Y** | n/a | N | P | **Y** | **Y** | N |
| 13 | Payment / refund | Y | n/a | P | n/a | **Y** (trigger) | Y | **N** | **N** (never shown) | N |
| 14 | Consent signature | Y (client) | n/a | n/a | n/a | P | P | **N** | Y | N |
| 15 | Studio settings change | **N** | n/a | **N** | n/a | N | n/a | **N** | **N** | n/a |
| 16 | Team membership change | Y (invite) | n/a | **N** (deactivation) | n/a | N | **N** | **P** | **N** | n/a |
| 17 | Client personal note | n/a | n/a | Y | n/a | N | P | **N** | **N** (never shown) | N |

### 6.1 Read-time substitution — the highest-value class in this section

**The clinical-note byline can name the reader.** `attachAuthors` (`lib/clinical-notes/queries.ts:31-46`)
builds `Map<practitioner_id, display_name>` from an RLS-scoped `SELECT`; the caller does
`author_name: authors.get(head.practitioner_id) ?? null` (`:88`, `:162`). The component then renders:

```tsx
// components/clinical-notes-section.tsx:309
{note.author_name ? note.author_name : "You"}
```

The `"You"` fallback exists for the optimistic just-created row, where `author_name` is deliberately
set to `null` client-side (`:192-195`, and the comment says so). But it applies to **every** falsy
`author_name`, including server-loaded rows — reached when the map misses (`undefined ?? null`) or when
`display_name` is the empty string (`practitioners.display_name` is `NOT NULL` at `0001:22` but `''`
is permitted, and `''` is falsy). The same data renders correctly in print:
`clinical-notes/print/page.tsx:104` uses `{note.author_name ?? "Unknown practitioner"}`. So one record
reads as authored by **you** on screen and by **Unknown practitioner** on paper. The database is
right in both cases.

**Deactivation blanks historical attribution.** `getPractitionersForStudio` filters
`.eq("active", true)` (`lib/supabase/queries.ts:204-209`); `sessionPerformerName`
(`lib/supabase/queries.ts:278-286`) does `practitioners.find(p => p.id === id)` and returns `null` on a
miss. `getClientById` passes exactly that active-only list (`:332`). Therefore **the moment a
practitioner is deactivated, every historical session they performed renders with no performer name**
on the client cheat-sheet and the session timeline — while `sessions.performed_by_practitioner_id` still
holds the truth.

**Not universal — and the contrast is the proof.** The printed *Client Record for Invasive Procedures*
loader (`lib/record-keeping/queries.ts:446-449`) has **no** `.eq("active", true)`, so the regulatory
print surface does **not** suffer the blackout. Two loaders, same data, opposite behaviour. That is
what makes this a defect rather than a design choice.

### 6.2 Deleted / deactivated practitioner

* **Deactivation** (`active = false`, the only path the app ships): historical rows keep their actor ids;
  the **UI** loses the names (above); the deactivation itself is recorded nowhere.
* **Hard delete**: not offered by the application — but permitted at the DB layer by
  `practitioners: owners delete` (`0001:249-251`) under the never-revoked `authenticated` grant. It would
  `CASCADE`-delete `client_clinical_notes` (`0126:59`) and `SET NULL` ~40 other actor columns. The guard
  intended to prevent it (`0119:429-437`) fires only for FINALIZED records and is therefore inert after
  0159. This is why **A-P1-01** is scored on the `DELETE` policy as well as the `UPDATE` policy.

### 6.3 Export

`exportStudioDataAction` writes 13 CSVs. `sessions.csv` carries `practitioner_id` and
`performed_by_practitioner_id` as **raw UUIDs**, and the `practitioners` extract it ships alongside is
the **active-only** list — so a departed practitioner's UUID resolves to no row anywhere in the same
ZIP. Six attributed record types are absent from the export entirely, including the two with the
strongest DB-enforced attribution (`client_clinical_notes`, `client_intake_forms`). This overlaps
`F-DATA-001` in the 2026-07-30 register, which remains open.

---

## 7. Findings — P0 to P3

**No P0.** Every forgery path found is confined to one studio by `is_studio_member` /
`is_studio_owner` or by a composite same-studio FK. No cross-tenant actor or performer forgery is
reachable at `03e7dea`.

### 7.0 How this register was produced, and what it cost in severity

The raw sweep produced **212 candidate findings**. Every one was then attacked by an independent
reader instructed to refute it, open each cited line, hunt for the guard the finder missed, and apply
the reachability rules in §0.2. The result:

| Stage | P0 | P1 | P2 | P3 |
|---|---|---|---|---|
| As first raised | 0 | 40 | 90 | 82 |
| After adversarial verification | 0 | **18** | 76 | 59 |
| After de-duplication to canonical findings | **0** | **7** | 24 themes | — |

**22 of the 27 unverified P1 claims were downgraded.** The most common cause was scoring a
`TRUNCATE` grant or a service-role-only RPC as browser-reachable. Two corrections that changed
conclusions this document had previously drawn:

* An early reading of **A-P2-13** supposed an empty `display_name` could trigger the `"You"` byline.
  It cannot: `settings/profile/actions.ts:16` rejects a blank name and `0141:173` coalesces to the
  email. The genuinely reachable trigger is the discarded error at `lib/clinical-notes/queries.ts:37`.
* An early reading treated the `client_clinical_notes` `CASCADE` as a failure of the `0119` guard. It
  is not: that guard tests only `clinical_record_snapshots.finalized_by` and
  `sessions.record_status` (`0119:430-436`) and never referenced `client_clinical_notes`, which did
  not exist until seven migrations later. The `CASCADE` was a documented deliberate choice
  (`0126:49-51`).

Duplicate IDs from the sweep are listed against each canonical finding so nothing is lost.

### 7.1 P1 findings (7 canonical)

---

#### `A-P1-01` — `public.practitioners` is fully rewritable and deletable by any studio owner, defeating every `auth.uid()`-derived actor guarantee in the clinical command layer

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** Independent · **Absorbs** `F-ADM-002`, `RLS-002`, `F-ADM-015`, `H-05`
- **Source evidence:**
  ```sql
  -- supabase/migrations/0001_init.sql:244-247
  create policy "practitioners: owners update"
    on public.practitioners for update to authenticated
    using (public.is_studio_owner(studio_id))
    with check (public.is_studio_owner(studio_id));
  -- :249-251
  create policy "practitioners: owners delete"
    on public.practitioners for delete to authenticated
    using (public.is_studio_owner(studio_id));
  ```
  A grep for any table-level `GRANT`/`REVOKE` naming `public.practitioners` across all 170 migration
  files returns **zero rows**, so Supabase's default `ALL` grant to `authenticated` stands. The four
  0001 policies are the **only** policy DDL ever issued on the table; nothing after 0001 drops,
  replaces or narrows them. The three triggers that exist are `BEFORE DELETE` (`0119:447-449`) and two
  `AFTER … OF studio_id` / `AFTER … OF active` capacity re-fans (`0134:609-613`, `0134:740-743`) —
  none is `BEFORE UPDATE` and none inspects a column value. There is no column list on the policy, no
  column-level grant, and no `CHECK` constraint on `user_id` or `role`.
- **Why the `WITH CHECK` does not help:** `is_studio_owner(studio_id)` (`0001:176-183`) is a function
  of `studio_id` and **the caller's own `auth.uid()`**. It is therefore unaffected by whatever
  `user_id` or `role` the NEW row carries. It pins the tenant and nothing else.
- **Proof the grant is live:** a shipping feature depends on it —
  `app/(app)/settings/profile/actions.ts:29-33` issues
  `.from("practitioners").update({ display_name: displayName })` through `createClient` from
  `@/lib/supabase/server` (the authenticated cookie client), not through `createAdminClient()`.
- **Failure scenario:** Maya owns Willow. She holds her own session JWT.
  1. `PATCH /rest/v1/practitioners?id=eq.<Priya>` with `{"user_id": "<a second auth account Maya controls>"}`.
     `unique (studio_id, user_id)` (`0001:27`) is satisfied because that uid holds no row in this
     studio. Maya's own row is untouched, so she remains owner throughout.
  2. Maya signs in as the second account. `session_actor_practitioner()` (`0167:78-99`),
     `treatment_image_actor()` (`0168:79-88`), the `client_clinical_notes` RLS `WITH CHECK`
     (`0127:37-51`) and the `0162` intake-review trigger now **all resolve her to Priya** — because
     each one resolves `practitioners WHERE user_id = auth.uid()`, and that row now says Priya.
  3. Maya writes a consultation note. The database's own append-only, RLS-bound, DB-derived author
     guarantee records **Priya** as the author. The strongest attribution in the schema now certifies
     a forgery.

  Three cheaper variants need no second account: `PATCH … {"role":"owner"}` (silent privilege grant,
  no audit); `PATCH … {"display_name":"…"}` (retroactively relabels every historical attribution that
  renders through `display_name`); and `DELETE /rest/v1/practitioners?id=eq.<Priya>`, which
  `CASCADE`-deletes Priya's `client_clinical_notes` (`0126:57-59`) and `SET NULL`s ~40 other actor
  columns. `set_practitioner_active_locked` (`0150:283-319`) — the whole point of which is to make
  deactivation atomic, owner-gated and self-removal-proof — is bypassed entirely by
  `PATCH … {"active":false}`.
- **Current protection:** `is_studio_owner` confines every variant to the owner's own studio, so this
  is **not** cross-tenant and **not** P0. The application never performs any of these writes: team
  management routes through the service-role-only `set_practitioner_active_locked`, and
  `tests/security/service-role-allowlist.ts` registers the admin-client callers.
- **Why that is insufficient:** the application not doing something is not a control. The `authenticated`
  role holds the privilege and the policy admits the row. Every guarantee the 0164–0168 command layer
  provides is conditional on `practitioners.user_id` being trustworthy, and it is the one identity
  column with no write protection at all.
- **Recommended closure:** (1) `revoke insert, update, delete on table public.practitioners from anon, authenticated;`
  retaining `SELECT`, in the shape of `0169:82-87`. (2) Replace the three write policies with a
  `SELECT`-only member policy. (3) Move the four self-service profile writes
  (`settings/profile/actions.ts:29-33`, `:56`, `:135`, the calendar-feed clear) onto a narrow
  `authenticated`-EXECUTE command that derives the target from `auth.uid()` and can only write
  `display_name` / `color` / `calendar_feed_token_hash` for the caller's own row — Style A, not Style B.
  (4) Route `role` and `user_id` changes through an owner-gated command that writes an
  `admin_action_events` row. (5) Change `client_clinical_notes_practitioner_same_studio` to
  `ON DELETE RESTRICT`; an append-only clinical table must never be torn down by a roster change.
- **Regression test:** `test:db` — as an owner, assert `PATCH practitioners SET user_id` is refused;
  assert `role`, `active` and `DELETE` are refused; assert a non-owner cannot write any practitioner
  row; assert `display_name` self-update still succeeds through the new command. Plus a privilege
  guard asserting `has_table_privilege('authenticated','public.practitioners','UPDATE') = false`.
- **Missing evidence:** not reproduced. No production query was run, so it is unknown whether any live
  `practitioners` row has ever been directly `PATCH`ed. Willow's roster (per the 2026-07-30 register:
  2 practitioners, 1 active owner, 0 active non-owners — *supplied, not independently verified by this
  audit*) bounds the blast radius today but not the capability.

---

#### `A-P1-02` — `public.appointments` is still outside the command boundary: any member can create, retime, reassign, cancel or delete an appointment with no actor and no audit row

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** **DML-coupled** · **Absorbs** `APC-001`, `APPT-001`, `APPT-012`, `APPT-013`, `RLS-001`
- **Source evidence:**
  ```sql
  -- supabase/migrations/0010_booking_v1.sql:272-277
  drop policy if exists "appointments_member_all" on public.appointments;
  create policy "appointments_member_all"
    on public.appointments
    for all
    using (public.is_studio_member(studio_id))
    with check (public.is_studio_member(studio_id));
  ```
  This is the **only** policy DDL naming `public.appointments` in all 170 migrations, and there is no
  table-level `GRANT`/`REVOKE` for it anywhere. Both command migrations say so explicitly —
  `0170:1018-1019`: *"this migration revokes NOTHING; the appointment DML revocation is a LATER PR."*
- **Failure scenario:** Priya, an active non-owner, POSTs directly to `/rest/v1/appointments` with
  `{studio_id, practitioner_id: <a colleague>, client_id, service_id, starts_at, ends_at,
  duration_minutes, status:'confirmed', booked_outside_availability: true}`. `is_studio_member`
  passes, so the `FOR ALL` policy admits it. `validate_appointment_availability` never runs — it exists
  only inside the `SECURITY DEFINER` commands (`0152:496-499`, `0170:875-877`) — so published hours are
  never consulted. The soft-buffer trigger short-circuits on the flag she set herself
  (`0152:226-227`: `if new.status = 'confirmed' and coalesce(new.booked_outside_availability, false) = false then`).
  `cancellation_token_hash` is nullable (`0090:66`), so no token is needed. Result: a confirmed
  out-of-hours appointment assigned to a colleague, created by a non-owner in violation of the
  owner-only override rule, **with zero rows in `appointment_audit`** — nothing in the database records
  that anyone created it. A `DELETE` on the same table then `CASCADE`s the entire audit trail
  (`0010:219`).
- **Current protection:** the GiST exclusions (`0152:80-97`) still refuse a true interval overlap; the
  shadow-reservation sync trigger still catches collisions with blocks, blockouts and breaks; the
  `0151:97-99` composite FK blocks a **cross-studio** assignee; and `0134:113-128` unconditionally
  overwrites `new.capacity_enabled` from the studios row, so the exclusions cannot be escaped by
  forging that flag. `tests/app/calendar/internal-booking-command-source.test.ts:28` asserts the
  application never inserts directly.
- **Why that is insufficient:** those are collision constraints, not attribution or authorization
  constraints. Nothing requires an `appointment_audit` row to exist, nothing binds
  `booked_outside_availability` to an owner, and nothing keeps a member out of the table. The source
  guard test proves what the **application** does; it says nothing about what the `authenticated`
  **role** may do.
- **Recommended closure:** in the reserved Appointment DML migration —
  `revoke insert, update, delete, truncate on public.appointments from anon, authenticated;` retaining
  `SELECT`, and replace `appointments_member_all` with a `SELECT`-only member policy. Exactly the shape
  of `0169:82-87`. ⚠️ **Before revoking, audit the live service-role writers** that a revoke will not
  touch but that a policy replacement might: `app/(app)/calendar/actions.ts:1114-1116` and `:1242-1244`,
  and `app/(app)/calendar/postcare-auto-send.ts:152-153`, `:187-188`, `:201-202` (postcare bookkeeping
  columns). Additionally make `booked_outside_availability` write-once-by-command with a
  `BEFORE INSERT OR UPDATE` trigger that refuses a `true` value from a non-definer writer.
- **Regression test:** privilege guard asserting `has_table_privilege('authenticated','public.appointments', …) = false`
  for INSERT/UPDATE/DELETE/TRUNCATE and the same for `anon`; plus a behavioural `test:db` case that,
  `asRole('authenticated')` as an active member, attempts an INSERT into its **own** studio with
  `booked_outside_availability = true` and asserts refusal.
- **Missing evidence:** not reproduced. This is the same defect the 2026-07-30 register carries as
  `F-SEC-002`; it remains open at `03e7dea`.

---

#### `A-P1-03` — `appointment_audit` accepts browser-forged rows with an arbitrary actor, and it is the *only* record of who created, moved or cancelled an appointment

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** **DML-coupled** · **Absorbs** `APPT-002`, `AUD-P1-002`, `RLS-003`, `APC-M1`, `FRG-004`, `CEN-001`
- **Source evidence:** the table DDL at `0010:217-225` (quoted in §3.3): `actor_id uuid` — nullable, no
  FK, no studio component — under `ON DELETE CASCADE`. The INSERT policy:
  ```sql
  -- supabase/migrations/0010_booking_v1.sql:291-299
  create policy "appointment_audit_member_insert"
    on public.appointment_audit
    for insert
    with check (
      appointment_id in (
        select id from public.appointments
        where public.is_studio_member(studio_id)
      )
    );
  ```
  `actor_type`, `actor_id`, `action` and `details` are **entirely unconstrained**. No table-level
  `GRANT`/`REVOKE` exists. There is no `UPDATE` or `DELETE` policy, so those are denied by
  default-deny — the forged row is **permanent**.
- **Why it matters here specifically:** `appointments` has **no creator column at all** (`0010:174-190`)
  and `cancelled_by` stores a role word, not an identity. So this audit row is the *sole* durable
  answer to "who booked / moved / cancelled this?", and it is forgeable by any member of the studio and
  destroyed by deleting its parent (which **A-P1-02** permits).
- **Failure scenario:** Priya POSTs `/rest/v1/appointment_audit` with
  `{appointment_id: <any appointment in her studio>, actor_type: 'practitioner', actor_id: '<Maya>',
  action: 'cancelled', details: {...}}`. It commits, permanently, and cannot be edited or removed. Any
  later reconstruction of who cancelled the appointment from the audit trail names Maya.
- **Correction to an earlier framing:** a forged row does **not** change what the appointment detail
  page displays. `app/(app)/calendar/[id]/page.tsx:132-137` selects only `details` from the audit row,
  and the on-screen "by {cancelled_by}" at `:537-539` reads `data.cancelled_by` — the **appointments
  column**, not the audit table. The harm is to the durable record and to any future forensic read, not
  to today's UI.
- **Current protection:** none specific to the actor. The studio predicate confines forgery to the
  attacker's own tenant.
- **Recommended closure:** (1) `revoke insert, update, delete on public.appointment_audit from anon, authenticated;`
  — only the `SECURITY DEFINER` commands should ever write it. (2) Drop the vestigial member INSERT
  policy. (3) Add `actor_practitioner_id uuid references practitioners(id, studio_id)` as a composite,
  `ON DELETE RESTRICT` column and backfill from `actor_id` where `actor_type='practitioner'`. (4) Change
  the parent FK from `ON DELETE CASCADE` to `RESTRICT`, or add a tombstone. (5) Actually write
  `actor_type='system'` on cron/webhook paths instead of borrowing a practitioner or writing null.
- **Regression test:** `test:db` — `asRole('authenticated')` as a member, attempt an INSERT naming a
  colleague as `actor_id` and assert refusal; assert `has_table_privilege('authenticated','public.appointment_audit','INSERT') = false`;
  assert deleting an appointment does not remove its audit rows.
- **Missing evidence:** not reproduced; no production count of `appointment_audit` rows whose `actor_id`
  does not correspond to any practitioner was taken.

---

#### `A-P1-04` — Seven attribution tables accept a browser-forged author because their RLS `WITH CHECK` names only `is_studio_member`

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** Independent · **Absorbs** `FRG-002`, `CLIN-P1-001`, `H1`
- **Source evidence:** each policy pins the tenant and never the author.

  | Table.column | Policy | Line |
  |---|---|---|
  | `client_pinned_notes.created_by_practitioner_id` | studio-only `WITH CHECK` | `0022:38-45` |
  | `treatment_plans.created_by_practitioner_id` / `.closed_by_practitioner_id` | studio-only on INSERT; **the UPDATE policy has `using` and no `with check` at all** | `0024:44-51`, `0024:54-62` |
  | `treatment_goals.created_by` | `is_studio_member` | `0087:189-196` |
  | `client_tags.created_by` / `.deleted_by` | `is_studio_member` | `0087:171-178` |
  | `client_personal_notes.updated_by_practitioner_id` | `is_studio_member` | `0087:208-215` |
  | `consent_form_templates.created_by_practitioner_id` | studio-only | `0057:128-134` |
  | `client_portal_messages.created_by_practitioner_id` (NOT NULL, `RESTRICT`) | `is_studio_member` | `0055:83-86`, `0055:97-101` |

  None of these tables has a table-level `GRANT`/`REVOKE` anywhere. The contrast is one migration away:
  `client_clinical_notes` (`0127:37-51`) uses the same table shape and binds the author to
  `p.user_id = (select auth.uid()) and p.active`.
- **Failure scenario:** Priya POSTs `/rest/v1/treatment_plans` with
  `{studio_id, client_id, name, suggested_visit_count, created_by_practitioner_id: '<Maya>'}`. The plan
  is authored, permanently, in Maya's name. On `treatment_plans` she can go further: because the UPDATE
  policy carries **no `WITH CHECK`**, she can `PATCH` an existing plan and re-point
  `created_by_practitioner_id` to anyone — a **destructive attribution rewrite** of an existing clinical
  artifact, with no audit row and no `updated_by` column to reveal it.
- **Current protection:** `is_studio_member` confines all of it to one studio. All seven have correct
  server actions that hard-code `practitioner.id`; the forgery bypasses the action entirely.
- **Why that is insufficient:** the server action is not in the request path. The database is the only
  control that applies to a direct PostgREST write, and it checks the wrong thing.
- **Recommended closure:** one migration adding the `0127` `WITH CHECK` shape to all seven INSERT
  policies, and a `WITH CHECK` to every UPDATE policy that pins the attribution column to its old value
  (or forbids changing it). Where a legitimate editor exists (pinned notes, plans), add
  `updated_by_practitioner_id` + `updated_at` rather than allowing the original author to be replaced.
- **Regression test:** a parameterised `test:db` suite that, for each of the seven tables,
  `asRole('authenticated')` as member A attempts an INSERT naming member B as author and asserts
  refusal; and for `treatment_plans` attempts an UPDATE re-pointing `created_by_practitioner_id` and
  asserts refusal.
- **Missing evidence:** not reproduced.

---

#### `A-P1-05` — Client-profile edits, including allergies and date of birth, record no actor, no timestamp and no audit event

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** Independent · **Absorbs** `CP-001`, `CP-002`, `CP-003`
- **Source evidence:** `public.clients` carries `created_by` (`0001:48`) and `archived_by`
  (`0050:55-57`) and **nothing else** — no `updated_by`, no `updated_at`. The main profile save is a
  direct `UPDATE public.clients` through the authenticated client under
  `clients: members all` (`0001:253-257`, `FOR ALL`, `is_studio_member`). The compensating control is a
  fail-soft `audit_logs` insert whose `actor_id` is itself browser-forgeable (`0001:294-296`, see
  `A-P2-14`). Unarchiving **erases** `archived_by` rather than preserving it.
- **Failure scenario:** a client's recorded allergies are changed from "lidocaine" to empty. Afterwards
  the record cannot answer who changed it or when — there is no `updated_by`, no `updated_at`, and if
  the fail-soft audit insert failed (its error is not checked) there is no trace at all. For an
  allergy field on a clinical record this is the difference between an accountable correction and an
  untraceable one.
- **Current protection:** RLS confines the write to the studio. The audit-log row usually lands.
- **Why that is insufficient:** "usually lands" is not a record, and a row whose `actor_id` any member
  can choose is not attribution.
- **Recommended closure:** add `updated_by_practitioner_id` (composite same-studio FK) + `updated_at` to
  `public.clients`; route profile saves through a command that derives both from `auth.uid()`; make the
  allergy/DOB fields write an append-only change row; stop erasing `archived_by` on unarchive.
- **Regression test:** `test:db` asserting an allergy edit writes a non-null `updated_by_practitioner_id`
  equal to the caller, and that a member cannot set it to a colleague.
- **Missing evidence:** not reproduced.

---

#### `A-P1-06` — The human who executes a charge is authenticated, authorised, then discarded; the ledger names only the preparer

- **Status** OPEN · **Reachable** n/a (design gap, not an attack) · **Queue** Independent · **Absorbs** `F-MONEY-001`, `F-MONEY-011`
- **Source evidence:** `executeSessionPaymentChargeAction`
  (`app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts:359-410`) resolves the executor via
  `getCurrentPractitionerWithStudio()` and passes it to `runSessionPaymentCharge({attemptId, studioId, practitionerId})`.
  That reaches `claim_session_payment_charge_attempt` (`lib/billing/session-payment-charge.ts:891-898`),
  whose body uses `p_practitioner_id` **only** to authorise:
  ```sql
  -- supabase/migrations/0075_claim_session_payment_charge_attempt.sql:148-153
  select pr.role into v_role
    from public.practitioners pr
   where pr.id = p_practitioner_id
     and pr.studio_id = v_row.studio_id
     and pr.active = true;
  ```
  It is never written. `payment_charge_attempts` has `created_by_practitioner_id` (preparer, `0073:203-206`),
  `cancelled_by_practitioner_id` (`0073:173`) and `refund_initiated_by_practitioner_id` (`0078:68`) —
  but **no executor column**. The terminal `status='succeeded'` write carries no human actor. The only
  surviving trace of the executor is a PostHog event (`payment-actions.ts:425-430`), which is analytics,
  is deliberately opaque-id only, and is not a financial record.
- **Failure scenario:** Maya prepares a CAD 180 charge and leaves. Priya reviews and runs it. The
  succeeded row, the receipt and the export all name **Maya**. If the client disputes the charge, the
  studio's own ledger cannot identify who authorised the money movement. Under the audit's own
  terminology (§2) preparer and executor are distinct roles and Hone models only one.
- **Current protection:** the executor **is** authenticated and re-authorised in-DB against the row's
  studio, and the RPC is `service_role`-only (`0075:246-249`), so nothing here is forgeable. The gap is
  purely that the identity is not persisted.
- **Why that is insufficient:** a financial ledger that cannot name who moved the money has not
  recorded the transaction. The same shape applies to manual fees (workflow 31).
- **Recommended closure:** add `executed_by_practitioner_id uuid` with the composite same-studio FK +
  `ON DELETE RESTRICT` (matching the three columns already on the table), set it inside
  `claim_session_payment_charge_attempt` from `p_practitioner_id` in the same statement that claims the
  row, and surface preparer-vs-executor in the payment UI and the export. Include the executor in the
  PaymentIntent metadata block.
- **Regression test:** unit test asserting the claim RPC writes `executed_by_practitioner_id`; a
  `test:db` case asserting a claimed row always has a non-null executor; a source guard asserting the
  terminal `succeeded` update cannot run without one.
- **Missing evidence:** not reproduced. Live payments are on at Willow (per the 2026-07-30 register —
  *supplied, not independently verified by this audit*), so real charge rows exist today with no
  executor recorded; this audit did not query them.

---

#### `A-P1-07` — Consent-template governance is owner-only in TypeScript and member-only in the database

- **Status** OPEN · **Reachable** REACHABLE_IN_PRODUCTION · **Queue** Independent · **Absorbs** `CC-005`, `CC-004`
- **Axis note:** this is the one P1 on a **privilege-bypass** axis rather than a forged/missing-actor
  axis. It is included because consent templates are the legal artifact clients sign, and because
  publishing one to the portal is an unattributed act.
- **Source evidence:** `consent_form_templates` policies are `with check (public.is_studio_member(studio_id))`
  on both INSERT and UPDATE (`0057:126-140`), with no `revoke` anywhere. The application gates the same
  operations on `practitioner.role !== "owner"`. So the owner-only rule exists **only** in TypeScript.
  `created_by_practitioner_id` is frozen at creation; edits, status changes and the `is_live` publish
  record no actor at all.
- **Failure scenario:** a non-owner member PATCHes `consent_form_templates` directly, editing the body of
  a live consent template or setting `is_live` — changing what clients are asked to agree to, with no
  role check and no record of who did it. Historical signatures continue to reference the template row.
- **Current protection:** `is_studio_member` confines it to the studio; the UI does not offer it to
  non-owners.
- **Recommended closure:** add the owner predicate to the DB policies (`is_studio_owner`), and record
  `updated_by_practitioner_id` + `published_by_practitioner_id` + `published_at`. Versioned templates
  must be append-only once signed against.
- **Regression test:** `test:db` asserting a non-owner member cannot UPDATE `consent_form_templates` and
  cannot set `is_live`.
- **Missing evidence:** not reproduced.

---

### 7.2 P2 findings (24 themes, 76 verified instances)

Grouped by theme; each names its canonical instances. Full per-instance evidence is in the writer
matrix (§4) and the forgery matrix (§5).

| ID | Theme | Instances | Evidence anchor |
|---|---|---|---|
| `A-P2-01` | The outside-hours override is a bare boolean with no actor, timestamp or role snapshot; a later move preserves it silently | `APC-004` | `0152:66`, audit `details` at `0152:523` |
| `A-P2-02` | `start_session` writes creator and performer to the same value, so an assistant-charted session reads as self-performed | `CEN-004`, `F-SES-001` | `0167:270-274` |
| `A-P2-03` | `set_session_performer` accepts an **inactive** target, has no role gate and writes **no audit row** | `FRG-001`, `CEN-004`, `TD-010` | `0167:356-357` (no `and p.active = true`), grant `0167:644`; only `session_audit` insert in the file is `0167:425` |
| `A-P2-04` | No attribution column anywhere in the clinical record is frozen — 0160 pins parentage only | `H-08`, `CEN-007` | `0160:173-202` |
| `A-P2-05` | Sterile-item **disposal has no column and no event**; disinfectant discard records only a date | `RK-005`, `CEN-012` | `0085:30-45`, `0085:90` |
| `A-P2-06` | Postcare send is unattributed and the email is signed with the appointment **assignee's** name | `CC-001` | `calendar/actions.ts:1114-1120`, `:1243-1249` |
| `A-P2-07` | Studio settings changes — including `late_cancel_fee_cents` and `cancellation_policy_text`, which justify a real charge — produce no attribution of any kind | `F-ADM-001`, `H-12`, `F-ADM-010` | seven direct `UPDATE public.studios` surfaces |
| `A-P2-08` | Practitioner deactivation records nothing; the actor is consumed by the gate and discarded | `F-ADM-004`, `F-ID-004` | `0150:297-318` |
| `A-P2-09` | `admin_action_events` is fail-soft, and its actor is an **auth user**, not a practitioner; three of five admin write paths are unattributable when it misses | `F-ADM-008`, `AUD-P2-006` | `lib/audit/admin-actions.ts:47-58` |
| `A-P2-10` | Every block save hard-`DELETE`s the authoritative `session_block_areas` rows with no tombstone, no actor and no audit | `CRIT-002` | `0156:160` |
| `A-P2-11` | `client_intake_forms.deleted_at` is member-`PATCH`-able, guarded by neither 0118 nor 0162, has no `deleted_by`, and is written by **no** application path — while every reader filters on it | `CRIT-001` | `0015:39`; policy `0087:155-159` |
| `A-P2-12` | Deactivating a practitioner blanks their name from six historical surfaces while the DB still holds the truth; the regulatory print loader does **not** do this | `F-ID-003`, `F-SES-003`, `H-06`, `CLIN-P2-008` | `queries.ts:204-209` + `:278-286` + `:332` vs `record-keeping/queries.ts:446-449` |
| `A-P2-13` | Three renderers give three different answers for an unresolved clinical-note author: `"You"`, `"Unknown practitioner"`, and nothing | `H-01` | `clinical-notes-section.tsx:309`; `clinical-notes/print/page.tsx:104`; `clinical-notes-summary.tsx:70`; trigger is the discarded error at `lib/clinical-notes/queries.ts:37` |
| `A-P2-14` | `audit_logs.actor_id` is browser-forgeable, which voids every compensating "we write an audit row" claim elsewhere in this document | `FRG-003`, `CP-011`, `CEN-010`, `F-ADM-016` | `0001:294-296` |
| `A-P2-15` | Pinned-note edit rewrites the body via the **service-role** client with no editor recorded, deliberately preserving the original author | `H-02`, `CLIN-P2-003`, `FRG-008`, `G4` | `pinned-notes-actions.ts:85-101` (comment at `:86`) |
| `A-P2-16` | The regulated logbook's operator falls through to arbitrary free text when the submitted id does not resolve, instead of erroring | `RK-004`, `FRG-005`, `D2` | `records/actions.ts:73-76`; column `0085:93` |
| `A-P2-17` | Logbook actor/operator columns are caller-declared under a membership-only `WITH CHECK` on **INSERT and UPDATE** | `RK-002`, `H4` | `0085:71-80,125-134,179-190`; `0088:55-58` |
| `A-P2-18` | `start_session` and `treatment_image_actor` resolve the acting studio with an unordered `limit 1`, ignoring the selected-studio cookie — violating the stated invariant that a studio is never auto-picked | `CEN-006`, `F-ID-001`, `F-ID-002`, `CP-005` | `0167:185-189`, `0168:83-88` vs `lib/supabase/queries.ts:42-43` |
| `A-P2-19` | Six audit tables carry no table-level `REVOKE`, so `TRUNCATE`/`REFERENCES`/`TRIGGER` remain granted — a defence-in-depth gap, **not** browser-reachable | `AUD-P1-001`, `RLS-009`, `RK-001` | absence of any `revoke` naming those tables |
| `A-P2-20` | Style-B commands assert the actor as a parameter; the DB validates membership, never identity | `APPT-007`, `CEN-011`, `AUD-P1-003`, `APC-002` | `0133:49-52` (says so); `0150:297`; `0075:148-153` |
| `A-P2-21` | `sessions.csv` exports performer UUIDs that resolve to no row in the same ZIP, and six attributed record types are absent from the export entirely | `H-04`, `H-07` | `settings/data/actions.ts` extract list |
| `A-P2-22` | `client_portal_messages` / `_replies`: a member can forge the **client's** review attestation and rewrite a client's reply body | `CC-M1`, `CC-M2`, `CC-003` | `0055:83-101` |
| `A-P2-23` | Four import-subsystem actor columns FK to `auth.users` while the sibling audit table records a practitioner id | `CEN-008` | `0089:71,77,131,136` vs `0089:176` |
| `A-P2-24` | `client_clinical_notes`' practitioner FK is `ON DELETE CASCADE`, so a roster deletion destroys append-only clinical notes. **LATENT** — no shipped delete path; armed only by `A-P1-01` | `H-05` | `0126:57-59`; deliberate per `0126:49-51` |
| `A-P2-26` | **`service_role` retains the `TRIGGER` privilege on every clinical table, and every attribution guard added since 0159 is trigger-based.** `0159:478-479` and `0159:495-496` revoke `truncate, references, trigger` from `anon` and `authenticated` **only**. `0160`'s lineage immutability and `0162`'s intake-review integrity guard are both triggers, so a service-role caller can drop them and then write freely. Not browser-reachable (REACHABLE_ONLY_WITH_SERVICE_ROLE), which is why it is P2 — but it is the standing bypass beneath several controls this document credits elsewhere, and it should be closed in the same migration as **A-P2-19** | `L20` (prior register) | `0159:476-479`, `0159:493-496`; `0169:51` (*"service_role and anon privileges are unchanged"*) |
| `A-P2-25` | **No clinical pass or settings block records who wrote it.** `session_blocks`, `session_block_areas`, `electrolysis_entries` and `laser_entries` carry no author column at all — the only identity any of them holds is `deleted_by` (`0114:35,40`). Per-pass authorship is ambiguous whenever two practitioners chart into one session; every pass inherits an actor only indirectly via `sessions.practitioner_id`, which **is** DB-derived (`0167:185-191`) and NOT NULL / `ON DELETE RESTRICT` (`0001:82`). That inheritance is why this is P2 and not a missing mandatory performer. | `CEN-003`, `F-SES-002`, workflows 10–13 | `0001:93-103`; `0114:35,40` |

### 7.3 P3 findings (59 verified)

Summarised rather than enumerated; the full list is reproducible from the agent corpus.

* **Naming and vocabulary (≈18).** `practitioner_id` meaning four different things; `cancelled_by`
  holding a role word; `created_by` vs `created_by_practitioner_id` vs `actor_practitioner_id` used
  interchangeably; `actor_type='system'` declared and never written.
* **Missing tests and stale docs (≈24).** No test asserts any attribution column is immutable; no test
  asserts `TRUNCATE` denial on any audit table; four appointment/copy audit tests assert the actor
  parameter the test itself supplied, so caller-asserted attribution is never actually probed
  (`TD-005`). `docs/audits/2026-07-30` still publishes `N-SEC-001` and `L18` as OPEN/REACHABLE, which
  0169 partly overtook — see §13.1.
* **UI labels (≈9).** The audit trail is read for its *reason* and never for its *actor*, so the
  product can say **why** an appointment was cancelled but not **by whom** (`H-10`); soft-deleted
  clinical passes record who removed them and no surface ever shows it (`H-09`).
* **Maintainability (≈8).** `service_practitioners` (booking eligibility) has `created_at` and no
  `created_by`; the reminder cron re-issues intake credentials through the same actor-less helper as
  the UI, conflating automated and named sends in `intake_link_send_count`.

### 7.4 Explicitly **not** findings — what is correct and must not regress

* `client_clinical_notes` (0126/0127) — append-only trigger, author bound to `auth.uid()` in RLS,
  composite same-studio FK, `UPDATE/DELETE/TRUNCATE` revoked, `anon` revoked.
* `session_audit` INSERT policy (`0117:38-58`) — binds the actor to the caller's own active
  practitioner **and** the session to the caller's studio.
* `client_intake_forms.reviewed_by` (`0162:219-232`, immutability at `:337-341`) — the only
  DB-enforced reviewer in the schema.
* The 0164–0168 clinical commands — actor derived from `auth.uid()`, `service_role` revoked
  (`0165` for the laser command), caller-supplied practitioner ids refused.
* `payment_charge_attempts` / `manual_fee_charge_attempts` — composite same-studio actor FKs with
  `ON DELETE RESTRICT` throughout.
* `calendar_connections` (`0121:100-108`) — self-only, composite same-studio FK, deliberate documented
  `CASCADE`.
* `record_keeping_audit_events` (`0086:83-95`) — SELECT-only policy, trigger-written, actor derived
  from `auth.uid()`.
* `session_copy_operations` (`0157:73,91`) — NOT NULL actor + composite FK + `RESTRICT`. **The model
  to generalise.**

### 7.5 UNKNOWN — could not be settled from source

1. Whether any live row carries a forged or inconsistent actor. Requires production reads; none were
   authorised or performed.
2. The actual grant matrix in the hosted database. Every grant statement in this document is derived
   from migration source plus Supabase's documented defaults; **no `information_schema` query was run.**
   The 2026-07-30 register's hosted facts are quoted as *supplied, not independently verified*.
3. Whether `practitioners: owners update` has ever been exercised outside the profile action.
4. Whether the `attachAuthors` error path (`A-P2-13`) has ever fired in production.


---

## 8. DML-coupled queue — must be resolved inside the Appointment DML command series

These findings **must not** be fixed independently. They live on `public.appointments` and
`public.appointment_audit`, which the Appointment DML command series already owns, and closing them
means revoking the same grants and replacing the same policy that series is designed to replace.
Fixing them separately would either collide with that migration or ship a half-revocation.

> **Migration `0172` is RESERVED for the Appointment DML series. This audit does not claim it and
> proposes no migration number.** Every migration below is described by content and ordering only;
> the DML owner assigns the numbers.

| # | Finding | What must happen inside the DML series | Why it cannot be done independently |
|---|---|---|---|
| D1 | **A-P1-02** | `revoke insert, update, delete, truncate on public.appointments from anon, authenticated;` retaining `SELECT`; replace `appointments_member_all` with a `SELECT`-only member policy | This *is* the DML cutover. It must be application-first: confirm zero remaining direct writers, deploy, then revoke — the L18 lesson (`0169` header) |
| D2 | **A-P1-03** | `revoke insert, update, delete on public.appointment_audit from anon, authenticated;`; drop the vestigial member INSERT policy; add composite `actor_practitioner_id`; change the parent FK from `CASCADE` to `RESTRICT` | The audit table's INSERT policy is only reachable because members hold appointment DML; and the `CASCADE` only matters because members can `DELETE` appointments. Both halves are the same cutover |
| D3 | **A-P2-01** — outside-hours override has no actor | Make `booked_outside_availability` write-once-by-command via a `BEFORE INSERT OR UPDATE` trigger refusing a `true` value from a non-definer writer; persist the authorising actor and their role at the time | The flag is only forgeable because of D1. A trigger added before the revoke would be redundant; added after, it is one statement in the same file |
| D4 | Appointment **creator** is recorded nowhere on the row | Add `created_by_practitioner_id` (composite same-studio FK, `ON DELETE RESTRICT`) to `public.appointments`, written by `create_internal_appointment_v2` / `create_public_appointment` (null + `actor_type='client'` for public bookings) | Requires editing the same command bodies the DML series is already rewriting |
| D5 | `cancelled_by` stores a **role word** | Add `cancelled_by_practitioner_id` alongside the existing role discriminator; keep the role word (it correctly distinguishes client-initiated from practitioner-initiated) | `reschedule_appointment_v2` (`0171:1304`) and the cancel command both write this column; changing it outside the series would fork the write path |
| D6 | **A-P2-20** — Style-B parameter-asserted actor on the appointment commands | Decide the direction: either move the appointment commands to Style A (`authenticated` EXECUTE + `auth.uid()` derivation, matching 0164–0168), or keep `service_role` and add a DB-side assertion that the asserted actor matches a caller-supplied verified claim | This is an architectural decision about the command family itself. §10 recommends Style A |
| D7 | `APPT-013` — `cancellation_token_hash` is member-writable | Covered automatically by D1's revoke | No separate work |

**Ordering within the series:** D4 and D5 (additive columns) can land *before* the cutover, as 0164–0168
did. D1, D2, D3 and D7 are the cutover itself and must land together, application-first. D6 should be
decided before D1 so the revoke lands in its final shape.

---

## 9. Independent attribution queue

These touch no appointment object and can proceed in parallel with the DML series. They are ordered by
value-per-unit-risk, not by severity alone.

| # | Finding | Work | Migration? | Blocks / blocked by |
|---|---|---|---|---|
| I1 | **A-P1-01** — `practitioners` write boundary | Revoke `authenticated` DML on `public.practitioners`; replace the three write policies with a `SELECT`-only member policy; move the four self-service profile writes onto a narrow Style-A command; route `role`/`user_id`/`active` through an owner-gated command that writes `admin_action_events`; change `client_clinical_notes`' practitioner FK to `RESTRICT` | **YES** | **Nothing blocks it. Do this first** — every other actor guarantee rests on it |
| I2 | **A-P1-04** — seven forgeable author tables | One migration applying the `0127` `WITH CHECK` shape to all seven INSERT policies; add `WITH CHECK` to every UPDATE policy pinning the attribution column; add `updated_by_practitioner_id` where an editor legitimately exists | **YES** | Independent |
| I3 | **A-P1-06** — payment executor | Add `executed_by_practitioner_id` (composite FK, `RESTRICT`) to `payment_charge_attempts` and `manual_fee_charge_attempts`; set it inside the claim RPC; surface preparer-vs-executor in UI + export + PaymentIntent metadata | **YES** | Independent. Touches live money code — ship behind the existing payment CI lane |
| I4 | **A-P1-05** — client-profile attribution | Add `updated_by_practitioner_id` + `updated_at` to `public.clients`; route saves through a command; stop erasing `archived_by` on unarchive | **YES** | Independent |
| I5 | **A-P1-07** — consent-template governance | Add the owner predicate to the DB policies; record `updated_by` / `published_by` / `published_at` | **YES** | Independent |
| I6 | **A-P2-16**, **A-P2-17** — regulated logbook | Reject a non-resolving, non-sentinel operator id instead of falling through to free text; distinguish *verified* from *typed* operator in the UI and the print view; bind the logbook's actor columns to `auth.uid()` in RLS; add a discard/disposal actor (**A-P2-05**) | **YES** | Independent. Highest regulatory value after I1 |
| I7 | **A-P2-03** — `set_session_performer` | Add `and p.active = true` to the target check; write a `session_audit` row for every performer change (old → new); consider an owner-or-self role gate | **YES** | Independent |
| I8 | **A-P2-12**, **A-P2-13** — read-time attribution | Load the practitioner directory for *historical* rendering without `.eq("active", true)` (a separate loader from the assignment picker, which must stay active-only); stop discarding the error in `attachAuthors`; make the three clinical-note renderers agree — never render `"You"` for a persisted row | **NO — code only** | Independent. Cheapest visible win in the audit |
| I9 | **A-P2-15** — pinned-note editing | Add `updated_by_practitioner_id` + `updated_at`; stop using the service-role client for a user-initiated edit (it exists only because 0022 has no UPDATE policy — add one bound to `auth.uid()` instead) | **YES** | Independent |
| I10 | **A-P2-25** — clinical pass authorship | Add `created_by_practitioner_id` to `session_blocks` / `electrolysis_entries` / `laser_entries`, derived in-DB by the existing 0164/0166 commands | **YES** | Should follow I1; the commands are already Style A so this is additive |
| I11 | **A-P2-19**, **A-P2-26** — audit-table and trigger privileges | `revoke truncate, references, trigger` from `anon, authenticated` on all audit tables; **and revoke `trigger` from `service_role`** on the clinical tables, so the 0160/0162 attribution guards cannot be dropped by the role every Style-B command runs as | **YES** | Independent, low risk. ⚠️ Verify no migration or command needs `TRIGGER` as `service_role` before revoking |
| I12 | **A-P2-07**, **A-P2-08**, **A-P2-09** — governance attribution | Record an actor for studio-settings changes, practitioner deactivation, and SMS enablement; make `admin_action_events` fail-closed for write paths | **YES** | Independent |
| I13 | **A-P2-11** — intake `deleted_at` | Guard the transition; add `deleted_by`; or remove the column if nothing should ever write it | **YES** | Independent |
| I14 | **A-P2-10** — structured-area destruction | Replace the hard `DELETE`-and-reinsert in `update_session_block_with_areas` with a soft-delete carrying `deleted_by` | **YES** | Coordinate with **Session 1D** — see §13.2 |
| I15 | **A-P2-18** — `limit 1` studio auto-pick | Give `start_session` and `treatment_image_actor` an explicit studio parameter validated against the caller's memberships, restoring the stated invariant | **YES** | Independent |
| I16 | **A-P2-21** — export attribution | Ship a resolvable practitioner extract (all practitioners, not active-only) and add the six absent record types | **NO — code only** | Overlaps `F-DATA-001` in the 2026-07-30 register; do them together |

---

## 10. Canonical actor model

### 10.1 The rule

> **An actor is never accepted. An assignee is always validated.**

Two column classes, two enforcement mechanisms, and they must never be confused:

| Class | Terms | Source of the value | Enforcement | Mutability |
|---|---|---|---|---|
| **Attribution** | actor, author, reviewer, executor | `auth.uid()`, resolved **inside** the database | RLS `WITH CHECK` binding the column to the caller's own active practitioner, **and** the column written by a `SECURITY DEFINER` command that derives it | **Immutable.** Corrections are new rows |
| **Designation** | assigned practitioner, performer, operator, preparer | may be submitted by the browser | re-validated server-side **and** structurally pinned by a composite `(id, studio_id)` FK; target must be `active` at write time | Mutable, but every change writes an audit row naming the changer |

`system actor` is a third class: a reviewed background process. It must be **named**
(`actor_type='system'` plus a process identifier), never represented by `null` and never by a borrowed
practitioner id.

### 10.2 The reference implementation already exists — twice

Hone does not need a new pattern. It needs two existing ones applied consistently.

**For attribution — `client_clinical_notes` (0126/0127):**

```sql
-- author bound to the caller, in the database  (0127:37-51, verbatim)
  with check (
    -- Caller is a member of the NOTE's studio (fully qualified — never the
    -- practitioner subquery's studio_id).
    public.is_studio_member(client_clinical_notes.studio_id)
    and exists (
      select 1 from public.practitioners p
      where p.id = client_clinical_notes.practitioner_id
        -- The authoring practitioner must belong to the SAME studio as the note
        -- (this is the clause 0126 accidentally turned into a tautology).
        and p.studio_id = client_clinical_notes.studio_id
        -- ...and must be the signed-in caller, and active.
        and p.user_id = (select auth.uid())
        and p.active
    )
  );
```

> **Copy this exactly, including the qualification.** 0126 wrote the same policy with the columns
> unqualified; because `practitioners` also has a `studio_id`, PostgreSQL resolved the inner reference
> to the subquery's own column and the same-studio clause degraded to `p.studio_id = p.studio_id`
> (`0127:6-19`). 0127 records that this was never exploitable — the composite
> `(practitioner_id, studio_id)` FK rejected a cross-studio practitioner independently — but an
> attribution policy that *looks* right and silently checks nothing is the worst outcome available
> here. **PR-A2 must qualify every column it names, and its tests must prove the clause bites** rather
> than assuming it does.
plus an append-only trigger (`0126:125-138`), a composite same-studio FK, and
`revoke update, delete, truncate … from authenticated`.

**For durability — `session_copy_operations` (0157:73, 0157:91):** `created_by_practitioner_id`
**NOT NULL**, composite `(id, studio_id)` FK, **`ON DELETE RESTRICT`**. It is the only live actor column
in the schema that is simultaneously mandatory, tenant-pinned and deletion-proof.

**Target shape for every attribution column:**

```sql
<role>_practitioner_id uuid not null,
constraint <table>_<role>_same_studio
  foreign key (<role>_practitioner_id, studio_id)
  references public.practitioners (id, studio_id) on delete restrict
```

`ON DELETE RESTRICT` — never `SET NULL` (destroys attribution) and never `CASCADE` (destroys the
record). ~40 actor FKs are `SET NULL` today; each is a silent history-eraser waiting for a roster
change.

### 10.3 Style A vs Style B — the decision this audit asks for

Hone runs two command styles simultaneously (§1). They are not equally safe, and the difference is not
cosmetic:

| | Style A (0164–0168) | Style B (0075, 0133, 0142–0152, 0150, 0157) |
|---|---|---|
| EXECUTE granted to | `authenticated` | `service_role` only |
| `auth.uid()` inside | available | **always null** |
| Actor | derived in-DB, caller-supplied ids refused | passed as `p_actor_practitioner_id` |
| What the DB verifies | **identity** | **membership** |
| Browser-forgeable | no | no (EXECUTE revoked) |
| Fails if the app layer is wrong | no — DB catches it | **yes — DB cannot catch it** |

Style B is not a live vulnerability. It is a **missing backstop**: the database's answer to "who did
this?" is only as good as the TypeScript that called it, and Hone has already demonstrated in the same
codebase that it does not have to be.

**Recommendation: converge on Style A.** New commands should be `authenticated`-EXECUTE with in-DB
actor derivation and `anon` + `service_role` revoked by name (the `0129`/`0164` grant lesson in
`CLAUDE.md` §5, pinned by `tests/security/clinical-rpc-grant-guard.test.ts`). Existing Style-B commands
should migrate as their surrounding work is touched — the appointment family via **D6**, the schedule
family opportunistically. Where a command genuinely must run as `service_role` (webhooks, cron), it
must write `actor_type='system'` and a process identifier, never a practitioner id.

### 10.4 Minimum schema changes — and what NOT to add

Consistent with the brief's instruction not to propose new fields where existing ones already carry the
correct meaning:

**Add (7 columns, 4 tables):**

| Column | Table | Why nothing existing carries it |
|---|---|---|
| `created_by_practitioner_id` | `appointments` | the table has **no** creator column; `practitioner_id` is the assignee |
| `cancelled_by_practitioner_id` | `appointments` | `cancelled_by` is a role discriminator and correctly stays one |
| `actor_practitioner_id` | `appointment_audit` | `actor_id` is FK-less, studio-less and untyped; keep it for backfill, add a real one |
| `executed_by_practitioner_id` | `payment_charge_attempts`, `manual_fee_charge_attempts` | `created_by_practitioner_id` is the **preparer**; no column means executor |
| `updated_by_practitioner_id` + `updated_at` | `clients` | only `created_by` and `archived_by` exist; edits are unattributed |
| `created_by_practitioner_id` | `session_blocks`, `electrolysis_entries`, `laser_entries` | no author column exists; `sessions.practitioner_id` cannot express two practitioners charting one session |
| a disposal/discard actor | `record_keeping_sterile_items`, `record_keeping_disinfectants` | disposal has **no** representation at all |

**Do NOT add:**

* An actor to `client_clinical_notes`, `client_intake_forms`, `treatment_images`, `session_copy_operations`,
  `calendar_connections` or the payment preparer/refund columns — they are already correct.
* A second `performed_by` to `sessions` — `performed_by_practitioner_id` is right; it needs an `active`
  check, an audit row and immutability from the *creator* column, not a sibling.
* A `display_name` snapshot column anywhere. Snapshots decay. The durable id plus a loader that does not
  filter `active` (**I8**) is the correct fix; `record_keeping_disinfectants.operator_name` should record
  an *unverified* operator explicitly, not shadow a verified one.
* Anything on `appointments` for the outside-hours override beyond making the existing boolean
  command-only and recording the authorising actor in the audit `details` it already writes.

---

## 11. Recommended implementation PRs

Eight PRs. Sequenced so that the foundation lands first, each is independently revertible, and none
collides with the Appointment DML series. **No migration number is proposed — `0172` is reserved for
Appointment DML, and every number below must be taken from `npm run migration:state` at the time the PR
is cut** (`CLAUDE.md` §2: migration state is derived, never hard-coded).

---

**PR-A1 — Close the `practitioners` write boundary** *(migration + code · closes **A-P1-01**)*

The foundation. Every other actor guarantee in the system depends on it, and it is the only P1 whose
absence makes the correct parts of the system untrustworthy.

Application-first, exactly as L18 was (`0169` header):
1. **Ship first, revoke later.** Add an `authenticated`-EXECUTE Style-A command
   `update_own_practitioner_profile(p_display_name, p_color, p_calendar_feed_token_hash)` that derives
   the target row from `auth.uid()` and can write no other column and no other row. Add an owner-gated
   `set_practitioner_role_locked` / `set_practitioner_user_id_locked` pair that writes an
   `admin_action_events` row. Deploy.
2. Move `settings/profile/actions.ts:29-33`, `:56`, `:135` and the calendar-feed clear onto the new
   command. This also fixes `F-ADM-003`: those four self-service writes currently match **zero rows**
   for a non-owner (the only UPDATE policy is owner-only) and report success anyway. Deploy.
3. **Then** revoke: `revoke insert, update, delete on table public.practitioners from anon, authenticated;`
   retaining `SELECT`; drop the three write policies; keep `practitioners: members read`.
4. Change `client_clinical_notes_practitioner_same_studio` to `ON DELETE RESTRICT`.

Risk: high blast radius if step 3 lands before step 2 is deployed — the same failure mode the L18
Remove-pass outage produced. Do not compress the steps.

---

**PR-A2 — Bind seven author columns to `auth.uid()`** *(migration only · closes **A-P1-04**)*

One migration replacing seven INSERT policies with the `0127:37-51` shape, and adding a `WITH CHECK`
to every corresponding UPDATE policy that pins the attribution column. Add `updated_by_practitioner_id`
+ `updated_at` to `client_pinned_notes` and `treatment_plans` so editing does not require rewriting
authorship (this also closes **A-P2-15** and **I9**).

Migration-first is safe: every shipped writer already sets the column to `practitioner.id`, so all
current traffic satisfies the stricter check — the same argument `0117` made.

---

**PR-A3 — Record the payment executor** *(migration + code · closes **A-P1-06**)*

Add `executed_by_practitioner_id` to `payment_charge_attempts` and `manual_fee_charge_attempts` with the
composite same-studio FK + `ON DELETE RESTRICT` already used by the other three actor columns on those
tables. Set it inside `claim_session_payment_charge_attempt` in the same statement that claims the row,
from the `p_practitioner_id` it already validates. Surface preparer-vs-executor in the payment UI, the
export and the PaymentIntent metadata block.

Touches live money code. Runs the payment CI lane; ship on its own.

---

**PR-A4 — Regulated record-keeping attribution** *(migration + code · closes **A-P2-05**, **A-P2-16**, **A-P2-17**)*

Highest regulatory value after PR-A1. Reject a non-resolving, non-sentinel `operator_practitioner_id`
instead of silently falling through to free text; render *verified operator* and *recorded name*
distinctly in the UI and the printed procedure record; bind the logbook actor columns to `auth.uid()` in
RLS; add a disposal/discard actor to sterile items and disinfectants.

---

**PR-A5 — Historical rendering tells the truth** *(code only · closes **A-P2-12**, **A-P2-13**)*

The cheapest visible win in the audit and the only PR with no migration.
* Add a `getAllPractitionersForStudio` loader **without** `.eq("active", true)` for historical
  rendering; keep the active-only loader for assignment pickers. Route `sessionPerformerName`,
  the client cheat-sheet, the session timeline and the intake/plan bylines through it.
* Stop discarding the error in `attachAuthors` (`lib/clinical-notes/queries.ts:37`).
* Make the three clinical-note renderers agree. `"You"` must never render for a persisted row —
  restrict it to the optimistic just-created row it was written for, or drop it entirely in favour of
  the print view's `"Unknown practitioner"`.

---

**PR-A6 — Client-profile and consent attribution** *(migration + code · closes **A-P1-05**, **A-P1-07**)*

`updated_by_practitioner_id` + `updated_at` on `public.clients`, written by a command; stop erasing
`archived_by` on unarchive; add the owner predicate to the `consent_form_templates` policies and record
`updated_by` / `published_by` / `published_at`.

---

**PR-A7 — Clinical pass authorship** *(migration + code · closes **A-P2-25**, **A-P2-03**)*

Add `created_by_practitioner_id` to `session_blocks`, `electrolysis_entries` and `laser_entries`,
derived in-DB by the existing 0164/0166 Style-A commands (additive — they already resolve the actor).
In the same PR: add `and p.active = true` to `set_session_performer`'s target check and make it write a
`session_audit` row for every performer change.

Sequence after PR-A1.

---

**PR-A8 — Audit-table privilege hygiene and governance attribution** *(migration · closes **A-P2-19**, **A-P2-07**, **A-P2-08**, **A-P2-09**, **A-P2-11**)*

`revoke truncate, references, trigger` from `anon, authenticated` on every audit table in one file
(defence-in-depth; not browser-reachable, hence last). Record an actor for studio-settings changes,
practitioner deactivation and SMS enablement. Make `admin_action_events` fail-closed on write paths.
Guard or remove `client_intake_forms.deleted_at`.

---

**Deferred to the DML owner:** D1–D7 in §8. **Deferred pending Session 1D:** I14 (structured-area
soft-delete) — see §13.2.

---

## 12. Required negative-security tests

### 12.1 Why the existing suite does not catch any of this

Hone has attribution tests. None of them is a **negative** test against the database.

* **No test asserts that any attribution column is immutable.** The lineage suite covers parentage
  only, matching `0160:173-202`.
* **No test asserts `TRUNCATE` denial on any audit table.** The migration suite pins the gap as
  documentation instead of behaviour.
* **Four appointment/copy audit tests assert the actor parameter the test itself supplied**, so
  caller-asserted attribution is structurally unprovable by them (`TD-005`).
* **`set_session_performer` has no test for an inactive target and no test that a performer change is
  audited** — both of which are exactly the defects in **A-P2-03**.
* The multi-studio actor is proven reachable in one test and then never driven through a single write
  command, so the `limit 1` auto-pick (**A-P2-18**) is never exercised (`TD-003`).

Two structural traps, from the repository's own history, that these tests must avoid:

1. **`asRole()` that always rolls back** never exercises the policy under test. Assert the *refusal*,
   not the absence of a row.
2. **Asserting a column exists is not asserting it is enforced.** Every test below asserts an attempted
   write is **rejected**, or that a written value **differs from what the caller asked for**.

Only `npm run test:db` (`vitest.db.config.ts:19-26`, `fileParallelism: false`) proves RLS, trigger and
privilege behaviour. Prerequisite: `supabase db start && npx --yes supabase@2.102.0 db reset --local`
— the pinned CLI is load-bearing (`CLAUDE.md` §3).

### 12.2 The required tests

**Privilege guards** (`npm test` — static, no database), in the style of
`tests/security/clinical-rpc-grant-guard.test.ts`:

| # | Assertion |
|---|---|
| T1 | `has_table_privilege('authenticated','public.practitioners', p) = false` for INSERT/UPDATE/DELETE; same for `anon`; `SELECT` still true |
| T2 | same for `public.appointments` and `public.appointment_audit`, plus TRUNCATE |
| T3 | `TRUNCATE` denied to `anon` and `authenticated` on every audit table (`audit_logs`, `session_audit`, `appointment_audit`, `stripe_payment_audit`, `stripe_events`, `record_keeping_audit_events`) |
| T4 | every new command is `authenticated`-EXECUTE with `anon` **and** `service_role` revoked **by name** — the 0129/0164 lesson |

**Negative security tests** (`npm run test:db` — behavioural). Each maps to a finding:

| # | Finding | `asRole('authenticated')` as… | Attempt | Assert |
|---|---|---|---|---|
| T5 | **A-P1-01** | studio owner | `UPDATE practitioners SET user_id = <other uid>` on a colleague | **rejected** |
| T6 | **A-P1-01** | studio owner | `UPDATE practitioners SET role = 'owner'` / `SET active = false` | **rejected** (must go through the command) |
| T7 | **A-P1-01** | studio owner | `DELETE FROM practitioners` | **rejected** |
| T8 | **A-P1-01** | non-owner member | `UPDATE practitioners SET display_name` on own row via the new command | **succeeds**, and via raw DML **rejected** |
| T9 | **A-P1-01** | — | delete a practitioner who authored a clinical note (after the FK change) | **rejected by `RESTRICT`**, note survives |
| T10 | **A-P1-02** | active member | `INSERT appointments` into **own** studio with `booked_outside_availability = true` | **rejected** |
| T11 | **A-P1-02** | active member | `UPDATE appointments SET practitioner_id` / `DELETE appointments` | **rejected** |
| T12 | **A-P1-03** | active member | `INSERT appointment_audit` naming a colleague as `actor_id` | **rejected** |
| T13 | **A-P1-03** | — | delete an appointment that has audit rows | audit rows **survive** |
| T14 | **A-P1-04** | member A | `INSERT` into each of the seven tables naming member B as author | **rejected**, ×7 (parameterised) |
| T15 | **A-P1-04** | member A | `UPDATE treatment_plans SET created_by_practitioner_id` | **rejected** |
| T16 | **A-P1-06** | — | claim a charge attempt | `executed_by_practitioner_id` is **non-null and equals the claiming practitioner**, and differs from `created_by_practitioner_id` when the preparer differs |
| T17 | **A-P2-03** | active member | `set_session_performer` targeting an **inactive** practitioner | **rejected**; and a successful change writes a `session_audit` row naming the changer and the old value |
| T18 | **A-P2-16** | active member | submit a `record_keeping_disinfectants` row with a non-resolving `operator_practitioner_id` | **error**, not a silent fall-through to free text |
| T19 | **A-P2-17** | member A | `UPDATE record_keeping_*` re-pointing `created_by_practitioner_id` to member B | **rejected** |
| T20 | **A-P2-18** | practitioner active in studios A **and** B, cookie selecting B | `start_session` for a client in B | resolves **B**, deterministically, ×20 iterations |
| T21 | **cross-tenant regression** | member of studio A | for each of the ~49 single-column practitioner FKs, write a row in A naming a practitioner of B | **rejected** (this is the durable form of `N-SEC-001`) |
| T22 | **A-P2-04** | — | after the attribution-immutability trigger lands, `UPDATE` any attribution column on a clinical row | **rejected** |

**Unit / source guards** (`npm test`):

| # | Assertion |
|---|---|
| T23 | `attachAuthors` propagates its error instead of discarding it (**A-P2-13**) |
| T24 | No renderer emits `"You"` for a row loaded from the server — only for the optimistic client-side row |
| T25 | The historical-rendering loader is **not** `getPractitionersForStudio` (which filters `active`) — a source guard, in the style of `tests/app/calendar/internal-booking-command-source.test.ts` |
| T26 | No `.from("practitioners").update(` / `.delete(` remains anywhere outside the new commands |
| T27 | No `.from("appointments").insert(`/`.update(`/`.delete(` outside the admin-client postcare writers enumerated in **A-P1-02** |

**Anti-vacuity requirement.** Every `test:db` case above must first assert the **positive** control
(the legitimate write succeeds) and then the **negative** control (the forged write is rejected). A
suite that only ever asserts rejection passes just as well when the table does not exist.

---

## 13. Coordination with Session 1D and the Appointment DML audit

### 13.1 Reconciliation with the 2026-07-30 findings register

That register was written at `395532489a…` / migration max 0160. We are at `03e7dea` / max 0171. Every
row below was re-verified **from source at this SHA** for this audit; the prior report's own wording was
not trusted.

| Prior ID | Prior claim | Status at `03e7dea` | Evidence |
|---|---|---|---|
| `N-SEC-001` | Session practitioner attribution can be re-pointed, **including to another studio's practitioner** | **PARTIALLY CLOSED** | The browser-reachable half is **closed**: `0169:82` — `revoke insert, update, delete on table public.sessions from authenticated;`. The durable half is **still open**: a grep of all 170 migrations for `references public.practitioners (id, studio_id)` returns 16 hits and **none is on `public.sessions`** — its five practitioner FKs remain single-column (`0001:82`, `0003:12`). `service_role` retains DML. Now carried as **T21** in §12 |
| `F-SEC-002` | Any authenticated member can create, retime, re-status or delete appointments by direct PostgREST DML | **STILL OPEN, unchanged** | No table-level `GRANT`/`REVOKE` naming `public.appointments` exists in any of the 170 migrations; `appointments_member_all` (`0010:272-277`) is still the only policy. `0170:1018-1019` defers the revocation in writing. Re-raised here as **A-P1-02** with the attribution consequences the original did not enumerate |
| `L18` | `authenticated` holds direct row DML on the clinical tables | **CLOSED for `authenticated`; PARTIAL overall** | `0169:82-87` revokes INSERT/UPDATE/DELETE on all six; `SELECT` retained (`0169:48-50`). But `service_role` DML is explicitly unchanged (`0169:51`), and the 25→0 writer migration is independently verifiable (zero direct write call sites remain). ⚠️ Verified by source and ACL reasoning only — **never behaviourally probed in production** |
| `F-CLIN-004` | "Mark reviewed" accepts an unsubmitted intake and any intake in the studio | **CLOSED** | Closed at both layers. Application: `intake/actions.ts:125-139` now carries every predicate the prior report found missing — `.eq("id")`, `.eq("studio_id")`, `.eq("client_id")`, `.is("deleted_at", null)`, `.eq("status","submitted")`, `.not("submitted_at","is",null)`, `.select(…)`. Database: `0162:219-232` + `0162:337-341`. ⚠️ Source-verified only; never behaviourally probed. ⚠️ **Stale comment to fix:** `intake/actions.ts:33-40` still asserts F-CLIN-004 "REMAINS OPEN at the database boundary" and that 0162 is "NOT YET APPLIED"; `docs/production/migration-state.json:9` declares `"hosted_migration_max": "0171"`. This audit found the adjacent hole 0162 left: `deleted_at` is member-`PATCH`-able and unguarded (**A-P2-11**) |
| `F-PAY-001` | Payment amount browser-supplied; **any** practitioner, not just the owner, can prepare and execute | **PARTIALLY CLOSED** | **Amount half closed** (code-only): `payment-actions.ts:177-180` — *"`amount_dollars` is NOT read. The browser no longer decides the amount."* **Role half still open**: `executeSessionPaymentChargeAction` (`:359-410`) contains no `practitioner.role` check; the only role gate in the file is on refund at `:618`, and `:615` records the non-owner execution as an intentional product position. This audit adds the orthogonal finding that the executor is not even *recorded* (**A-P1-06**) |
| `F-DATA-001` | Owner ZIP export omits most tenant-owned data | **STILL OPEN**; this audit adds the attribution dimension | `sessions.csv` ships performer UUIDs against an active-only practitioner extract, so a departed practitioner resolves to nothing (**A-P2-21**) |
| `L19a` | `TRUNCATE` granted to browser roles | **STILL OPEN** | The last `revoke … truncate` in the chain is `0159:495-505`; nothing in 0161–0171. `public.appointments` has no `TRUNCATE` revoke anywhere. Bounded — PostgREST does not expose `TRUNCATE` — hence **A-P2-19**, not a P1 |
| `L20` | `TRIGGER` privilege never revoked from `service_role` | **STILL OPEN — and load-bearing for this audit** | `0159:478-479` and `0159:495-496` revoke `truncate, references, trigger` from `anon` and `authenticated` only. `0160`'s lineage protection and `0162`'s review-integrity guard are **both trigger-based**, so a service-role caller can disable every attribution guard added since 0159. Carried here as **A-P2-26** |
| `F-SEC-001`, `L19b` | session association fields app-validated only | **PARTIALLY CLOSED** | Both association fields are now validated inside the write transaction (`0167:215-217`, `0167:522-524`) and the direct-DML route is revoked by `0169:82`. Same shape as `N-SEC-001`: reachable path closed, durable constraint absent |

**Net effect on the prior register:** 13 attribution-touching rows re-verified at this SHA —
**1 CLOSED** (`F-CLIN-004`), **5 PARTIALLY CLOSED**, **5 STILL OPEN**, **2 SUPERSEDED**. This audit adds
no cross-tenant finding, which is consistent with `N-SEC-001`'s cross-studio half having been the
register's only such claim and its browser-reachable path having been revoked by 0169.

**A pattern worth naming.** `N-SEC-001`, `F-SEC-001` and `L19b` all closed the *same way*: the reachable
path became a validated command, and the durable database constraint was never built. That is
precisely the Style-A/Style-B split of §10.3 seen from the remediation side — and it is why **A-P1-01**
matters so much. When every guarantee lives inside a command rather than in a constraint, the integrity
of `practitioners` (which those commands read to decide who you are) becomes the single point of
failure.

### 13.2 Coordination with Chloe Session 1D (`~/Hone-1D`, PR #517)

Session 1D is code-only from the same base SHA and touches the calendar appointment-prep surface and
the session/charting **read** path. Two intersections:

* **Read-path overlap (PR-A5 / I8).** 1D replaces the calendar page's newest-ROW previous-treatment
  query with the shared newest-CHARTED authority and renders the practitioner narrative. If it renders
  a practitioner name through `getPractitionersForStudio`, it inherits **A-P2-12** — a deactivated
  practitioner's name vanishes from the new surface too. **Recommendation:** 1D should not be blocked,
  but PR-A5 must sweep any name-rendering path 1D introduces. Coordinate before PR-A5 is cut so the
  new loader is applied once, not twice.
* **Structured-area destruction (I14 / A-P2-10).** `update_session_block_with_areas` hard-`DELETE`s
  every `session_block_areas` row on each block save (`0156:160`). Session 1D reads per-area setup and
  outcomes. Making that write a soft-delete carrying `deleted_by` changes what 1D's readers see (rows
  that previously vanished will persist with `deleted_at` set). **I14 must not land before 1D merges**,
  and 1D's readers must filter `deleted_at` when it does.

No file overlap exists today: this audit's only change is a document, and I8/I14 are the first code
work that would touch 1D's surfaces.

### 13.3 Coordination with the Appointment DML boundary audit (`~/Hone-DML-Audit`)

* **§8 is written to be consumed directly** by that audit as an input queue. D1–D7 are stated as
  requirements on the DML series, not as independent work.
* **Migration `0172` is reserved for Appointment DML.** This audit claims no migration number and
  proposes none; §11 explicitly defers numbering to `npm run migration:state` at cut time.
* **One decision is owed back to this audit: D6** — whether the appointment command family converges on
  Style A. §10.3 recommends it. That decision determines the final shape of the D1 revoke, so it should
  be made before the cutover migration is written.
* **Shared root causes.** `A-P1-02` here and `F-SEC-002` there are the same defect; `A-P1-03` is its
  attribution consequence. If the DML audit scores the `appointments` policy independently, the two
  registers should be merged rather than double-counted.
* **Prior-audit note the DML series should carry forward:** the Phase 0 audit recorded that 0135 had
  already fixed policies an earlier pass wrongly flagged. The same discipline applies here — §7.0
  records that 22 of 27 unverified P1 claims in this audit did not survive verification.

---

## 14. Exact next implementation prompt

The next implementation step is **PR-A1**, and nothing else. It is the foundation every other
attribution guarantee rests on, it is the only P1 whose absence makes the *correct* parts of the system
untrustworthy, and it must be application-first or it will repeat the L18 Remove-pass outage.

Copy the block below verbatim as the next prompt.

---

```
# Hone PR-A1 — Close the public.practitioners write boundary (A-P1-01)

Implement the FIRST attribution-hardening PR from
docs/audits/PRACTITIONER_ATTRIBUTION_INTEGRITY_2026-08.md.

## Exact repository state

Repository: SaiSamyukthVemuri/Hone
Base: production HEAD at the time you start — re-derive it, do NOT assume 03e7dea.
Required branch:   fix/practitioner-write-boundary
Required worktree: ~/Hone-Actor-PR1

Runs in parallel with the Appointment DML series and Chloe Session 1D.
Migration 0172 is RESERVED for Appointment DML. Take your migration number from
`npm run migration:state` — never hard-code it, and never assume it is 0173.

## The defect

supabase/migrations/0001_init.sql:244-247 and :249-251 are still the only write
policies on public.practitioners, and no migration anywhere issues a table-level
GRANT or REVOKE on that table. `authenticated` therefore holds full DML. The
WITH CHECK is is_studio_owner(studio_id), a function of studio_id and the
CALLER's auth.uid() only — it pins the tenant and pins NO column.

A studio owner can therefore, with one PostgREST request:
  * rewrite a colleague's user_id, so that every auth.uid()-derived actor
    resolution (0167:78-99, 0168:79-88, 0127:37-51, 0162:219-232) resolves the
    owner AS that colleague — forging a clinical author with the database's own
    guarantee vouching for it;
  * set role='owner' or active=false, bypassing set_practitioner_active_locked
    (0150:283-319) and its owner/self guards, with no audit row;
  * DELETE a practitioner row, which CASCADE-deletes their append-only
    client_clinical_notes (0126:57-59) and SET NULLs ~40 other actor columns.

Proof the grant is live: app/(app)/settings/profile/actions.ts:29-33 updates
public.practitioners through the authenticated cookie client.

Confirm all of the above yourself before writing code. Stop if any of it is
false at your base SHA.

## Required sequence — APPLICATION-FIRST. Do not compress it.

This is the L18 lesson (see the 0169 header): a revoke that lands before its
replacement is deployed breaks live traffic.

### Step 1 — additive migration + code, deployed together
Add an `authenticated`-EXECUTE, Style-A SECURITY DEFINER command:

    update_own_practitioner_profile(p_display_name text, p_color text,
                                    p_calendar_feed_token_hash text)

  * resolves the target row from auth.uid() — accepts NO practitioner id;
  * raises if auth.uid() is null (the 0167:89-92 shape);
  * writes ONLY display_name / color / calendar_feed_token_hash, only on the
    caller's own row, only in the caller's active studio;
  * `set search_path = ''`;
  * REVOKE EXECUTE from public, anon AND service_role BY NAME, then GRANT to
    authenticated. All three, explicitly — the 0129/0164 lesson, pinned by
    tests/security/clinical-rpc-grant-guard.test.ts.

Add an owner-gated pair for governance changes, each writing an
admin_action_events row via lib/audit/admin-actions.ts:

    set_practitioner_role_locked(p_studio_id, p_actor_practitioner_id,
                                 p_target_practitioner_id, p_role)
    set_practitioner_user_id_locked(...)

Model them on set_practitioner_active_locked (0150:283-319), including
lock_studio_and_assert_owner and the cannot_modify_owner / self guards.

Migrate these four call sites onto the new command:
  app/(app)/settings/profile/actions.ts:29-33  (updateOwnProfileAction)
  app/(app)/settings/profile/actions.ts:56     (updatePractitionerColorAction)
  app/(app)/settings/profile/actions.ts:135    (calendar feed token)
  the calendar-feed clear action in the same file

NOTE: this also fixes F-ADM-003. Those four writes currently match ZERO rows for
a non-owner — the only UPDATE policy is owner-only — and report success anyway.
Add a test proving a NON-OWNER can now actually change their own display name.

DEPLOY AND VERIFY BEFORE STEP 2.

### Step 2 — the revoke (separate migration, separate PR if you prefer)
  revoke insert, update, delete on table public.practitioners
    from anon, authenticated;   -- SELECT deliberately retained
  drop the three write policies; keep "practitioners: members read".
  alter client_clinical_notes_practitioner_same_studio to ON DELETE RESTRICT.

Do NOT use REVOKE ALL — it would take SELECT with it (the 0169 rationale).
Open your own begin;/commit; and set local lock_timeout INSIDE the file —
`supabase db push` does not wrap a migration in a transaction (the 0159 lesson).

## Tests — all must be NEGATIVE and non-vacuous

npm test (static privilege guards):
  * has_table_privilege('authenticated','public.practitioners', X) = false for
    INSERT/UPDATE/DELETE; same for anon; SELECT still true.
  * the new commands are authenticated-EXECUTE with anon AND service_role
    revoked by name.
  * source guard: no `.from("practitioners").update(` or `.delete(` remains
    outside the new commands.

npm run test:db (behavioural — the ONLY lane that proves policy behaviour;
prereq `supabase db start && npx --yes supabase@2.102.0 db reset --local`):
  T5  owner: UPDATE practitioners SET user_id on a colleague  -> REJECTED
  T6  owner: SET role='owner' / SET active=false via raw DML  -> REJECTED
  T7  owner: DELETE FROM practitioners                        -> REJECTED
  T8  non-owner: display_name via the new command -> SUCCEEDS;
      the same write via raw DML                  -> REJECTED
  T9  delete a practitioner who authored a clinical note -> REJECTED by
      RESTRICT, and the note still exists afterwards

Every case must assert the POSITIVE control first (the legitimate write
succeeds) and then the negative. A suite that only asserts rejection passes
just as well when the table does not exist. Beware the asRole() helper that
always rolls back — assert the refusal, not the absence of a row.

## Constraints

* Do not create migration 0172.
* Do not touch public.appointments or public.appointment_audit — those belong
  to the Appointment DML series (§8 D1-D7).
* Do not modify generated types beyond what the new columns require.
* No production write, no migration apply, no merge, no deploy without explicit
  per-change authorization.
* Commits must be authored SaiSamyukthVemuri <samyukth.ssv@gmail.com>.
* Before pushing run, in order: git add -A; git diff --cached --check;
  git status --porcelain; commit; git status --porcelain (empty);
  git diff HEAD --exit-code; npm run verify:prepush.
* Open a DRAFT PR. Do not mark ready.

## Deliverable

Step 1 as one PR (migration + code + tests), Step 2 as a second PR that must not
merge until Step 1 is deployed and verified. State explicitly in the Step 2 PR
body which deployed SHA satisfies the application-first precondition.
```

---

*End of audit.*
