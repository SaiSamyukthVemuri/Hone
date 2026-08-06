# Appointment DML Boundary — Complete Writer and Authorization Audit

**Repository** `SaiSamyukthVemuri/Hone` · **Branch** `audit/appointment-dml-boundary` · **Pinned at** `03e7deaa38a7646a1f19a3d883c0a2b07894cec0`
**Date** 2026-08-06 · **Scope** documentation-only, static · **Applied production migration max** 0171 (0158 permanently skipped)

---

## 1. Executive verdict

**The appointment command layer is built. The appointment boundary is not.**

Hone has fifteen reviewed `SECURITY DEFINER` appointment commands, every one of them revoked from `public`, `anon` and `authenticated` and granted only to `service_role`. Every lifecycle workflow the product actually exposes — internal creation, public booking, client-token reschedule, internal move/reassign, client cancellation, practitioner cancellation, completion, no-show — routes through one of them. **Zero appointment writes in shipped application code use the authenticated, RLS-bound Supabase client.** The seven direct `PostgREST` statements that remain touch only `postcare_email_*` bookkeeping columns and all run as `service_role` under a server-resolved `studio_id`.

None of that is enforced.

`public.appointments` is the only significant table in this schema that has never received a single `GRANT` or `REVOKE` in 170 migrations. Under Supabase's default privileges, `authenticated` therefore still holds `INSERT`, `UPDATE` and `DELETE` on it, and the only RLS policy — `appointments_member_all`, `supabase/migrations/0010_booking_v1.sql:273-277` — is a `FOR ALL` policy whose `USING` and `WITH CHECK` are both nothing more than `public.is_studio_member(studio_id)`. `is_studio_member` (`0001_init.sql:153-166`) is true for **any active practitioner of the studio, of any role**. The result is that every guarantee this audit documents about the command layer is a property of the code path, not of the database: a signed-in practitioner holding the credentials their own browser already carries can reach past all fifteen commands with one `PATCH`.

This is not an inference from platform documentation. The repository asserts it directly. Two DB tests — `tests/db/public-appointment-command.db.test.ts:475-489` ("THIS PR does not revoke any appointment table grant") and `tests/db/public-reschedule-command.db.test.ts:1430-1443` ("revokes NOTHING from the appointments table") — run `has_table_privilege` against `public.appointments` and assert `INSERT`, `UPDATE` and `DELETE` are **true** for both `anon` and `authenticated`. The open posture is deliberate, documented (`0170:1018`, `0171:1507`), and pinned by passing tests.

### What is at risk, and what is not

The exposure is narrower than the raw finding count suggests, and stating the bounds precisely is what makes the remediation cheap:

- **There is no P0.** `anon` holds the grant but fails RLS — `is_studio_member` is false without `auth.uid()`. There is no unauthenticated appointment mutation path.
- **There is no write path into a studio the actor does not already belong to.** `WITH CHECK` pins `studio_id`, and `0151_appointment_tenant_consistency.sql:83-99` replaced the single-column foreign keys with composite same-studio keys on `(client_id, studio_id)`, `(service_id, studio_id)` and `(practitioner_id, studio_id)`. A forged row cannot bind another studio's client, service or practitioner. (The one caveat: a practitioner active in *two* studios can migrate an appointment between them by moving all four columns in one statement — an ungoverned tenant move, not an access escalation.)
- **Actual double-booking is not achievable.** `studio_calendar_reservations` carries an *unconditional* GiST exclusion (`0134:238-243`) fed by the `AFTER` trigger `appointments_sync_calendar_reservation_trg`. Triggers and constraints fire for direct DML exactly as they do for a command, and the shadow's `resource_key` derives from the live studio flag rather than the row's own `capacity_enabled`, so it cannot be side-stepped by forging that column. Overlap protection is genuinely path-independent.
- **Existing audit rows cannot be edited or deleted.** `appointment_audit` has exactly two policies — `SELECT` and `INSERT` (`0010:280-299`) — so RLS default-denies `UPDATE` and `DELETE`.

What *is* at risk is everything the commands exist to control that the schema does not: **status legality, actor attribution, the audit trail's existence, the owner-only gates, working-hours and buffer discipline, and the durability of the record itself.** A member can move an appointment to 03:00 on a closed Sunday, flip a future appointment to `completed` (which is the gate `lib/billing/session-payment-eligibility.ts:142-144` reads before a live card charge), resurrect a cancelled appointment while leaving its cancellation metadata in place, write no audit row for any of it, forge an `appointment_audit` row attributed to a colleague with a caller-chosen `created_at`, or `DELETE` the appointment outright and cascade away its entire audit history (`0010:219`) and its signed policy-acknowledgement evidence (`0056:34`).

### The verdict

**Three P1 findings, all sharing one remediation; fourteen P2; twenty-two P3. No P0.** (106 raw findings were raised by the census; the adversarial verification pass and hand spot-checks refuted or merged the rest.)

The headline P1 has been known since the 2026-07-30 register (`HN-007` / `F-SEC-002`) and is **reconfirmed unchanged at this HEAD**. What this audit adds is the proof that it is now cheap to close: because no shipped writer uses the authenticated client for appointment DML, `revoke insert, update, delete on public.appointments from authenticated` is a **zero-application-change migration**. The blocking prerequisites are not new commands — they are four small gaps (an administrative-repair path, an audit-write guarantee, the two grant-pinning tests that must be inverted, and a decision on `appointment_audit`'s own INSERT grant).

`SELECT` must be retained. Authenticated-client reads of `appointments` are load-bearing across the calendar, client detail, dashboard, portal and search surfaces; revoking it would break the product.

> **Amended by §16.** After this audit was written, the practitioner-attribution audit (draft PR #520)
> was ingested and reconciled. Two changes follow, and §§10–14 should be read with them in view:
> (a) the program is re-phased **application-first** — the additive attribution columns now precede the
> revocation and `0172` moves to them (§16.6); and (b) `0172` closes the appointment **boundary** but does
> **not** by itself establish trustworthy appointment **attribution**, because the actor every command
> records is resolved through `public.practitioners`, a table PR #520 proves any studio owner can rewrite
> (§16.3). PR #520's `PR-A1` is a **co-requisite** of the revocation, not a blocker.

The recommended sequence is still **nine PRs, but not the nine the brief proposed**. Six of the brief's nine — internal creation, public booking, reschedule, move/reassign, cancellation, complete and no-show — have nothing to build, because the commands already exist and are already `service_role`-only; they collapse into a single *verify-and-pin* PR. The revocation moves from eighth to third. The writer census moves from last to first, because a census that ships last never froze the writers while the migration was being written. The count returns to nine only because this audit found work the brief did not know about: audit-table integrity, a status-transition guard, and the `/cancel` acknowledgement atomicity fix. Migrations `0172`–`0177`; **`0172` is reserved here and deliberately not created**.

---

## 2. Source establishment

### 2.1 Exact state

| Item | Value |
|---|---|
| Repository | `SaiSamyukthVemuri/Hone` (`https://github.com/SaiSamyukthVemuri/Hone.git`) |
| Production branch | `claude/build-hone-saas-hOex7` |
| Audit branch | `audit/appointment-dml-boundary` |
| Audit worktree | `~/Hone-DML-Audit` (isolated; created for this audit) |
| Pinned SHA | `03e7deaa38a7646a1f19a3d883c0a2b07894cec0` |
| Commit | `Merge pull request #516 from SaiSamyukthVemuri/fix/charting-copy-search-accuracy`, SaiSamyukthVemuri, Thu Aug 6 09:17:00 2026 -0400 |
| Relationship to production | The pinned SHA **is** `origin/claude/build-hone-saas-hOex7` at audit time — the audit reads production HEAD exactly, not an ancestor |
| Worktree state | Clean (`git status --short --branch` reported no modifications) |
| Pre-existing remote branch | None (`git ls-remote --heads origin audit/appointment-dml-boundary` empty) |
| Open PRs owning this audit | None (`gh pr list --state open` returned `[]`) |
| Migration count | 170 files, `0001`..`0171` |
| Applied production max | `0171` |
| Permanently skipped | `0158` — never applied, must never be applied; treated throughout as non-existent |
| Next free migration | `0172` — **reserved for the first boundary migration and deliberately not created by this audit** |

No material mismatch was found; the audit proceeded.

### 2.2 Method and its limits

This is a **static, read-only, documentation-only** audit. Nothing was executed against any database, no test lane was run, no browser was driven, and hosted production was never contacted. `supabase/migrations/*.sql` and repository source at the pinned SHA are the sole authority for database state.

Every database object in this document is presented at its **effective current definition**, resolved by walking the 170 migrations in numeric order and taking the last redefinition. This matters more here than in most codebases: `reschedule_appointment` is defined four times (0029 → 0066 → 0090 → 0091), `move_or_reassign_appointment` five times (0143 → 0144 → 0145 → 0148 → 0152), and `sync_appointment_to_calendar_reservation` five times (0030 → 0032 → 0134 → 0136 → 0152). Where this document quotes a definition it names the migration that establishes it.

The evidence base was produced by fourteen parallel census agents, each adversarially re-verified by an independent agent instructed to refute its findings, followed by hand spot-checks of every load-bearing claim. That process raised **106 findings**, of which the verification pass refuted or downgraded a substantial fraction; the register in §10 is the deduplicated survivor set.

Four claims that reached the register in a first pass were **removed after hand verification** and are recorded here so they are not re-raised:

| Rejected claim | Why it is wrong |
|---|---|
| `public.finalize_card_required_public_booking` is an installed, service-role-executable appointment creator with no caller | It was **dropped** at `0091_drop_raw_cancellation_token.sql:174` |
| `public.create_or_claim_charge_attempt` still exists | It was **dropped** at `0103_mode_scoped_stripe_connect_provisioning.sql:590` |
| A studio member can UPDATE or DELETE existing `appointment_audit` rows | `appointment_audit` has exactly two policies — `SELECT` (`0010:280`) and `INSERT` (`0010:291`). RLS default-denies `UPDATE` and `DELETE`. Audit rows are erasable only through the appointment's own `ON DELETE CASCADE` |
| Direct DML can produce an overlapping confirmed appointment | `studio_calendar_reservations` carries an unconditional GiST exclusion (`0134:238-243`) written by an `AFTER` trigger that fires for direct DML too, and whose `resource_key` derives from the live studio flag rather than the row's own `capacity_enabled` |

### 2.3 What this audit cannot prove

The following are stated as **UNPROVEN (static audit)** wherever they appear, and each is convertible to proof by a specific read-only production query listed in §13:

1. **The live ACL on `public.appointments` and `public.appointment_audit`** was not measured by this audit. Three independent lines of evidence converge on the same answer, and the third is a production record: (a) no migration grants or revokes anything on either table, so Supabase default privileges apply; (b) two repository DB tests assert `has_table_privilege(...) = true` for `anon` and `authenticated` on a freshly-migrated chain (`tests/db/public-appointment-command.db.test.ts:475-489`, `tests/db/public-reschedule-command.db.test.ts:1430-1443`); (c) the canonical current-state record for hosted production, written after the 0171 apply and its read-only post-apply probes, states in terms: *"no table grant revoked … appointments INSERT/UPDATE/DELETE remain granted to anon and authenticated"* (`docs/production/migration-state.json`, `hosted_note`). The remaining gap is only that no one has run `has_table_privilege` against production *for this audit*. The probe is in §13.
   The same record supplies the production scale this audit reasons about: **139 appointments** (63 confirmed, 29 cancelled), 220 `appointment_audit` rows, 12 policy acknowledgements, 117 reservations, 46 clients, 5 studios, as of 2026-08-05.
2. **The deployed body of `public.snapshot_appointment_buffer`.** Three repository tests assert it carries an out-of-band GUC bypass (`app.bypass_appointment_buffer_snapshot`) that appears in no migration. See P2-8.
3. **Per-studio flag values** — `practitioner_capacity_enabled`, `practitioner_capacity_booking_enabled`, `google_calendar_outbound_sync_enabled`. Migration comments assert every studio is capacity-OFF (`0134:11-13`, `0136:29`, `0170:47-53`); that is documentation, not a measurement. Several P2s are dormant *only* on that premise.
4. **Whether any production row was ever mutated by direct DML.** Every P1 here is a *capability* finding: the path is proven reachable with credentials the browser already holds. Exploitation is not claimed and was not sought.
5. **Whether `reschedule_appointment_v2` (0171) has been exercised by a real reschedule.** The repository's own apply record says it had not been, as of 2026-08-05.

### 2.4 Parallel-work constraints honoured

`~/Hone-1D` (Chloe Session 1D, draft PR #517) was never opened or modified. Its owned files were read only in their production versions inside `~/Hone-DML-Audit`. No `supabase db reset`, DB integration suite, Playwright run, browser matrix, fake-Stripe or fake-Google lane, or process-killing command was executed. The only repository change proposed by this audit is the addition of `docs/audits/APPOINTMENT_DML_BOUNDARY_2026-08.md`.

---

## 3. Complete writer census

Every path that mutates `public.appointments` at prod SHA `03e7deaa38a7646a1f19a3d883c0a2b07894cec0`, migrations `0001..0171` (0158 permanently skipped). Effective SQL definitions were resolved by walking migrations in numeric order and taking the last redefinition; grants were resolved the same way, including `execute format('revoke …')` DO-block loops (`supabase/migrations/0134_practitioner_capacity_foundation.sql:750-774`), which a literal grep misses.

**Totals.** 9 reviewed SECURITY DEFINER commands reached from 10 shipped call sites · 7 direct PostgREST DML statements in 2 files · 6 peripheral metadata writers · 1 trigger-mediated writer plus 4 BEFORE-row `NEW`-mutators · 3 caller-less installed functions · test-only and migration-time DML enumerated for completeness. **Zero appointment writes use the authenticated (RLS-bound) Supabase client** — every runtime writer is `service_role` via `createAdminClient()` (`lib/supabase/admin-server.ts:15-27`) or a `service_role`-only SECURITY DEFINER command.

### 3.1 Master table — (a) reviewed SECURITY DEFINER commands

All are `security definer`, all revoked from `public`/`anon`/`authenticated` and granted only to `service_role`, and all are invoked through the service-role admin client. None is browser-callable.

| ID | Call site path:line | Command (effective def) | Op | Workflow | Caller surface | Required role | Audit? | Atomic? | Class |
|---|---|---|---|---|---|---|---|---|---|
| C-01 | `app/(app)/calendar/actions.ts:311-325` | `create_internal_appointment_v2` (`0152_actual_overlap_hard_buffer_soft.sql:376`) | INSERT `:505` | internal booking | authenticated server action | active member; **owner** for duration override / outside-hours (`0152:437-440`) | yes `0152:515` | yes | legitimate |
| C-02 | `app/book/[slug]/actions.ts:775-786` | `create_public_appointment` (`0170_public_appointment_command.sql:636`) | INSERT `:892` | public booking | **unauthenticated** server action | n/a (visitor) | yes `0170:906` | yes | legitimate |
| C-03 | `app/reschedule/[token]/actions.ts:773-783` | `reschedule_appointment_v2` (`0171_public_reschedule_command_v2.sql:797`) | UPDATE `:1301` + INSERT `:1324` + UPDATE `:1349` | public reschedule | **token-bearer** server action | n/a (token) | yes ×2 `0171:1363`,`:1373` | yes | legitimate |
| C-04 | `app/(app)/calendar/move-appointment-actions.ts:352-370` | `move_or_reassign_appointment` (`0152:537`, 8-arg) | UPDATE `:686` | move / reassign | authenticated server action | active member for time-only; **owner** for reassign + `custom_time` (`0152:627-634`) | yes `0152:694` | yes | legitimate |
| C-05 | `app/(app)/calendar/actions.ts:431-439` | `practitioner_cancel_appointment` (`0033_pre_stripe_operational_hardening.sql:241`) | UPDATE `:291` | practitioner cancel | authenticated server action | active member (role read live, `0033:256`) | yes `0033:299` | yes | legitimate |
| C-06 | `app/cancel/[token]/actions.ts:252-261` | `public_cancel_appointment_with_token` (`0091_drop_raw_cancellation_token.sql:75`) | UPDATE `:122` | public cancel | **token-bearer** server action | n/a (token) | yes `0091:130` | yes | legitimate |
| C-07 | `app/(app)/calendar/actions.ts:550-554` | `mark_appointment_complete` (`0032_stripe_connect_phase_1.sql:4052`) | UPDATE `:4086` | mark complete (calendar) | authenticated server action | active member (`0032:4064-4069`) | yes `0032:4090` | yes | legitimate |
| C-08 | `app/(app)/clients/[id]/sessions/new/actions.ts:49-53` | `mark_appointment_complete` (same fn) | UPDATE `:4086` | auto-complete on session start | authenticated server action (fail-soft helper) | active member | yes | yes | legitimate |
| C-09 | `app/(app)/calendar/actions.ts:607-614` | `mark_appointment_no_show` (`0033:334`) | UPDATE `:373` | mark no-show | authenticated server action | active member (`0033:344-352`) | yes `0033:378` | yes | legitimate |

Grant anchors: `0152:733-737` (C-01, C-04) · `0170:955-964` (C-02) · `0171:1451-1458` (C-03) · `0033:314-316` (C-05) · `0091:147-158` (C-06) · `0032:4099-4101` re-asserted `0033:402-404` (C-07/C-08) · `0033:392-394` (C-09). C-02 and C-03 additionally revoke from `service_role` before re-granting, because Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to all three browser-visible roles at create time (`0170:928`).

### 3.2 Master table — (b) direct PostgREST DML in shipped app code

The only `.from("appointments").<insert|update|delete|upsert>` chains in the repository. All are `update`, all through `createAdminClient()`, all scoped `.eq("id").eq("studio_id")`, and all confined to the six `postcare_email_*` bookkeeping columns (`0043:43-44`, `0100:24-27`). None touches `status`, `starts_at`, `ends_at`, `duration_minutes`, `practitioner_id`, `client_id`, `service_id`, `studio_id` or `cancellation_token_hash`.

| ID | Path:line (statement start) | Name | Op | Workflow | Caller surface | Required role | Audit? | Atomic? | Class |
|---|---|---|---|---|---|---|---|---|---|
| D-01 | `app/(app)/calendar/actions.ts:1114` | `sendPostcareEmailAction` — first-send claim | update | manual postcare send | authenticated server action (`:1014`) | active member, **no owner gate** (`:1030`) | no | single conditional UPDATE | legitimate |
| D-02 | `app/(app)/calendar/actions.ts:1155` | `sendPostcareEmailAction` — resend claim | update | manual postcare resend | same | same | no | **unconditional** UPDATE | legitimate (see 3.6) |
| D-03 | `app/(app)/calendar/actions.ts:1211` | `sendPostcareEmailAction` — failure record | update | manual postcare send | same | same | no | single UPDATE | legitimate |
| D-04 | `app/(app)/calendar/actions.ts:1242` | `sendPostcareEmailAction` — success stamp | update | manual postcare send | same | same | no | single UPDATE | legitimate |
| D-05 | `app/(app)/calendar/postcare-auto-send.ts:151` | `autoSendPostcareOnComplete` — claim | update | auto postcare after completion | internal helper of C-07 (`actions.ts:581`) and C-08 (`sessions/new/actions.ts:68`) | inherited from caller | no | single conditional UPDATE | legitimate |
| D-06 | `app/(app)/calendar/postcare-auto-send.ts:186` | `autoSendPostcareOnComplete` — failure | update | same | same | inherited | no | single UPDATE | legitimate |
| D-07 | `app/(app)/calendar/postcare-auto-send.ts:200` | `autoSendPostcareOnComplete` — success | update | same | same | inherited | no | single UPDATE | legitimate |

Line-number disambiguation (the three evidence files disagree because each cites a different line of the same chain): the `await admin` statement head is at `actions.ts:1114/1155/1211/1242` and `postcare-auto-send.ts:151/186/200`; `.from("appointments")` is one line later (`:1115/1156/1212/1243`, `:152/187/201`); `.update({` one line after that. All three refer to the same seven statements.

**Status precondition asymmetry.** D-05 carries `.eq("status", "completed")` (`app/(app)/calendar/postcare-auto-send.ts:160`); D-01 and D-02 carry no status predicate at all (`app/(app)/calendar/actions.ts:1121-1127`, `:1162-1163`). Two code paths implementing one product rule disagree about it.

### 3.3 Master table — (c) peripheral metadata writers

`service_role`-only SECURITY DEFINER functions whose names contain no appointment verb but which each execute `update public.appointments`. None writes `appointment_audit`. None carries a studio predicate of its own — every one filters on `p_appointment_id` alone, so tenancy safety is a property of the callers, not of the function.

| ID | Call site path:line | Function (effective def) | Columns written | Workflow | Caller surface | Audit? | Atomic? | Class |
|---|---|---|---|---|---|---|---|---|
| M-01 | `lib/email/send-appointment.ts:175-179` | `record_email_attempt` (`0033:63`, UPDATE `:74,82,90,98`; grants `:111-113`) | `confirmation_*`, `reminder_24h_*`, `reminder_2h_*`, `no_show_email_*` | confirmation/reminder bookkeeping | called from `app/(app)/calendar/actions.ts:911`, `app/book/[slug]/actions.ts:1092`, `app/reschedule/[token]/actions.ts:1074` | no | single UPDATE branch | legitimate |
| M-02 | `lib/email/send-appointment.ts:218-221` | `claim_email_send` (`0098_intake_reminder_columns.sql:45`; grants `:161-164`) | `*_send_attempts`, `*_claimed_at` | reminder cron claim-before-send | `app/api/cron/appointment-reminders/route.ts:195,367` | no | atomic claim | legitimate |
| M-03 | `lib/email/send-appointment.ts:247-251` | `record_email_result` (`0098:118`; grants `:161-164`) | `*_sent_at`, `*_claimed_at` | reminder cron result | `app/api/cron/appointment-reminders/route.ts:233,284,400` | no | single UPDATE | legitimate |
| M-04 | `lib/sms/send-appointment.ts:61-64` | `claim_sms_send` (`0049_sms_foundation.sql:170`, UPDATE `:184,194,204`; effective grants `0062_harden_sms_rpc_grants.sql:48-69`) | `sms_*_send_attempts`, `sms_*_claimed_at` | SMS claim-before-send | `sendOne()` `lib/sms/send-appointment.ts:372` | no | atomic claim | legitimate |
| M-05 | `lib/sms/send-appointment.ts:86-90` | `record_sms_result` (`0049:230`, UPDATE `:241,246,251`; grants `0062:50-69`) | `sms_*_sent_at`, `sms_*_claimed_at` | SMS result | `sendOne()` `finally` `lib/sms/send-appointment.ts:428` | no | single UPDATE | legitimate |
| M-06 | `lib/google-calendar/sync/reconcile-store.ts:215-219` | `repair_bump_appointment_sync_version` (`0125_google_calendar_outbound_enqueue_activation_boundary.sql:384`, UPDATE `:388`; grants `:392-393`) | `sync_version` | Google outbound reconcile repair | cron `/api/cron/calendar-reconcile` (registered `0 9 * * *` in `vercel.json`), via `lib/google-calendar/sync/reconcile.ts:537` | no | single UPDATE, no row lock | **dormant** |

M-01..M-05 live in modules that receive an already-privileged client as a parameter (`lib/email/send-appointment.ts`, `lib/sms/send-appointment.ts` never call `createAdminClient()`), so they sit structurally outside `tests/security/service-role-allowlist.ts`, which detects call sites of `createAdminClient()` only (`tests/security/service-role-allowlist.test.ts:25-38`). M-06's dormancy rests on the per-studio `google_calendar_outbound_sync_enabled` flag plus an owner `write_calendar_id` (`lib/google-calendar/sync/reconcile-store.ts:62-79`, re-checked at `reconcile.ts:529-533`) — flag values are UNPROVEN (static audit).

### 3.4 Master table — (d) trigger-mediated writers

| ID | Object | Fires on | Effective def | What it mutates | Audit? | Class |
|---|---|---|---|---|---|---|
| T-01 | `appointments_enforce_buffer_trg` → `enforce_appointment_buffer()` | BEFORE INSERT OR UPDATE OF `starts_at, ends_at, status, practitioner_id, booked_outside_availability, capacity_enabled` | trigger `0152:240-246`, fn `0152:217-238` | nothing; raises `HB001` | n/a | legitimate |
| T-02 | `appointments_set_capacity_enabled_trg` → `set_appointment_capacity_enabled()` | BEFORE INSERT OR UPDATE OF `studio_id, practitioner_id, status` | trigger `0134:124-128`, fn `0134:106-122` | `NEW.capacity_enabled` | n/a | legitimate (column list omits `capacity_enabled` itself) |
| T-03 | `appointments_snapshot_buffer_trg` → `snapshot_appointment_buffer()` | BEFORE INSERT OR UPDATE, **no column list** (deliberate, `0029:102-106`) | trigger `0029:107-110`, fn `0029:62-95` | `NEW.buffer_minutes_snapshot`, `NEW.blocked_ends_at` | n/a | legitimate; production body is asserted to have drifted (`tests/migrations/0171-public-reschedule-command.test.ts:177-181`) — UNPROVEN (static audit) |
| T-04 | `appointments_sync_version_bump_trg` → `bump_appointment_sync_version()` | BEFORE INSERT OR UPDATE, no column list | trigger `0125:82-85`, fn `0125:60-76` | `NEW.sync_version` | n/a | legitimate |
| T-05 | `studios_capacity_flag_change_trg` → `on_studio_capacity_flag_change()` → `rematerialize_studio_reservations(uuid)` | AFTER UPDATE OF `studios.practitioner_capacity_enabled` | trigger `0134:556-574`; target fn `0137_scoped_blocks_and_breaks.sql:247`, UPDATE `:266-268` | `appointments.capacity_enabled` for **every row in the studio** | **no** | legitimate but armed (see below) |
| T-06 | `practitioners_capacity_refan_trg` → `on_practitioner_change_refan()` → same | AFTER INSERT OR DELETE OR UPDATE OF `practitioners.studio_id` | trigger `0134:582-613` | same | **no** | strict no-op while capacity is OFF (`0134:585-607` guards on `studio_capacity_enabled()`) |

T-05/T-06 are the **only** indirect trigger path that writes `appointments`. No `returns trigger` function anywhere in the tree performs INSERT/UPDATE/DELETE against `public.appointments` other than through this two-hop route. `sync_appointment_to_calendar_reservation()` (effective `0152:108-150`, trigger `0134:478-483`) and `enqueue_calendar_outbound()` (`0132:249`, trigger `0125:322-325`) read the appointment row and write `studio_calendar_reservations` / the outbound queue — they are not appointment writers. **No trigger writes `appointment_audit`**; every audit row in the system is written explicitly by a command (`insert into public.appointment_audit` appears only inside function bodies — `0032:4090`, `0033:201,299,378`, `0091:130,279,293`, `0152:515,694`, `0170:906`, `0171:1363,1373`).

### 3.5 Master table — (e) caller-less / obsolete installed functions

Installed, `service_role`-EXECUTE-able, and reachable from no shipped code path. Each is a live capability of any compromised server process, an older Vercel deployment holding the same `SUPABASE_SERVICE_ROLE_KEY`, or a manual DB session.

| ID | Function (effective def) | Op | Superseded by | Grants | App caller | Class |
|---|---|---|---|---|---|---|
| L-01 | `reschedule_appointment(uuid,text,timestamptz,timestamptz,integer,text)` (`0091:186`; chain `0029:264 → 0066:55 → 0090:244 → 0091:186`) | UPDATE `0091:245` + INSERT `:253` | `reschedule_appointment_v2` (C-03) | `service_role` `0091:311-320` — never revoked, never dropped | **none** (`rg 'reschedule_appointment' app/ lib/` returns only `_v2`) | **obsolete-but-present, strictly weaker** |
| L-02 | `create_internal_appointment(9 args)` (`0147_internal_booking_legacy_wrapper.sql:31`) | INSERT via C-01 | `create_internal_appointment_v2` | `service_role` `0147:81-84` | none | obsolete wrapper, safe pure delegation (`0147:70-77`) |
| L-03 | `practitioner_move_appointment(6 args)` (`0145_move_preserve_target_race_fix.sql:200`) | UPDATE via C-04 | `move_or_reassign_appointment` | `service_role` `0145:235-238` | none (`app/(app)/calendar/move-appointment-actions.ts:346-351` documents the retirement) | obsolete wrapper; binds to the 8-arg signature through its default since `0148:31` dropped the 7-arg form |
| L-04 | `rematerialize_studio_reservations(uuid)` (`0137:247`) | UPDATE `0137:266` | — | revoked from `public`/`anon`/`authenticated` by the DO-block loop `0134:750-774`; **no explicit grant to anyone** | none from app; invoked only by T-05/T-06 and `retire_practitioner_capacity` | dormant, armed |

L-01 is the material one: it accepts `p_new_ends_at` **and** `p_new_duration_minutes` with no cross-check (`0091:262,271`), validates only `p_new_starts_at > now()` (`:225`) and `p_new_ends_at > p_new_starts_at` (`:231`), takes no studio lock and no `acquire_studio_capacity_lock`, never sets `cancellation_kind` or the `rescheduled_from/to` lineage, and silently drops `referral_source` from the successor (`:253-274`). Its retention is explicitly intentional (`0171:61-67`) and is asserted by a repo test (`tests/db/public-reschedule-command.db.test.ts:1419-1428`).

**Dropped — must not be reported as installed:** `finalize_card_required_public_booking` (created `0032:3092`, **dropped `0091:174`**) · `public_cancel_appointment_with_token(text,text)` 2-arg (**dropped `0091:166`**) · `move_or_reassign_appointment(7 args)` (**dropped `0148:31`**) · `appointments_hash_cancellation_token()` + its trigger (**dropped `0091:329-331`**) · `create_or_claim_charge_attempt` (**dropped `0103_mode_scoped_stripe_connect_provisioning.sql:590`**).

### 3.6 Master table — (f) test-only writers and (g) migration-time one-off DML

| ID | Path:line | Op | Client / context | Class |
|---|---|---|---|---|
| X-01 | `e2e/helpers/seed.ts:504` (`seedConfirmedAppointment`, declared `:496`) | raw `insert into public.appointments` | direct `pg` client to `E2E_DB_URL`, documented hardcoded localhost (`:11-13`) | test-only |
| X-02 | `e2e/helpers/seed.ts:1832` | raw `update … set status = $2` | same | test-only |
| X-03 | `e2e/helpers/seed.ts:1839` | raw `update … set postcare_email_*` | same | test-only |
| X-04 | `tests/db/**` — e.g. `tests/db/double-booking-constraint.db.test.ts:41`, `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:285`, `tests/db/practitioner-move-appointment.db.test.ts:117` | raw INSERT / UPDATE / **DELETE** | `adminQuery` against the disposable local stack | test-only |
| G-01 | `supabase/migrations/0025_email_system.sql:69` | UPDATE — backfill `cancellation_token` (column since dropped, `0091:343`) | migration transaction | one-off, spent |
| G-02 | `supabase/migrations/0029_double_booking_constraint.sql:118` | UPDATE — backfill `buffer_minutes_snapshot` / `blocked_ends_at` | migration transaction | one-off, spent |
| G-03 | `supabase/migrations/0033_pre_stripe_operational_hardening.sql:535` | UPDATE inside a fail-closed DO block — backfill missing cancellation tokens on future confirmed rows | migration transaction | one-off, spent |
| G-04 | `supabase/migrations/0090_appointment_token_hash.sql:73` | UPDATE — derive `cancellation_token_hash` from the raw token | migration transaction | one-off, spent |
| G-05 | `supabase/migrations/0134_practitioner_capacity_foundation.sql:131` | UPDATE — set `capacity_enabled = false` everywhere | migration transaction | one-off, spent |

`tests/db/**` is the only place in the tree where `delete from public.appointments` appears at all; no migration and no application path deletes an appointment (verified: `rg -i 'delete\s+from\s+(only\s+)?(public\.)?appointments\b' supabase/migrations/*.sql` → no output). Cancellation is a status flip everywhere.

---

### 3.7 Per-writer attribute detail — group (a) commands

#### C-01 `create_internal_appointment_v2` — internal booking INSERT

| Attribute | Value |
|---|---|
| Effective def / DML | `supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql:376`; INSERT `:505`; audit `:515` |
| Studio source | server-resolved `studio.id` from `getCurrentPractitionerWithStudio()` (`app/(app)/calendar/actions.ts:158`, passed `:314`); studio row LOCKED `for update` `0152:411`, then `acquire_studio_capacity_lock` `:418` |
| Actor source | server-resolved `practitioner.id` (`actions.ts:315`); role re-read live from `practitioners` inside the command (`0152:425-429`) |
| Practitioner source | `targetPractitionerId` (`actions.ts:192-195`); a submitted id is honoured only when capacity is ON **and** actor is owner; command re-validates membership `0152:443-447` |
| Client source | browser id, re-verified in-app against `studio.id` (`actions.ts:218-228`) and in SQL `0152:451-455`. **The SQL check is `c.id = p_client_id and c.studio_id = p_studio_id` only — no `archived_at is null` gate**, unlike C-02 (`0170:756-764`) |
| Service source | browser id; service row LOCKED and re-validated active + same-studio `0152:459-463` |
| Appointment-id source | n/a (minted by the DB default) |
| Time source | browser `starts_at`; past-time refused in JS `actions.ts:238-240` and in SQL `0152:489-491` |
| Duration source | **authoritative in SQL** — the LOCKED service row's `default_duration_minutes`; an override must be 15..360 and a multiple of 15 (`0152:475-479`) and is owner-only |
| Status source | the command; `'confirmed'` hard-coded in the INSERT (`0152:505-513`). No parameter |
| Outside-hours input | `p_allow_outside_availability`, owner-gated in JS (`actions.ts:178-183`) and again in SQL (`0152:437-440`) |
| Collision / availability / buffer / eligibility / membership | `validate_appointment_availability` (`0152:496`, fn `0152:252`) under the studio lock; hard overlap by the two partial GiST exclusions `0152:80-97`; buffer by `HB001` trigger T-01; eligibility `0152:467-471` and membership `0152:443-447` are **fenced behind `if v_cap`** (`0152:286`), so on a capacity-OFF studio they do not run |
| Lineage | n/a (no predecessor) |
| Transition enforcement | n/a (creation) |
| Audit behavior | mandatory `appointment_audit` row, same transaction, `0152:515-526` |
| Atomicity | one SECURITY DEFINER transaction |
| Idempotency | none; the exclusion constraint is the race authority. `23P01` → "slot taken" (`actions.ts:329-345`) |
| Error handling | closed result-code map `bookingResultMessage` (`actions.ts:43-76`); SQLSTATE-only DB logging (`logBookingDbError`, `:80-86`) |
| Privacy-safe logging | yes — structured `booking_slot_collision` with ids/times, no PHI |
| Browser-bypassable? | the RPC is not; a direct `INSERT into appointments` by an authenticated member **is** (no table REVOKE anywhere in `0001..0171`) |

#### C-02 `create_public_appointment` — public booking INSERT

| Attribute | Value |
|---|---|
| Effective def / DML | `0170_public_appointment_command.sql:636`; INSERT `:892`; audit `:906` |
| Studio source | URL slug → `getStudioBySlug` (`app/book/[slug]/actions.ts:428`); never a submitted `studio_id`. Studio row LOCKED `0170:677-686`, then `acquire_studio_capacity_lock` |
| Actor source | none — unauthenticated visitor. Compensating controls: `limitPublicBooking` before any DB access (`actions.ts:418-427`, fails **open**), booking-horizon gate (`:430-437`), past-time guard (`:449-454`), publish readiness soft-gate (`:461-464`) |
| Practitioner source | **chosen inside SQL** — sole active owner else NULL, resolved in one `limit 2` + `count(*)=1` snapshot (`0170:812-833`). No `p_practitioner_id` parameter exists |
| Client source | server-resolved or created `clientId`; SQL requires same-studio **and `archived_at is null`** (`0170:756-764`). `client_type` is a closed enum and an `"existing"` match must not have the submitted phone written onto it (`actions.ts:369-410`) |
| Service source | submitted `service_id`, re-validated in-app and again in SQL with the service row LOCKED (`0170:768-786`) |
| Appointment-id source | DB default |
| Time source | submitted `starts_at`, required **exactly millisecond-precise** — rejected, never truncated (`0170:723-732`) |
| Duration source | the LOCKED service row. No duration parameter exists (`0170:922-924`) |
| Status source | the command; no status parameter |
| Outside-hours input | **none** — the public path cannot request an override; `booked_outside_availability` is left at its FALSE default so `HB001` always arms (`0170:885-891`) |
| Collision / availability / buffer / eligibility / membership | `validate_public_booking_slot` (`0170:392-619`, called `:875`) enforces membership, eligibility (only when the service has an eligibility list, `:445-461`), full-day blockouts, studio-wide working hours, SERVICE-end-before-close, shadow collision and exact public-slot membership (`:589-609`) **in both capacity modes** — explicitly unlike `validate_appointment_availability` (`0170:621-622`) |
| Lineage | n/a |
| Transition enforcement | n/a |
| Audit behavior | mandatory, same transaction; the email is read from the client row so no PII crosses the boundary (`0170:906-916`) |
| Atomicity | one transaction; `23P01`/`HB001` deliberately uncaught → full rollback (`0170:885-889`) |
| Idempotency | none; two identical calls create two appointments unless the exclusion or `HB001` refuses the second |
| Error handling | closed result-code map; `SLOT_TAKEN_CODES` set (`actions.ts:809-816`); unknown codes → one generic message |
| Privacy-safe logging | yes — `logInternalBookingError` uses a salted email fingerprint, never the raw booker email and never the raw DB message (the row carries free-text notes) |
| Browser-bypassable? | not by `anon` — `appointments_member_all` (`0010_booking_v1.sql:272-277`) requires `is_studio_member`, false without `auth.uid()`. Member-scoped bypass only |

#### C-03 `reschedule_appointment_v2` — public reschedule (UPDATE + INSERT + UPDATE)

| Attribute | Value |
|---|---|
| Effective def / DML | `0171_public_reschedule_command_v2.sql:797`; cancel `:1301`, successor `:1324`, reverse lineage `:1349`; audits `:1363`, `:1373` |
| Studio source | read from the LOCKED original inside the command; the unlocked pre-read at `0171:862-869` is documented as proving nothing and never trusted again |
| Actor source | none — token bearer. `resolveAppointmentIdFromToken` (`app/reschedule/[token]/actions.ts:105-138`) plus `assertReschedulableOriginal` (`:194-239`); rate-limited `limitTokenRoute` (`:645-651`) |
| Practitioner / client / service source | all preserved from the LOCKED original — the RPC takes no studio, client, service, practitioner, status, end time, duration or lineage id (`actions.ts:766-770`). Capacity-ON membership + eligibility re-gate at `0171:1209-1240` |
| Appointment-id source | `p_original_appointment_id` with a token-hash equality re-check on the re-read row; every failure collapses to `appointment_not_found` (`0171:967-978`). Successor id minted server-side with `gen_random_uuid()` (`0171:1316`) |
| Time source | submitted `newStartsAt`; millisecond precision `0171:1038-1046`; same-time no-op `:1055-1061`; future + horizon checks |
| Duration source | the **ORIGINAL appointment's** stored `duration_minutes`, not the service default (`0171:994-1002`) |
| Status source | the command (`'cancelled'` on the original with `cancellation_kind='rescheduled'` set in the same statement; `'confirmed'` on the successor) |
| Outside-hours input | none |
| Collision / availability / buffer | `validate_public_reschedule_slot` (`0171:516`, called `:1257`) — the 0170 pair plus original-reservation exclusion and capacity-mode awareness (`0171:78-108`) |
| Eligibility / membership | `0171:1209-1240` (capacity-ON only) |
| Lineage enforcement | both directions written in-transaction: `rescheduled_from_appointment_id` on the successor (`:1324-1334`) and `rescheduled_to_appointment_id` on the original (`:1349-1352`) |
| Transition enforcement | original must be `status='confirmed'` **and** `starts_at > now()` (`0171:982-989`); financial refusal on any payment/charge attempt → `payment_state_requires_studio` (`:1160-1181`); policy-snapshot freshness re-derived in SQL → `policy_changed` (`:1136-1156`) |
| Audit behavior | two audit rows + the policy acknowledgement (`:1392-1404`), all in the one transaction |
| Atomicity | one transaction for cancel + successor + lineage + audits + acknowledgement. Three post-commit effects are each isolated in `attempt()` (`actions.ts:1043-1122`); one of them, `recordEmailAttempt(…)` at `:1074`, is itself M-01 |
| Idempotency | the duplicate-submit loser blocks on the row lock, then fails `appointment_not_reschedulable` (`0171:914-919`, `:982`) |
| Error handling | closed switch over 13 result codes (`actions.ts:820-843`); `23P01`/`HB001` → slot-taken; a malformed `success` row is logged as a contract violation, not reported as a failed reschedule (`:864-889`) |
| Privacy-safe logging | yes; the pre-commit delivery gates (studio row, client row with non-empty email, `getRequiredAppOrigin()`, `actions.ts:676-751`) exist because the successor's raw token is a one-time in-memory secret only the confirmation email can carry |
| Browser-bypassable? | not by `anon`. Member-scoped direct DML bypasses all of the above |

#### C-04 `move_or_reassign_appointment` — move / reassign UPDATE

| Attribute | Value |
|---|---|
| Effective def / DML | `0152:537` (8-arg); UPDATE `:686`; audit `:694`. Chain `0143:35 → 0144:31 → 0145:25` (7-arg, **dropped `0148:31`**) → `0148:33` → `0152:537` |
| Studio source | server-resolved `studio.id`; studio row LOCKED `0152:575`, `acquire_studio_capacity_lock` `:583` |
| Actor source | server-resolved `practitioner.id`; role read live `0152:619-623` |
| Practitioner source | `p_target_practitioner_id`, `coalesce`d to the LOCKED row's current practitioner (`0152:595`); JS re-validates against the eligible set (`move-appointment-actions.ts:285-294`); non-owner reassignment refused (`0152:627-629`) |
| Client / service source | preserved from the LOCKED row; not parameters |
| Appointment-id source | form field, re-scoped `a.id = p_appointment_id and a.studio_id = p_studio_id` under `for update` (`0152:586-589`) |
| Time source | studio-local `localDate`+`localTime` → `utcInstantFromLocal(…, studio.timezone)` (`move-appointment-actions.ts:310`) — never the browser timezone; past instants refused in JS `:311-313` and SQL `0152:609-611` |
| Duration source | the appointment's EXISTING `duration_minutes`; new end derived `0152:674` |
| Status source | not written — status is preserved |
| Outside-hours input | `p_allow_outside_availability`, set only for `mode === "custom_time"` (`move-appointment-actions.ts:369`), owner-gated in JS `:267-274` and SQL `0152:632-634` |
| Collision / availability / buffer / eligibility / membership | `validate_appointment_availability` (`0152:676`); `available_slot` mode re-derives the offered slot list server-side and matches by START INSTANT (`move-appointment-actions.ts:320-344`); capacity-ON membership `0152:641-645` and eligibility `:651-655` |
| Lineage | n/a |
| Transition enforcement | `v_appt.status <> 'confirmed' or v_appt.starts_at <= v_now` → `appointment_not_movable` (`0152:597-598`); optimistic concurrency on `p_expected_starts_at`/`p_expected_ends_at` → `stale_appointment` (`0152:603-605`) |
| Audit behavior | one row, action `moved` / `reassigned` / `moved_and_reassigned` (`0152:694-710`) |
| Atomicity | one transaction |
| Idempotency | `no_change` short-circuit when neither time nor practitioner changes (`0152:662-663`) |
| Error handling | `23P01`/`HB001` → safe conflict copy (`move-appointment-actions.ts:373-379`); closed switch over 15 result codes (`:388-427`) |
| Privacy-safe logging | `{event:"move_appointment_rpc_error", code}` only (`:381`) |
| Browser-bypassable? | yes, member-scoped, via direct `UPDATE` of `starts_at`/`ends_at`/`practitioner_id` |

#### C-05 `practitioner_cancel_appointment` — practitioner cancel UPDATE

| Attribute | Value |
|---|---|
| Effective def / DML | `0033:241`; UPDATE `:291`; audit `:299`. Only definition (`0133`/`0170` mention it in prose only) |
| Studio source | server-resolved `studio.id` (`app/(app)/calendar/actions.ts:435`) |
| Actor source | server-resolved `practitioner.id`; **`cancelled_by` is the LIVE `practitioners.role`** read inside the command (`0033:256`, written `:293`) — never browser-supplied |
| Practitioner / client / service / time / duration source | not written |
| Appointment-id source | form field, re-scoped `a.id and a.studio_id` under `for update` (`0033:264-269`) |
| Status source | the command → `'cancelled'` |
| Outside-hours input | n/a |
| Collision / availability / buffer / eligibility | n/a (no time change) |
| Membership enforcement | active member else `not_authorized` (`0033:254-261`) |
| Lineage | none written (`cancellation_kind` left NULL) |
| Transition enforcement | `already_cancelled` idempotent return (`0033:272-274`); non-`confirmed` → `not_cancelable` (`:276-278`); **and `starts_at <= now()` → `not_cancelable`** (`0033:285-288`) — once an appointment has started the legitimate outcomes are complete or no-show |
| Audit behavior | one row, `action='cancelled'`, `details` = reason + role + `source:'practitioner_action'` (`0033:299-308`) |
| Atomicity | one transaction; the client cancellation email is post-commit, failure logged only (`actions.ts:512-514`) |
| Idempotency | yes — `already_cancelled` |
| Error handling | closed result-code returns; no exceptions raised on the business paths |
| Privacy-safe logging | yes |
| Browser-bypassable? | yes, member-scoped: `UPDATE … SET status='cancelled', cancelled_by='client'` skips the role derivation, the start-time guard and the audit row entirely |

#### C-06 `public_cancel_appointment_with_token` — token cancel UPDATE

| Attribute | Value |
|---|---|
| Effective def / DML | `0091:75` (5-arg); UPDATE `:122`; audit `:130`. Chain `0033:147` (2-arg, **dropped `0091:166`**) → `0063:59` → `0090:142` → `0091:75` |
| Studio source | derived from the located row — the function's only predicate is `a.cancellation_token_hash = p_token` under `for update` (`0091:98-100`); the token's partial unique index (`0090:98-100`) makes it globally unique |
| Actor source | none; `actor_type='client'`, `actor_id=null` (`0091:130-133`) |
| Practitioner / client / service / time / duration source | not written |
| Appointment-id source | **the token alone** — no submitted appointment id. `resolveAppointmentIdFromToken` (`app/cancel/[token]/actions.ts:68-89`) hashes the raw URL token with a stateless-HMAC fallback; the RPC re-verifies by hash |
| Status source | the command → `'cancelled'`, `cancelled_by='client'` |
| Reason input | validated against the closed `CANCELLATION_REASONS` set; the stored label is derived server-side, never a client string (`actions.ts:136-144`) |
| Outside-hours / collision / availability / buffer / eligibility | n/a |
| Membership enforcement | n/a (token is the credential); rate-limited `limitTokenRoute({routeClass:"cancel_submit"})` (`actions.ts:155-160`) |
| Lineage | none |
| Transition enforcement | empty/NULL token → `invalid_token` (`0091:92-95`); `already_cancelled` (`:106-109`); non-`confirmed` → `not_cancelable` (`:111-114`); `starts_at <= now()` → `not_cancelable` (`:116-119`) |
| Audit behavior | one row in the same transaction, `details` = source/reason/label/note/follow-up (`0091:130-142`) |
| Atomicity | the status flip + audit are one transaction. The `appointment_policy_acknowledgements` INSERT is a **separate post-commit statement** (`actions.ts:365-377`); its failure is logged and deliberately does not roll back (`:348-354`) |
| Idempotency | yes — `already_cancelled` |
| Error handling | every non-`cancelled` outcome, including `already_cancelled`, collapses to one identical string (`actions.ts:271-280`) — deliberate information-leak collapse |
| Privacy-safe logging | `logInternal("public_cancel_rpc_error", {code, message})` only |
| Browser-bypassable? | not by `anon`; member-scoped bypass applies |

#### C-07 / C-08 `mark_appointment_complete` — completion UPDATE (two call sites, one function)

| Attribute | Value |
|---|---|
| Effective def / DML | `0032:4052`; UPDATE `:4086`; audit `:4090`. Grants `0032:4099-4101`, re-asserted `0033:402-404` |
| Studio source | server-resolved `studio.id`. C-08 derives it from a lineage-validated appointment read performed through the **authenticated** client (`app/(app)/clients/[id]/sessions/new/actions.ts:138-176`) — same-studio, same-client and unassigned-or-mine practitioner are each hard-rejected on mismatch |
| Actor source | server-resolved `practitioner.id`; active-membership re-checked in SQL, `42501` on failure (`0032:4064-4069`) |
| Practitioner / client / service / time / duration source | not written |
| Appointment-id source | form field (C-07) or the validated read (C-08), re-scoped `a.id and a.studio_id` under `for update` (`0032:4072-4076`) |
| Status source | the command → `'completed'` |
| Outside-hours / collision / availability / buffer / eligibility | n/a |
| Membership enforcement | active member else `42501` exception |
| Lineage | none |
| Transition enforcement | not found → `P0002`; non-`confirmed` → `P0002` (`0032:4079-4081`); **`ends_at > now()` → `P0002` "appointment has not yet ended"** (`0032:4082-4084`). C-08 pre-filters the same two conditions in JS (`sessions/new/actions.ts:39-45`) to avoid a noisy roundtrip |
| Audit behavior | one row, `action='marked_complete'` (`0032:4090-4095`) |
| Atomicity | one transaction. Post-commit `autoSendPostcareOnComplete(appointmentId, studio.id)` (`actions.ts:581-582`, `sessions/new/actions.ts:68-71`) → D-05..D-07 |
| Idempotency | none needed — a second call finds a non-`confirmed` row and raises |
| Error handling | C-07 surfaces a mapped message; C-08 is **fail-soft** — a failed auto-complete never blocks session start (`sessions/new/actions.ts:53-81`) |
| Privacy-safe logging | yes — `{event, appointmentId, code, message}` |
| Browser-bypassable? | yes, member-scoped, and this is the sharpest case: a direct `PATCH … {"status":"completed"}` skips the active-member re-check, the `ends_at` guard and the audit row, so a future appointment can be marked completed today |

#### C-09 `mark_appointment_no_show` — no-show UPDATE

| Attribute | Value |
|---|---|
| Effective def / DML | `0033:334`; UPDATE `:373`; audit `:378`. Only definition |
| Studio source / actor source | server-resolved (`app/(app)/calendar/actions.ts:611-613`); active membership → `not_authorized` (`0033:344-352`) |
| Practitioner / client / service / time / duration source | not written |
| Appointment-id source | form field, re-scoped under `for update` (`0033:355-360`) |
| Status source | the command → `'no_show'` |
| Outside-hours / collision / availability / buffer / eligibility / membership | n/a beyond the membership check |
| Lineage | none |
| Transition enforcement | not found or non-`confirmed` → `wrong_status` (`0033:362-368`); `ends_at > now()` → `too_early` (`0033:370-372`) |
| Audit behavior | one row, `action='marked_no_show'`, `details.source='manual'` (`0033:378-386`) |
| Atomicity | one transaction |
| Idempotency | none; a repeat returns `wrong_status` |
| Error handling | closed result-code returns mapped in `actions.ts:627-632` |
| Privacy-safe logging | yes |
| Browser-bypassable? | yes, member-scoped |

Note for completeness: `app/api/cron/no-show-check/route.ts` is a live registered route that is **deliberately non-mutating** — it returns `{ok:true, disabled:true, scanned:0, marked:0}` after the `CRON_SECRET` check (`:38-54`); the historical `starts_at + 30min` auto-no-show is documented as removed (`:7-22`).

### 3.8 What the census does not contain

- **No Supabase Edge Functions.** `supabase/` holds only `config.toml` and `migrations`; `supabase/functions/` does not exist.
- **No hand-rolled PostgREST calls.** `rg 'rest/v1|/rest/' app lib components` → zero.
- **No dynamic-table writer.** The only variable-table chain is a `count` read (`lib/onboarding/getting-started.ts:357`).
- **No appointment `DELETE` in application or SQL.** Only tests and the `on delete cascade` from `studios` / `clients` (`0010:176`, `0151_appointment_tenant_consistency.sql:84-86`).
- **No writer for `cancellation_kind` outside C-03** — `lib/google-calendar/sync/reconcile-store.ts:166` reads it; nothing else writes it.
- **No idempotency key on any creating surface.** Neither C-01 nor C-02 accepts a request token; duplicate suppression rests entirely on the GiST exclusions (`0152:80-97`) and the shadow exclusion (`0134:236-244`).
- **`/manage/[token]` and `/calendar-feed/[token]` have zero writers** by design (`app/manage/[token]/actions.ts:47-48`).
- **UNPROVEN (static audit):** hosted `proacl` and table-grant state; hosted studio flag values gating M-06; whether an older Vercel deployment still calling L-01 is reachable; the production body of `snapshot_appointment_buffer` (T-03).

---

## 4. Workflow coverage matrix

### 4.1 How to read this matrix

Seventeen workflows were enumerated in the audit brief. Each is traced from its browser entry surface through its server action to the SQL object that actually writes `public.appointments`, and is assigned one status:

| STATUS | Meaning |
|---|---|
| COVERED-BY-COMMAND | The only shipped write path runs through a `security definer`, `service_role`-only RPC that validates, mutates and audits in one transaction. |
| DIRECT-DML | The shipped write path is a PostgREST statement against the table rather than a command. |
| DORMANT | The path exists and is installed, but has no application caller, or is gated on a flag that is off everywhere. |
| ABSENT | No path of this kind exists in the product at this SHA. |

Two facts apply to **every** row below and are stated once here rather than repeated per workflow. First, no migration in the tree grants or revokes a table privilege on `public.appointments`, and the sole RLS policy is `appointments_member_all` (`supabase/migrations/0010_booking_v1.sql:272-277`), `for all` with `using` and `with check` = `public.is_studio_member(studio_id)`. Every COVERED-BY-COMMAND status therefore describes the *shipped* path only; an authenticated studio member can bypass all of it with a direct PostgREST write. Migration 0169 applied the correct revocation shape to six clinical tables (`supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql:82-87`) and deliberately excluded appointments; both later migrations restate the position (`0170_public_appointment_command.sql:1018`, `0171_public_reschedule_command_v2.sql:1507`). Second, **no trigger writes `appointment_audit`** — every audit row in the product is an explicit `insert` inside a command body, so any write that is not a command produces no audit row at all.

The only application read of `appointment_audit` is `app/(app)/calendar/[id]/page.tsx:131-139`, gated on `isCancelled`, filtered to `action = 'cancelled'`, selecting `details` alone.

### 4.2 Creation — workflows 1 and 2

| # | Workflow | Entry surface | Server action | Command / RPC |
|---|---|---|---|---|
| 1 | Internal creation | `app/(app)/calendar/QuickBookDrawer.tsx:615`; `app/(app)/clients/[id]/BookAppointment.tsx:207` | `bookAppointmentForClientAction` — `app/(app)/calendar/actions.ts:88` | `create_internal_appointment_v2` — called `actions.ts:312`, EFFECTIVE `0152_actual_overlap_hard_buffer_soft.sql:376` |
| 2 | Public booking | `app/book/[slug]/PublicBookForm.tsx:389` | `publicBookAppointmentAction` — `app/book/[slug]/actions.ts:336` | `create_public_appointment` — called `actions.ts:776`, `0170_public_appointment_command.sql:636` |

| # | DB client | Audit row | Atomic | STATUS |
|---|---|---|---|---|
| 1 | `createAdminClient()` (service role) → `admin.rpc` | yes — `'created'`, `0152:515-526` (action literal at `0152:517`) | yes — one plpgsql body | COVERED-BY-COMMAND |
| 2 | `createAdminClient()` → `admin.rpc` | yes — `'created'`, `0170:906-914` (literal at `0170:909`) | appointment + audit yes; **workflow no** | COVERED-BY-COMMAND |

Workflow 2's caveat is precise: `create_public_appointment` is internally atomic, but `publicBookAppointmentAction` mutates `clients` *before* it — an INSERT for a new client at `app/book/[slug]/actions.ts:669-673`, an sms-consent UPDATE for an existing one at `:625-631` — and every refusal path returns without unwinding that write.

`create_internal_appointment(...)` (`0147_internal_booking_legacy_wrapper.sql:31`) is a thin wrapper delegating to `_v2`. It has no application caller and is DORMANT.

### 4.3 Reschedule, move, reassignment and override — workflows 3, 4, 5, 10, 11

There are **two different things named "reschedule" in this product**, and only one of them produces a successor appointment.

| # | Workflow | Entry surface | Server action | Command / RPC |
|---|---|---|---|---|
| 3 | Client-token reschedule | `app/reschedule/[token]/RescheduleForm.tsx:216` | `rescheduleAppointmentViaTokenAction` — `app/reschedule/[token]/actions.ts:619` | `reschedule_appointment_v2` — called `actions.ts:774`, `0171_public_reschedule_command_v2.sql:797` |
| 4 | Practitioner / internal reschedule | `app/(app)/calendar/[id]/page.tsx:633` (`MoveAppointmentButton` under the `Reschedule` heading at `:627`) | `moveAppointmentAction` — `app/(app)/calendar/move-appointment-actions.ts:211` | `move_or_reassign_appointment` — called `:352`, EFFECTIVE `0152:537` |
| 5 | Calendar drag / move | `app/(app)/calendar/MoveAppointmentDialog.tsx:329`; also reached from `AppointmentPreviewDrawer.tsx:150` | same as 4 | same as 4 |
| 10 | Practitioner reassignment | same dialog, reassign arm gated at `move-appointment-actions.ts:283-284` | same as 4 | same as 4 (`practitioner_id` written at `0152:686-692`) |
| 11 | Outside-availability override | create: `QuickBookDrawer.tsx:599`, `BookAppointment.tsx:201` (`allow_outside_availability=true`); move: `MoveAppointmentDialog.tsx:261,336` (`mode="custom_time"`) | `actions.ts:88` / `move-appointment-actions.ts:211` | `0152:376` / `0152:537` |

| # | DB client | Audit row | Atomic | STATUS |
|---|---|---|---|---|
| 3 | `createAdminClient()` → `admin.rpc` | **two** — `'cancelled'` on the original (`0171:1366`) and `'created'` on the successor (`0171:1376`) | yes — cancel, successor, both lineage columns and the policy acknowledgement (`0171:1393-1403`) in one transaction | COVERED-BY-COMMAND |
| 4 | `createAdminClient()` → `admin.rpc` | one — `'moved'` (`0152:698-699`) | yes | COVERED-BY-COMMAND |
| 5 | — | — | — | **entry gesture ABSENT**, see below |
| 10 | `createAdminClient()` → `admin.rpc` | one — `'reassigned'` / `'moved_and_reassigned'` (`0152:698,714`) | yes | COVERED-BY-COMMAND; app arm DORMANT while capacity is OFF |
| 11 | as above | flag carried in `details->>'outside_availability'` (`0152:708`) and persisted to `appointments.booked_outside_availability` (`0152:690`) | yes | COVERED-BY-COMMAND |

Three precise notes:

**There is no drag-to-MOVE gesture.** The calendar drag is drag-to-CREATE. `DragActionChooser` offers exactly two actions — "Book appointment" (`app/(app)/calendar/DragActionChooser.tsx:78-81`) and "Block time" (`:85-88`) — and it is the only consumer of the drag range in both `DayColumn.tsx:803` and `CalendarMobileDayView.tsx:275`. The single drag-related handler on an appointment surface is `DayColumn.tsx:522`, `onDragStart={(e) => e.preventDefault()}`; there is no `draggable` attribute and no `onDrop` anywhere in `app/(app)/calendar/`. Workflow 5 therefore has no gesture entry point at all — its only surface is the move dialog, which is workflow 4.

**The in-app "Reschedule" section mounts the MOVE dialog and updates the row in place.** `app/(app)/calendar/[id]/page.tsx:619-623` states the contract in the source: *"A move UPDATES this same appointment row (same id, same client/service/payment/clinical links); it never cancels + rebooks."* The command's UPDATE column list is `starts_at, ends_at, practitioner_id, booked_outside_availability, updated_at` (`0152:686-692`) — no lineage, no `cancellation_kind`. **Cancel + successor lineage therefore exists ONLY on the public token path**, where `reschedule_appointment_v2` writes `cancellation_kind = 'rescheduled'` in the same statement that cancels (`0171:1302-1306`), `rescheduled_from_appointment_id` on the successor (`0171:1324-1334`) and `rescheduled_to_appointment_id` on the original (`0171:1349-1352`). Any consumer reading those columns as "this appointment's reschedule history" will see null for every staff-initiated move. Whether the lineage columns hold any production row today is UNPROVEN (static audit); the 0171 apply record states the command had not been exercised by any caller at apply time.

**Two legacy commands remain installed, caller-less and `service_role`-EXECUTE-able**: `reschedule_appointment` (EFFECTIVE `0091_drop_raw_cancellation_token.sql:186`, retained by design per `0171:61-66`, strictly weaker — caller-supplied end time and duration, no lineage) and `practitioner_move_appointment` (EFFECTIVE `0145_move_preserve_target_race_fix.sql:200`, a delegate to `move_or_reassign_appointment`). Both DORMANT.

### 4.4 Terminal lifecycle transitions — workflows 6, 7, 8, 9

| # | Workflow | Entry surface | Server action | Command / RPC |
|---|---|---|---|---|
| 6 | Client cancellation | `app/cancel/[token]/CancelForm.tsx:128` | `publicCancelAppointmentAction` — `app/cancel/[token]/actions.ts:101` | `public_cancel_appointment_with_token` — called `:253`, EFFECTIVE `0091:75` |
| 7 | Practitioner cancellation | `app/(app)/calendar/PractitionerCancelForm.tsx:30` | `cancelAppointmentAction` — `app/(app)/calendar/actions.ts:409` | `practitioner_cancel_appointment` — called `:432`, `0033_pre_stripe_operational_hardening.sql:241` |
| 8 | Completion | `components/appointment/mark-complete-control.tsx:112` | `markAppointmentCompleteAction` — `actions.ts:537`; **and** `maybeMarkAppointmentCompletedOnSessionStart` — `app/(app)/clients/[id]/sessions/new/actions.ts:49` | `mark_appointment_complete` — called `actions.ts:550`, `0032_stripe_connect_phase_1.sql:4052` |
| 9 | No-show | `app/(app)/calendar/AppointmentLifecycleActions.tsx:103` | `markAppointmentNoShowAction` — `actions.ts:594` | `mark_appointment_no_show` — called `:608`, `0033:334` |

| # | DB client | Audit row | Atomic | STATUS |
|---|---|---|---|---|
| 6 | `createAdminClient()` → `admin.rpc` | yes — `'cancelled'`, `0091:130-133`; `actor_type` is the literal `'client'` | status + audit yes; **the policy acknowledgement is written after commit** at `app/cancel/[token]/actions.ts:365` | COVERED-BY-COMMAND |
| 7 | `createAdminClient()` → `admin.rpc` | yes — `'cancelled'`, `0033:299-302`; `cancelled_by` read from `practitioners.role` inside SQL (`0033:255,294`) | yes | COVERED-BY-COMMAND |
| 8 | `createAdminClient()` → `admin.rpc` (both callers) | yes — `'marked_complete'`, `0032:4090-4093` | yes | COVERED-BY-COMMAND |
| 9 | `createAdminClient()` → `admin.rpc` | yes — `'marked_no_show'`, `0033:378` | yes | COVERED-BY-COMMAND |

Automatic no-show marking is deliberately switched off, not merely unscheduled: `app/api/cron/no-show-check/route.ts:44-54` returns `{ok:true, disabled:true, scanned:0, marked:0}` and performs no write. The practitioner-initiated action is the only writer of `status = 'no_show'` in the product.

`appointments.status` is constrained by value only — `check (status in ('confirmed','cancelled','completed','no_show'))` at `0010:183`. There is **no transition constraint anywhere in the schema**; terminal-safety lives entirely inside the four command bodies.

### 4.5 Missing workflows — 12 and 13 are ABSENT, and that is a finding

**Workflow 12 — deletion: ABSENT.** A whole-tree scan of `app/`, `lib/`, `components/` and `scripts/` for a write following `.from("appointments")` returns exactly seven statements, all `.update()`, all postcare (§4.7) — zero `.insert()`, `.upsert()` or `.delete()`. No migration contains a `delete from public.appointments`. Every other lifecycle transition has a reviewed `security definer` command; deletion has none. The consequence is asymmetric: `appointment_audit.appointment_id` carries `on delete cascade` (`0010:219`), as does `appointment_policy_acknowledgements` (`0056:33-34`), so a deletion destroys the appointment's entire audit trail with it. **A genuinely bad production row can only be removed by the ungoverned member DML described in §4.1 or by out-of-band SQL — both un-audited.** Closing the DML boundary without adding a governed path would leave the product with no way to remove an appointment at all; the two must be sequenced together.

**Workflow 13 — import / administrative repair: ABSENT.** Appointments are export-only. The data export selects them read-only at `app/(app)/settings/data/actions.ts:119-125`, deliberately omitting the token hash and trigger-managed snapshots, and there is no matching import: `app/(app)/settings/import/actions.ts:27` and `lib/import/quick-import.ts:9` both name appointments in the list of what the importer never creates, and neither file contains any appointment code. The admin console has no appointment mutation of any kind. The nearest thing to a repair primitive is `repair_bump_appointment_sync_version` (`0125_google_calendar_outbound_enqueue_activation_boundary.sql:384`), which increments `sync_version` and nothing else. `rematerialize_studio_reservations` (EFFECTIVE `0137_scoped_blocks_and_breaks.sql:247`) does UPDATE `appointments.capacity_enabled` at `0137:266-268`, but it is reachable only from the capacity flag-flip trigger and the retirement RPC, has no TypeScript caller, and is not a repair surface for scheduling data.

One indirect authenticated-client path is worth recording because it is the sole counter-example to "zero appointment writes use the RLS-bound client": `/auth/callback` calls `reconcile_my_pending_invitation` on the authenticated client (`app/(auth)/auth/callback/route.ts:40-41`), which is `security definer` and granted to `authenticated` (`0141_onboarding_invitation_reconciliation.sql:490`). It inserts a `practitioners` row (`0141:169`), firing `practitioners_capacity_refan_trg` (`0134_practitioner_capacity_foundation.sql:609-613`) → `on_practitioner_change_refan` (`0134:582`) → `rematerialize_studio_reservations` → the `capacity_enabled` UPDATE. Every arm of that trigger is guarded by `studio_capacity_enabled()` (`0134:590,598,602`), so the chain is a strict no-op while every studio runs capacity-OFF. The mutation itself executes as the function owner, not as `authenticated`.

### 4.6 Domains that do not mutate the appointment row — workflows 14 and 15

| # | Workflow | Finding | STATUS |
|---|---|---|---|
| 14 | Stripe / payment-driven mutation | **No payment event mutates the appointments row.** `app/api/stripe/webhook/route.ts` touches `studio_payment_settings`, `client_stripe_customers`, `client_consent_signatures` and `client_payment_methods` — zero `appointments` access. All payment state lives in `payment_charge_attempts`. The one function that could ever INSERT an appointment from a payment, `finalize_card_required_public_booking`, was **DROPPED** at `0091:174` and is not installed. | ABSENT (by design) |
| 15 | Google-Calendar-driven mutation | **Outbound-only; there is no inbound writer.** The integration mutates exactly one column, `appointments.sync_version`, through exactly one function, `repair_bump_appointment_sync_version` (`0125:384`), called from `lib/google-calendar/sync/reconcile-store.ts:215` ← `reconcile.ts:537` ← `app/api/cron/calendar-reconcile/route.ts:75`. Gated on `studios.google_calendar_outbound_sync_enabled`, default `false` (`0121:56`). No audit row, no `updated_at`. The OAuth callback, the worker-drain route and `calendar_event_link_transition` (0132) write links and outbox rows only. | DORMANT |

### 4.7 Peripheral metadata mutation — workflow 16

This is the one workflow whose shipped path is genuinely DIRECT-DML rather than a command.

| Writer | Where | Client | Scope | Audit |
|---|---|---|---|---|
| Postcare manual send (4 UPDATEs) | `app/(app)/calendar/actions.ts:1115, 1156, 1212, 1243` | `createAdminClient()` (service role) | `.eq("id").eq("studio_id")` on every statement | none |
| Postcare auto-send (3 UPDATEs) | `app/(app)/calendar/postcare-auto-send.ts:152, 187, 201` | `createAdminClient()` | `.eq("id").eq("studio_id")`; the claim additionally `.eq("status","completed")` | none |
| Email claim / result | `claim_email_send` `0098_intake_reminder_columns.sql:45`; `record_email_result` `0098:118`; `record_email_attempt` `0033:63` | `security definer`, `service_role` only | `where id = p_appointment_id` — **no studio predicate** | none |
| SMS claim / result | `claim_sms_send` `0049_sms_foundation.sql:170`; `record_sms_result` `0049:230` | `security definer`, `service_role` only | same | none |
| Sync-version repair | `repair_bump_appointment_sync_version` `0125:384` | `security definer`, `service_role` only | same | none |

STATUS: **DIRECT-DML (governed)**. Those seven TypeScript statements are the complete set of direct PostgREST DML on `appointments` in shipped app code — verified by scanning every `.from("appointments")` chain across `app/`, `lib/`, `components/` and `scripts/`. All seven use the service-role admin client and all seven are scoped by both `id` and `studio_id`, so **revoking `authenticated` INSERT/UPDATE/DELETE breaks none of them**. What they lack is forensic visibility: none writes an `appointment_audit` row, none sets `updated_at`, and there is no `updated_at` trigger on the table — so a change to `postcare_email_sent_at` or `sync_version` leaves no trace on any surface a practitioner can see.

### 4.8 Test and utility paths — workflow 17

| Writer | Where | Reaches production? |
|---|---|---|
| e2e seed helpers | `e2e/helpers/seed.ts:504` (insert), `:1832` (status update), `:1839` (postcare update) | No — connects to the hardcoded `E2E_DB_URL` at `e2e/helpers/seed.ts:36-47`; `e2e/helpers/local-env.ts:20-56` runs `refuseHostedOverrides()` at module load and `playwright.config.ts:2` imports it |
| DB payment seed | `tests/db/helpers/payment-seed.ts:223` (insert), `:420` (delete) | No — every connection resolves through `tests/db/helpers/harness.ts:31-65`, which rejects any hosted URL pattern and any non-localhost host |
| `scripts/**` | — | No appointment writer exists in `scripts/`; the two scripts that do reach production (`verify-production.mjs`, `verify-practitioner-capacity.mjs`) issue only `supabase db query --linked` reads |
| e2e-only HTTP route | `app/api/google-calendar/e2e/authorize/route.ts:19` | Fail-closed — `assertE2eFakeGoogleAllowed` (`lib/google-calendar/e2e/fake-google-guard.ts:43-59`) requires an explicit opt-in env var, a valid per-run id, and rejects any deployed-environment signal. It writes no appointment |

STATUS: **cannot reach production**, and the guards are structural rather than conventional. The audit-relevant observation is in the opposite direction: `tests/db/appointments-tenant-consistency.db.test.ts:131-147` performs an authenticated-role `insert into public.appointments` and asserts it fails with `23503` — a foreign-key error, meaning the write cleared both the table grant and the RLS `WITH CHECK` and was stopped only by the composite same-studio FK added in `0151_appointment_tenant_consistency.sql:83-99`. No test anywhere asserts `42501` on this table, and two DB tests actively pin the open posture (`tests/db/public-appointment-command.db.test.ts:474-489`; `tests/db/public-reschedule-command.db.test.ts:1430-1443`).

### 4.9 Roll-up

| STATUS | Workflows |
|---|---|
| COVERED-BY-COMMAND | 1, 2, 3, 4, 6, 7, 8, 9, 10, 11 |
| DIRECT-DML (service-role, governed) | 16 |
| DORMANT | 15; plus the caller-less legacy commands `create_internal_appointment` (0147:31), `reschedule_appointment` (0091:186), `practitioner_move_appointment` (0145:200) |
| ABSENT | 5 (no gesture — the move dialog covers it), 12 (deletion), 13 (import / administrative repair), 14 (by design and correct) |
| Cannot reach production | 17 |

Ten of the seventeen workflows run through a reviewed command that validates, mutates and audits atomically. That is a genuinely strong command layer — and it is the reason the boundary matters: **every one of those ten statuses describes the shipped path only.** The member-privilege DML channel of §4.1 sits underneath all ten, produces no audit row on any of them, and is the only channel available for the two workflows (12 and 13) that were never built.

---

## 5. Browser-authority matrix

This section asks one question of every appointment field: **if the browser sends a value for it, what stops that value from becoming the stored truth?** It is a field-level, not a route-level, view — a route can be perfectly authorized and still hand one field's authority to the caller.

### 5.1 Threat model actually applied

Two properties of this stack define the attack surface, and both are load-bearing for every cell below.

**(a) A Next.js Server Action is a POST endpoint.** Every action enumerated here is reachable by a crafted POST carrying the action id from the page bundle, with arbitrary field names, arbitrary values, and arbitrary combinations. Disabled buttons, closed `<select>` lists, confirmation modals and client-side `if` statements are not consulted on that path. **Client-side validation is therefore scored as zero evidence throughout.** Two of the actions do not even take `FormData` — `moveAppointmentAction` takes a typed object (`app/(app)/calendar/move-appointment-actions.ts:211-222`) and `autoSendPostcareOnComplete` takes positional args (`app/(app)/calendar/postcare-auto-send.ts:101`) — which changes the serialization, not the reachability.

**(b) The browser holds a working Supabase credential.** `lib/supabase/client.ts:3-8` calls `createBrowserClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!)`, and it is imported by a `"use client"` page (`app/(auth)/login/page.tsx:1` and `:5`), so both values are inlined into the client bundle. `@supabase/ssr`'s browser client hydrates its session from cookies, so the signed-in member's JWT is available to page JS and to the user in devtools. The app CSP deliberately scopes `connect-src` to that project host (`next.config.ts:28-35`, comment: *"the app's browser Supabase client also reads it"*). **PostgREST is therefore an appointment writer in its own right**, and it is carried below as writer **W12**.

W12 matters because `public.appointments` carries no `GRANT` and no `REVOKE` in any of the 170 migrations, so `authenticated` retains INSERT/UPDATE/DELETE by Supabase default privilege — asserted directly by two repo DB tests on a freshly-migrated chain (`tests/db/public-appointment-command.db.test.ts:475-489`, `tests/db/public-reschedule-command.db.test.ts:1430-1443`, both expecting `has_table_privilege(...,'INSERT'/'UPDATE'/'DELETE') = true` for `anon` **and** `authenticated`). The single policy on the table is `appointments_member_all` (`supabase/migrations/0010_booking_v1.sql:272-277`), `for all`, USING and WITH CHECK both `public.is_studio_member(studio_id)` — true for any *active* practitioner of the studio, with no role gate (`0001_init.sql:153-166`). `anon` is blocked in practice because `is_studio_member` is false without `auth.uid()`; this is a **member-privilege** surface, not an unauthenticated one.

### 5.2 The browser-reachable writer set

| ID | Entry point | Terminal mutation | Auth |
|---|---|---|---|
| W1 | `app/(app)/calendar/actions.ts:88` `bookAppointmentForClientAction` | `create_internal_appointment_v2` (`0152_actual_overlap_hard_buffer_soft.sql:376`) | session |
| W2 | `app/(app)/calendar/actions.ts:409` `cancelAppointmentAction` | `practitioner_cancel_appointment` (`0033_pre_stripe_operational_hardening.sql:241`) | session |
| W3 | `app/(app)/calendar/actions.ts:537` `markAppointmentCompleteAction` | `mark_appointment_complete` (`0032_stripe_connect_phase_1.sql:4052`) | session |
| W4 | `app/(app)/calendar/actions.ts:594` `markAppointmentNoShowAction` | `mark_appointment_no_show` (`0033:334`) | session |
| W5 | `app/(app)/calendar/actions.ts:1014` `sendPostcareEmailAction` | direct `UPDATE appointments` (`:1115`, `:1156`, `:1212`, `:1243`) | session |
| W6 | `app/(app)/calendar/postcare-auto-send.ts:101` `autoSendPostcareOnComplete` | direct `UPDATE appointments` (`:152`, `:187`, `:201`) | server-internal |
| W7 | `app/(app)/calendar/move-appointment-actions.ts:211` `moveAppointmentAction` | `move_or_reassign_appointment` (`0152:537`) | session |
| W8 | `app/book/[slug]/actions.ts:336` `publicBookAppointmentAction` | `create_public_appointment` (`0170_public_appointment_command.sql:636`) | **none** |
| W9 | `app/reschedule/[token]/actions.ts:619` `rescheduleAppointmentViaTokenAction` | `reschedule_appointment_v2` (`0171_public_reschedule_command_v2.sql:797`) | token |
| W10 | `app/cancel/[token]/actions.ts:101` `publicCancelAppointmentAction` | `public_cancel_appointment_with_token` (`0091_drop_raw_cancellation_token.sql:75`) | token |
| W11 | `app/(app)/clients/[id]/sessions/new/actions.ts:99` `startSessionAction` | `mark_appointment_complete` via helper (`:49`) | session |
| W12 | `POST/PATCH/DELETE /rest/v1/appointments` from page JS | raw table DML | session (RLS) |

W1–W11 all reach the database through the **service-role admin client** (`actions.ts:304`, `:430`, `:549`, `:606`, `:1040`; `postcare-auto-send.ts:113`; `move-appointment-actions.ts:251`; `book/[slug]/actions.ts:456`; `reschedule/[token]/actions.ts:663`; `cancel/[token]/actions.ts` via the RPC; `sessions/new/actions.ts:48`), so RLS is bypassed and the *command* is the boundary. W12 is the only writer RLS applies to, and RLS is the only thing applying.

### 5.3 Legend

| Code | Meaning |
|---|---|
| **SD** | SERVER-DERIVED — the field is not a parameter; the server or the DB computes it |
| **SRV** | SAFE-REVALIDATED — the browser proposes, but the server (and usually the command, independently) re-proves it |
| **BA-LOW** | BROWSER-AUTHORITATIVE-LOW-RISK — the caller decides, and that is the intended product semantics |
| **BA-UNSAFE** | BROWSER-AUTHORITATIVE-UNSAFE — the caller decides something the system elsewhere treats as an invariant |
| **IGN** | IGNORED — accepted by the wire format, deliberately discarded |
| **AMB** | AMBIGUOUS — could not be settled statically |
| — | writer never touches this field |

### 5.4 Matrix A — tenancy and identity

| Field | W1 book | W7 move | W2/3/4 lifecycle | W11 sess-start | W8 pub book | W9 tok resched | W10 tok cancel | W12 direct |
|---|---|---|---|---|---|---|---|---|
| `studio_id` | SD `actions.ts:158` | SD `:249` | SD `:416`/`:543`/`:600` | SD `:117` | SRV (slug) `book:427` | SD (token) | SD (token) | **BA-UNSAFE** |
| `practitioner_id` (assignee) | SRV `:190-195`, `0152:432-435` | SRV `:283-293`, `0152:627-660` | — | — | SD `0170:790-833` | SD `0171:1184-1245` | — | **BA-UNSAFE** |
| actor id in audit | SD `:316`→`0152:517` | SD `0152:694` | SD `0033:303`/`0033:380`/`0032:4092` | SD `:52` | SD `'client',null` `0170:909` | SD `'client',null` | SD `'client'` `0091:133` | **BA-UNSAFE** |
| `client_id` | SRV `:218-223`, `0152:450-455` | — | — | SRV `:148-160` | SD-from-email `book:534-540`, `0170:756-765` | SD (copied) | — | **BA-UNSAFE** |
| `service_id` | SRV `:200-206`, `0152:458-465` | — | — | — | SRV `book:468-474`, `0170:769-779` | SD (copied) | — | **BA-UNSAFE** |

`studio_id` is never a form field on any authenticated writer. It resolves from an **httpOnly** cookie (`lib/supabase/selected-studio.ts:31` `httpOnly: true`) that is re-checked against live active memberships on every request — the file states its own contract at `:8-13`: *"NEVER trusted on its own — every resolver re-queries the user's active memberships (RLS-scoped)"* — via `getCurrentPractitionerWithStudio` (`lib/supabase/queries.ts:124-142`). The composite same-studio FKs added by `0151_appointment_tenant_consistency.sql:83-99` are the path-independent floor under all five rows: even W12 cannot bind another tenant's client, service or practitioner.

`client_id` on W8 deserves its own note: the public action never accepts a client id, it resolves one from the submitted `email` (`app/book/[slug]/actions.ts:534-540`) or creates a row. The appointment→client binding on that surface is exactly as strong as knowing a real client's email address. That is inherent to "existing client books without an account" and is not an information leak (the confirmation and its management token go to the typed address, and existing name/phone are never overwritten — `book:577-603`), but it is browser-supplied linkage and should be read as such.

### 5.5 Matrix B — scheduling and state

| Field | W1 book | W7 move | W2/3/4 lifecycle | W8 pub book | W9 tok resched | W10 tok cancel | W12 direct |
|---|---|---|---|---|---|---|---|
| `status` | SD `'confirmed'` `0152:511` | — | SD literals `0033:292`/`0033:374`/`0032:4087` | SD `'confirmed'` `0170:898` | SD both rows `0171:1302`,`:1331` | SD `'cancelled'` `0091:123` | **BA-UNSAFE** |
| `starts_at` | SRV `:238`,`:262-294`; `0152:490`,`:496` | SRV `:310`,`:320-344`; `0152:676` | — | SRV `book:434-510`; `0170:727-752`,`:875` | SRV `0171:1044-1088`,`:1262` | — | **BA-UNSAFE** |
| `ends_at` | SD `0152:494` | SD `0152:674` | — | SD `0170:788` | SD `0171:1054` | — | **BA-UNSAFE** |
| `duration_minutes` | SRV (owner-only override) `:119-152`; `0152:437-440`,`:475-484` | SD (locked row) `0152:674` | — | SD (locked service) `0170:769-788` | SD (locked original) `0171:998` | — | **BA-UNSAFE** |
| appointment id / ownership | — | SRV `:253-258`; `0152:588` | SRV `0033:264`/`0033:356`/`0032:4074` | — | SRV via token `0171:975` | SRV via token `0091:98-101` | **BA-UNSAFE** |
| outside-hours override | SRV owner-only `:178-183`; `0152:437-440` | SRV owner-only `:267-273`; `0152:633` | — | **no such parameter** `0170:636-643` | **no such parameter** | — | **BA-UNSAFE** |
| `booked_outside_availability` | SRV `0152:508`,`:512` | SD from mode `:369` | — | SD `false` default `0170:884-888` | SD default | — | **BA-UNSAFE** |
| `capacity_enabled` | SD trigger `0134:124-128` | SD trigger | SD trigger | SD trigger | SD trigger | SD trigger | **BA-UNSAFE** |
| timezone | SD `studios.timezone` `:263` | SD `:310` (*"Never the browser timezone"*, `:308-309`) | — | SD | SD (studio-local horizon) `0171:1078-1088` | — | *not a column* |

There is **no timezone column on `appointments`** (`0010:174-190`); every local-time decision reads `studios.timezone` server-side. There is likewise **no price, fee, deposit or amount column on `appointments` at all.** The base table is `0010:174-190`; every later `add column` against `public.appointments` across 0011–0171 is email/SMS send bookkeeping (`0025:17-24`, `0028:23`, `0043:43-44`, `0049:125-133`, `0080:37-39`, `0098:16-21`, `0100:24-27`), buffer/shadow fields (`0029:44-45`), `referral_source` (`0069:49`), `cancellation_token_hash` (`0090:66`), Google-sync lineage (`0125:46-51`), `capacity_enabled` (`0134:104`) and `booked_outside_availability` (`0152:66`). Not one is monetary. Price lives on `services.price_cents` (`0010:149`). **A forged appointment cannot misprice anything, because the appointment does not carry a price.** Any monetary consequence must travel through the billing tables, and the coupling point is status (see 5.8, U1).

State transitions deserve emphasis. `appointments.status` has a value CHECK (`0010:183`) and **no transition constraint anywhere in the schema**. Every legal transition is enforced only inside a command: cancel refuses non-`confirmed` and any already-started row (`0033:273-289`), no-show refuses `ends_at > now()` (`0033:369-371`), complete refuses non-`confirmed` and a future `ends_at` (`0032:4079-4084`). None of that is reachable by W12.

Within a studio there is **no per-appointment ownership check** on W2/W3/W4 — any active member may cancel, complete or no-show any appointment in the studio. That is a deliberate product rule (a small studio shares a calendar), not a boundary break, and it is recorded here so the matrix is not read as claiming otherwise. W11 is the exception: it additionally refuses an appointment assigned to a *different* practitioner (`sessions/new/actions.ts:173-175`).

### 5.6 Matrix C — side effects, free text and acknowledgements

| Field | Writer | Class | Evidence |
|---|---|---|---|
| notification decision (email) | W1 | SD | `studio.send_confirmation_emails` `:877`; `studio.notify_practitioner_on_new_booking` `:947` — both from the server-resolved studio row |
| notification decision (SMS) | W1, W8 | SD / SRV | consent-gated from stored client state `:936`; W8 requires no prior opt-out, no prior consent, **and** a normalised phone match `book:613-623` |
| `is_resend` | W5 | **BA-UNSAFE** | `actions.ts:1018`; guarded branch only under `if (!isResend)` `:1110-1148` |
| `treatment_performed_during_consultation` | W5 | BA-LOW | `:1026`, gate `:1074-1086`; explicitly designed as a practitioner attestation (`:1019-1024`) |
| postcare claim columns | W5, W6 | SD | server clock + computed counters `:1116-1119`, `:1245-1248`; error strings from the fixed safe set `:1008-1012` |
| `notes` | W1 | BA-LOW | stored verbatim `0152:511`; authenticated author |
| `notes` | W8 | BA-LOW (unbounded) | `book:353` → `0170:899` **and** `appointment_audit.details->'notes'` `0170:913`; no cap in action, command or column; action body limit is 16 MB (`next.config.ts:31`) |
| `cancellation_reason` | W2 | BA-LOW | free text `:413` → `0033:295`; no cap |
| `cancellation_reason` | W10 | SD | written from the **server-derived label**, never the browser string — `getCancellationReasonLabel` `cancel:143` → `0091:126`; the machine value is closed-set checked at `cancel:139` |
| `note` (audit only) | W10 | BA-LOW | capped at 1000 chars `cancel:145` (`lib/booking/cancellation-reasons.ts:45`); audit-only `0091:138` |
| `follow_up_allowed` | W10 | BA-LOW | `=== "true"` collapse `cancel:149`; audit-only |
| `referral_source` | W8 | SRV (app-layer only) | `parseReferralSource` throws outside the canonical set `book:363`; **the column has no CHECK** (`0069:49` is a bare `text`), so the guarantee is app-layer, not schema |
| `name` / `phone` for an existing client | W8 | **IGN** | deliberately discarded `book:577-603` — a public booker must not inject a phone into someone else's record |
| cancellation token | W1, W8, W9 | SD | minted server-side, only the SHA-256 crosses the boundary (`actions.ts:296`,`:320`) |
| cancellation token | W9, W10 | SRV → **AMB on the HMAC path** | hash match under lock `0171:968-982`; but see 5.9 |
| policy acknowledgement | W9 | SRV | server-generated proof-of-display hash `reschedule:417-429` → posted back `:638` → re-derived and compared in-command `0171:1148-1156`, *"A missing presented hash is treated as a mismatch, not as consent"* `0171:1145-1147` |
| policy acknowledgement | W10 | **BA-UNSAFE** | `cancel:119`, `:217`; no proof-of-display token exists on this surface |
| `appointment_audit` row | W1–W4, W7–W11 | SD, in-transaction | `0152:515-525`, `0033:299-307`, `0033:378-386`, `0032:4090-4095`, `0152:694-710`, `0170:906-914`, `0171:1363-1381`, `0091:130-141` |
| `appointment_audit` row | W5, W6, W12 | **none written** | the postcare writers and raw DML leave no audit row at all |

### 5.7 W12 in detail — every column is browser-authoritative

For direct PostgREST DML there is exactly one gate: `is_studio_member(studio_id)` in both USING and WITH CHECK (`0010:272-277`). **No other column is constrained by the policy.** What still holds, path-independently, is only what the schema itself carries:

- table CHECKs — `appointments_range_check` `ends_at > starts_at` (`0010:192-196`) and `appointments_duration_check` `duration_minutes between 5 and 480` (`0010:198-202`), plus the `status` value CHECK (`0010:183`);
- composite same-studio FKs (`0151:83-99`) — no cross-tenant binding;
- the two partial GiST exclusions on `appointments`, both `where status='confirmed'`, partitioned on `capacity_enabled` (`0152:80-97`);
- **the shadow reservation, which is the real one.** `appointments_sync_calendar_reservation_trg` (`0134:478-483`) fires AFTER INSERT/DELETE and `UPDATE OF status, studio_id, starts_at, ends_at, blocked_ends_at, practitioner_id`, running `sync_appointment_to_calendar_reservation` (EFFECTIVE `0152:108-150`), which mirrors `status in ('confirmed','completed')` into `studio_calendar_reservations` with `resource_key` computed from the **live studio flag** `studio_capacity_enabled()` (`0152:124-128`) — not from the row's own `capacity_enabled`. That table carries the **unconditional** exclusion `no_overlapping_calendar_reservations_per_resource` (`0134:238-243`), and members hold only SELECT on it (`0030_calendar_reservations.sql:180`,`:187-189`). **Direct DML therefore cannot produce an overlapping confirmed appointment.** Double-booking is not on the exploit list below, and any claim that it is should be rejected.

Everything else — status transitions, the working-hours window, the buffer, the booking-pause kill switch, the owner gates, duration authority, and the audit trail — lives only in the commands and is skipped entirely.

### 5.8 Every UNSAFE cell, and what it buys

**U1 — W12 `status`.** `PATCH /rest/v1/appointments?id=eq.<X>` `{"status":"completed"}` from any active member. No `ends_at` check, no actor check, no audit row. It feeds a money gate: `lib/billing/session-payment-eligibility.ts:142-145` refuses a session payment unless `appointmentSummary.status === "completed"`, a state otherwise only reachable via `mark_appointment_complete`, whose `0032:4082-4084` guard refuses a future `ends_at`. Direct DML self-grants the precondition.

**U2 — W12 `booked_outside_availability`.** `PATCH {"booked_outside_availability":true}`. `0152:62-63` asserts in a *comment* that "only the owner-gated internal commands below ever set it true"; nothing enforces it. The buffer trigger's own guard is `if new.status = 'confirmed' and coalesce(new.booked_outside_availability,false) = false` (`0152:226-227`), so setting it true disarms the soft-buffer check (HB001) for that row. The RPC path restricts the flag to owners (`0152:437-440`); raw DML hands it to any member.

**U3 — W12 `starts_at` / `ends_at`.** `PATCH` them to 03:00. No constraint or trigger enforces the published working-hours window or blockouts — that logic lives only in `validate_appointment_availability` (`0152:252`), which is an RPC-path function and is revoked from `public, anon, authenticated` (`0152:730`). The overlap guarantee still holds via the shadow, so this moves an appointment *out of hours*, not *on top of another one*.

**U4 — W12 `capacity_enabled`.** The re-derivation trigger `appointments_set_capacity_enabled_trg` fires `before insert or update of studio_id, practitioner_id, status` (`0134:124-125`) — **the list omits `capacity_enabled` itself**, so a direct write to it sticks and flips the row between the two partial exclusions (`0152:80-97`). The mirror trigger's `UPDATE OF` list omits it too, deliberately (`0134:473-476`). Consequence today is *not* a double-book (the shadow row is unchanged and still collides); it is a hardening gap of the same self-granted-mechanics shape as U2. **UNPROVEN (static audit)** whether any sequence of column-by-column writes dodges both the appointments-level partials and the shadow simultaneously.

**U5 — W12 `DELETE`.** `DELETE /rest/v1/appointments?id=eq.<X>` removes the row **and its entire audit trail** via `appointment_audit.appointment_id ... on delete cascade` (`0010:219`). This is the only way a member can destroy existing audit rows: `appointment_audit` has exactly two policies, both in `0010` — SELECT (`0010:279-288`) and INSERT (`0010:290-299`) — and RLS default-denies UPDATE and DELETE outright, so rows are otherwise append-only within a tenant.

**U6 — forged `appointment_audit` rows.** The INSERT policy's WITH CHECK constrains **only** `appointment_id` (`0010:291-299`). `actor_type` has a CHECK (`0010:220`) but `actor_id` is a bare uuid with no FK and no correlation to it, `action` is free text, `details` is free JSONB, and `created_at` is a plain writable column with only a default (`0010:224`). **No trigger writes this table** — every legitimate row is written explicitly by a command, so a forged row is byte-shaped identically to a real one. A member can `POST /rest/v1/appointment_audit` `{"actor_type":"client","actor_id":null,"action":"cancelled","details":{"source":"public_token","reason":"schedule_change"}}` and fabricate a client-initiated cancellation, or attribute a completion to a colleague. Forged `details` **do reach a rendered practitioner-facing surface**: `app/(app)/calendar/[id]/page.tsx:130-139` reads exactly this table through the RLS-bound client (`:97`), gated on `isCancelled`, filtered to `action='cancelled'`, selecting `details` alone, and renders it as the cancellation insight. Forged `actor_id`/`actor_type` are stored but never rendered.

**U7 — W5 `is_resend`.** A browser boolean disables the action's own send-once claim. `actions.ts:1018` reads it; the guarded first-send branch (`:1110-1148`) claims with `.is("postcare_email_sent_at", null)` plus a stale-claim window and `.select("id")`; the `else` at `:1149-1175` is an **unconditional** UPDATE with no `postcare_email_sent_at` predicate and no check that a prior send ever happened, then falls through to `sendPostcareToClient` at `:1179`. There is no rate limiter on any authenticated server action (`lib/rate-limit/public.ts` is used only by `/book`, `/cancel`, `/reschedule`, `/manage`). Exploit: loop the action id with `{appointment_id: <any in studio>, is_resend: "true"}` and send unbounded postcare email to that client from the studio's verified domain. The tenant boundary still holds (`:1047-1048`, `:1163`), as do the email-on-file, aftercare-text and active-practitioner gates (`:1068`, `:1090`, `:1029-1032`) — all of them bound *who* and *which record*, none bound *how many times*.

**U8 — W10 `acknowledged_policy`.** `cancel:119` reads it, `cancel:217` requires `=== "true"`, and nothing proves the visitor was ever shown the policy. The acknowledgement row is then built from a **post-cancellation re-read** of the studio row (`cancel:360-377`), so a policy edited between render and submit is snapshotted as if it were the text displayed — a durable record asserting the client accepted terms they never saw. The identical sequence on `/reschedule` returns `policy_changed` and writes nothing, because 0171 requires a server-minted proof-of-display hash and treats its absence as a mismatch (`0171:1145-1156`). The cancel surface was left behind. Note what *is* safe here: the snapshot **text** is server-read so its content cannot be forged, and `appointment_policy_acknowledgements` is genuinely append-only — RLS-enabled with a single SELECT policy and no write policy at all (`0056_appointment_policy_acknowledgements.sql:84-101`), so the W12 pattern does not extend to it.

### 5.9 Two near-misses worth recording, not scored UNSAFE

**The optimistic-concurrency tokens on W7.** `expectedStartsAt` / `expectedEndsAt` are compared against the locked row (`0152:603-608` → `stale_appointment`). A crafted caller reads the current values first and defeats the staleness check trivially — but this is a UX concurrency guard, and every authorization gate on that path (`move-appointment-actions.ts:267-273`, `:283-293`; `0152:627-660`) is independent of it. Classed **BA-LOW**.

**The HMAC-fallback token path makes the command's token re-check tautological.** When a token resolves via the HMAC fallback rather than the stored hash, the action passes **the row's own stored hash** to the command — `app/reschedule/[token]/actions.ts:122-136` and `app/cancel/[token]/actions.ts:231-244`. The command then compares the row's hash to itself (`0171:973-976`), which can never fail. Authorization on that path rests entirely on the app-layer HMAC verification, which is itself sound: a dedicated `APPOINTMENT_SIGNING_SECRET` with no service-role fallback (`lib/booking/tokens.ts:22-32`), constant-time compare (`:82-85`), payload bound to `appointment_id` + `expires_at` (`:95-110`). A defence-in-depth loss, not a live bypass — classed **AMB** in Matrix C because the 0171 header presents that in-command check as an independent authority and on this path it is not.

### 5.10 Reachability limits on the exposure

Three things bound how far W12 goes, and overstating the exposure is as much an error as understating it:

1. **No cross-tenant write path.** The policy's WITH CHECK plus the composite FKs of `0151:83-99` close it.
2. **No double-booking.** The shadow exclusion is path-independent (5.7).
3. **TRUNCATE is held but not reachable.** `anon` and `authenticated` hold TRUNCATE on the appointment-domain tables by the same default-privilege absence, but PostgREST exposes no TRUNCATE verb, so no browser-reachable channel can issue it. Doctrine and hygiene gap, not an exploit.

And one caveat on the whole of W12: the *absence* of any grant/revoke in the migrations is proven by source; that this leaves `authenticated` **holding** the privilege is a property of the hosted cluster's default privileges. The two DB tests in 5.1 assert it on a freshly-migrated chain, which is strong, but the hosted grant state itself is **UNPROVEN (static audit)** — a `has_table_privilege` probe against production would convert it from proven-by-absence to proven-by-measurement.

---

## 6. RLS and grant analysis

This section resolves the database boundary itself: what privileges the browser roles hold, what RLS actually evaluates, and which invariants the schema enforces regardless of who writes. Every object is presented at its **effective current definition**, resolved by walking `supabase/migrations/0001`..`0171` in numeric order (0158 permanently skipped) and taking the last redefinition.

### 6.1 The grant model

#### 6.1.1 There is no grant, because nobody ever wrote one

No migration in the repository issues a `GRANT` or `REVOKE` on any appointment-domain table. Filtering function grants out of every `grant`/`revoke` statement in `supabase/migrations/` and matching on `appointment|reservation` returns nothing:

```
$ rg -n -i '^\s*(grant|revoke)\b' supabase/migrations/ | rg -v 'on function|on all functions' | rg -i 'appointment|reservation'
(no output)
```

This is an omission, not a policy. The same 170 migrations issue explicit table grants for nineteen other tables — `treatment_images` (`supabase/migrations/0092_treatment_images.sql:106`), `clinical_audit_events` (`supabase/migrations/0120_clinical_record_corrections_amendments_phase2.sql:206`), `session_copy_operations` (`supabase/migrations/0157_whole_session_copy_setup.sql:115`), `client_intake_forms` (`supabase/migrations/0163_revoke_authenticated_intake_insert.sql:116`), and the six clinical tables twice (`supabase/migrations/0159_retire_signed_clinical_records.sql:458`, `supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql:82-87`). **The appointment domain is the one major domain that never received one.**

There is likewise no `alter default privileges` and no `grant … on all tables in schema public` statement anywhere in the migration set. The baseline is therefore whatever Supabase established at project creation, outside the migration chain.

#### 6.1.2 What the Supabase default implies

Supabase's project-creation defaults grant `anon` and `authenticated` all table privileges on new `public` tables. The repository states this in its own migration prose, written by the team that measured production:

| Statement | Source |
|---|---|
| "RLS does NOT gate TRUNCATE, and Supabase grants ALL on public tables to anon/authenticated by default" | `supabase/migrations/0089_imported_treatment_memory.sql:350-351` |
| "the platform-default DELETE grant to authenticated/anon was never revoked" | `supabase/migrations/0115_entry_hard_delete_hardening.sql:9-10` |
| "holding a privilege because Supabase's ALTER DEFAULT PRIVILEGES grants it at create time. Revoke from the ROLE, explicitly, by name." | `supabase/migrations/0163_revoke_authenticated_intake_insert.sql:116-118` |
| "revoke EVERY table privilege from the browser roles first — this covers not just INSERT/UPDATE/DELETE but also TRUNCATE, REFERENCES, and TRIGGER (none of which RLS protects)" | `supabase/migrations/0157_whole_session_copy_setup.sql:104-107` |

Derived effective ACL for the five appointment-domain tables:

| Table | `anon` | `authenticated` | Grant/revoke in any migration |
|---|---|---|---|
| `appointments` | SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER | same | none |
| `appointment_audit` | same | same | none |
| `appointment_payments` | same | same | none (`0032_stripe_connect_phase_1.sql:1422` enables RLS only) |
| `appointment_policy_acknowledgements` | same | same | none |
| `studio_calendar_reservations` | same | same | none |

The **privilege** layer is wide open across the whole domain. Everything that constrains a browser role here is RLS — and RLS governs only SELECT/INSERT/UPDATE/DELETE.

The live production ACL is **UNPROVEN (static audit)** — no hosted query was run. Three independent lines of evidence converge on the table above: the total absence of grant statements, the two DB tests in §6.1.3, and the post-apply verification blocks the migration authors wrote for themselves.

#### 6.1.3 The two DB tests that pin the open posture

The open posture is not merely inferred; two repository DB tests assert it against a freshly-migrated chain and **pass**:

| Test | Assertion |
|---|---|
| `tests/db/public-appointment-command.db.test.ts:475-489` — `it("THIS PR does not revoke any appointment table grant")` | `has_table_privilege(rolname, 'public.appointments', 'INSERT'/'UPDATE'/'DELETE')` is `true` for both `anon` and `authenticated` |
| `tests/db/public-reschedule-command.db.test.ts:1430-1443` — `it("revokes NOTHING from the appointments table")` | identical three-privilege assertion, both roles |

The first carries the comment: *"Deliberately still TRUE — the revocation is a LATER PR, after every remaining appointment writer has migrated to a reviewed command"* (`tests/db/public-appointment-command.db.test.ts:484-486`).

The two newest migrations carry matching post-apply probes for the operator:

- `supabase/migrations/0170_public_appointment_command.sql:1012-1019` — *"EXPECT both roles still TRUE on all three. This migration revokes NOTHING; the appointment DML revocation is a LATER PR."*
- `supabase/migrations/0171_public_reschedule_command_v2.sql:1501-1507` — verbatim repeat.

**Consequence for remediation:** both tests assert the *current* posture as a locked-in fact. A revoking migration must invert them, not merely add a new test. No test anywhere asserts an appointment *RLS* posture; `has_table_privilege` never appears alongside `appointments` outside those two files.

#### 6.1.4 Contrast: 0169 deliberately excluded appointments

The complete executable body of `supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql:78-89` revokes `insert, update, delete` from `authenticated` on exactly six **clinical** tables: `sessions`, `session_blocks`, `session_block_areas`, `electrolysis_entries`, `laser_entries`, `treatment_images`. No appointment-domain table appears. The pattern, the idiom and the lock timeout are all already proven in production at migration 0169 — only the table list is missing.

### 6.2 Effective RLS policy set

`ENABLE ROW LEVEL SECURITY` is present for all five tables. `DISABLE ROW LEVEL SECURITY` appears in no migration. **`FORCE ROW LEVEL SECURITY` appears nowhere in the repository** (`rg -n -i 'force row level security' .` returns nothing), so the table owner and any `SECURITY DEFINER` function it owns bypass RLS — which is exactly the mechanism the command layer relies on.

| Table | RLS enabled at | Policies (effective) | Commands with **no** policy ⇒ default-denied |
|---|---|---|---|
| `appointments` | `0010_booking_v1.sql:241` | `appointments_member_all` — `0010:273-277` | none |
| `appointment_audit` | `0010:242` | `appointment_audit_member_read` (SELECT) `0010:280-288`; `appointment_audit_member_insert` (INSERT) `0010:291-299` | **UPDATE, DELETE** |
| `appointment_payments` | `0032_stripe_connect_phase_1.sql:1422` | **none** | SELECT, INSERT, UPDATE, DELETE |
| `appointment_policy_acknowledgements` | `0056_appointment_policy_acknowledgements.sql:84-85` | `appointment_policy_acks_studio_member_select` (SELECT, `to authenticated`) `0056:97-100` | INSERT, UPDATE, DELETE |
| `studio_calendar_reservations` | `0030_calendar_reservations.sql:180` | `studio_calendar_reservations_member_select` (SELECT) `0030:187-190` | INSERT, UPDATE, DELETE |

#### 6.2.1 `appointments` — one policy, `FOR ALL`, membership-only

`supabase/migrations/0010_booking_v1.sql:272-277`, never redefined and never dropped (`rg -n -U '(create|drop) policy[^;]{0,400}?on public\.appointments\b' supabase/migrations/` returns only lines 272-274 of that file):

```sql
drop policy if exists "appointments_member_all" on public.appointments;
create policy "appointments_member_all"
  on public.appointments
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));
```

| Field | Value |
|---|---|
| Command | **ALL** — SELECT + INSERT + UPDATE + DELETE |
| Roles | **none named ⇒ `PUBLIC`**, so it applies to `anon` and `authenticated` alike |
| USING / WITH CHECK | both `public.is_studio_member(studio_id)` — nothing else |

There is no role gate, no owner gate, no column restriction and no status predicate. Every guarantee the fifteen commands enforce — actor authorisation, status legality, availability, audit — is a property of the code path, not of this policy.

#### 6.2.2 `appointment_audit` — insertable, but not editable

Both policies constrain **only** that `appointment_id` resolves to an appointment in a studio the caller belongs to (`0010:283-288`, `0010:294-299`). The row's own content is entirely caller-supplied: `actor_type` carries a value CHECK (`0010:220`, `in ('practitioner','client','system')`), `actor_id` is a **bare uuid with no FK and no correlation to `actor_type`** (`0010:221`), `action` and `details` are unconstrained (`0010:222-223`), and `created_at` is a plain writable column with only a default (`0010:224`).

**Correction to earlier census drafts:** existing audit rows **cannot** be UPDATEd or DELETEd by a member. Only SELECT and INSERT policies exist, and RLS default-denies any command with no matching policy. Audit rows are erasable only through the appointment's own `on delete cascade` (`0010:219`). The exposure is forgery and destruction-by-cascade, not in-place tampering.

There is also **no append-only trigger** on `appointment_audit`, though the pattern is established twice elsewhere in this schema: `stripe_payment_audit_immutable` (`0032:1411`) and `clinical_audit_events_append_only` (`0120_clinical_record_corrections_amendments_phase2.sql:219`).

#### 6.2.3 `appointment_payments` — total default-deny

Zero policies exist across all 170 migrations. The section header at `0032:396-399` states the design: *"14 payment tables … NO policies for anon or authenticated. All access via SECURITY DEFINER RPCs."* Practitioner-facing reads go through three `authenticated`-executable display RPCs — `get_appointment_payment_display` (`0032:7281-7282`), `get_refunds_for_appointment` (`0032:7358-7359`), `get_payment_audit_for_appointment` (`0032:7423-7424`). This is the posture the appointment domain should have had.

#### 6.2.4 `appointment_policy_acknowledgements` — SELECT-only, and the comment says why

`0056:97-100` is `for select to authenticated using (public.is_studio_member(studio_id))`. The migration states the intent at `0056:87-94`: no INSERT/UPDATE/DELETE policy *"because … we want hard-delete and after-the-fact mutation locked down by RLS default-deny so the acknowledgement trail is append-only by construction."* That intent survives at the RLS layer and is defeated only by the appointment's `on delete cascade` (`0056:33-34`).

#### 6.2.5 `studio_calendar_reservations` — SELECT-only, trigger-written

`0030:187-190` is the sole policy, role-unqualified. `0030:182-184` states: *"SELECT only. INSERT/UPDATE/DELETE have no policy and the table default-denies; only the SECURITY DEFINER trigger functions write to the shadow."* A member cannot delete shadow rows through PostgREST. This matters because the shadow is the path-independent collision authority (§6.5.2).

### 6.3 Policy helper functions

Every appointment-domain policy resolves to exactly one predicate.

**`public.is_studio_member(uuid)`** — effective at `supabase/migrations/0001_init.sql:153-167`, the only definition in the repository:

```sql
create or replace function public.is_studio_member(target_studio_id uuid)
returns boolean language sql stable security definer
set search_path = public
as $$
  select exists (
    select 1 from public.practitioners
     where studio_id = target_studio_id
       and user_id = auth.uid()
       and active = true
  );
$$;
```

| Property | Value |
|---|---|
| Checks | an `active = true` practitioner row in the target studio whose `user_id = auth.uid()` |
| Does **not** check | `role` — an ordinary practitioner and an owner are indistinguishable to `appointments_member_all` |
| Volatility / security | `stable`, `SECURITY DEFINER` |
| `search_path` pin | `public` (`0001:158`) — the older, weaker pin; later functions use `pg_catalog, pg_temp` or `""`. Body references are schema-qualified, so not exploitable |
| EXECUTE | `revoke all … from public` then `grant execute … to authenticated` (`0001:186`, `0001:188`). Per the 0129/0130 lesson, revoking from `PUBLIC` does not remove Supabase's default `anon` grant — but `auth.uid()` is null for `anon`, so the predicate is false for every row regardless |

**`public.is_studio_owner(uuid)`** (`0001:169-184`) is the same shape plus `and role = 'owner'`. **No appointment-domain policy uses it.** Owner-only semantics exist only inside command bodies (e.g. `supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql:437-441`).

**`public.studio_capacity_enabled(uuid)`** (`0134_practitioner_capacity_foundation.sql:295-306`) is not a policy helper but is load-bearing for two triggers: it reads the **live** `studios.practitioner_capacity_enabled`, coalescing to `false`. It is `stable`, `SECURITY DEFINER`, `search_path = pg_catalog, pg_temp`.

### 6.4 The effective trigger set on `public.appointments`

Seven triggers are live. Postgres fires row triggers of the same timing/event in **trigger-name alphabetical order**; both orderings below are derived from the names, not asserted from a live catalog.

#### 6.4.1 BEFORE row triggers — fire in this order

| Order | Trigger | Events / column list | Function (effective) | Established | Enforces / mutates |
|---|---|---|---|---|---|
| 1 | `appointments_enforce_buffer_trg` | `BEFORE INSERT OR UPDATE OF starts_at, ends_at, status, practitioner_id, booked_outside_availability, capacity_enabled` | `enforce_appointment_buffer()` `0152:217-238` | trigger `0152:241-246` | mutates nothing; raises SQLSTATE `HB001` on a soft-buffer violation |
| 2 | `appointments_set_capacity_enabled_trg` | `BEFORE INSERT OR UPDATE OF studio_id, practitioner_id, status` | `set_appointment_capacity_enabled()` `0134:106-122` | trigger `0134:124-128` | writes `NEW.capacity_enabled` from `studios.practitioner_capacity_enabled` |
| 3 | `appointments_snapshot_buffer_trg` | `BEFORE INSERT OR UPDATE` — **no column list, deliberately** | `snapshot_appointment_buffer()` `0029:62-95` | trigger `0029:107-110` | writes `NEW.buffer_minutes_snapshot`, `NEW.blocked_ends_at` |
| 4 | `appointments_sync_version_bump_trg` | `BEFORE INSERT OR UPDATE` — no column list | `bump_appointment_sync_version()` `0125:60-76` | trigger `0125:83-85` | writes `NEW.sync_version` |

Firing order is safe despite trigger 1 preceding trigger 2: `enforce_appointment_buffer` derives capacity itself via `public.studio_capacity_enabled(new.studio_id)` (`0152:228`) rather than reading `new.capacity_enabled`, so it never depends on trigger 2 having run.

`0029:102-106` states explicitly why trigger 3 carries no column list: an `of studio_id, starts_at, ends_at` filter *"would let a malicious or buggy caller bypass the snapshot via a direct UPDATE on the protected columns themselves."* Trigger 2 reintroduced exactly that shape by omitting `capacity_enabled` from its own list.

The deployed body of `snapshot_appointment_buffer` is asserted by three repository tests to differ from repo source, carrying an out-of-band GUC bypass `app.bypass_appointment_buffer_snapshot` that no migration creates (`tests/migrations/0171-public-reschedule-command.test.ts:177-181`, `tests/security/public-reschedule-command-guard.test.ts:459-464`, `tests/db/public-reschedule-atomicity-google.db.test.ts:19-21`). **UNPROVEN (static audit)** — but it means any future `create or replace` of that function from repo source would silently delete a live production behaviour.

#### 6.4.2 AFTER row triggers

| Order | Trigger | Events / column list | Function (effective) | Established | Enforces |
|---|---|---|---|---|---|
| 1 | `appointments_sync_calendar_reservation_trg` | `AFTER INSERT OR DELETE OR UPDATE OF status, studio_id, starts_at, ends_at, blocked_ends_at, practitioner_id` | `sync_appointment_to_calendar_reservation()` **`0152:108-151`** | trigger `0134:478-483` (widened from `0030:570-575`) | maintains the shadow row that carries the unconditional collision exclusion |
| 2 | `appointments_zzz_outbound_enqueue_delete_trg` | `AFTER DELETE` | `enqueue_calendar_outbound_on_delete()` **`0132:372-420`** | trigger `0125:372-374` | Google outbound queue (dormant) |
| 3 | `appointments_zzz_outbound_enqueue_trg` | `AFTER INSERT OR UPDATE OF starts_at, ends_at, status, sync_version` | `enqueue_calendar_outbound()` **`0132:249-362`** | trigger `0125:323-325` | Google outbound queue (dormant) |

The effective shadow writer (`0152:117-149`) deletes on `DELETE`; on INSERT/UPDATE it mirrors `status in ('confirmed','completed')` (`0152:123`), computes `v_rk` from `public.studio_capacity_enabled(new.studio_id)` — **the live studio flag, not the row's own `capacity_enabled`** (`0152:124-128`) — upserts the **actual** interval `(new.starts_at, new.ends_at)` with no buffer expansion (`0152:133-134`), and deletes any stale row under a different `resource_key` (`0152:142-143`).

#### 6.4.3 Dropped, and the missing trigger

`appointments_hash_cancellation_token_trg` (created `0090_appointment_token_hash.sql:127-130`) was dropped with its function at `0091_drop_raw_cancellation_token.sql:329-331`. It is not live.

**No trigger writes `appointment_audit`.** Every audit row in the system is written by an explicit `insert into public.appointment_audit` inside a command body. The audit-trigger pattern exists in this codebase — record-keeping audit triggers at `supabase/migrations/0086_record_keeping_audit_events.sql:193-301` — and was never applied here.

**No `set_updated_at` trigger exists on `appointments`.** `updated_at timestamptz not null default now()` (`0010:189`) is maintained only by writers that set it explicitly; essentially every other mutable table in the schema has one (`0015:74`, `0019:52`, `0034:98`, `0053:125`, `0058:179`, `0140:144`).

#### 6.4.4 The one indirect mutation path

`public.rematerialize_studio_reservations(uuid)` — effective at `0137_scoped_blocks_and_breaks.sql:247`, superseding `0134:492` and `0136:160` — contains `update public.appointments set capacity_enabled = v_enabled where studio_id = p_studio_id …` (`0137:266-268`). Two triggers on other tables invoke it: `studios_capacity_flag_change_trg` (`0134:570-574`, `AFTER UPDATE OF practitioner_capacity_enabled` on `studios`) and `practitioners_capacity_refan_trg` (`0134:609-613`, on `practitioners`, guarded by `studio_capacity_enabled`). No other trigger function anywhere performs DML against `appointments`.

### 6.5 The effective constraint set

#### 6.5.1 On `public.appointments`

| Name | Kind | Definition | Established |
|---|---|---|---|
| `appointments_pkey` | PK | `(id)` | `0010:175` |
| `appointments_id_studio_id_unique` | UNIQUE | `(id, studio_id)` | `0032:265-266` |
| `appointments_id_client_id_studio_id_unique` | UNIQUE | `(id, client_id, studio_id)` | `0032:267-269` |
| `appointments_cancellation_token_hash_uniq` | UNIQUE INDEX (partial) | `(cancellation_token_hash) where … is not null` | `0090:98-100` |
| `appointments_range_check` | CHECK | `ends_at > starts_at` | `0010:194-196` |
| `appointments_duration_check` | CHECK | `duration_minutes between 5 and 480` | `0010:200-202` |
| status (inline) | CHECK | `status in ('confirmed','cancelled','completed','no_show')` | `0010:183` |
| `cancelled_by` (inline) | CHECK | `cancelled_by in ('client','practitioner','owner') or null` | `0010:187` |
| `cancellation_kind` (inline) | CHECK | `null or in ('rescheduled','withdrawn')` | `0125:51-52` |
| `appointments_buffer_snapshot_non_negative` | CHECK | `buffer_minutes_snapshot >= 0` | `0029:183-184` |
| `appointments_blocked_ends_at_after_ends_at` | CHECK | `blocked_ends_at >= ends_at` | `0029:193-194` |
| `appointments_blocked_end_matches_snapshot` | CHECK | `blocked_ends_at = ends_at + make_interval(mins => buffer_minutes_snapshot)` | `0029:209-212` |
| `appointments_cancellation_token_hash_check` | CHECK | `null or ~ '^[a-f0-9]{64}$'` | `0090:86-90` |
| `appointments_capacity_requires_practitioner` | CHECK | `capacity_enabled = false or practitioner_id is not null or status not in ('confirmed','completed')` | `0134:141-146` |
| **`no_overlapping_appointments_studio_wide`** | EXCLUDE gist | `studio_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&` **WHERE** `status='confirmed' and capacity_enabled=false` | `0152:80-85` |
| **`no_overlapping_appointments_per_practitioner`** | EXCLUDE gist | `practitioner_id WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&` **WHERE** `status='confirmed' and capacity_enabled=true` | `0152:92-97` |

Foreign keys and cascades:

| Constraint | Definition | Established |
|---|---|---|
| `studio_id` FK (inline) | `→ studios(id) ON DELETE CASCADE` | `0010:176` |
| `appointments_client_same_studio_fk` | `(client_id, studio_id) → clients(id, studio_id) ON DELETE CASCADE` | `0151_appointment_tenant_consistency.sql:84-86` |
| `appointments_service_same_studio_fk` | `(service_id, studio_id) → services(id, studio_id) ON DELETE SET NULL (service_id)` | `0151:91-93` |
| `appointments_practitioner_same_studio_fk` | `(practitioner_id, studio_id) → practitioners(id, studio_id) ON DELETE SET NULL (practitioner_id)` | `0151:97-99` |
| self-FKs | `rescheduled_from/to_appointment_id → appointments(id) ON DELETE SET NULL` | `0125:47-50` |

The three composite same-studio FKs replaced the single-column ones dropped at `0151:74-76`. **They are why there is no cross-tenant write path:** a forged row cannot bind another studio's client, service or practitioner.

Children of `appointments`, and what a `DELETE` does to them:

| Child | Action | Established |
|---|---|---|
| `appointment_audit` | **CASCADE** — the audit history dies with the row | `0010:219` |
| `appointment_policy_acknowledgements` | **CASCADE** — the signed acknowledgement evidence dies with the row | `0056:33-34` |
| `appointment_payments` | **RESTRICT** — a paid appointment cannot be deleted | `0032:747` |

Dropped along the way and **not** current: `no_overlapping_active_appointments_per_studio` (`0029:236`, dropped `0134:259`); its 0134 buffer-expanded replacements on `blocked_ends_at` (dropped and replaced at `0152:78`/`0152:90`); `appointments_cancellation_token_unique` (`0025:28`, dropped `0091:340`).

Two gaps worth naming: `duration_minutes` is tied by no constraint to `ends_at - starts_at`, and there is **no status-transition constraint anywhere** — `0010:183` is value-only. The transition-guard pattern exists in this codebase (`guard_retired_finalization_transition`, `0159:241-277`; `client_intake_forms_terminal_immutability`, `0162:352-356`) but was never applied to appointments.

#### 6.5.2 On `public.studio_calendar_reservations` — the unconditional exclusion

| Name | Kind | Definition | Established |
|---|---|---|---|
| `studio_calendar_reservations_source_unique` | UNIQUE | `(source_kind, source_id, resource_key)` — re-keyed, name deliberately preserved so `on conflict on constraint` bindings still bind | `0134:211-213` (was `(source_kind, source_id)` at `0030:171-173`) |
| `studio_calendar_reservations_kind_check` | CHECK | `source_kind in ('appointment','timed_block','full_day_blockout','recurring_break_occurrence')` | `0030:146-153` |
| `studio_calendar_reservations_range_check` | CHECK | `ends_at > starts_at` | `0030:161-163` |
| **`no_overlapping_calendar_reservations_per_resource`** | EXCLUDE gist | `resource_key WITH =, tstzrange(starts_at, ends_at, '[)') WITH &&` — **NOT partial** | `0134:238-243` |
| `practitioner_id` FK | FOREIGN KEY | `→ practitioners(id) ON DELETE CASCADE` | `0134:155-156` |

`resource_key` is `NOT NULL` (`0134:165-166`) and defaults to `studio_id` via the BEFORE INSERT trigger `studio_calendar_reservations_resource_key_default_trg` (`0134:190-193`, function `0134:176-188`). The 0030 predecessor `no_overlapping_calendar_reservations_per_studio` was dropped at `0134:230-231`.

**This constraint is the load-bearing correction to several census drafts.** It is unconditional, it is a table constraint, and its feeding trigger fires for direct DML exactly as it does for a command. Because `resource_key` derives from the live studio flag (`0152:124-128`) and not from the row's own `capacity_enabled`, forging that column does not re-key the shadow row. **Actual double-booking is therefore NOT achievable by direct DML.** The shadow additionally catches what no appointments-table constraint covers at all: appointment-vs-`timed_block`/`full_day_blockout`/`recurring_break_occurrence`, and confirmed-vs-`completed` overlap.

#### 6.5.3 What the database enforces regardless of writer

| Invariant | Mechanism |
|---|---|
| `ends_at > starts_at`; `duration_minutes ∈ [5,480]`; `status` value legality | CHECKs `0010:194`, `0010:200`, `0010:183` |
| buffer-snapshot self-consistency | CHECKs `0029:183/193/209` + trigger `0029:107` |
| client / service / practitioner belong to the **same studio** | composite FKs `0151:84/91/97` |
| capacity-ON confirmed/completed rows carry a practitioner | CHECK `0134:141-146` |
| actual-interval overlap, studio-wide (capacity OFF) | EXCLUDE `0152:80-85` |
| actual-interval overlap, per-practitioner (capacity ON) | EXCLUDE `0152:92-97` |
| appointment vs block/blockout/break, and confirmed vs completed | EXCLUDE `0134:238-243`, trigger-fed by `0134:478-483` |
| `sync_version` monotonicity on serialized-field change | trigger `0125:83-85` |

### 6.6 The brief's eleven Phase-4 questions

Threat model for "reachable": a signed-in studio member holding a normal Supabase JWT (role `authenticated`) issuing raw PostgREST requests with the publishable anon key — exactly what the browser already carries (`lib/supabase/server.ts:7-9`).

| # | Question | Verdict | Evidence |
|---|---|---|---|
| Q1 | Can an authenticated practitioner directly `INSERT` an appointment? | **YES** | `supabase/migrations/0010_booking_v1.sql:273-277`; grant never revoked, `tests/db/public-appointment-command.db.test.ts:475-489` |
| Q2 | Can they directly `UPDATE` arbitrary columns? | **YES** | same `FOR ALL` policy, `0010:275`; only `buffer_minutes_snapshot`/`blocked_ends_at` are trigger-protected (`0029:107-110`) |
| Q3 | Can they change `practitioner_id` directly? | **YES** (within their own studio) | no policy/trigger guards the column; cross-studio blocked by `0151:97-99` |
| Q4 | Can they change `studio_id` directly? | **QUALIFIED** — no for a single-studio member; yes for a member of two studios moving all four columns at once | USING evaluates OLD, WITH CHECK evaluates NEW (`0010:276-277`); composite FKs `0151:84-99` force client/service/practitioner to be re-pointed together |
| Q5 | Can they set an illegal status directly? | **PARTLY** — illegal values no, illegal transitions yes | `0010:183` is value-only; no transition constraint or trigger exists anywhere |
| Q6 | Can they bypass `appointment_audit` entirely? | **YES** | no trigger writes it; every row comes from an explicit `insert into public.appointment_audit` inside a command (e.g. `0170:906`, `0171:1363`) |
| Q7 | Can they tamper with existing `appointment_audit` rows? | **FORGE-ONLY** — insert yes, update/delete no | INSERT policy `0010:291-299` constrains only `appointment_id`; no UPDATE/DELETE policy ⇒ RLS default-deny. `actor_id` has no FK (`0010:221`), `created_at` is plain-writable (`0010:224`) |
| Q8 | Can they bypass availability / buffer / collision checks? | **PARTLY** — hard overlap survives; availability and buffer do not | SURVIVES: `0152:80-97` + `0134:238-243`. BYPASSED: `validate_appointment_availability` is called only from RPCs (`0152:250+`), and `enforce_appointment_buffer` self-disables on `booked_outside_availability = true` (`0152:226-227`), a plain column (`0152:66`) |
| Q9 | Can they `DELETE` an appointment? | **YES** | `FOR ALL` includes DELETE (`0010:275`); cascades destroy the audit trail (`0010:219`) and acknowledgements (`0056:33-34`). Blocked only for paid rows by RESTRICT (`0032:747`) |
| Q10 | Can public/anonymous callers mutate appointments directly? | **NO** | `anon` holds the privilege but `is_studio_member` is false with `auth.uid()` null (`0001:160-166`); every appointment RPC is EXECUTE-revoked from `anon` (`tests/db/public-appointment-command.db.test.ts:416-429`, and `:435-458` proves SQLSTATE `42501` on a real call) |
| Q11 | Can they `TRUNCATE` any appointment-domain table? | **UNREACHABLE** | the privilege is held (§6.1.2) and RLS does not gate TRUNCATE (`0089:350-351`), but PostgREST exposes no TRUNCATE verb and `authenticated` is a NOLOGIN role. **UNPROVEN (static audit)** that any browser path exists; treat as a doctrine gap, not an exploit |

### 6.7 Which revocations would break legitimate flows today

#### 6.7.1 `revoke insert, update, delete on public.appointments from authenticated` — **BREAKS NOTHING**

An exhaustive scan of every `.from("appointments")` statement chain in `app/`, `lib/` and `components/` finds **55 chains**, of which exactly **seven** are mutating. All seven use the service-role admin client and write only `postcare_email_*` bookkeeping columns:

| Path:line | Verb | Client | Columns |
|---|---|---|---|
| `app/(app)/calendar/actions.ts:1115` | UPDATE | `admin` (`:1039-1040`) | `postcare_email_claimed_at`, `..._last_attempt_at`, `..._send_attempts` |
| `app/(app)/calendar/actions.ts:1156` | UPDATE | `admin` | same three (resend branch) |
| `app/(app)/calendar/actions.ts:1212` | UPDATE | `admin` | `postcare_email_failed_at`, `..._last_error`, `..._claimed_at` |
| `app/(app)/calendar/actions.ts:1243` | UPDATE | `admin` | `postcare_email_sent_at`, `..._failed_at`, `..._last_error`, `..._claimed_at` |
| `app/(app)/calendar/postcare-auto-send.ts:151` | UPDATE | `admin` | claim triple |
| `app/(app)/calendar/postcare-auto-send.ts:186` | UPDATE | `admin` | failure triple |
| `app/(app)/calendar/postcare-auto-send.ts:200` | UPDATE | `admin` | success quad |

There is **zero** `.insert(` and **zero** `.delete(` on `appointments` anywhere in the codebase, and no dynamic `.from(table)` resolves to `"appointments"` for a write. Every other appointment mutation goes through a `service_role`-only `SECURITY DEFINER` command.

**An appointments-scoped clone of `0169:82-87` is a pure no-op for the deployed application.** The only things it breaks are the two tests that pin the current posture (§6.1.3), which must be inverted in the same PR.

The same reasoning extends to `anon`: every public and pre-auth route already uses the service-role client (`app/book/[slug]/actions.ts`, `app/cancel/[token]/actions.ts`, `app/reschedule/[token]/actions.ts`, `app/manage/[token]/actions.ts`, `app/calendar-feed/[token]/route.ts`, `lib/portal/queries.ts`), so `anon` needs no privilege at all on any appointment-domain table.

#### 6.7.2 `revoke select … from authenticated` — **BREAKS THE PRODUCT.** Do not.

SELECT on `appointments` from the authenticated, RLS-bound client (`lib/supabase/server.ts:4-9`) is load-bearing across fourteen surfaces:

| Path:line | Surface that breaks |
|---|---|
| `lib/booking/queries.ts:237` (`getAppointmentsForRange`) | the entire internal calendar, incl. `MonthView` |
| `app/(app)/calendar/[id]/page.tsx:100` | appointment detail page |
| `app/(app)/calendar/upcoming/page.tsx:23` | upcoming list |
| `app/(app)/calendar/actions.ts:356`, `:473`, `:797` | post-book read-back, client context, last-service suggestion |
| `app/(app)/dashboard/page.tsx:142` | dashboard |
| `app/(app)/global-search-actions.ts:235`, `:247`, `:276` | global search |
| `lib/dashboard/practice-metrics.ts:247`, `:273` | practice metrics |
| `lib/dashboard/missing-records-assistant.ts:322`, `:368` | missing-records assistant |
| `lib/supabase/queries.ts:401`, `:504` | shared client-profile queries |
| `lib/billing/quick-checkout.ts:59` | quick-checkout eligibility |
| `app/(app)/settings/data/actions.ts:120` | studio data export |
| `app/(app)/clients/[id]/sessions/new/actions.ts:138` | session-creation appointment link |
| `app/(app)/clients/[id]/sessions/[sessionId]/page.tsx:188` | session detail |

Two further authenticated-client reads must also be retained:

- **`appointment_audit` SELECT** — `app/(app)/calendar/[id]/page.tsx:131-138`, the only application read of the table. Gated on `isCancelled`, filtered to `action='cancelled'`, selecting `details` alone. This is the surface on which forged `details` reach a rendered practitioner-facing page; forged `actor_id`/`actor_type` are stored but never rendered.
- **`studio_calendar_reservations` SELECT** — `lib/booking/slots.ts:253-257`, reached with the authenticated client from the internal quick-book slot generator (`app/(app)/clients/[id]/booking-actions.ts:84-85`, client from `:32`; `app/(app)/calendar/actions.ts:269-270`, client from `:197`). The public booking page passes the admin client instead.

**Net:** the boundary migration is `revoke insert, update, delete` on the appointment-domain tables from `authenticated` (and all privileges from `anon`), retaining `select` for `authenticated` on `appointments`, `appointment_audit` and `studio_calendar_reservations`, and `select` on `appointment_policy_acknowledgements` (its policy already restricts to members, `0056:97-100`). `appointment_payments` needs nothing retained — it has no policy at all and is read only through the three `authenticated` display RPCs (`0032:7282`, `0032:7359`, `0032:7424`).

One open question the revoke does not answer by itself: `appointment_audit`'s **INSERT** grant. Revoking it closes forgery, but `appointment_audit_member_insert` (`0010:291-299`) then becomes dead policy text, and no application code inserts audit rows with the authenticated client — the write is done inside command bodies under `service_role`. Revoking INSERT is therefore also a no-op for the deployed app, and the policy should be dropped in the same migration rather than left as a false signal.

---

## 7. Transition and invariant matrix

### 7.1 Ground truth — the permitted value set

`public.appointments.status` is a bare `text` column with an inline four-value CHECK, `not null`, defaulting to `'confirmed'`:

`supabase/migrations/0010_booking_v1.sql:183` — `status text not null default 'confirmed' check (status in ('confirmed','cancelled','completed','no_show'))`

No later migration drops, replaces or widens `appointments_status_check`. There is no Postgres enum type for appointment status anywhere in the chain.

The TypeScript union is declared once, at `lib/types/database.ts:362-366`:

| Source | Values | Agreement |
|---|---|---|
| DB CHECK, `0010:183` | `confirmed`, `cancelled`, `completed`, `no_show` | — |
| TS `AppointmentStatus`, `lib/types/database.ts:362-366` | identical four, identical spellings | **No drift** |
| UI prop union, `app/(app)/calendar/AppointmentLifecycleActions.tsx:42` | identical four | No drift |

There is no generated Supabase types module in the tree — `lib/types/database.ts` is hand-written, so the CHECK and the union are the only two authorities and they match. All four values are written by at least one shipped command (§7.3); none is orphaned.

Three adjacent columns are status-shaped but are **not** part of the state machine: `cancelled_by` (`0010:187`, CHECK `client|practitioner|owner`), `cancellation_kind` (`0125:51-52`, CHECK `rescheduled|withdrawn`), and `capacity_enabled` (`0134:104`, a trigger-derived mirror of the studio flag).

### 7.2 There is no transition constraint anywhere in the database

Every effective CHECK on `appointments` restricts a **value**, never a **movement**. This is structurally unavoidable for a CHECK — it cannot reference `OLD` — so the question is whether a trigger does the job. None does:

| Trigger | Effective function | Validates old→new status? |
|---|---|---|
| `appointments_snapshot_buffer_trg` (`0029:107`) | `snapshot_appointment_buffer()` `0029:62` | No |
| `appointments_set_capacity_enabled_trg` (`0134:124`) | `set_appointment_capacity_enabled()` `0134:106` | No — copies the studio flag |
| `appointments_sync_version_bump_trg` (`0125:83`) | `bump_appointment_sync_version()` `0125:60` | No — bumps on **any** status change (`0125:71-73`) |
| `appointments_enforce_buffer_trg` (`0152:241`) | `enforce_appointment_buffer()` `0152:217` | No — arms only on `new.status = 'confirmed'` (`0152:226`) |
| `appointments_sync_calendar_reservation_trg` (`0134:478`) | `sync_appointment_to_calendar_reservation()` `0152:108` | No — branches on `new.status` alone (`0152:123`) |
| `appointments_zzz_outbound_enqueue_trg` (`0125:323`) | `enqueue_calendar_outbound()` `0132:249` | No — reads `old.status` only to decide whether to *enqueue*, never to refuse |
| `appointments_zzz_outbound_enqueue_delete_trg` (`0125:372`) | `enqueue_calendar_outbound_on_delete()` `0125:333` | n/a (DELETE) |

The only two constraints that reference status at all are the partial GiST exclusions `no_overlapping_appointments_studio_wide` (`0152:80-85`) and `no_overlapping_appointments_per_practitioner` (`0152:90-96`), both `where status = 'confirmed'`, and `appointments_capacity_requires_practitioner` (`0134:140-146`). All three constrain the *new* row only.

**Consequence:** the database enforces which values the column may hold and nothing about which value may follow which. Every transition rule in this product lives inside the body of a `SECURITY DEFINER` command function and applies only when a caller chooses to invoke it. §7.6 shows that a caller who does not is a real, browser-reachable actor.

### 7.3 Legal transitions

All six status-mutating commands are `SECURITY DEFINER` and EXECUTE-granted to `service_role` only; `anon` and `authenticated` hold EXECUTE on none of them. In the "Server-side?" column, "Yes (SQL)" means the guard sits inside the function body under `FOR UPDATE` and no caller of that function can skip it. "Bypassed by direct DML?" means an authenticated active practitioner can reach the same end-state through PostgREST without the command (§7.6).

#### Creation

| # | → | Actor / workflow | Enforcement site | Server-side? | Audit written? |
|---|---|---|---|---|---|
| T1 | (none)→`confirmed` | anonymous visitor, `/book/[slug]` | `app/book/[slug]/actions.ts:776` → `create_public_appointment` `0170:636`; INSERT at `0170:898` with a **literal** `'confirmed'` | Yes (SQL) — the caller has no status parameter | Yes, same txn — `0170:906-913`, `action='created'`, `actor_type='client'`, `details.source='public_booking'` |
| T2 | (none)→`confirmed` | practitioner/owner, calendar quick-book | `app/(app)/calendar/actions.ts:311` → `create_internal_appointment_v2` `0152:376`; INSERT with literal `'confirmed'` | Yes (SQL) | Yes, same txn — `0152:515-524`, `action='created'`, `details.source='internal_booking_command_v2'` |

T1 is not DML-bypassable by its own actor: `anon` fails RLS because `is_studio_member` (`0001_init.sql:153-166`) requires an authenticated practitioner row. T2 **is** bypassable.

#### Status-changing transitions

| # | Transition | Actor | Enforcement site (guards) | Server-side? | Bypassed by direct DML? |
|---|---|---|---|---|---|
| T3 | `confirmed`→`confirmed` (move/reassign) | owner, or practitioner on own appointments | `move_or_reassign_appointment` `0152:537`; source-state + past-start guard `0152:597`; optimistic concurrency `0152:602-607`; role gate `0152:618-636`; UPDATE `0152:686-692` never sets status | Yes (SQL) | Yes |
| T4 | `confirmed`→`completed` | any **active** practitioner | `mark_appointment_complete` `0032:4052`; membership `0032:4064-4070` (42501); `for update` `0032:4072-4075`; source state `0032:4079`; **time gate `0032:4082` (`ends_at > now()` → raise)**; UPDATE `0032:4086-4088` | Yes (SQL) | **Yes — and the `ends_at` gate is what is lost** |
| T5 | `confirmed`→`cancelled` (client token) | token holder, no login | `public_cancel_appointment_with_token` `0091:75`; hash-only match under `for update` `0091:98-101`; `already_cancelled` `0091:107`; `not_cancelable` `0091:112`; past-start `0091:117`; UPDATE `0091:122-128` | Yes (SQL) | Yes for a member; no for the token holder |
| T6 | `confirmed`→`cancelled` (staff) | any **active** practitioner | `practitioner_cancel_appointment` `0033:241`; role read from the live practitioner row `0033:255-262`; `already_cancelled` `0033:273`; `not_cancelable` `0033:277`; **post-start refusal `0033:287`** (rule stated at `0033:281-286`); UPDATE `0033:291-297` | Yes (SQL) — actor role is derived, never accepted | Yes |
| T7 | `confirmed`→`cancelled` + new `confirmed` successor (reschedule) | token holder, `/reschedule/[token]` | `reschedule_appointment_v2` `0171:797`; authoritative re-read under locks `0171:956-966`; token re-verify `0171:973-982`; source state `0171:986`; payment refusal `0171:1162-1182`; cancel `0171:1301-1308` (sets `cancellation_kind='rescheduled'` in the **same** statement, `0171:1295-1300`); successor INSERT `0171:1324-1334` | Yes (SQL), fully atomic | Yes for a member |
| T8 | `confirmed`→`no_show` | any **active** practitioner | `mark_appointment_no_show` `0033:334`; membership `0033:346-354`; `for update` `0033:356-360`; source state `0033:365` (`wrong_status`); **time gate `0033:369-370` (`too_early`)**; UPDATE `0033:373-376` | Yes (SQL) | **Yes — the `ends_at` gate is what is lost** |

Audit rows for T3–T8, all written inside the same transaction as the status flip:

| # | Action value | actor_type | Line |
|---|---|---|---|
| T3 | `moved` / `reassigned` / `moved_and_reassigned` | practitioner | `0152:694-710` |
| T4 | `marked_complete` | practitioner | `0032:4090-4095` |
| T5 | `cancelled` | client (`actor_id` null) | `0091:130-141` |
| T6 | `cancelled` | practitioner | `0033:299-308` |
| T7 | `cancelled` on the original + `created` on the successor | client, both | `0171:1363-1371`, `0171:1373-1380` |
| T8 | `marked_no_show` | practitioner | `0033:378-386` |

**No trigger writes `appointment_audit`.** Every row above is written explicitly by the command. A writer that skips the command writes zero audit rows.

T4 has a second, non-UI caller: `app/(app)/clients/[id]/sessions/new/actions.ts:49`, the charting "Start session" auto-complete. It pre-filters in TypeScript at `:39` (`status !== "confirmed"` → return) and `:42-44` (`endsAt > Date.now()` → return) and is fail-soft, but the DB guards at `0032:4079` and `0032:4082` remain authoritative.

### 7.4 Terminal-state behaviour

`cancelled`, `completed` and `no_show` are terminal **at the command layer only**. Every status-mutating command reads the row `FOR UPDATE` and refuses a source status other than `confirmed`:

| Command | Refusal on a non-`confirmed` source |
|---|---|
| `public_cancel_appointment_with_token` | `already_cancelled` `0091:107` / `not_cancelable` `0091:112` |
| `practitioner_cancel_appointment` | `already_cancelled` `0033:273` / `not_cancelable` `0033:277` |
| `mark_appointment_complete` | **raises** P0002 `0032:4079` |
| `mark_appointment_no_show` | `wrong_status` `0033:365` |
| `reschedule_appointment_v2` | `appointment_not_reschedulable` `0171:986` |
| `move_or_reassign_appointment` | `appointment_not_movable` `0152:597` |

There is no command in the tree whose UPDATE can be reached with a source status other than `confirmed`. The UI reinforces this — `AppointmentLifecycleActions.tsx:79` renders nothing once `status !== "confirmed"` — but that is presentation, not enforcement.

Terminal rows also drop out of the reminder cron (`app/api/cron/appointment-reminders/route.ts:84`, `.eq("status","confirmed")`) and out of both table GiST exclusions (`where status='confirmed'`, `0152:84`, `0152:96`). `cancelled` and `no_show` lose their shadow reservation (`0152:145-147`); `completed` **keeps** one (`0152:123`), so after completion the interval is protected by `studio_calendar_reservations` rather than by the appointments table itself.

### 7.5 Illegal transitions — what actually stops them

"Should forbid" is taken from the product's own stated rules at `0033:281-286`, `0032:4045-4049` and `AppointmentLifecycleActions.tsx:79`.

| # | Transition the product should forbid | Stopped by a command? | Stopped by the DB? | Stopped end-to-end today? |
|---|---|---|---|---|
| I1 | `completed`→`confirmed` | Yes — `0032:4079`, `0033:277`, `0033:365`, `0091:112`, `0152:597`, `0171:986` | **No** — no CHECK, no trigger; `enqueue_calendar_outbound` emits an `event.create`/`event.update` (`0132:271-279`) | **No** — direct DML |
| I2 | `cancelled`→`completed` | Yes — `0032:4079` raises | **No** — the only side-effect is re-insertion of the shadow reservation (`0152:123-140`), which raises 23P01 only if the slot was rebooked | **No** |
| I3 | `no_show`→`completed` | Yes — `0032:4079` | **No** — as I2 | **No** |
| I4 | `cancelled`→`cancelled` (double cancel) | Yes — both cancel commands return `already_cancelled` **before** any write (`0091:107`, `0033:273`); no second audit row | **No** — a direct re-UPDATE silently rewrites `cancelled_at`/`cancelled_by`/`cancellation_reason` | Command path yes; direct DML **no** |
| I5 | `completed`→`cancelled` | Yes — `0033:277`, `0091:112` | **No** — and the trigger emits an `event.delete` to Google (`0132:315-326`) | **No** |
| I6 | `completed`→`no_show` | Yes — `0033:365` | **No** | **No** |
| I7 | `no_show`↔`cancelled` | Yes — `0033:365` / `0091:112` | **No** | **No** |
| I8 | `confirmed`→`completed` **before `ends_at`** | Yes — `0032:4082` raises `appointment has not yet ended` | **No** — nothing ties `status='completed'` to `ends_at <= now()` | **No** — see §7.7 payment note |
| I9 | `confirmed`→`no_show` **before `ends_at`** | Yes — `0033:369-370` returns `too_early` | **No** | **No** |
| I10 | `confirmed`→`cancelled` **after `starts_at`** | Yes — `0033:287`, `0091:117` | **No** | **No** |
| I11 | `confirmed`→`confirmed` at a new time without the move command | Yes — `0152:597-607` | **Partial** — the GiST exclusions (`0152:80-96`), `enforce_appointment_buffer` (`0152:226` → HB001) and the shadow's unconditional exclusion (`0134:238-243`) all fire on a direct UPDATE, so a *colliding* move is genuinely refused. Availability windows, blockouts, breaks, role gating, optimistic concurrency and the audit row are not enforced. | Collisions yes; everything else **no** |
| I12 | Any transition with **no** audit row | Yes — every command writes its audit in the same txn | **No** — no trigger writes `appointment_audit` | **No** |
| I13 | Row DELETE instead of a terminal status | n/a — no command deletes; no `.delete()` on `appointments` exists in `app/` or `lib/` | **No** — and `appointment_audit.appointment_id … on delete cascade` (`0010:219`) destroys the whole audit trail with the row | **No** |

**The command layer forbids all thirteen. The database layer forbids none of them.** The state machine is a property of which function you call, not of the data.

### 7.6 Why the direct-DML column is not hypothetical

The single RLS policy on the table is `appointments_member_all` (`0010:272-277`), `for all` with USING and WITH CHECK both `public.is_studio_member(studio_id)` — no role gate, no per-command narrowing. No grant or revoke touches `public.appointments` in any of the 170 migrations, so `anon` and `authenticated` retain Supabase's default INSERT/UPDATE/DELETE. The repo pins this deliberately: `tests/db/public-appointment-command.db.test.ts:474-489` and `tests/db/public-reschedule-command.db.test.ts:1430-1443` both assert `has_table_privilege` INSERT/UPDATE/DELETE = true for both roles. Migration 0169 revoked exactly these privileges on six clinical tables (`0169:82-87`) and excluded appointments by design.

Scope: `anon` fails RLS (no `auth.uid()`), and portal clients are not Supabase auth users, so this is a **member-privilege** exposure — any active practitioner of the studio, same-studio only. The composite same-studio FKs added at `0151:83-99` block cross-tenant binding.

The audit table compounds it. `appointment_audit_member_insert` (`0010:291-299`) constrains only that `appointment_id` belongs to the caller's studio; `action`, `details`, `actor_id` (bare uuid, no FK) and `created_at` (`0010:224`, plain writable column) are entirely caller-controlled, so a member can fabricate history. Forged `details` reach a rendered practitioner-facing surface — `app/(app)/calendar/[id]/page.tsx:130-139` reads the newest `action='cancelled'` row's `details` when `isCancelled`. Existing audit rows, however, **cannot** be UPDATEd or DELETEd: RLS default-denies commands with no matching policy, and only the appointment's own cascade erases them.

### 7.7 Side-effect implications of each transition

| Transition | Notification | Payment | Google Calendar | Postcare |
|---|---|---|---|---|
| →`confirmed` (public) | `new_booking`, `app/book/[slug]/actions.ts:970` — post-commit, fire-and-forget | none | `event.create`/`event.update` (`0132:271-272`) | none |
| →`confirmed` (internal) | none | none | same INSERT arm | none |
| →`completed` | none | **Unlocks session payment** — `lib/billing/session-payment-eligibility.ts:142` requires `status === "completed"` | **Nothing enqueued** — `completed` falls through to `else return new` (`0132:327-328`) | Auto-send fires when `postcare_delivery_mode='auto_on_complete'`; gate `postcare-auto-send.ts:48`, claim re-asserts `.eq("status","completed")` at `:160` |
| →`cancelled` (token) | `appointment_cancelled`, `app/cancel/[token]/actions.ts:327` — post-commit | enables `late_cancel` manual fee, `lib/billing/manual-fee-eligibility.ts:144-151` | `event.delete` (`0132:315-326`) | never |
| →`cancelled` (staff) | none to staff; a client email at `app/(app)/calendar/actions.ts:492-514`, try/catch-swallowed | same as above | `event.delete` | never |
| reschedule (T7) | `appointment_rescheduled`, `app/reschedule/[token]/actions.ts:1114` — post-commit | **refuses** if any payment state exists (`0171:1162-1182`) | original: **no** delete (`0132:318-320` short-circuits on `cancellation_kind='rescheduled'`); successor adopts the predecessor's link with `last_hone_version=0` (`0132:286-292`) | none |
| →`no_show` | **none** — no notification, no client email | enables `no_show` manual fee (`manual-fee-eligibility.ts:144-151`); the **only** gate is the status string | **Nothing enqueued** — same fall-through as `completed`; the Google event stays looking like a normal appointment | never |

Every notification is post-commit and best-effort: a status flip can commit with no notification, but a notification can never exist without the flip.

Two payment observations are load-bearing for I8. First, manual fees (`late_cancel`, `no_show`) are on a hard LIVE hold — `lib/billing/live-charge-reason-allowlist.ts:19` permits only `session_payment` in live mode, applied at `manual-fee-eligibility.ts:172`. Second, `session_payment` therefore *is* live-reachable, and its appointment-side gate is the status string alone (`session-payment-eligibility.ts:142`); the only time check on that path is `sessions.started_at IS NOT NULL` (`session-payment-eligibility.ts:133-136`), which is a property of the session, not of the appointment's `ends_at`. A forged `completed` on a future appointment is therefore not caught downstream. **UNPROVEN (static audit)** whether any production row is in that state.

Note also that the **manual** postcare send (`app/(app)/calendar/actions.ts:1114-1127`) carries no status filter at all — it claims on `postcare_email_sent_at IS NULL` plus a stale-claim window and is reachable for a `cancelled` or `no_show` appointment from the detail page. Low impact (practitioner-initiated, studio-settings-only body), recorded for completeness.

### 7.8 Dead schema in the transition domain

| Object | Defined | Writer at this head |
|---|---|---|
| `appointments.cancellation_kind = 'withdrawn'` | `0125:51-52` CHECK permits it | **None in `app/` or `lib/`.** Only DB tests set it via raw SQL (`tests/db/google-calendar-b2-3b-reconcile.db.test.ts:487,664,699,769`). Production cancels leave it NULL; only `reschedule_appointment_v2` writes `'rescheduled'` (`0171:1306`). The read side does branch on it (`tests/lib/google-calendar/sync/reconcile.test.ts:54`), so the value is consumed but never produced. |
| `appointments.no_show_email_sent_at`, `no_show_email_send_attempts` | `0025:20`, `0028:23` | **No live writer.** A service-role path exists — `record_email_attempt` with `p_email_type='no_show'` (`0033:96-104`) — and `EmailType` includes `"no_show"` (`lib/email/send-appointment.ts:154-158`), but all three call sites pass `"confirmation"` (`app/book/[slug]/actions.ts:1092`, `app/reschedule/[token]/actions.ts:1074`, `app/(app)/calendar/actions.ts:911`). The columns are read-only display at `app/(app)/calendar/[id]/page.tsx:717-721`. |
| `/api/cron/no-show-check` | route exists | **Deliberately non-mutating.** `app/api/cron/no-show-check/route.ts:44-54` returns `{disabled:true, scanned:0, marked:0}` after a `CRON_SECRET` check; the rationale and the required redesign are documented at `:8-36`. There is no automatic no-show writer, and the route is not registered in `vercel.json`. |
| `public.reschedule_appointment` (legacy) | `0091:186` | **Caller-less**, retained by design (`0171:61-66`), service_role EXECUTE still granted (`0091:311-322`). It has none of the v2 guards and does not set `cancellation_kind`, so if invoked it would emit the predecessor `event.delete` that `0171:1295-1300` exists to prevent. |

`public.create_or_claim_charge_attempt` is **not** part of this picture: it was dropped at `0103_mode_scoped_stripe_connect_provisioning.sql:590`. Its `status='completed' AND ends_at <= now()` gate (`0032:4193-4197`) no longer exists in the database at this head and must not be cited as a compensating control.

---

## 8. Availability and collision matrix

### 8.1 Columns — the six mutation paths

| # | Path | App entry point | Final DB writer (EFFECTIVE) |
|---|---|---|---|
| **IC** | Internal create (calendar quick-book, client-profile book) | `app/(app)/calendar/actions.ts:311` | `create_internal_appointment_v2` — `0152:376` |
| **PB** | Public booking (unauthenticated slug page) | `app/book/[slug]/actions.ts:776` | `create_public_appointment` — `0170:636` |
| **RS** | Client-token reschedule | `app/reschedule/[token]/actions.ts:774` | `reschedule_appointment_v2` — `0171:797` |
| **MV** | Internal move (time change, same practitioner) | `app/(app)/calendar/move-appointment-actions.ts:352` | `move_or_reassign_appointment` — `0152:537` |
| **RA** | Reassignment (practitioner change, ± time change) | same call, `p_target_practitioner_id` non-null | same function — `0152:537` |
| **DML** | Direct authenticated PostgREST DML | any active practitioner's browser session | raw INSERT/UPDATE/DELETE under policy `appointments_member_all` — `0010:272-277` |

MV and RA are the *same* RPC; they differ only in which gates the branch reaches (`v_reassign`, `0152:616`) and in the app-side mode contract (`move-appointment-actions.ts:209`, `:236`).

Two legacy RPCs sit outside the six. `reschedule_appointment` (EFFECTIVE `0091:186`) is caller-less and materially weaker — treated as a footnote row below. `practitioner_move_appointment` (EFFECTIVE `0145:200`) is **not** weaker: its whole body is a 7-argument delegate to `move_or_reassign_appointment` (`0145:220-227`), and since 0148 dropped the 7-arg overload and created the 8-arg one (`0148:31-41`), that call now resolves to the EFFECTIVE 0152 body with `p_allow_outside_availability` defaulted false. It therefore inherits every MV cell in this matrix.

**Path abbreviations used in the tables.** Migration numbers are files under `supabase/migrations/`: `0152` = `0152_actual_overlap_hard_buffer_soft.sql`, `0170` = `0170_public_appointment_command.sql`, `0171` = `0171_public_reschedule_command_v2.sql`, `0134` = `0134_practitioner_capacity_foundation.sql`, `0137` = `0137_scoped_blocks_and_breaks.sql`, `0091` = `0091_drop_raw_cancellation_token.sql`, `0010` = `0010_booking_v1.sql`, `0001` = `0001_init.sql`, `0121` = `0121_google_calendar_connection_foundation.sql`, `0148` = `0148_move_reassign_availability_validator.sql`. App abbreviations: `cal-act` = `app/(app)/calendar/actions.ts`, `mv-act` = `app/(app)/calendar/move-appointment-actions.ts`, `bk-act` = `app/book/[slug]/actions.ts`, `tz.ts` = `lib/booking/tz.ts`, `slots.ts` = `lib/booking/slots.ts`.

### 8.2 The two-layer collision model — read before the matrix

Actual-interval overlap is protected by **two independent table constraints**, which is why it is the one rule no path can weaken.

**Layer A — two partial GiST exclusions on `appointments` itself.**
`no_overlapping_appointments_studio_wide` — `exclude using gist (studio_id with =, tstzrange(starts_at, ends_at, '[)') with &&) where (status = 'confirmed' and capacity_enabled = false)` (`0152:80-85`).
`no_overlapping_appointments_per_practitioner` — same shape keyed on `practitioner_id`, `where (status = 'confirmed' and capacity_enabled = true)` (`0152:92-97`).
Both are `ALTER TABLE … ADD CONSTRAINT EXCLUDE`, evaluated by the index machinery on every row version. No trigger is involved, so **DML cannot sidestep them**. Their predicates are exhaustive over `status='confirmed'` because `capacity_enabled` is `boolean not null default false` (`0134:104`).

**Layer B — one unconditional GiST exclusion on the shadow.**
`no_overlapping_calendar_reservations_per_resource` — `exclude using gist (resource_key with =, tstzrange(starts_at, ends_at, '[)') with &&)`, **no partial predicate** (`0134:238-243`, inside the guarded block `0134:233-244`). Its appointment rows are written by the AFTER trigger `appointments_sync_calendar_reservation_trg` (`0134:478-483`) → `sync_appointment_to_calendar_reservation` (EFFECTIVE `0152:108-150`), which mirrors `status in ('confirmed','completed')` (`0152:123`) and derives `resource_key` from the **live studio flag** `studio_capacity_enabled()` (`0152:124-128`), not from the row's own `capacity_enabled`. Triggers fire for direct DML too.

Consequences that must not be overstated or understated:

* **Actual double-booking is NOT achievable by direct DML.** Layer A holds unconditionally; and where Layer A's partial predicate could be dodged (a `capacity_enabled`-only UPDATE does not re-fire `appointments_set_capacity_enabled_trg`, whose column list is `studio_id, practitioner_id, status` — `0134:124-128`), Layer B still catches the overlap because the shadow row keeps `resource_key = studio_id` at a capacity-OFF studio.
* **Layer B is the ONLY layer covering appointment-vs-block and confirmed-vs-completed.** Layer A is `status='confirmed'` only, so a `completed` row blocks through the shadow alone.
* `cancelled` and `no_show` free the slot on both layers — Layer A by predicate, Layer B by the `else delete` branch (`0152:144-146`). That is the intended product rule.

### 8.3 Matrix A — rules R1–R4

Legend: **DB** = enforced inside the database · **APP** = enforced only in TypeScript before the call · **NOT-ENF** = not enforced on this path · **N-A** = rule does not apply.

| Rule | IC | PB | RS | MV | RA | DML |
|---|---|---|---|---|---|---|
| **R1** practitioner availability (weekly + date overrides) | APP `cal-act:262-292`; DB **cap-ON only** `0152:290`/`:322-352` | DB `0170:525-562` (studio-wide rows only) + APP `bk-act:492-504` | DB both modes `0171:656-719` | APP `mv-act:320-345` (`available_slot` mode only); DB **cap-ON only** `0152:676`→`0152:290` | same as MV | **NOT-ENF** — no trigger or constraint encodes a window |
| **R2** service duration authority | DB — locked service row `0152:458-461`; override owner-gated + range-checked `0152:437-441`, `:475-484` | DB — locked service row `0170:769-774`; no duration parameter in the signature | DB — locked ORIGINAL's `duration_minutes`, never the service default `0171:998` | DB `0152:674` | DB `0152:674` | **NOT-ENF** — no CHECK ties `ends_at − starts_at` to `duration_minutes` (`0010:182`, `:194-196` only) |
| **R3** cleanup / buffer | DB validator `0152:359-366` + trigger `0152:226-234`; **owner-bypassable** `0152:437-441` → stamped `0152:508-512` | DB pre-check `0170:573-593` + trigger; **not** bypassable (flag left at default, `0170:886`) | DB pre-check `0171:726-753` + trigger; **not** bypassable `0171:231-233` | DB `0152:676-684` + trigger; owner-bypassable `0152:633-637` → stamped `0152:690` | same as MV | DB trigger only — and **BYPASSABLE**: `0152:226-227` short-circuits on `booked_outside_availability`, a plain column (`0152:66`) |
| **R4** existing-appointment collision (actual overlap) | DB, unbypassable — Layer A `0152:80-85`/`:92-97`, Layer B `0134:238-243`. No in-function overlap test (`0152:355-358`) | DB, unbypassable + pre-check `0170:573-593` → `time_unavailable` | DB, unbypassable + pre-check `0171:726-753` | DB, unbypassable; no in-function overlap test | same as MV | **DB, unbypassable** — both layers apply to raw DML |

R3 trigger arming: `appointments_enforce_buffer_trg`, `before insert or update of starts_at, ends_at, status, practitioner_id, booked_outside_availability, capacity_enabled` (`0152:241-246`). `appointment_buffer_conflict` reads `studios.buffer_minutes` **live** (`0152:183-186`), not `buffer_minutes_snapshot`, and subtracts true overlap (`0152:203-206`) so the soft check never duplicates Layer A.

### 8.4 Matrix B — rules R5–R8

| Rule | IC | PB | RS | MV | RA | DML |
|---|---|---|---|---|---|---|
| **R5** blocked time (timed blocks, recurring breaks, full-day blockouts) | DB via shadow (all three, both modes); in-function blockout check **cap-ON only** `0152:313-319` | DB `0170:499-506` (blockout) + shadow collision `0170:573-593` | DB `0171:647-654` (blockout, both modes) + shadow collision `0171:726-753` | DB via shadow; in-function blockout **cap-ON only** `0152:313-319` | same as MV | **DB via shadow only** — Layer B `0134:238-243` |
| **R6** imported Google busy time | N-A | N-A | N-A | N-A | N-A | N-A |
| **R7** outside-hours override | DB **owner-only** `0152:437-441` + APP `cal-act:178` | N-A — no such parameter; flag left false `0170:886` | N-A — successor deliberately does not inherit it `0171:231-233` | DB **owner-only** `0152:633-637`; APP mode gate `mv-act:236`, `:267`, `:369` | same as MV | **NOT-ENF** — any member may write `booked_outside_availability = true` (`0152:66` + `0010:272-277`) |
| **R8** practitioner service eligibility | DB **cap-ON only** `0152:467-473` | DB **both modes**, and only when the service has a list `0170:450-462` | DB **cap-ON only** `0171:596-619` (deliberate; rationale `0171:561-595`) | DB **cap-ON only** `0152:650-659` | DB **cap-ON only** `0152:650-659` + APP pre-filter `mv-act:286` | **NOT-ENF** |

**R5 shadow materialisation, verified end to end.** Full-day blockouts: `sync_blockout_to_calendar_reservation` (EFFECTIVE `0134:421-448`) computes `v_start := (new.starts_on::timestamp) at time zone v_tz`, `v_end := ((new.ends_on + 1)::timestamp) at time zone v_tz` (`0134:441-442`) and calls `fanout_studio_wide_reservation` (EFFECTIVE `0137:173-189`) → `sync_scoped_calendar_reservation`, which at capacity-OFF writes exactly one row with `resource_key = studio_id` (`0137:162-165`). Appointments at capacity-OFF mirror to the same `resource_key` (`0152:127`). **A full-day blockout therefore still collides an appointment at a capacity-OFF studio even though `validate_appointment_availability` never reaches its own blockout test** — this corrects the intuitive reading of the `if v_cap` fence. Timed blocks and recurring-break occurrences mirror through the same synchroniser (`0137:194-228`, triggers `0137:232-242`).

Practitioner-**scoped** blocks and breaks write zero reservations at capacity-OFF (`0137:145-152`), but they also cannot be created at capacity-OFF: `guard_scoped_source_capacity` raises `42501` (`0137:86-90`). No gap today.

**R6 is genuinely N-A, not a miss.** No ingest, no table, no reader. `external_calendar_busy_events` appears exactly once in the tree — a comment listing what 0121 deliberately does not add (`0121:22`). The only artefact is the dormant flag `studios.google_calendar_inbound_busy_enabled boolean not null default false` (`0121:57`).

### 8.5 Matrix C — rules R9–R12

| Rule | IC | PB | RS | MV | RA | DML |
|---|---|---|---|---|---|---|
| **R9** active practitioner | DB **both modes** — actor `0152:425-431`, **target** `0152:443-449` (outside the `v_cap` fence) | DB `0170:437-445`; practitioner is server-derived as the sole active owner or NULL `0170:819-833` | DB **cap-ON only** `0171:1209-1223` (deliberate) | DB actor both modes `0152:619-626`; **target cap-ON only** `0152:639-649` | same as MV | **PARTIAL** — RLS requires the ACTOR be active (`is_studio_member`, `0001:153-166`); nothing checks the target `practitioner_id` |
| **R10** studio timezone | APP local→UTC `QuickBookDrawer.tsx:593`; DB UTC→local `0152:305-306` | **DB both directions** — `public_booking_local_to_utc` `0170:172-201`, native `at time zone` `0170:489-495` | **DB both directions** — reuses the 0170 helper; UTC→local `0171:637-643` | APP local→UTC `mv-act:310`; DB UTC→local `0152:305-306` (cap-ON only) | same as MV | N-A — absolute instants only, never projected |
| **R11** DST transitions | DB/APP — no fixed offsets anywhere | DB `0170:154-201` | DB (0170 port reused, `0171:104-105`) | DB/APP | DB/APP | N-A |
| **R12** concurrent booking races | DB — `studios` FOR UPDATE `0152:408-413`, advisory `0152:418`, `services` FOR UPDATE `0152:458-461`. **No appointment-row lock.** | DB — `0170:678-682`, advisory `:688`, `services` `:769-774`, **window appointments FOR UPDATE** `:866-873` | DB — `0171:878-886`, advisory `:894`, **window ∪ original FOR UPDATE** `:941-951` | DB — `studios` `0152:572-577`, advisory `:583`, target row FOR UPDATE `:585-588`, optimistic `expected_starts_at/ends_at` `:603-608` | same as MV | **NOT-ENF** — no lock of any kind; only `23P01`/`HB001` |

IC, PB, RS, MV and RA all take `studios … FOR UPDATE` on the same row, so **every command-mediated write at one studio is fully serialised**. DML sits outside that serialisation entirely and is protected only by the two exclusion constraints.

### 8.6 The capacity-OFF degeneration of `validate_appointment_availability`

`validate_appointment_availability` (EFFECTIVE `0152:252-370`) opens with `if v_cap then` at **`0152:290`** and closes that block at `0152:353`. Everything inside it — active-target re-check (`:291-296`), service eligibility (`:298-303`), local-time projection (`:305-311`), full-day blockout (`:313-319`) and the working-hours window (`:322-352`, itself further gated by `if not p_allow_outside_availability` at `:323`) — is skipped when `studios.practitioner_capacity_enabled` is false. What remains is the soft buffer test at `0152:359-366`. **At a capacity-OFF studio the shared validator is buffer-only**, and every production studio is capacity-OFF (asserted `0134:11`, `0170:47-53` — UNPROVEN (static audit) against the hosted database).

The material effect on IC, MV and RA is that R1 (working hours) and R8 (eligibility) have **no DB enforcement at all** today; the app pre-check is the whole guarantee, and it is skipped on the owner override (`cal-act:262`) and in `custom_time` mode (`mv-act:320`). The effect is **not** as broad as the fence's placement suggests: R5 survives through Layer B (§8.4), R4 survives through both layers, R9's target check sits outside the fence (`0152:443-449`), and R3 runs unconditionally.

The two public commands are not fenced the same way. 0170 has no capacity fence on its window resolution at all (`0170:525-544`); 0171 fences only the *practitioner-scoped* probes of its four-probe precedence (`0171:663`, `:683`) while the studio-wide probes (`0171:673-682`, `:693-702`) run in both modes — so R1 holds for RS at capacity-OFF, degenerating to the same studio-wide resolution 0170 uses.

### 8.7 Timezone: two implementations of one algorithm

`lib/booking/tz.ts` derives every offset from `Intl.DateTimeFormat` at the instant in question (`tz.ts:23-38`) and `utcInstantFromLocal` double-samples the offset across a transition, re-applying when the two samples disagree (`tz.ts:42-68`). 0170 ports that algorithm into SQL rather than delegating to `AT TIME ZONE`, because Postgres and the TS helper disagree by one hour on both DST edges: `public_booking_tz_offset_minutes` (`0170:154-169`) and `public_booking_local_to_utc` (`0170:172-201`), rationale and measured Toronto values at `0170:82-92` and `0170:136-149`. 0171 reuses the 0170 port instead of writing a third implementation (`0171:104-105`). Both helpers are revoked from `public`/`anon`/`authenticated`/`service_role` and re-granted to `service_role` only (`0170:935-943`, `:960-961`).

Net: no path uses a fixed offset, and there is no DST finding. UNPROVEN (static audit): that the port is byte-identical to the TS helper for every IANA zone — 0170's header cites `America/Toronto` measurements only.

IC, MV and RA still convert in TypeScript (`QuickBookDrawer.tsx:593`, `mv-act:310`) and send an absolute instant, so they inherit the TS semantics; PB and RS convert in the database. The two implementations are *intended* to agree, and 0170 exists precisely because the naive third option (native `AT TIME ZONE` on the DB side) did not.

### 8.8 Absent rule — lead time / minimum notice

**There is no lead-time rule on any path.** `lib/booking/slots.ts:41-43` states it explicitly: *"NOT a lead-time / buffer. A slot starting one minute from now still passes. Add a separate helper if a real 'n-hour lead time' becomes a per-studio setting."* `filterFutureSlots` (`slots.ts:47`) is a past-time filter applied only on the public surfaces. Every command's sole temporal floor is `> now()` — IC `0152:490`, MV/RA `0152:610`, legacy reschedule `0091:231`. A client can book or reschedule into the next minute. This is a product gap, not a defect against any stated invariant.

### 8.9 Asymmetries — every path enforcing a weaker rule than another

| # | Rule(s) | Weaker path | Stronger path | Why it matters |
|---|---|---|---|---|
| **A1** | R1, R2, R3, R7, R8, R9, R12 — and the audit trail | **DML** | every command | The only policy on the table is `appointments_member_all` (`0010:272-277`), `for all` with `is_studio_member` (`0001:153-166`) in USING and WITH CHECK. R4 and R5 still hold (§8.2), and the composite same-studio FKs (`0151:83-99`) block cross-tenant writes — but a member can move a booking to a closed Sunday, inside another client's buffer, with no audit row. |
| **A2** | R1 + R8 at capacity-OFF, i.e. every production studio | **IC, MV, RA** (DB layer) | **PB, RS** | The `if v_cap` fence at `0152:290` removes both rules from the shared validator; PB (`0170:450-462`, `:525-562`) and RS (`0171:673-702`) enforce in both modes. The internal surfaces are left with a TypeScript pre-check that they themselves skip on override. |
| **A3** | R3 bypass authority | **DML** (any member sets `booked_outside_availability`) | **IC, MV, RA** (owner-only, re-checked in DB) | `0152:437-441` and `0152:633-637` return `not_authorized` for a non-owner; the underlying column has no write gate (`0152:66`). |
| **A4** | R9 target-practitioner active | **RS** (cap-ON only, `0171:1209`), **MV/RA** (cap-ON only, `0152:639-649`), **DML** (never) | **IC** (`0152:443-449`, both modes), **PB** (`0170:437-445`) | IC deliberately hoisted the target check outside the fence; the move and reschedule commands did not. |
| **A5** | R1 window-resolution algorithm | — | — | Three commands use three different precedences: 0152 prefers a practitioner-scoped row over a studio-wide one (`0152:325-341`); 0170 reads **studio-wide rows only** (`0170:510-531`, rationale `:508-524`); 0171 uses a four-probe order (`0171:656-702`). Deliberate and documented, but it means the same instant can be legal on one surface and refused on another once capacity is ON. |
| **A6** | R1, R2, R5, R12 + booking horizon | legacy **`reschedule_appointment`** (`0091:186-305`) | **RS** (`0171:797`) | The legacy body validates only `original.starts_at > now()` (`0091:224`), `new_starts_at > now()` (`0091:231`) and `ends > starts` (`0091:238`); it writes caller-supplied `p_new_ends_at` and `p_new_duration_minutes` verbatim (`0091:271-272`) and locks only the original row (`0091:210`). It is caller-less but retained and `service_role`-executable by design (`0171:61-66`). |
| **A7** | R7, R8, R9 target | **`practitioner_move_appointment`** — *no asymmetry* | — | Listed to close it out: the EFFECTIVE definition (`0145:200-229`) is a thin delegate whose 7-argument call now binds the 8-arg `move_or_reassign_appointment` (`0148:31-41`, body `0152:537`). It inherits MV's enforcement exactly, with the override defaulted false. |
| **A8** | R12 lock scope | **IC** (no appointment-row lock, `0152:408-461`) | **PB** (`0170:866-873`), **RS** (`0171:941-951`) | Only the public commands lock the candidate window's appointment rows. IC relies on the studio row lock plus `23P01`; correct, but it retries nothing and surfaces the constraint error instead. |

No asymmetry above permits a **cross-tenant** write (composite FKs, `0151:83-99`) or an **actual overlap of two confirmed appointments** (§8.2). Every asymmetry is a bypass of a *policy* rule — hours, eligibility, buffer, override authority, audit — not of the hard scheduling invariant.

---

## 9. Audit atomicity

### 9.1 `public.appointment_audit` — effective definition

Created at `supabase/migrations/0010_booking_v1.sql:217-225` and **never altered by any later migration**. A full sweep of the 170 applied files (`rg -n "appointment_audit" supabase/migrations/*.sql`) returns no `alter table`, no added constraint, no added index, and no `grant`/`revoke` naming the table after 0010.

| Column | Type / default | Notes |
|---|---|---|
| `id` | `uuid pk default gen_random_uuid()` | surrogate; never collides, so it is not a dedupe key |
| `appointment_id` | `uuid not null references public.appointments(id) on delete cascade` | `0010:219` — the only tenancy link |
| `actor_type` | `text not null check (in ('practitioner','client','system'))` | `0010:220` — value-checked, not identity-checked |
| `actor_id` | `uuid` (nullable) | `0010:221` — **no FK, no correlation to `actor_type`** |
| `action` | `text not null` | `0010:222` — free text; no enum, no CHECK |
| `details` | `jsonb` (nullable) | `0010:223` — untyped, unvalidated |
| `created_at` | `timestamptz not null default now()` | `0010:224` — plain writable column; not `GENERATED ALWAYS`, no trigger |

Structural properties that matter for atomicity:

- **No `studio_id` column** (`0010:217-225`). Tenancy is inherited transitively through `appointment_id`, which is why the audit row cannot outlive its appointment.
- **No unique/dedupe key.** The only unique object is the surrogate PK and the non-unique index `appointment_audit_appointment_idx (appointment_id, created_at desc)` (`0010:227-228`). Nothing at the database level prevents two identical rows for the same `(appointment_id, action, actor_id)`.
- **No idempotency key, request id, or `source` column.** `source` exists only as a convention inside `details`.
- **No trigger on the table** — no `create trigger … on public.appointment_audit` anywhere in the migration tree. Every audit row is written explicitly by a command; nothing writes one implicitly.
- **No append-only trigger.** The pattern exists elsewhere in this codebase (`stripe_payment_audit_immutable`, `0032:1411`; `clinical_audit_events_append_only`, `0120:219`) and was never applied here.
- **`on delete cascade`** (`0010:219`): deleting an appointment destroys its entire audit trail, with no tombstone.

### 9.2 RLS and grants

RLS is enabled at `0010:242`. Exactly two policies exist, both created in 0010 and never dropped or redefined:

| Policy | Command | Predicate | Location |
|---|---|---|---|
| `appointment_audit_member_read` | `FOR SELECT` | `appointment_id in (select id from public.appointments where public.is_studio_member(studio_id))` | `0010:280-288` |
| `appointment_audit_member_insert` | `FOR INSERT` (`WITH CHECK`) | same predicate | `0010:291-299` |

**There is no UPDATE policy and no DELETE policy.** Under RLS, a command with no matching policy is default-denied, so existing audit rows cannot be edited or individually deleted by a role subject to RLS. That is the whole of the append-only enforcement, and it is policy-level only — it does not survive the parent-row cascade.

The INSERT `WITH CHECK` constrains **only** `appointment_id`. `actor_type`, `actor_id`, `action`, `details` and `created_at` are entirely caller-supplied on that path.

Grants: **no `GRANT` and no `REVOKE` statement names `public.appointment_audit` in any migration.** The table therefore carries Supabase's `ALTER DEFAULT PRIVILEGES` defaults — the same posture the repository measures and documents for other never-granted tables at `0169_revoke_authenticated_clinical_direct_dml.sql:41-46`. `anon` cannot reach the rows in practice because it holds no EXECUTE on `public.is_studio_member` (`0001_init.sql:186-188`), so the policy predicate errors out for it.

| Role | SELECT | INSERT | UPDATE | DELETE |
|---|---|---|---|---|
| `service_role` | yes (RLS bypass) | yes | yes | yes |
| `authenticated`, active member of the appointment's studio | yes (`0010:280-288`) | **yes — full control of actor, action, details and `created_at`** (`0010:291-299`) | no (no policy) | no (no policy) |
| `authenticated`, non-member | no | no | no | no |
| `anon` | no | no | no | no |

`TRUNCATE`, `REFERENCES` and `TRIGGER` were likewise never revoked, unlike the clinical tables 0159 hardened (`0159:458-505`). TRUNCATE is not filtered by RLS, but no browser-reachable channel can issue it — PostgREST exposes no TRUNCATE verb — so this is doctrine, not an exploit.

### 9.3 What "one transaction" means on this stack

Two facts fix the whole analysis:

1. **PostgREST wraps each HTTP request in exactly one transaction.** A single `admin.rpc(...)` call therefore commits every statement in the function body together or none of them.
2. **supabase-js exposes no client-side transaction control.** There is no `BEGIN`/`COMMIT` available to a server action. Two `await`ed PostgREST calls from Node are two transactions, always, with no possible interleaving guarantee between them.

Consequently the paths partition cleanly: **single-RPC paths are atomic by construction; multi-call paths are categorically non-atomic.** No path is "probably atomic".

A supporting check: none of the six command-bearing migrations (`0032`, `0033`, `0091`, `0152`, `0170`, `0171`) contains an `exception when` / `when others` handler in any appointment command body. Nothing can swallow a failed audit insert from inside a command. `0170:884-888` says so explicitly: *"A 23P01 exclusion violation is deliberately not caught: it must roll the whole transaction back."*

### 9.4 Single-RPC paths — atomic by construction

Every audited mutation is one `plpgsql SECURITY DEFINER` function containing both the appointment write and the audit write, invoked by exactly one `admin.rpc(...)`. All EXECUTE grants are `revoke … from public, anon, authenticated` + `grant … to service_role`.

| # | Command (effective definition) | Appointment write | Audit write | One txn? | Actor origin |
|---|---|---|---|---|---|
| A1 | `create_public_appointment` (`0170:636-921`) | INSERT `0170:892-900` | INSERT `0170:906-914` | **YES** | server-set literal `'client'`, `actor_id` NULL — no parameter exists |
| A2 | `reschedule_appointment_v2` (`0171:797-1420`) | UPDATE + INSERT successor + lineage | 2 INSERTs `0171:1363`, `0171:1373` | **YES** | server-set `'client'` / NULL |
| A3 | `create_internal_appointment_v2` (`0152:376-528`) | INSERT `0152:505-513` | INSERT `0152:515-525` | **YES** | `p_actor_practitioner_id`, re-validated as an active member of `p_studio_id` (`0152:424-428`) |
| A4 | `move_or_reassign_appointment` (`0152:537-720`) | UPDATE `0152:686-692` | INSERT `0152:694-710` | **YES** | `p_actor_practitioner_id`, re-validated |
| A5 | `practitioner_cancel_appointment` (`0033:241-306`) | UPDATE `0033:291-297` | INSERT `0033:299-308` | **YES** | `p_practitioner_id` validated; the `cancelled_by` role is re-read server-side (`0033:255-259`) |
| A6 | `mark_appointment_complete` (`0032:4052-4097`) | UPDATE `0032:4086-4088` | INSERT `0032:4090-4095` | **YES** | `p_practitioner_id` validated (`0032:4064-4069`) |
| A7 | `mark_appointment_no_show` (`0033:334-390`) | UPDATE `0033:373-376` | INSERT `0033:378-386` | **YES** | `p_practitioner_id` validated |
| A8 | `public_cancel_appointment_with_token` (`0091:75-145`) | UPDATE `0091:122-128` | INSERT `0091:130-141` | **YES** | server-set `'client'` / NULL |
| A9 | `reschedule_appointment` — LEGACY, caller-less (`0091:186-305`) | UPDATE `0091:245-251` + INSERT `0091:253-276` | 2 INSERTs `0091:279`, `0091:293` | **YES** | server-set |
| A10 | `practitioner_move_appointment` — legacy delegate (`0145:200-228`) | via A4 | via A4 | YES | via A4 |
| A11 | `create_internal_appointment` — legacy wrapper (`0147:31-78`) | via A3 | via A3 | YES | via A3 |

**No path lets a browser choose the actor.** It is either a server-set literal or a `p_actor_practitioner_id` that the function re-validates against `practitioners` and that the app derives from `getCurrentPractitionerWithStudio()` (`app/(app)/calendar/actions.ts:313`, `app/(app)/calendar/move-appointment-actions.ts:352-355`).

**There is one behavioural proof of this in the repo**, not merely a structural argument: `tests/db/practitioner-move-appointment.db.test.ts:393-410` installs a temporary `BEFORE INSERT` trigger on `appointment_audit` that raises on `action='moved'`, calls the move command, and asserts the appointment's `starts_at` is unchanged — *"a forced audit-insert failure rolls back the appointment update"* (`:394`). The suite-wide invariant is pinned separately: `tests/db/public-appointment-command.db.test.ts:389-397` asserts every created appointment has **exactly one** audit row.

### 9.5 Retry and idempotency posture

**There is no idempotency key or request id anywhere in the appointment lifecycle**, and `appointment_audit` has no column for one. Retry safety is entirely structural.

| # | Retry → duplicate appointment? | Retry → duplicate audit row? | Guard |
|---|---|---|---|
| A1 | No — a second identical booking hits the unconditional GiST exclusion on the reservation shadow (`0134:238-243`, written by the trigger at `0152:108-150`) and raises `23P01` | No — rolls back with the appointment | GiST exclusion |
| A2 | No — the original's `cancellation_token_hash` is consumed; a second call returns `appointment_not_reschedulable` | No | token-hash CAS on the original |
| A3 | No (GiST: `no_overlapping_appointments_studio_wide` / `_per_practitioner`, `0152:80-97`) | No | GiST exclusion |
| A4 | n/a (UPDATE) | No | `p_expected_starts_at` / `p_expected_ends_at` optimistic CAS |
| A5 | n/a | No — a second call returns `already_cancelled` before any write | status guard |
| A6 | n/a | No — a second call raises `P0002` "not confirmed" before any write (`0032:4079-4080`) | status + `ends_at` guard |
| A7 | n/a | No | status + `ends_at` guard (`0033:365-371`) |
| A8 | n/a | No — `already_cancelled` short-circuits | token-hash lookup + status guard |
| A9 | n/a | No | none beyond the status guard; **no availability validation at all** |

Because audit rows only ever exist inside the same transaction as the mutation they describe, duplicate audit rows have **no reachable production path today**. Nothing in the schema would prevent them if a writer were ever added outside a command.

### 9.6 Multi-call paths — categorically non-atomic

These sit **beside** an atomic command, in a second PostgREST call from Node. Each is a separate transaction by definition.

| # | Surface | Detached write | Failure handling | Consequence |
|---|---|---|---|---|
| N1 | public cancel | `appointment_policy_acknowledgements` INSERT, `app/cancel/[token]/actions.ts:365-377`, guarded by `requiresAck` at `:360` | error logged and **swallowed** (`:378-383`); the action still returns `{ ok: true }` | a confirmed cancellation with no acknowledgement row |
| N2 | public booking | `booking_tracking_consents` INSERT, `app/book/[slug]/actions.ts:987-1007`, inside `void (async () => …)` with a bare `catch {}` at `:1005` | fire-and-forget, error logged only (`:999-1003`) | marketing-consent capture can be silently lost after a committed booking |
| N3 | mark complete | `autoSendPostcareOnComplete(...)`, `app/(app)/calendar/actions.ts:581-582`, invoked after `mark_appointment_complete` has already committed | fail-soft `catch` at `app/(app)/calendar/postcare-auto-send.ts:210-215` | an atomic completion with a non-atomic postcare tail (S5–S7 below) |
| N4 | public cancel / reschedule / booking | `recordPractitionerNotification({...})` — `app/cancel/[token]/actions.ts:327-338`, `app/book/[slug]/actions.ts:970-979`, `app/reschedule/[token]/actions.ts:1114` | fire-and-forget by design | notification loss only; carries no evidentiary weight |

**N1 is the material one.** The code itself states there is no recovery (`app/cancel/[token]/actions.ts:348-354`): *"Failure to write this row does NOT roll back the cancel… Re-running the action with the same token is a no-op (the RPC rejects non-confirmed source state), so we cannot retry the ack here."* The acknowledgement is not cosmetic: `appointment_policy_acknowledgements(id)` is the `ON DELETE RESTRICT` FK target for manual fee charges (`0064:148`) and is a required condition of fee eligibility (`lib/billing/manual-fee-eligibility.ts:44`, query at `:287`). A cancel that commits without it silently forfeits the studio's ability to charge or defend a late-cancellation fee.

**0171 fixed exactly this defect for reschedule and not for cancel.** `reschedule_appointment_v2` writes the acknowledgement inside the transaction at `0171:1393-1403`, under the comment at `0171:1390-1392`: *"The route used to write this AFTER the RPC committed, in a statement whose error was logged and swallowed — so a confirmed reschedule could exist with no acknowledgement, which is precisely the evidence a fee dispute needs."* The reschedule route now passes `p_acknowledged_policy` and `p_presented_policy_snapshot_hash` into the command (`app/reschedule/[token]/actions.ts:780-781`) and performs no acknowledgement write of its own. The cancel route — the surface fees are actually charged on — still writes it outside.

The same fix was applied to the audit row on the booking path by 0170; the route comment records the old shape and its one production casualty (`app/book/[slug]/actions.ts:761-766`, `:1010-1015`).

### 9.7 Mutations that write NO audit row (silent mutation)

Silent mutation is worse than non-atomic mutation: there is no partial record to reconcile. The list below is exhaustive for shipped code, established by a scan of every `.from("appointments")` in `app/ lib/ components/ scripts/` (52 sites, of which exactly 7 are writes and the rest `.select`) plus every SQL mutation of `public.appointments` across all 170 migrations.

**Application-layer writes — all service-role, all `.eq("id")`+`.eq("studio_id")` scoped:**

| # | Site | Columns mutated | Audit? |
|---|---|---|---|
| S1 | `app/(app)/calendar/actions.ts:1114-1129` — first-send claim | `postcare_email_claimed_at`, `_last_attempt_at`, `_send_attempts` | none |
| S2 | `app/(app)/calendar/actions.ts:1155-1163` — resend claim | same | none |
| S3 | `app/(app)/calendar/actions.ts:1211-1219` — failure stamp | `postcare_email_failed_at`, `_last_error`, `_claimed_at` | none |
| S4 | `app/(app)/calendar/actions.ts:1242-1250` — success stamp | `postcare_email_sent_at`, `_failed_at`, `_last_error`, `_claimed_at` | none |
| S5 | `app/(app)/calendar/postcare-auto-send.ts:151-163` — auto claim | as S1 | none |
| S6 | `app/(app)/calendar/postcare-auto-send.ts:186-194` — auto failure | as S3 | none |
| S7 | `app/(app)/calendar/postcare-auto-send.ts:200-209` — auto success | as S4 | none |

These seven are the **only** direct appointment DML left in shipped application code, and none records who triggered it. A practitioner clicking *Resend* restamps `postcare_email_sent_at` and bumps `postcare_email_send_attempts` with no actor and no distinction between a first send and a resend. The four writes in each flow are four independent transactions; the claim can commit and the success stamp fail — the code logs that exact case at `app/(app)/calendar/actions.ts:1252-1266` and deliberately under-claims ("still sending") rather than overclaiming "sent".

**Database-layer writers — SECURITY DEFINER, service-role or definer-only, none audited:**

| # | Function (effective) | Columns mutated |
|---|---|---|
| S8 | `claim_email_send` (`0098:45-113`) | `{confirmation,reminder_24h,reminder_2h,intake_reminder_7d,intake_reminder_3d}_{send_attempts,claimed_at}` |
| S9 | `record_email_result` (`0098:118-155`) | `*_sent_at`, `*_claimed_at` |
| S10 | `record_email_attempt` (`0033:63-110`) | `{confirmation,reminder_24h,reminder_2h,no_show}_{send_attempts,sent_at}` |
| S11 | `claim_sms_send` (`0049:170-218`) | `sms_*_{send_attempts,claimed_at}` |
| S12 | `record_sms_result` (`0049:230-258`) | `sms_*_sent_at`, `sms_*_claimed_at` |
| S13 | `repair_bump_appointment_sync_version` (`0125:384-390`) | `sync_version` |
| S14 | `rematerialize_studio_reservations` (`0137:247-...`) | `capacity_enabled` (bulk, whole studio) |

**The unbounded one:**

| # | Path | Scope |
|---|---|---|
| S15 | Direct PostgREST DML on `public.appointments` by any authenticated active studio member — policy `appointments_member_all` (`0010:272-277`), grants never revoked | **any column** (`status`, `starts_at`, `practitioner_id`, `notes`, `cancellation_token_hash`, …) plus DELETE, with **no audit row**, and DELETE additionally cascades the existing trail away via `0010:219` |

S15 is what makes the audited command surface optional from the client's point of view: every guard in §9.4 — the `ends_at` gate, the terminal-status refusals, the actor attribution — is skippable by writing the row directly. The grants are still open by design and pinned as such by two repo tests (`tests/db/public-appointment-command.db.test.ts:474-489`, `tests/db/public-reschedule-command.db.test.ts:1430-1443`); 0171 confirms it changes nothing (`0171:1507`). The countervailing fact is that the shadow-reservation trigger fires on direct DML too, so a *time* change still faces the GiST exclusion (`0134:238-243`) — status, practitioner, notes and DELETE face none.

### 9.8 Sensitive data in audit payloads

`details` is untyped `jsonb` with no schema, no validation, no redaction and no deletion path other than destroying the parent appointment.

| Command | Free text / PII stored in `details` | Location |
|---|---|---|
| `create_public_appointment` | the client's `email` (read server-side from `public.clients`, not accepted from the caller) and the visitor's raw `notes` | `0170:906-914` |
| `public_cancel_appointment_with_token` | `note` — free text typed by an unauthenticated visitor holding a cancellation token — plus `reason`, `reason_label`, `follow_up_allowed` | `0091:130-141` |
| `practitioner_cancel_appointment` | `reason` free text | `0033:299-308` |
| `create_internal_appointment_v2`, `move_or_reassign_appointment`, `reschedule_appointment_v2`, `mark_appointment_complete`, `mark_appointment_no_show` | ids, timestamps and flags only — no free text | `0152:515-525`, `0152:694-710`, `0171:1363-1380`, `0032:4090-4095`, `0033:378-386` |

The single application read of `appointment_audit` is `app/(app)/calendar/[id]/page.tsx:131-138` — gated on `isCancelled`, filtered to `action='cancelled'`, ordered `created_at desc limit 1`, selecting `details` alone. Both the free text and the forgeable `details` from §9.2 therefore reach a rendered practitioner-facing surface; `actor_id` and `actor_type` are stored but never rendered.

### 9.9 On the 0170 "created_at delta collapsed to 0" production observation

**That observation is NOT verifiable from this repository.** It was recorded from live Willow traffic; no artifact in the tree carries the measurement, and this audit made no connection to production. It is cited nowhere in what follows.

The atomicity of `create_public_appointment` is proven structurally instead, from the SQL alone:

1. Both writes are statements in **one** function body. `create_public_appointment` is defined exactly once, at `0170:636-921`; the appointment INSERT is at `0170:892-900` and the audit INSERT at `0170:906-914`, with nothing between them that can commit.
2. There is **no exception handler** anywhere in the body — verified by grep across the whole migration. A failure of either statement propagates and aborts the transaction (`0170:884-888`).
3. The function is invoked by exactly one `admin.rpc("create_public_appointment", …)` (`app/book/[slug]/actions.ts:775-786`), and PostgREST wraps one request in one transaction (§9.3). Both INSERTs commit together or neither does. **This is the proof.**
4. The zero delta is a *consequence*, not evidence. `appointments.created_at` and `appointment_audit.created_at` both default to `now()` (`0010:188`, `0010:224`), neither is overridden by the command, and no trigger rewrites either. Postgres's `now()` is `transaction_timestamp()` — fixed for the whole transaction — so the delta is *necessarily* exactly zero for any two default-`now()` inserts in one transaction, regardless of elapsed wall-clock time. A zero delta proves a shared transaction timestamp, which is weaker than what the SQL body already establishes.

The identical structural argument holds for all eleven paths in §9.4, and for A4 it is additionally confirmed behaviourally by the forced-failure test at `tests/db/practitioner-move-appointment.db.test.ts:393-410`.

### 9.10 Documented posture vs shipped schema

| Document | Claim | Reality |
|---|---|---|
| `docs/09_DATABASE_AND_RLS.md:161` | lists `appointment_audit` under *"Service-role-only write"* | **false** — `0010:291-299` grants member INSERT and no grant was ever revoked |
| `PRE_STRIPE_HARDENING_NOTES.md:385` | *"Append-only at SQL level (no app delete path)"* | true for direct row deletes only; ignores the `on delete cascade` at `0010:219` |
| `app/cancel/[token]/actions.ts:352` | *"the audit_logs row the RPC stamped"* | the RPC stamps `appointment_audit` (`0091:130`); nothing in the appointment lifecycle writes `audit_logs` |

No drift-guard test pins `appointment_audit`'s grants. The pattern exists — `tests/db/l18-final-revocation.db.test.ts:52-153` — but covers only the six clinical tables 0169 hardened.

---

## 10. Findings, ordered P0 → P3

**0 × P0 · 3 × P1 · 14 × P2 · 22 × P3.**

The three P1s share one root cause and one remediation. Every P2 carries a **Closed by revocation?** verdict so the sequencing in §12 can be read off directly: a P2 marked *yes* needs no separate work beyond the revocation migration; a P2 marked *no* is independent and survives it.

### P0

**None.** `anon` holds the table grant but fails RLS — `public.is_studio_member` (`0001_init.sql:153-166`) returns false without `auth.uid()`, and `0001:186-188` revokes it from `PUBLIC`. There is no unauthenticated appointment mutation path, and no path into a studio the actor is not an active member of.

---

### P1-1 — `authenticated` holds direct INSERT/UPDATE/DELETE on `public.appointments`, making the entire command layer optional

> Consolidates raw findings F-APP-01, F-DB-01, F-DB-04, F-DB-08, F-CREATE-01, F-RS-01, WF-L-01, P1-BA-01, F-P5-01, AVAIL-01, F-ATOM-01, F-COORD-01, TS-01.
> Prior register: `HN-007` / `F-SEC-002` in `docs/audits/2026-07-30/` — **reconfirmed unchanged at this HEAD**, still OPEN.

**Evidence**

| Fact | Location |
|---|---|
| Sole RLS policy is `FOR ALL`, USING and WITH CHECK both `is_studio_member(studio_id)` | `supabase/migrations/0010_booking_v1.sql:273-277` (the `drop policy` precedes it at `:272`) |
| `is_studio_member` = *any* active practitioner, no role gate | `supabase/migrations/0001_init.sql:153-166` |
| No `GRANT` or `REVOKE` on `public.appointments` in any of the 170 migrations | verified by exhaustive grep; zero hits |
| 0169 revoked the same privileges on six **clinical** tables and excluded appointments | `supabase/migrations/0169_revoke_authenticated_clinical_direct_dml.sql:82-87` |
| The deferral is explicit and documented | `0170:1018`, `0171:1507` |
| The open posture is **pinned by passing tests** asserting `has_table_privilege(...) = true` for `anon` and `authenticated` | `tests/db/public-appointment-command.db.test.ts:475-489`; `tests/db/public-reschedule-command.db.test.ts:1430-1443` |
| Browser holds the credentials needed | `lib/supabase/client.ts` ships `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY`; the session JWT is in a page-readable cookie |

**Exploit scenario.** An active non-owner practitioner of studio S opens devtools, takes the anon key and their own JWT, and calls PostgREST directly as role `authenticated`:

- `PATCH /rest/v1/appointments?id=eq.<X>` `{"status":"completed"}` — flips a **future** appointment to completed. `mark_appointment_complete` (`0032:4052`) refuses this (it locks the row, requires a non-terminal source state, and checks `ends_at`); the direct write performs none of those. `lib/billing/session-payment-eligibility.ts:142-144` then reads `appointmentSummary.status !== "completed"` as the gate before preparing a live card charge.
- `PATCH ... {"starts_at":"…T03:00Z","ends_at":"…T04:00Z","booked_outside_availability":true}` — moves the appointment to a closed hour and permanently exempts the row from the soft-buffer trigger, with no owner gate. `move_or_reassign_appointment` (`0152:537`) gates the override on ownership at `0152:432-441`; the direct write never reaches it.
- `PATCH ... {"status":"confirmed","cancelled_at":null}` or, worse, leaving `cancelled_at`/`cancelled_by`/`cancellation_reason` populated — resurrects a cancelled appointment into a state no command can produce.
- `DELETE /rest/v1/appointments?id=eq.<X>` — see **P1-2**.
- **In every case, `appointment_audit` gains zero rows.** No trigger writes it; every audit row in this system is written explicitly by a command.

**Affected workflows.** All of 1–12 (§4). Every guarantee in §3, §7 and §8 that is attributed to a command rather than to a constraint.

**Current protections, and why they are insufficient.**

*What genuinely holds:* the write is confined to studios the actor is already an active member of (`WITH CHECK`); the composite same-studio FKs added by `0151_appointment_tenant_consistency.sql:84-99` prevent repointing `client_id`, `service_id` or `practitioner_id` at another tenant's row; the shadow-reservation GiST exclusion (`0134:238-243`), fed by an `AFTER` trigger that fires for direct DML, prevents actual overlap; the `status` CHECK (`0010:183`) confines the value to the four legal strings.

*Why that is not enough:* none of those touch **who may do what to which appointment, in which order, with what record**. The schema has no transition state machine, no audit-write guarantee, no owner gate, no working-hours rule and no actor binding. Membership is authorisation for *reading* a studio's calendar; it was never intended to be authorisation for arbitrary lifecycle mutation. One narrow tenancy caveat: a practitioner who is an active member of **two** studios can `UPDATE studio_id` together with `client_id`/`service_id`/`practitioner_id` in a single statement and migrate an appointment between two studios they legitimately belong to — the composite FKs are satisfied because all four columns move together. That is not access escalation, but it is an ungoverned tenant move (raw finding F-DB-09).

**Recommended boundary.** `revoke insert, update, delete on table public.appointments from authenticated;` — retaining `SELECT`, which is load-bearing (§6.7). Because **no shipped writer uses the authenticated client for appointment DML**, this is a zero-application-change migration. Prerequisites are listed in §11 and sequenced in §12; the substantive ones are an administrative-repair command (P2-11) and inverting the two tests that currently pin the open posture.

**Test that proves closure.** A behavioural DB probe in the `tests/db/l18-final-revocation.db.test.ts` style — as `authenticated`, issue `INSERT`, `UPDATE` and `DELETE` against `public.appointments` with a predicate matching **zero rows**, so that a *retained* privilege succeeds (and fails the test) while a revoked one raises `42501`. Plus a `has_table_privilege` grant pin, and a static direct-DML census guard (§14).

---

### P1-2 — Direct `DELETE` cascades away the appointment's entire audit trail and its signed policy-acknowledgement evidence

> Consolidates F-DB-02 and the deletion halves of WF-L-01, F-P5-02, F-ATOM-03.

**Evidence.** `appointment_audit.appointment_id uuid references public.appointments(id) on delete cascade not null` (`0010_booking_v1.sql:218-219`). `appointment_policy_acknowledgements.appointment_id uuid not null references public.appointments(id) on delete cascade` (`0056_appointment_policy_acknowledgements.sql:33-34`). The `FOR ALL` policy of P1-1 permits the `DELETE`; no `ON DELETE RESTRICT` guards the audit side.

**Exploit scenario.** A practitioner who wants a cancellation or a no-show to disappear issues `DELETE /rest/v1/appointments?id=eq.<X>`. Postgres removes the appointment, cascades every `appointment_audit` row for it, cascades the client's `appointment_policy_acknowledgements` row — the SHA-256-hashed snapshot of the cancellation policy the client accepted, which `0056:86-94` was explicitly designed to make append-only — and fires the shadow trigger to release the reservation. **No record remains that the appointment ever existed.** `audit_logs` is not written for any appointment lifecycle transition, so there is no non-cascading trail either.

**Affected workflows.** 6, 7, 9, 12 (§4), and the fee-dispute path that depends on the acknowledgement.

**Current protections.** Partial and incidental: `ON DELETE RESTRICT` foreign keys from `appointment_payments` (`0032:747`), `payment_charge_attempts` (`0073:200`) and `manual_fee_charge_attempts` (`0064:155`) mean an appointment that **carries payment state** cannot be deleted. Every other appointment can.

**Why insufficient.** The protection is a side effect of payment bookkeeping, not a deliberate retention rule, and it covers exactly the appointments least likely to be the ones someone wants to erase.

**Recommended boundary.** The same `revoke` closes it. Additionally: change the two audit cascades to `ON DELETE RESTRICT` (or introduce a `deleted_at` soft-delete and forbid hard delete outright), and give `appointment_audit` its own `studio_id` so the trail can outlive its parent row and be retained/exported per tenant.

**Test that proves closure.** The `authenticated`-is-refused-`DELETE` probe above, plus a test asserting that deleting an appointment with audit rows raises a foreign-key violation once the cascade is tightened.

---

### P1-3 — `appointment_audit` accepts forged rows: actor, action, `details` and `created_at` are all caller-chosen

> Consolidates F-DB-03, P1-BA-04, F-ATOM-02, F-P5-02 (forgery half), WF-L-02, F-COORD-02, TRG-P1-02.

**Evidence.**

| Fact | Location |
|---|---|
| `appointment_audit_member_insert` — `FOR INSERT`, WITH CHECK constrains **only** that `appointment_id` belongs to a studio the caller is a member of | `0010_booking_v1.sql:291-299` |
| `actor_id` is a bare `uuid` — no FK, no correlation with `actor_type` (which *is* CHECKed at `0010:220`) | `0010:221` |
| `created_at timestamptz not null default now()` — a plain writable column, no trigger, no CHECK | `0010:224` |
| **No trigger writes `appointment_audit`** — every row is written explicitly by a command | verified across all 170 migrations |
| No append-only trigger, unlike `stripe_payment_audit_immutable` and `clinical_audit_events_append_only` | `0032:1411`, `0120:219` |
| Forged `details` reach a rendered practitioner-facing surface | `app/(app)/calendar/[id]/page.tsx:131-139` |

**Exploit scenario.** Practitioner B, any active member of studio S, `POST`s to `/rest/v1/appointment_audit` with their own JWT:
`{"appointment_id":"<any appointment in S>","actor_type":"practitioner","actor_id":"<owner A's practitioner id>","action":"cancelled","details":{"source":"practitioner_action","reason_label":"Client request","note":"…"},"created_at":"2020-01-01T00:00:00Z"}`.
The policy accepts it. The appointment detail page reads `appointment_audit` with the **user-scoped** client, filtered to `action='cancelled'`, and renders `details.reason_label` / `details.note` as the authoritative cancellation account (`page.tsx:130-139`, render sites `:566`, `:580-591`, `:599`). Because `created_at` is caller-chosen and the read orders by `created_at desc`, a forged row can be positioned ahead of the genuine one.

Combined with P1-1, the pair is complete: a member can mutate an appointment with no audit row *and* write the audit row they would prefer to exist.

**Affected workflows.** 6, 7, 8, 9 (§4); any future forensic reconstruction; the charge-attribution narrative `0032:4050-4051` attributes to this table.

**Current protections.** Existing rows are safe from tampering — RLS default-denies `UPDATE` and `DELETE` because only `SELECT` and `INSERT` policies exist. `actor_type` is CHECK-constrained. The blast radius is one studio.

**Why insufficient.** Append-only is worthless if anyone can append anything. The table is the *only* lifecycle record (`audit_logs` is never written for appointments), and the one surface that renders it renders attacker-controlled JSON.

**Recommended boundary.** Drop `appointment_audit_member_insert` and `revoke insert on public.appointment_audit from authenticated` — the commands write it as `service_role` and are unaffected. Additionally: bind `actor_id` to a `practitioners` FK, add a CHECK correlating `actor_id` nullability with `actor_type`, make `created_at` non-writable (`default now()` plus a `BEFORE INSERT` trigger that overwrites it), add an append-only trigger matching `0120:219`, and add `studio_id`.

**Test that proves closure.** As `authenticated`, `INSERT` into `appointment_audit` for an appointment in the caller's own studio and assert `42501`. Plus a policy-set pin asserting the table carries exactly one `SELECT` policy and no `INSERT`/`UPDATE`/`DELETE` policy.

---

### P2 — fourteen findings

| # | Finding | Location | Closed by revocation? |
|---|---|---|---|
| P2-1 | The owner "custom time" override **also disables the soft buffer**. The UI promises the opposite — *"Custom time can be outside regular operating hours. Existing appointments, buffers and blocked time still apply."* — immediately above the checkbox the owner ticks. Two of the three promises hold (the GiST exclusions still block overlap; blockouts are still mirrored into the shadow); **buffers do not**: `validate_appointment_availability`'s buffer arm keys on the same `p_allow_outside_availability` as the working-hours arm, 37 lines below the comment declaring working hours "the ONLY thing the owner override may bypass" | `0152:322` vs `0152:359`; UI promise at `MoveAppointmentDialog.tsx:525`, consent at `:535` | **No** |
| P2-2 | `validate_appointment_availability` degenerates to **buffer-only** at capacity-OFF studios — which per `0134:11-13` and `0170:47-53` is every production studio. Practitioner membership, service eligibility, full-day blockout and the working-hours window are all fenced inside `if v_cap then … end if` (`0152:290-352`). For the two *internal* commands those rules therefore live **only in the application layer**, and 0170/0171 closed the same hole for the public paths by adding a second, stricter validator rather than widening this one. **This is a defence-in-depth gap, not an open hole through the shipped path**: both internal callers recompute the slot grid with `getAvailableSlots` and refuse a non-offered start (`app/(app)/calendar/actions.ts:262-292`; `move-appointment-actions.ts:322-345`), and full-day blockouts are still caught by the shadow exclusion. The exposure is any *other* service-role caller — a future import tool, cron, operator script, or a stale deployment reaching the 0147 legacy wrapper | `0152:290-352`; public counterpart `0170:392`, `0171` `validate_public_reschedule_slot` | **No** |
| P2-3 | **Internal creation books archived clients; public creation refuses them.** `create_internal_appointment_v2` validates the client with `select 1 from public.clients c where c.id = p_client_id and c.studio_id = p_studio_id` and no `archived_at is null` check; `create_public_appointment` explicitly refuses. The archived client's own page still renders the Book button | `0152:451` vs `0170:754-760` | **No** |
| P2-4 | **Two obsolete appointment-mutating commands remain installed, caller-less and `service_role`-EXECUTE-able**, both strictly weaker than their replacements. Legacy `reschedule_appointment` (retained by explicit decision at `0171:61-66`) performs no horizon, availability, blockout or slot-membership validation and writes no reschedule lineage. `practitioner_move_appointment` is a delegate whose 7-argument call now binds to the 8-argument `move_or_reassign_appointment` via a parameter default | `0091:186` + grant `0091:320`; `0145:200` + grant `0145:238` | **No** |
| P2-5 | The `/cancel` **policy acknowledgement is written outside the RPC transaction** and its failure is swallowed. `public_cancel_appointment_with_token` commits the status flip and the audit row; the subsequent `admin.from('appointment_policy_acknowledgements').insert(...)` can fail transiently, the error is logged and discarded, the action still returns `{ok: true}`, and the missing row **permanently blocks the late-cancellation fee**. 0171 fixed exactly this defect for reschedule by moving the acknowledgement inside the command | `app/cancel/[token]/actions.ts:365`; contrast `0171:1137-1149` | **No** |
| P2-6 | **`is_resend`, a browser-supplied boolean, disables the postcare send-once claim.** The first-send branch guards on `postcare_email_sent_at is null` plus a stale-claim window and proves the claim with `.select("id")`; the resend branch is an unconditional `UPDATE` scoped only by `id` + `studio_id`. Any active practitioner can POST the server action with `is_resend=true` N times concurrently against a never-sent appointment and send N emails to the client | `app/(app)/calendar/actions.ts:1156-1163` vs `:1115-1140` | **No** |
| P2-7 | **`rematerialize_studio_reservations` still writes buffer-EXPANDED shadow intervals**, reverting 0152's actual-interval contract whenever it runs — and because it is a single `INSERT … SELECT` into a table carrying an unconditional GiST exclusion, any studio holding two same-resource appointments back-to-back inside its buffer will raise `23P01` and **abort the entire capacity flip**, which is a documented operator action | `0137_scoped_blocks_and_breaks.sql:271-279`; exclusion `0134:238-243`; triggers `0134:570`, `0134:609`; `retire_practitioner_capacity` `0138:266` | **No** (dormant while every studio is capacity-OFF — UNPROVEN) |
| P2-8 | **Production's `snapshot_appointment_buffer` diverges from the migration tree.** Three repository tests assert the deployed function carries an out-of-band GUC bypass (`app.bypass_appointment_buffer_snapshot`) that exists in no migration. Any future `create or replace` of that function — the documented way to fix an unrelated bug in it — silently deletes the production-only behaviour, with no diff and no test failure | `0029:62-95`; the 0171 suite forbids redefinition of eight trigger functions at `tests/migrations/0171-public-reschedule-command.test.ts:181-193` | **No** |
| P2-9 | **The public commands ignore the booking-pause kill switch the internal ones honour.** `create_internal_appointment_v2` (`0152:420-423`) and `move_or_reassign_appointment` (`0152:668-672`) both refuse with `booking_paused`; neither `create_public_appointment` (0170) nor `reschedule_appointment_v2` (0171) reads `practitioner_capacity_booking_enabled` at all. The documented "EMERGENCY PAUSE" (`0136:13-22`) therefore stops staff but not the public booking page | `0170:678`, `0171:878` | **No** (dormant while capacity is OFF — UNPROVEN) |
| P2-10 | **`/cancel` records a policy acknowledgement with no currency check while `/reschedule` requires one.** 0171 added `p_presented_policy_snapshot_hash`, recomputes the hash under the row lock and refuses on mismatch; `/cancel` snapshots whatever the studio's policy says *after* the RPC returns, so an owner edit between page load and submit produces a durable legal record asserting the client accepted text they never saw | `app/cancel/[token]/actions.ts:217`, `:290-296`, `:361-364`; contrast `0171:803`, `:1137`, `:1148-1149` | **No** |
| P2-11 | **No governed `DELETE` and no administrative-repair path exists.** There is no server action, RPC, admin route or script that deletes an appointment; `mark_appointment_complete` and `mark_appointment_no_show` are strictly terminal (`0032:4079`, `0033:365`); nothing un-completes, un-cancels or un-no-shows, and no import/bulk-load surface exists to balance the data export at `app/(app)/settings/data/actions.ts:119-125`. **Revoking direct DML removes the only escape hatch anyone currently has** — this is the one P2 that is a *prerequisite* of P1-1, not a consequence of it | absence, verified across `app/`, `lib/`, `scripts/`, and all 170 migrations | **No — it blocks the revocation** |
| P2-12 | **The schema encodes no transition state machine and no audit-write guarantee.** `status` carries a four-value CHECK (`0010:183`) and nothing more: no transition constraint, no guard trigger, no `set_updated_at` trigger, no invariant tying a mutation to an audit row. The pattern exists in this codebase (`guard_retired_finalization_transition` `0159:241-277`; client-intake terminal immutability `0162`) and was never applied to appointments | `0010:183`, `0010:189` | Partly — the revocation removes the *browser* route to an illegal transition, but any service-role writer, script or operator session still bypasses it |
| P2-13 | **`booked_outside_availability` and `capacity_enabled` are unguarded columns whose maintaining triggers do not cover them.** `appointments_set_capacity_enabled_trg` fires `before insert or update of studio_id, practitioner_id, status` — omitting `capacity_enabled` itself, so a direct write to that column is never re-derived and moves the row between the two partial GiST exclusions. `enforce_appointment_buffer` honours `booked_outside_availability` unconditionally (`0152:226-227`) although `0152:62-63` asserts in a comment that "only the owner-gated internal commands below ever set it true". Separately, `move_or_reassign_appointment` unconditionally sets `booked_outside_availability = p_allow_outside_availability` (`0152:690`), so an ordinary available-slot move **silently clears** an override an owner had applied | `0134:124-128`; `0152:226-227`, `0152:690` | Yes for the forgery route; **no** for the trigger-column gap and the silent clear |
| P2-14 | **The LIVE session-payment path gates on the appointment status string in TypeScript, and its only time gate is on the wrong entity.** `session-payment-eligibility.ts:142-144` refuses unless `appointmentSummary.status === "completed"`; the accompanying temporal check (`:133-136`) tests the *session's* `startedAt`, never the *appointment's* `ends_at`. So a `completed` status on a future appointment passes both gates as long as a session was started. Combined with P1-1 that is a money-adjacent state a member can write directly; independent of P1-1 it is weak validation, because the gate re-reads a denormalised summary rather than re-deriving it at charge time | `lib/billing/session-payment-eligibility.ts:133-136`, `:142-144` | Partly |

---

### P3 — twenty-two findings

| # | Finding | Location |
|---|---|---|
| P3-01 | No static drift guard exists for direct `appointments` DML. `tests/security/entry-direct-dml-guard.test.ts` covers exactly six clinical tables; the syntax-aware analyzer that would make an appointments guard trivial already exists at `tests/security/helpers/supabase-write-census.ts` | `tests/security/entry-direct-dml-guard.test.ts:36-43` |
| P3-02 | No test asserts the grant or policy posture of `appointments`/`appointment_audit`; the only two that touch it assert the **open** posture | `tests/db/public-appointment-command.db.test.ts:474`, `tests/db/public-reschedule-command.db.test.ts:1430` |
| P3-03 | `tests/scripts/e2e-guardrails.test.ts` is vacuous: its directory loop scans nothing, and its regex targets `process.env.E2E_AUTH_BYPASS`, the only occurrence of that string in the repository. The real markers are `HONE_E2E_*`, and an app-side E2E hook route does ship | `tests/scripts/e2e-guardrails.test.ts:70`, `:76`; `app/api/google-calendar/e2e/authorize/route.ts` |
| P3-04 | `mark_appointment_complete`, `mark_appointment_no_show` and `practitioner_cancel_appointment` have **no behavioural test**; the one file named for them only scans `pg_proc.prosrc` | `tests/db/public-booking-concurrency.db.test.ts:259` |
| P3-05 | The `tests/db` lane is **conditional** in CI, so a PR that touches no `supabase/**` or `tests/db/**` path never runs the DB probes | `.github/workflows/ci.yml:229`; `scripts/classify-changes.mjs:19-31` |
| P3-06 | The service-role allowlist's `why` justification is unverified free text and is stale for the appointment move writer; library modules that mutate appointments are invisible to the gate, and the scan excludes `tests/`, `e2e/` and `scripts/` | `tests/security/service-role-allowlist.ts:37`; `tests/security/service-role-allowlist.test.ts:25`, `:36` |
| P3-07 | `appointments.updated_at` is not trigger-maintained, unlike essentially every other mutable table here | `0010:189` |
| P3-08 | `repair_bump_appointment_sync_version` mutates **any** appointment in **any** studio with no studio predicate, no lock and no audit row. Every peripheral SQL writer shares the bare-`appointment_id` pattern | `0125:384-400` |
| P3-09 | `claim_email_send` / `record_email_result` (`0098:51`, `:125`) and `claim_sms_send` / `record_sms_result` (`0049:176`, `:237`) declare `set search_path = public`, contradicting the `pg_catalog, pg_temp` hardening standard this repository applies elsewhere | `0098`, `0049` as cited |
| P3-10 | `record_email_attempt`'s `no_show` branch is unreachable appointment-mutating dead code; `send_no_show_followup` (`0025:60`) and the `no_show_email_*` columns have no writer | `0033:97`; `0025:16-28`, `0028:22` |
| P3-11 | `cancellation_kind = 'withdrawn'` is permitted by the CHECK but written by nothing; only `reschedule_appointment_v2` ever writes the column, always `'rescheduled'` | `0125:51-52`; `0171:1306` |
| P3-12 | Reschedule lineage (`rescheduled_from_appointment_id` / `rescheduled_to_appointment_id`) has exactly one writer and, per the production apply record, has **never been populated** | `0171`; `docs/production/migration-state.json` |
| P3-13 | The `completed` and `no_show` transitions emit nothing to Google Calendar, so a missed appointment keeps a normal-looking event forever | `0132:327` |
| P3-14 | Manual postcare send has no appointment-status filter, so postcare can be emailed for a cancelled or no-show appointment; its automatic twin carries `.eq("status","completed")` | `app/(app)/calendar/actions.ts:1115`; contrast `postcare-auto-send.ts:160` |
| P3-15 | Postcare writes are forensically invisible: four independent non-atomic `UPDATE`s, no actor attribution, no audit row, no `updated_at` bump. The terminal stamps carry no claim-ownership predicate, so a slow loser can clear the winner's claim | `app/(app)/calendar/actions.ts:1115`, `:1156`, `:1212`, `:1243`; `postcare-auto-send.ts:152`, `:187`, `:201` |
| P3-16 | One shared `CRON_SECRET` authorizes all five cron routes including both appointment-mutating ones, is held by a third-party scheduler, and has no documented rotation runbook | `lib/cron/auth.ts:17`; `docs/08:111-113` |
| P3-17 | Two cron routes' header comments claim they are not registered; `vercel.json` registers both. The reconcile route's dormancy comment likewise contradicts `vercel.json` | `app/api/cron/calendar-sync/route.ts:19`; `app/api/cron/calendar-reconcile/route.ts:30-31` |
| P3-18 | Public booking mutates `clients` **before** the appointment command runs, so a refused booking permanently leaves an orphan client row or a consent update behind. Explicitly out of 0170's scope (`0170:26-30`) | `app/book/[slug]/actions.ts:626-627`, `:669-671`, `:776` |
| P3-19 | Internal creation enforces neither a booking horizon nor a timestamp-precision domain nor exact slot-grid membership in the database, while public creation enforces all three | `0152:489`, `:496`; contrast `0170:392` |
| P3-20 | Unbounded anonymous free text from the public booking surface is copied, along with the client's raw email, into `appointment_audit.details` — an untyped `jsonb` column with no schema, no redaction and no retention path. `appointments.notes` has no length constraint | `0170:906`; `app/book/[slug]/actions.ts:352` |
| P3-21 | On the HMAC-fallback token path, both the cancel and reschedule commands' own token re-verification is tautological — the row's hash is compared to itself — so the database is not a second line of defence there; the HMAC payload is not studio-bound | `app/cancel/[token]/actions.ts:231`; `app/reschedule/[token]/actions.ts:126-131` |
| P3-22 | Documentation contradicts the shipped schema: `docs/09_DATABASE_AND_RLS.md:159-161` understates the effective appointments policy as INSERT-by-RPC-only and describes an audit posture the schema does not have; `docs/production/migration-ledger.md:22` and `docs/04_BOOKING_AND_PORTAL_FLOWS.md:105,187` are stale, still calling 0170/0171 unapplied. `docs/audits/2026-07-30/MASTER_FINDINGS_REGISTER.json` is eleven migrations behind | as cited |

**Not carried forward.** `TRUNCATE`, `REFERENCES` and `TRIGGER` were never revoked on any appointment-domain table, breaking this project's own stated doctrine — but PostgREST exposes no `TRUNCATE` verb and no browser-reachable channel can issue one, so it is a hygiene item folded into the revocation migration rather than a finding. Likewise the `/auth/callback → reconcile_my_pending_invitation → practitioners INSERT → rematerialize` chain is a real authenticated-client route into appointment DML but is a strict no-op while every studio is capacity-OFF (`on_practitioner_change_refan` is gated by `studio_capacity_enabled()`, `0134:585-607`).

---

## 11. Target command boundary

Three independent designs were produced against the evidence in §§2–10. This section scores them, states plainly what was rejected, and specifies the single boundary Hone should actually build.

**The synthesized position in one sentence:** the appointment command layer does not need to be redesigned — it needs to be made *mandatory*, by one privilege migration that changes no application code, followed by the two small capabilities the product genuinely lacks (a governed outcome correction and an editable note) and the audit-integrity work that turns "every write is audited" from a convention into a schema property.

---

### 11.1 How the three designs scored

| Criterion | **D1 — Minimal delta** | **D2 — Invariant-first** | **D3 — Operator reality** |
|---|---|---|---|
| **(a) Closes both P1 root causes** | **Yes, exactly.** Revokes DML on `appointments` and `appointment_audit`, drops `appointment_audit_member_insert`, narrows `appointments_member_all` `FOR ALL` → `FOR SELECT`. The policy narrowing is the durable half and D1 is the only design that argues *why* (a privilege can be silently re-granted by platform tooling; a surviving `FOR ALL` policy reopens the hole the instant it is) | Yes for privileges — and its revoke list is the widest. **But it never narrows `appointments_member_all`,** and it explicitly *keeps* `appointment_audit_member_insert` "as defence in depth", which is backwards: a policy permitting an INSERT nobody may issue is a documentation hazard, not a defence | Yes, and it is the only design that also drops the three caller-less legacy RPCs, shrinking the `service_role` surface as well as the `authenticated` one |
| **(b) Prerequisite list correct and complete** | **Best on repo hygiene.** The only design that enumerates the full migration-state dance: invert the two pinning tests, move the repo-max tripwire off `tests/migrations/0171-*.test.ts:44-47`, add both a source-contract and a behavioural probe, hold `docs/production/migration-state.json` at `0171` until the push lands, fix the four stale doc claims. **Miss:** does not mention `tests/db/appointments-tenant-consistency.db.test.ts:131-147`, which asserts an authenticated INSERT fails with `23503` and will fail with `42501` after the revoke | **Only design to catch the tenant-consistency test.** Ordering (privilege first, invariants second, audit third, `VALIDATE CONSTRAINT` last) is correct and well argued. Over-broad: `revoke all … from authenticated` + `grant select` back is riskier than naming three verbs, and it re-represents ACLs that were previously platform defaults | Correct on capability, over-long on scope: three migrations and two large app PRs land before the revoke. Its `no_audit_baseline` production scan is the single best idea in any of the three (see §11.7) |
| **(c) Breaks a shipped flow?** | **No.** Zero-application-change, provably | **Yes, in ways it did not enumerate.** Its time-gate invariant (`completed`/`no_show` require `ends_at <= now()`) breaks `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:219-221`, which completes a *future* seeded appointment; its forward-only transition guard breaks `:230-231`, an explicit `cancelled → confirmed` "defensive un-cancel" test. Triggers fire for the superuser harness too, so `adminQuery` seeding does not escape them | **Yes.** The soft-void column puts a `voided_at is null` obligation on ~43 read sites; a missed one leaves a voided appointment on a live calendar — the exact symptom the void was performed to remove |
| **(d) Buildable in focused PRs** | **Yes** — one migration, two test files, two test inversions | Yes — four migrations, cleanly separable, but S9 (a `DEFERRABLE INITIALLY DEFERRED` constraint trigger that *writes* fallback audit rows at commit) is the hardest-to-review object anyone proposed | Partly — the app PRs are large and one of them wants the file Session 1D owns |
| **(e) Avoids inventing product decisions** | **Exemplary.** Explicitly rules out eight tempting extras as "desirable cleanup that must follow, not precede" | Mostly. `admin_correct_appointment_status` is a defensible break-glass; S6/S9 invent mechanism rather than product | **Worst.** Invents `studios.cancellation_window_hours` and `appointments.cancellation_window_class` — a structured cancellation-fee policy engine the brief explicitly forbids inventing, and which `0064:37` and `lib/billing/manual-fee-eligibility.ts:56` record as a deliberate *not-yet* decision. Also invents an appointment import feature and proposes re-enabling automatic no-show marking |

**Winner: Design 1, as the base.** It is the only design that is *provably* safe to ship as written, it is the only one that gets the policy narrowing right, and its central structural argument is correct and important: the clinical precedent (`0087` split the `FOR ALL` policies, `0169` revoked the privileges — 82 migrations apart) needed two steps *because 25 authenticated clinical writers existed in between*. Appointments has **zero** authenticated writers, so the two steps collapse into one migration with no compatibility window.

**Graft from D2:** the missing test (`appointments-tenant-consistency`), the ordering discipline, the audit-table structural work (`studio_id`, FK re-point, `BEFORE INSERT` derive, append-only), the `capacity_enabled` one-word trigger fix, the hard prohibition on redefining `snapshot_appointment_buffer`, and — critically — the observation that an append-only **DELETE** arm on `appointment_audit` is only safe *after* the FK stops cascading.

**Graft from D3:** `revert_appointment_outcome` and `set_appointment_notes` (the two capabilities the revoke genuinely freezes), the shared helpers (`lock_appointment_for_command`, `write_appointment_audit`, `appointment_has_blocking_dependents`), the retirement of the three caller-less legacy RPCs, and the production `no_audit_baseline` scan that converts the whole sequencing question from argument into measurement.

---

### 11.2 What was rejected, and why

| Proposal | From | Verdict | Reason |
|---|---|---|---|
| `studios.cancellation_window_hours` + `appointments.cancellation_window_class` stamped at cancel time | D3 | **Rejected** | This is a structured cancellation-fee policy engine. `0064_manual_fee_protection.sql:37` and `lib/billing/manual-fee-eligibility.ts:56` both record, in the product's own words, that Hone deliberately has no structured threshold and that v1 records "the practitioner's manual assertion of charge_type with a surfaced warning". Adding one is a pricing/policy decision for the user, not an audit remediation. Listed in §11.7 |
| `import_appointment(...)` + `appointments.external_ref` + `import_batch_id` | D3 | **Rejected** | A new product feature. No import surface exists, no user asked for one, and it would put an INSERT path into the scheduling table that deliberately skips every availability validator |
| `auto_mark_no_show_batch(...)` + `studios.auto_no_show_enabled` | D3 | **Rejected for now** | `app/api/cron/no-show-check/route.ts:4-38` records an explicit product decision to keep automatic no-show marking disabled until the manual path is validated in production. Re-enabling it is that decision being reversed, and it manufactures `no_show_fee`-eligible states from a cron authorized by one shared secret held by a third-party scheduler (P3-16). Listed in §11.7 |
| `void_appointment(...)` + `appointments.voided_at/voided_by/void_reason` + a `voided_at is null` filter on every read | D3 | **Rejected** | The largest blast radius proposed by anyone (~43 read sites) for a capability the product already has a governed form of: `practitioner_cancel_appointment` cancels with a reason and writes an audit row. "This appointment should never have existed" and "this appointment was cancelled" are not different enough to justify a new lifecycle dimension across every calendar query. Whether Hone should ever *hard*-delete an appointment is a real question — §11.7 |
| `guard_appointment_command_origin()` keyed on `current_user` (material columns writable only by the table owner) | D2 | **Rejected** | Genuinely clever, and the `current_user`-not-a-GUC reasoning (`0159:334-337`) is right. But it rests on an ownership assumption no one here could measure, it fails *closed for every command at once* if Supabase ever re-owns `public` tables, and it buys protection against a threat — a future service-role script writing schedule columns directly — that `tests/security/helpers/supabase-write-census.ts` already catches at CI time for a fraction of the risk. Take the static census guard (P3-01) instead |
| Time gates as schema invariants: `completed`/`no_show` require `ends_at <= now()`; `cancelled` requires `starts_at > now()` | D2 | **Rejected as a trigger** | Breaks `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:219-221` (completes a future seeded appointment) and removes the operator's ability to fix a late-recorded outcome. The money-adjacent half of the concern (P2-14) is better closed where the money is: re-derive `ends_at` at charge time in `lib/billing/session-payment-eligibility.ts:142-144` instead of trusting a denormalised status string |
| `appointments_span_matches_duration` CHECK, `NOT VALID` then validated | D2 | **Deferred, not rejected** | Correct in principle and correctly proposed as `NOT VALID`. But its only violator is the legacy `reschedule_appointment` (`0091:186`, which takes `p_new_ends_at` and `p_new_duration_minutes` independently), and the whole pre-0171 reschedule lineage may have written mismatched pairs into production. Ship it after the legacy retirement and after a read-only violator count — never blind |
| `appointment_audit_fallback()` — a deferred constraint trigger that *writes* an `undocumented_mutation` row at commit | D2 | **Deferred** | The most complex object anyone proposed, and after the revoke the only remaining material writers are the commands themselves and the table owner. Revisit only if the §11.7 production scan shows the direct path has actually been used |
| Retire the three caller-less legacy RPCs **inside the revoke migration** | D2, D3 | **Rejected as placement, accepted as work** | D1 is right that the revoke's entire value is being a no-op; adding function drops widens its blast radius. The drops are a separate migration (11.3, `0175`). The retention reason recorded at `0171:61-66` (deployment skew) has expired — PR #513 is merged and prod head is the pinned SHA |
| Keeping `appointment_audit_member_insert` "as defence in depth" | D2 | **Rejected** | A policy that permits an INSERT no role holds the privilege for is not a defence; it is a false statement about intent that the next reader will believe. Drop it, as D1 and D3 both do |
| `record_postcare_email_state` / `claim_postcare_email_send` in the boundary program | D1 (as ruled out), D2, D3 (as required) | **Deferred — correct, but not now** | It closes real defects (P2-6's browser-authoritative `is_resend`, the lost-update counter, P3-15's forensic invisibility) but it is a `service_role` → `service_role` refactor that changes nothing about what a browser JWT can do, and `coordination.md` flags that postcare column work collides with Session 1D's PR #517. Ship it after #517 merges |

---

### 11.3 The migration ladder

| # | Migration | Contents | Application change | Blast radius |
|---|---|---|---|---|
| **0172** | `revoke_authenticated_appointment_dml` | The four revoke/policy groups in §11.4 | **None** | Zero — provably a no-op for the deployed app |
| **0173** | `appointment_repair_commands` | Shared helpers + `revert_appointment_outcome` + `set_appointment_notes` | New owner-only repair surface in a **new** file, `app/(app)/calendar/appointment-repair-actions.ts` + a new panel component | Additive only |
| **0174** | `appointment_audit_integrity` | `appointment_audit.studio_id`, FK `cascade` → `set null`, read-policy rewrite, `BEFORE INSERT` derive trigger, append-only trigger (UPDATE **and** DELETE arms) | None | Audit table only; must land after the FK re-point |
| **0175** | `appointment_transition_guard` | `BEFORE UPDATE OF status` transition guard (full legal edge set), `set_updated_at` trigger, `capacity_enabled` added to its own trigger's column list, drop the three legacy RPCs | None | Behaviour-changing at the DB layer; needs its own review |

Everything else — the postcare command, the `/cancel` acknowledgement atomicity fix (P2-5/P2-10), the span CHECK, the peripheral `p_studio_id` hardening (P3-08), the `rematerialize_studio_reservations` buffer fix (P2-7) — sits **after** this ladder and is sequenced in §12.

---

### 11.4 The revocation: exact scope

Structured as four separable groups inside the file's **own** transaction, so a reviewer can delete group 3 or 4 without touching the P1 closure in groups 1–2. `supabase db push` does not wrap a migration file in a transaction, so a bare `SET LOCAL` emits `25P01` and never arms — this is the 0159 lesson, recorded verbatim at `0169:70-76`.

```sql
begin;
set local lock_timeout = '5s';

-- GROUP 1 — P1-1. SELECT is deliberately NOT named.
revoke insert, update, delete on table public.appointments       from authenticated;
revoke insert, update, delete on table public.appointments       from anon;

-- GROUP 2 — P1-3. SELECT is deliberately NOT named.
revoke insert, update, delete on table public.appointment_audit  from authenticated;
revoke insert, update, delete on table public.appointment_audit  from anon;

-- GROUP 3 — policy residue. The privilege is the enforcement; the policy is the
-- durable record of intent, and the thing that keeps the hole shut if a privilege
-- is ever re-granted by platform tooling.
drop policy if exists "appointments_member_all" on public.appointments;
create policy "appointments_member_select"
  on public.appointments for select to authenticated
  using (public.is_studio_member(studio_id));
drop policy if exists "appointment_audit_member_insert" on public.appointment_audit;

-- GROUP 4 — doctrine (P3, docs/09_DATABASE_AND_RLS.md:204-214).
revoke truncate, references, trigger on table public.appointments      from anon, authenticated;
revoke truncate, references, trigger on table public.appointment_audit from anon, authenticated;

commit;
```

**Never `revoke all`.** `0169`'s own header states the doctrine: it would take `SELECT` with it, and it would silently absorb any future privilege type rather than naming exactly the verbs this cutover is about. `authenticated` `SELECT` on `appointments` is load-bearing at ~22 read sites (`lib/booking/queries.ts:236-241`, `app/(app)/calendar/[id]/page.tsx:100`, dashboard, global search, practice metrics, quick checkout, data export); `authenticated` `SELECT` on `appointment_audit` powers the cancellation-insight card at `app/(app)/calendar/[id]/page.tsx:130-139`.

**The `DROP POLICY` and the `CREATE POLICY` must be adjacent and in the same transaction.** Dropping `appointments_member_all` without the replacement has exactly the same blast radius as `revoke all`. The replacement reuses `public.is_studio_member(studio_id)` verbatim so no read changes.

**Out of scope for 0172:** `appointment_payments` (zero policies at all), `appointment_policy_acknowledgements` (one SELECT policy, `0056:95-100`), `studio_calendar_reservations` (one SELECT policy, `0030:180-189`, writes are trigger-only). All three are already RLS-default-denied for row DML. D2 is right that revoking there is good hygiene and wrong that it belongs here — it is defence in depth on tables with no writers, and folding it in costs 0172 its "exactly two tables" scope note. Give it its own hygiene migration.

#### What must ship with 0172 — the complete co-requisite list

Nothing on this list is a database capability.

| # | Item | Why it is a co-requisite, not cleanup |
|---|---|---|
| 1 | Invert `tests/db/public-appointment-command.db.test.ts:474-489` and `tests/db/public-reschedule-command.db.test.ts:1430-1443` | Both assert `has_table_privilege(...)` INSERT/UPDATE/DELETE = **true** for `anon` and `authenticated` on a freshly-migrated chain. They go red the instant 0172 exists on disk — before any push |
| 2 | Rewrite `tests/db/appointments-tenant-consistency.db.test.ts:131-147` | It asserts an authenticated INSERT fails with `23503` (composite FK). After 0172 it fails with `42501`. The test proves something valuable — the FK is a second line of defence — so keep a table-owner-role variant that still proves the FK bites, and add a `42501` assertion at the privilege layer |
| 3 | Move the repo-max tripwire | `tests/migrations/0171-public-reschedule-command.test.ts:44-47` holds `isRepoMax("0171")`/`versionsAbove("0171")`; per the convention at `tests/migrations/0170-*.test.ts:41-46` only the current max carries it |
| 4 | Two new test files | `tests/migrations/0172-*.test.ts` (byte-level source contract, cloned from `tests/migrations/0169-final-l18-revocation.test.ts`: the exact revoke statements, `revoke all` never appears, no revoke line matches `/select/i`, only two tables named) and `tests/db/appointment-dml-boundary.db.test.ts` (behavioural, cloned from `tests/db/l18-final-revocation.db.test.ts`) |
| 5 | Update the two stale in-migration verification comments | `0170:1012-1019` and `0171:1501-1508` say "EXPECT both roles still TRUE". They are now wrong and are the first thing a future reader will trust |
| 6 | **After** the push applies, bump `docs/production/migration-state.json` `hosted_migration_max` to `"0172"` | The field is *declared*, not derived (`scripts/migration-state.mjs:100-121`). `scripts/verify-production.mjs` derives the expected max from disk and hard-FAILs while 0172 sits unapplied, so keep the merge→push window short |
| 7 | Docs | `docs/09_DATABASE_AND_RLS.md:160-161`, `PRE_STRIPE_HARDENING_NOTES.md:385`, `docs/production/known-limitations.md:250`. All three currently make claims that are FALSE and that this migration is what makes true |

**The behavioural probe must use predicates that match no rows.** A still-granted privilege would otherwise succeed with `rowCount 0` and pass the test silently — the pattern documented at `tests/db/l18-final-revocation.db.test.ts:11-15`. And `asRole()` in `tests/db/helpers/harness.ts` **always rolls back**, so assert the `SQLSTATE` (`42501`) and never a row count. This exact vacuous-pass has bitten this codebase four times.

---

### 11.5 The command surface

Every command below is `SECURITY DEFINER`, owned by the table owner, with `EXECUTE` revoked from `public`, `anon` and `authenticated` and granted only to `service_role`. Every one is reached from a `"use server"` action through `createAdminClient()`. That is the boundary: **the only role that may write an appointment is `service_role`, and the only way `service_role` writes one is through a reviewed command.**

#### Lifecycle commands — unchanged

| Command | Status | Caller | Request inputs | Server-derived | Atomic mutation + audit row | Idempotency | Errors | Events |
|---|---|---|---|---|---|---|---|---|
| `create_internal_appointment_v2` (EFF `0152:376`) | **EXISTS-UNCHANGED** | `app/(app)/calendar/actions.ts:311` | client, service, target practitioner, `starts_at`, notes, duration override, outside-availability flag | `studio_id` from the httpOnly cookie re-validated against live memberships; actor practitioner; token hash (`:296`, only the SHA-256 crosses at `:320`); `status` literal `'confirmed'` (`0152:511`); `ends_at`; `capacity_enabled` and buffer columns by trigger | one INSERT (`0152:505-513`) + `action='created'`, `actor_type='practitioner'` (`0152:515-525`), same txn | none by design; collision safety is structural (two partial GiST exclusions `0152:80-97` + the unconditional shadow exclusion `0134:236-244`) | sentinel strings in `result` | confirmation email (studio flag), practitioner notification (flag), consent-gated SMS, Google enqueue **dormant** |
| `create_public_appointment` (`0170:636`) | **EXISTS-UNCHANGED** | `app/book/[slug]/actions.ts:776` (unauthenticated surface) | slug, client identity, service, `starts_at`, notes, referral source | studio from slug; practitioner assigned; `'confirmed'`; duration/`ends_at` from the locked service row; token hash | one INSERT (`0170:895-901`) + `action='created'`, `actor_type='client'` (`0170:906-916`), same txn | none; atomicity proven by real Willow traffic (audit/appointment `created_at` delta 162.5 ms → 0) | sentinel `result` | client confirmation, practitioner notification, consent-gated SMS |
| `reschedule_appointment_v2` (`0171:797`) | **EXISTS-UNCHANGED** | `app/reschedule/[token]/actions.ts:774` | raw token, `new_starts_at`, `acknowledged_policy`, presented snapshot hash | every successor field copied from the locked original; new token hash; `cancellation_kind='rescheduled'` set in the *same statement* as the cancel (`0171:1301-1308`); both lineage columns | UPDATE original + INSERT successor + UPDATE lineage + **two** audit rows (`0171:1363`, `:1373`) + the acknowledgement, one txn | token-scoped; ⚠️ still never exercised by a real production reschedule | sentinel `result` incl. `payment_state_requires_studio` | reschedule email; predecessor emits no `event.delete` (`0132:318-320` short-circuits on `cancellation_kind`) |
| `move_or_reassign_appointment` (EFF `0152:537`) | **EXISTS-UNCHANGED** | `app/(app)/calendar/move-appointment-actions.ts:352` | appointment, `new_starts_at`, target practitioner, `expected_starts_at`/`expected_ends_at`, outside-availability | studio + actor from `getCurrentPractitionerWithStudio()`; `ends_at` recomputed from the stored duration (`0152:674`); previous values read under lock | one UPDATE (`0152:686-692`) + `action='moved'\|'reassigned'\|'moved_and_reassigned'` (`0152:694-710`), same txn | **the expected-timestamp pair is the idempotency token** — a replay returns a stale-snapshot refusal | sentinels incl. stale-expectation | move email to client, shadow re-materialised by trigger |
| `practitioner_cancel_appointment` (`0033:241`) | **EXISTS-UNCHANGED** | `app/(app)/calendar/actions.ts:432` | appointment, reason | studio + practitioner; `cancelled_by` = role read from the **live** practitioner row (`0033:256-258`) | one UPDATE (`0033:289-294`) + `action='cancelled'`, `actor_type='practitioner'` (`0033:301-305`) | **yes** — `already_cancelled` returns before any write (`0033:273-275`), so no duplicate audit row | sentinel text; `42501` only for a non-member actor | client cancellation email; enables the `late_cancel` manual fee |
| `mark_appointment_complete` (`0032:4052`) | **EXISTS-UNCHANGED** | `app/(app)/calendar/actions.ts:550` **and** `app/(app)/clients/[id]/sessions/new/actions.ts:49` | appointment | studio + practitioner; `'completed'` | one UPDATE + `action='completed'`, same txn | transition-guarded — a second call raises because the source is no longer `confirmed` | **outlier:** raises `42501`/`P0002`, reducing its caller to `rpcErr.message?.includes(...)` string matching at `actions.ts:566-572`. Do not copy this shape into new commands | triggers `autoSendPostcareOnComplete`; unlocks `session_payment`, the one charge reason permitted in live mode |
| `mark_appointment_no_show` (`0033:334`) | **EXISTS-UNCHANGED** | `app/(app)/calendar/actions.ts:608` | appointment | studio + practitioner; `'no_show'`; `cancelled_at`/`cancelled_by` stay NULL | one UPDATE (`0033:373-376`) + `action='no_show'` | transition-guarded | sentinel text | enables the `no_show` manual fee; nothing to Google (`0132:327-328`) |

#### Lifecycle command needing change

| Command | Status | What changes and why |
|---|---|---|
| `public_cancel_appointment_with_token` (EFF `0091:75`) | **EXISTS-NEEDS-CHANGE** | Add `p_acknowledged_policy` and `p_presented_policy_snapshot_hash`, verify the hash under the row lock, and move the `appointment_policy_acknowledgements` INSERT **inside** the transaction — exactly what `0171:1381-1403` did for reschedule. Today the acknowledgement is written after the RPC commits and its failure is swallowed (`app/cancel/[token]/actions.ts:365-377`), while `lib/billing/manual-fee-eligibility.ts:287-298` makes that row a **hard precondition**, so a lost write permanently forfeits the studio's fee (P2-5, P2-10). Everything else — the `already_cancelled` short-circuit, the started-appointment refusal, the audit row that `app/(app)/calendar/[id]/page.tsx:130-139` renders — stays byte-for-byte. **Not a prerequisite of the revoke.** No invented window classifier |

#### New commands

**`revert_appointment_outcome(p_appointment_id, p_studio_id, p_actor_practitioner_id, p_expected_status, p_reason)` — NEW**

The single reverse edge: `{completed, no_show, cancelled} → confirmed`. This is the capability P2-11 identifies as missing, and it is the answer to "a practitioner mis-clicked Mark no-show". The correction model is the one this repo already uses for imported clinical history (`0089`: correction by soft voiding, never uncontrolled hard delete) and for sessions (`0167` `soft_delete_session`, reason ≥ 10 chars): **a new audit row that reverses, never a rewrite of the old one.** No lateral corrections — `no_show → completed` is performed as revert-then-re-apply, and both halves are audited.

| Field | Contract |
|---|---|
| Caller | New `revertAppointmentOutcomeAction` in a **new** file `app/(app)/calendar/appointment-repair-actions.ts`, mounted from a **new** owner-only panel component. Deliberately not added to `app/(app)/calendar/actions.ts` (2000+ lines) and **not** mounted by editing `app/(app)/calendar/[id]/page.tsx` — Session 1D owns that file in PR #517 |
| DB role | `SECURITY DEFINER`, `set search_path = ''`, `EXECUTE` `service_role` only |
| Request inputs | `appointment_id`, `expected_status` (optimistic concurrency), `reason` (raw, untrimmed) |
| Server-derived | `studio_id` and `practitioner_id` from `getCurrentPractitionerWithStudio()`; `v_role` read **inside SQL** from the live `practitioners` row; `now()`; the id of the audit row that set the current status |
| Validations | `length(btrim(p_reason)) >= 10` (`0167:455` precedent — SQL is the *only* trimmer; JS `.trim()` strips a wider Unicode set, the exact bug carried by the 0171 work) · actor is an **active owner** of `p_studio_id`, a deliberate tightening versus cancel/complete/no-show · row scoped `(id, studio_id)` · `status = p_expected_status` · `p_expected_status in ('completed','no_show','cancelled')` · `cancellation_kind is distinct from 'rescheduled'` and `rescheduled_to_appointment_id is null` · **correction window**: the audit row that set the current status must exist and be < 72 h old; no audit baseline ⇒ refuse (`no_audit_baseline`) · `appointment_has_blocking_dependents()` returns NULL · for `cancelled → confirmed` only, `starts_at > now()` |
| Mutation | One UPDATE: `status='confirmed'`, `cancelled_at/cancelled_by/cancellation_reason = null`, `updated_at = now()`, with `and status = p_expected_status` **in the WHERE clause** as the concurrency guard. Nothing else on the row is touched, so revert-then-re-apply reproduces the original state exactly |
| Audit row | One `action='outcome_reverted'`, `actor_type='practitioner'`, `details` = `{from, to, reason, role, reverted_audit_id, source:'operator_repair'}`, same txn. The original outcome row is never touched — and after 0174 that is enforced, not merely intended |
| Idempotency | Self-idempotent: a second call sees `status='confirmed' <> p_expected_status`, updates zero rows, returns `stale_appointment`, writes no audit row |
| Return | `table (result text, appointment_id uuid, previous_status text, new_status text, audit_id uuid)` |
| Errors | Sentinels only, never `raise` for a business refusal. Two mapped constraint escapes: `23P01` → `slot_no_longer_available`, `HB001` → `buffer_conflict` |
| Events | **No** client email and **no** practitioner notification — the client was never told about the erroneous no-show, so there is nothing to un-tell, and `PractitionerNotificationEventType` has no reversal member. `cancelled → confirmed` re-inserts the shadow reservation (`0152:123-140`) and may hit the unconditional GiST exclusion if the slot was rebooked — hence the `23P01` mapping. Google: `→ confirmed` lands in the upsert arm (`0132:271-275`), so a revert emits an `event.create`/`event.update` for a transition that never emitted a delete. Dormant today; see §11.8 |

**`set_appointment_notes(p_appointment_id, p_studio_id, p_actor_practitioner_id, p_notes)` — NEW**

The smallest command here and the one that is pure new capability rather than regression cover. `appointments.notes` (`0010:184`) is written **only at creation** and nothing in the product edits it; after the revoke it becomes permanently immutable.

| Field | Contract |
|---|---|
| Caller | `setAppointmentNotesAction`, same new file |
| DB role | `SECURITY DEFINER`, `service_role` only |
| Request inputs | `appointment_id`, `notes` |
| Server-derived | studio + practitioner from the session |
| Validations | **active member, not owner-only** — correcting a booking note is ordinary work · row scoped `(id, studio_id)` · `length(p_notes) <= 2000` |
| Mutation | `set notes = nullif(btrim(p_notes), ''), updated_at = now()` |
| Audit row | `action='notes_edited'`, `details` = `{previous_length, new_length, source:'operator_edit'}` — **lengths, not text**. Notes can carry client-identifying content and `appointment_audit` is member-readable via `appointment_audit_member_read`; copying note text into `details` would widen the read surface for data the trail does not need |
| Idempotency | Naturally idempotent; skip the audit row when the value is unchanged |
| Return | `table (result text, appointment_id uuid)` |
| Errors | Sentinels |
| Events | **None, and this is verifiable rather than assumed.** `notes` appears in no trigger's `UPDATE OF` column list — `appointments_enforce_buffer_trg` (`0152:241`), `appointments_set_capacity_enabled_trg` (`0134:124`), `appointments_sync_calendar_reservation_trg` (`0134:478`) and `appointments_zzz_outbound_enqueue_trg` (`0125:323`) all name explicit columns that exclude it; the sync-version bump fires only on `starts_at`/`ends_at`/`status` (`0125:71-74`) |

#### Peripheral writers

| Writer | Status | Position |
|---|---|---|
| `record_email_attempt` (`0033:63`), `claim_email_send`/`record_email_result` (`0098:45`,`:118`), `claim_sms_send`/`record_sms_result` (`0049:170`,`:230`) | **EXISTS-UNCHANGED** | They stay **outside** the lifecycle command boundary and **inside** the privilege boundary. They touch no state-machine column, fire no scheduling trigger (column-list verified against all seven appointment triggers), are machine-driven with no human actor, and are already `service_role`-only. Writing an audit row per reminder attempt would bury the four rows that describe what actually happened to the client under six machine rows. The `p_studio_id` scoping and the `status='confirmed'` claim predicate (P3-08, P3-09) are a later hygiene PR |
| `repair_bump_appointment_sync_version` (`0125:384`) | **EXISTS-NEEDS-CHANGE** | The one exception in that family: it causes **real outbound Google traffic** (`sync_version` is in the enqueue trigger's column list at `0125:324-325`). It currently mutates any appointment in any studio with no studio predicate, no lock and no audit row. Add `p_studio_id` and a `'system'` audit row. The caller already has the studio id in hand. Deferred — the whole outbound path is dormant |
| `rematerialize_studio_reservations` (EFF `0137:247`) | **EXISTS-NEEDS-CHANGE** | Independent of the boundary and **more urgent than it looks**: its appointment arm still inserts buffer-EXPANDED shadow intervals (`0137:271-279`), contradicting 0152's actual-interval contract. Its trigger entry points fire on exactly the first capacity activation, so its first run re-hardens the SOFT buffer into a `23P01` and can abort the flag flip (P2-7). Fix before capacity is ever enabled anywhere |
| The seven `postcare_email_*` direct UPDATEs (`app/(app)/calendar/actions.ts:1114,1155,1211,1242`; `postcare-auto-send.ts:151,186,200`) | **EXISTS-UNCHANGED** for the boundary; `record_postcare_email_state` is **NEW** and deferred | These are `service_role` writes scoped `.eq("id").eq("studio_id")` that touch only bookkeeping columns — they are *inside* the boundary the revoke draws, not outside it. The command that replaces them closes P2-6 and P3-15 and makes `rg` over `app/` + `lib/` return **zero** direct appointment DML, which is what turns the boundary from an argument into a CI assertion. It collides with Session 1D; ship after #517 |
| `reschedule_appointment` (EFF `0091:186`), `practitioner_move_appointment` (EFF `0145:200`), `create_internal_appointment` (`0147:31`) | **EXISTS-NEEDS-CHANGE** — retire in 0175 | All three caller-less, all three `service_role`-EXECUTE-able, all three strictly weaker than their replacements. The legacy reschedule performs no availability, horizon, blockout or slot-membership validation, writes no lineage, and never sets `cancellation_kind='rescheduled'` — so if it were ever called it would emit the exact Google churn `0171:1295-1300` exists to prevent. The retention reason at `0171:61-66` (deployment skew) has expired. Precedent for the drop: `0091:166-176` |

---

### 11.6 Shared foundations

Things every command depends on, stated once so no command re-derives them.

**Already in place — do not touch, do not overstate**

| Foundation | Location | Why it matters here |
|---|---|---|
| `public.is_studio_member(uuid)` | `0001:153-166`, never redefined | Active practitioner, target studio, `auth.uid()` — **no role gate**. It is the entire `USING`/`WITH CHECK` of every appointment-domain policy, and the replacement `FOR SELECT` policy must reuse it verbatim so no read changes |
| `validate_appointment_availability` | EFF `0152:250`, `service_role` only | The single derivation point for hours, availability, blockouts, breaks, duration authority, eligibility, horizon and booking-pause. **No trigger calls it** — which is exactly why the revoke is the enforcement and not a nice-to-have. It also degenerates to buffer-only at capacity-OFF studios (P2-2); do not claim it as a schema guarantee |
| The unconditional shadow exclusion | `0134:236-244`, fed by `sync_appointment_to_calendar_reservation` (EFF `0152:108-150`) | Fires for direct DML too, and derives `resource_key` from the live studio flag rather than the row's own `capacity_enabled`. **Double-booking was never open. Do not claim the revoke closes it** |
| Composite same-studio FKs | `0151:83-99` | `(client_id, studio_id)`, `(service_id, studio_id)`, `(practitioner_id, studio_id)`. The reason there is no cross-tenant write path, and therefore the reason this is P1 and not P0 |
| The buffer pair | `snapshot_appointment_buffer` `0029:62-93` + CHECK `0029:209-214` | The only two columns a direct writer already could not forge |
| `appointments.status` CHECK | `0010:183` | **Value-only.** No transition constraint anywhere. The state machine is a property of which function you call, not of the data — until 0175 |
| The migration-state spine | `scripts/migration-state.mjs` (`PERMANENTLY_SKIPPED = [158]`) → `tests/migrations/helpers/migration-state.ts` → `docs/production/migration-state.json` | Pins live in **both** `tests/docs/` and `tests/migrations/`. Run the FULL unit suite; 0163, 0164 and 0165 each went red after push for precisely this reason |
| `tests/db/helpers/harness.ts` | `adminQuery` / `asRole` / `userQuery` | Every appointment-writing statement in the entire `tests/db` tree uses `adminQuery`, so the revoke breaks **zero** test seeding. `asRole()` **always rolls back** — assert the SQLSTATE, never a row count |
| The `0169` template | `supabase/migrations/0169_*.sql` | Six revokes inside its **own** `begin;`/`commit;` with `set local lock_timeout = '5s'`, and the "never `revoke all`" doctrine in its header. 0172 copies this shape exactly |

**To be built**

| Foundation | Migration | Contract |
|---|---|---|
| `lock_appointment_for_command(p_appointment_id, p_studio_id) returns public.appointments` | 0173 | Enforces **the** lock order in one place: `studios FOR UPDATE` → `acquire_studio_capacity_lock()` (`0136:225`) → `appointments FOR UPDATE` scoped `(id, studio_id)`. `0170`, `0171:875-951` and `0152:576-586` all use this order; a new command that improvises its own will deadlock against a concurrent booking under load. This is the easiest thing to get wrong when adding commands |
| `appointment_actor_role(p_studio_id, p_practitioner_id) returns text` | 0173 | Role read from the live `practitioners` row, never from the caller. Inlined today at `0033:255-262` and duplicated at `0032:4064-4070`. Needs no grants at all — the `0167:591-599` posture |
| `appointment_has_blocking_dependents(p_appointment_id) returns text` | 0173 | Returns the first blocking dependent's sentinel or NULL: live `public.sessions` (`0068:53`) → `clinical_session_linked`; `payment_charge_attempts` (`0073:200`, `on delete restrict`), `manual_fee_charge_attempts` (`0064:155`, restrict), `appointment_payments` (`0032:747`, restrict) → `payment_state_requires_studio`; `postcare_email_sent_at is not null` → `postcare_already_sent`. This one helper is what keeps the operator escape hatch from becoming a money-and-clinical-record hazard, and it reuses `0171:1162-1182`'s refuse-rather-than-move-money doctrine |
| `write_appointment_audit(...) returns uuid` | 0173 | The single INSERT point, returning the new id. Today there are 28 hand-written inserts across 17 migrations; one helper means `details.source` is never forgotten and the shape stays comparable |
| `appointment_audit.studio_id` + FK re-point + read-policy rewrite | 0174 | `studio_id uuid not null references public.studios(id) on delete cascade`, backfilled through `appointments`; then `appointment_id` becomes nullable and its FK moves from `on delete cascade` (`0010:219`) to `on delete set null`; `appointment_audit_member_read` (`0010:280-288`) is rewritten onto `using (public.is_studio_member(studio_id))`. This is the structural answer to **P1-2** — history that survives its parent row — and no privilege revoke can give it to you. The only application read (`app/(app)/calendar/[id]/page.tsx:130-139`, filtered by `appointment_id` + `action='cancelled'`) is unchanged and still passes the new policy, so there is **no file overlap with Session 1D** |
| `appointment_audit_derive()` `BEFORE INSERT` | 0174 | Overwrites `created_at := now()` (today a plain writable column, `0010:224`) and derives `studio_id`, ignoring anything the caller supplied. Plus a `NOT VALID` CHECK correlating `actor_id` nullability with `actor_type`, and a `NOT VALID` FK `actor_id → practitioners(id)`. Production may hold rows written by commands since dropped (`finalize_card_required_public_booking`, dropped at `0091:174`), hence `NOT VALID` |
| `appointment_audit_append_only()` | 0174 | `BEFORE UPDATE OR DELETE`, matching `stripe_payment_audit_immutable` (`0032:1411`) and `clinical_audit_events_append_only` (`0120:219`). **Sequencing is load-bearing:** the DELETE arm is only safe after the FK re-point above. Applied before it, every appointment DELETE fails — including `tests/db/practitioner-move-appointment.db.test.ts:117,124`, `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:285,294,415` and `tests/db/google-calendar-c1-link-transition.db.test.ts:297,324`, all of which delete appointments and rely on the cascade. D2 caught this; D3 proposed the DELETE arm with no mention of it |
| `guard_appointment_status_transition()` | 0175 | `BEFORE INSERT OR UPDATE OF status`, named `appointments_aaa_*` so it fires before the derived-column triggers (Postgres orders same-timing row triggers by **name**; the repo already uses `zzz_` for the opposite end at `0125:323`). INSERT arm: born `'confirmed'` only. UPDATE arm: the **full legal edge set** — forward `confirmed → {cancelled, completed, no_show}` and reverse `{cancelled, completed, no_show} → confirmed`. Every lateral edge raises, closing I2, I3, I5, I6 and I7 at the DB layer, which nothing does today. **No time gates and no GUC or `current_user` escape hatch:** the reverse edges are legal in the trigger and the *commands* restrict who may traverse them and under what conditions. That is what keeps `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:230-231`'s "defensive un-cancel" green |
| `set_updated_at` on `public.appointments` + `capacity_enabled` in its own trigger's column list | 0175 | Every other mutable table in the tree has the former (`0015:74`, `0019:52`, `0034:98`, `0053:125`, `0058:179`, `0140:144`); `appointments.updated_at` has only `default now()` (`0010:189`), so the postcare writers leave it stale (P3-07). The latter is one word added to `0134:124-128`: the column is absent from its **own** trigger's `UPDATE OF` list, so a bare `set capacity_enabled = …` is never re-derived and silently migrates the row between the two partial GiST exclusions (P2-13) |
| A static direct-DML census guard for `appointments` / `appointment_audit` | with 0172 | `tests/security/entry-direct-dml-guard.test.ts:36-43` covers six clinical tables; the syntax-aware analyzer that makes this trivial already exists at `tests/security/helpers/supabase-write-census.ts`. This is the cheap, zero-runtime-risk substitute for D2's `current_user` guard: it catches a regression at CI time instead of failing closed in production |
| **Hard prohibition** | all migrations in this program | Do **not** `create or replace public.snapshot_appointment_buffer()`. Three repository tests assert production's deployed body carries an out-of-band GUC bypass (`app.bypass_appointment_buffer_snapshot`) that exists in no migration and in no locally-reset database. Replacing it from repo source would silently delete a live production behaviour (P2-8). The existing negative guards are scoped to 0171 and do **not** generalise — each new migration must carry its own copy |

---

### 11.7 Decisions the user must make

None of these are audit findings. They are places where the product genuinely has no decision recorded, and where a designer would otherwise have to invent one.

1. **Does the revoke wait for the repair command, or ship first?** §10 P2-11 rates the missing repair path as a prerequisite of P1-1. That is defensible, but it is worth being precise about what the revoke actually removes: it is scoped to `authenticated`, so it does not touch the operator's real channel — the Supabase SQL editor as `postgres`, or a service-role script — and the "escape hatch" it closes was never an in-product capability, only a devtools `PATCH` no practitioner has been asked to perform. **Recommendation: resolve it by measurement, not argument.** Run one read-only production query through the approved channel (`supabase db query --linked`): `select status, count(*) from public.appointments a where not exists (select 1 from public.appointment_audit x where x.appointment_id = a.id) group by status;`. If it returns zero, the direct path has never been used and the revoke may ship first as 0172 with the repair command as 0173. If it returns rows, someone *has* been correcting data by hand, the repair command becomes a genuine prerequisite, and the order flips. That query is D3's best contribution.
2. **Should Hone ever hard-delete an appointment?** Today nothing in the product does; after the revoke nothing outside `service_role`/`postgres` can. But a client data-deletion request will eventually need an answer, and the current cascades (`appointment_audit` `0010:219`, `appointment_policy_acknowledgements` `0056:34`) mean any deletion also destroys the evidence of itself. 0174's FK re-point fixes the audit half. The policy-acknowledgement half — and whether a retention/erasure path is needed at all — is a product and legal decision.
3. **Should Hone have a structured cancellation window?** `0064:37` and `lib/billing/manual-fee-eligibility.ts:56` record the current answer as "not yet — v1 records the practitioner's manual assertion with a surfaced warning". D3 proposed building one. That is a pricing-policy decision, not a boundary decision, and it should be made on its own merits.
4. **Should automatic no-show marking be re-enabled?** `app/api/cron/no-show-check/route.ts:4-38` already contains the correct design (cutoff = `ends_at` + grace, mutation through `mark_appointment_no_show`, claim + advisory lock) and a documented decision to stay disabled. Re-enabling it manufactures fee-eligible states with no human in the loop and depends on P3-16 (one shared `CRON_SECRET` for all five routes, held by a third-party scheduler) being fixed first.
5. **Is 72 hours the right correction window for `revert_appointment_outcome`?** The number is chosen, not derived. Any bound is defensible; none is in the product today.

---

### 11.8 Risks

1. **The three contradicting tests are the single highest-probability way this ships broken.** `tests/db/public-appointment-command.db.test.ts:474-489`, `tests/db/public-reschedule-command.db.test.ts:1430-1443` and `tests/db/appointments-tenant-consistency.db.test.ts:131-147` all encode the current posture and all run against a fresh migrated chain. Anyone who writes the migration first and runs a scoped local lane will see green locally and red in CI. Edit them in the same commit.
2. **`revoke all` would take `SELECT` with it and break the product** across ~22 read sites, two of which Session 1D owns. Name `insert, update, delete` and nothing else in groups 1 and 2.
3. **Dropping `appointments_member_all` without creating `appointments_member_select` has the same blast radius.** Adjacent statements, same transaction, predicate reused verbatim.
4. **`REVOKE` takes an ACCESS EXCLUSIVE lock**, and `appointments` is the busiest table in the product. `set local lock_timeout = '5s'` only arms inside the file's own `begin;`/`commit;` — `supabase db push` does not wrap a migration file in a transaction and a bare `SET LOCAL` emits `25P01`.
5. **The L18 precedent is an ACL-verified revoke that was never behaviourally probed in production. Do not repeat it.** `has_table_privilege` returning false is a catalog read, not proof that a real JWT gets `42501`. Plan a controlled post-apply probe, and do not write "production-verified" in the PR until it has run.
6. **Do not overstate what the revoke closes.** It does not close double-booking (never open — `0134:236-244`), it does not close the transition state machine for `service_role` (0175 does, partially), and it does not touch the seven postcare UPDATEs. What it closes is the **browser** path to forged status transitions, forged reassignment, silent deletion, and audit forgery. State it that way in the migration header, the PR body and the memory note.
7. **The audit append-only DELETE arm must not precede the FK re-point.** At least six DB test files delete appointments and rely on the `0010:219` cascade. Ordering this wrong takes the whole `tests/db` lane red — and the lane is *conditional* in CI (`.github/workflows/ci.yml:229`), so a PR touching no `supabase/**` path would not even reveal it.
8. **`revert_appointment_outcome` has a Google edge nobody has reasoned about.** `completed` and `no_show` emit nothing outbound (`0132:327-328`), but `→ confirmed` lands in the upsert arm (`0132:271-275`), so a revert emits an `event.create`/`event.update` for a transition that never emitted a delete. Dormant today (zero studios have outbound sync enabled — **unverified**, no production access), and it activates the moment the flag is turned on. Decide explicitly — suppress the enqueue for reverts, or accept it as correct-by-convergence — rather than discovering it at activation.
9. **Session 1D owns `app/(app)/calendar/[id]/page.tsx`** (draft PR #517, code-only, migration max still 0171). None of the four migrations require editing it. But three adjacent temptations do: the audit reader's `order by created_at desc limit 1` tie-break, anything touching `postcare_email_*`, and widening the history timeline so the operator can actually *see* the new `outcome_reverted` and `notes_edited` rows. **A repair model whose audit trail the operator cannot see is not an operator tool** — sequence that widening after #517 merges. Also: any PR adding an e2e spec is a guaranteed textual conflict, because it must add the filename to `BROWSER_GROUPS` in `scripts/browser-groups.mjs` (1D-owned) and bump the hard-coded counts at `tests/ci/browser-selection.test.ts:64-71`. Do not add an e2e spec to 0172.
10. **Reason-length validation must have exactly one authority.** Every repair command gates on `length(btrim(p_reason)) >= 10`. JS `.trim()` strips a wider Unicode whitespace set than Postgres `btrim()`; send the raw string, let SQL be the only trimmer, and assert the disagreement case in a unit test. This bug is already on the record from the 0171 work.
11. **The hosted grants are inferred, not measured.** Every privilege claim rests on the absence of any GRANT/REVOKE across 170 migrations plus two repo tests asserting the open posture on a **fresh local chain**. Neither is a production measurement. Before 0172 is pushed, run the applied-state check through the approved read-only path — exactly what `0169:29-43` did for the six clinical tables ("Measured in production before writing this").
12. **Post-apply verification must be measurement, not assertion — the 0171 standard.** Before/after business counts identical (appointments 139 / 63 confirmed / 29 cancelled, `appointment_audit` 220, acknowledgements 12, reservations 117 as of 2026-08-05), `max(appointments.updated_at)` unchanged, then a real privilege probe on both roles and both tables, and a member `SELECT` that still returns rows.
13. **`anon` SELECT is deliberately retained on both tables.** The evidence is that every public/pre-auth route already uses the service-role client, so `anon` needs no privilege at all — but that is an argument, not a probe. A later reviewer who wants to revoke it must prove it first.
14. **Never push without approval, and guard the CLI ref.** `supabase/.temp/project-ref` carries the PROD ref; read-only prod SQL is `db query --linked` (`db dump` is classifier-blocked). The production `snapshot_appointment_buffer` GUC drift must not be "fixed" by any migration in this program.

---

## 12. Focused PR sequence

### 12.0 The audit brief's nine-PR structure, checked against the evidence

The brief proposed nine PRs: shared foundations · internal creation · public booking · reschedule + move ·
cancellation · complete + no-show · reassignment + outside-hours override · direct DML revocation ·
final census + negative-security suite.

That structure is the right *shape* for a domain where the commands do not exist yet. In this domain they
do. Fifteen appointment writers were reviewed in §§4–8 and **every single one that a browser can reach is
already a `service_role`-only `SECURITY DEFINER` command**, and **zero appointment writes use the
authenticated client**. Six of the brief's nine PRs therefore have nothing to build.

| Brief's PR | What the evidence says | Becomes |
|---|---|---|
| 1. Shared foundations | Partly exists and must not be re-derived: `is_studio_member` (`0001:153-166`), the two partial GiST exclusions (`0152:80-97`), the unconditional shadow exclusion (`0134:236-244`), the composite same-studio FKs (`0151:83-99`), the buffer pair (`0029:62-93`). What is genuinely missing is four SQL helpers (`lock_appointment_for_command`, `appointment_actor_role`, `appointment_has_blocking_dependents`, `write_appointment_audit`) — and they exist to serve the **new** commands only, so they belong in that migration, not in a standalone foundations PR that ships four unused functions | **Folded into B4.** A foundations PR with no consumer is dead SQL with a `service_role` grant — the exact shape of `finalize_card_required_public_booking`, which sat installed and caller-less from 0032 to 0091 |
| 2. Internal creation | `create_internal_appointment_v2` EFFECTIVE `0152:376`, called from `app/(app)/calendar/actions.ts:311` via `createAdminClient()`, `EXECUTE` `service_role` only (`0152:733-734`). **EXISTS-UNCHANGED** | **Verify + pin only → B2** |
| 3. Public booking | `create_public_appointment` `0170:636`, called from `app/book/[slug]/actions.ts:776`. Shipped 2026-08-04 and proven atomic by real Willow traffic. **EXISTS-UNCHANGED** | **Verify + pin only → B2** (already has `tests/db/public-appointment-command.db.test.ts` + a route guard) |
| 4. Reschedule + move | `reschedule_appointment_v2` `0171:797` and `move_or_reassign_appointment` EFFECTIVE `0152:537`. Both **EXISTS-UNCHANGED**. ⚠️ v2 has never been exercised by a real production reschedule | **Verify + pin only → B2** |
| 5. Cancellation | Two commands. `practitioner_cancel_appointment` (`0033:241`) **EXISTS-UNCHANGED**. `public_cancel_appointment_with_token` (EFFECTIVE `0091:75`) is **EXISTS-NEEDS-CHANGE** — the policy acknowledgement is written outside the transaction and swallowed on failure (P2-5) with no snapshot-currency check (P2-10). This is the **only** lifecycle command in the domain that needs real work, and it is **not** a prerequisite of the revoke | **Split: verify+pin → B2; the real change → B7** |
| 6. Complete + no-show | `mark_appointment_complete` (`0032:4052`) and `mark_appointment_no_show` (`0033:334`). Both **EXISTS-UNCHANGED**. But both have **zero behavioural coverage** — `rg -ln "mark_appointment_complete\|mark_appointment_no_show" tests/db/` returns one file whose only reference is a `prosrc` text scan (`tests/db/public-booking-concurrency.db.test.ts:299-300`) and a test named for the RPC that actually runs a bare `select … for update` (`:259-287`) | **Verify + pin, with real new tests → B2** |
| 7. Reassignment + outside-hours override | There is no separate reassignment command. Reassignment *is* `move_or_reassign_appointment` — the 7-arg `practitioner_move_appointment` overload was dropped at `0148:31` and the delegate at `0145:200` is caller-less. Outside-hours override is an owner-gated boolean parameter on the same command and on `create_internal_appointment_v2`. Two genuine defects live here (P2-1: the override also silently disables the soft buffer, contradicting the UI promise at `MoveAppointmentDialog.tsx:525`; P2-13: `move_or_reassign_appointment` unconditionally sets `booked_outside_availability = p_allow_outside_availability` at `0152:690`, silently clearing an owner's prior override) — but neither is a *boundary* defect and neither is closed by any privilege change | **Collapsed into B2 for coverage; the two defects are named and deferred to B9's backlog, not manufactured into a PR** |
| 8. Direct DML revocation | The actual P1 closure. `public.appointments` and `public.appointment_audit` carry **no GRANT and no REVOKE in any of the 170 migrations**, so `anon` and `authenticated` hold INSERT/UPDATE/DELETE by Supabase default privilege — asserted by two shipped tests on a fresh chain (`tests/db/public-appointment-command.db.test.ts:474-489`, `tests/db/public-reschedule-command.db.test.ts:1430-1443`) | **B3, migration 0172 — unchanged in substance, promoted in priority** |
| 9. Final census + negative-security suite | Correct that it is needed. **Wrong that it goes last.** The static census (T2) passes *today*; shipping it last means the seven known writers were never frozen while the migration was written. The behavioural probes (T1, T3) fail today and can only ship *with* the migration | **Split: census first (B1), probes with the migration (B3), reconciliation last (B9)** |

**Net structural change.** Six build-PRs become one verify-and-pin PR. The census moves from last to first.
The revocation moves from eighth to third. Two capabilities the revoke genuinely freezes (a governed
outcome revert, and editable notes) get a PR that the brief did not have. Total count stays at nine
because the audit found work the brief did not know about — audit integrity, the transition guard,
and the `/cancel` acknowledgement atomicity fix.

**One thing the brief got exactly right and that must not be softened:** the revocation is its own PR. It
is the only PR in this program with *zero* application-code change, and that property is what makes it
reviewable, pushable independently of a deploy, and trivially reversible.

---

### 12.1 The sequence at a glance

| # | PR | Migration | Merge order | Blocked by | Session 1D conflict |
|---|---|---|---|---|---|
| **B1** | Appointment direct-DML census guard + unit-test repairs | none | 1 | — | **No** |
| **B2** | Lifecycle / audit-invariant / cross-tenant behavioural coverage (verify + pin) | none | 2 | — (parallel with B1) | **No** |
| **B3** | Revoke `anon`/`authenticated` DML on `appointments` + `appointment_audit` | **0172** | 3 | B1, B2; **operator probe §13.2** | **No** |
| **B4** | Appointment repair commands (`revert_appointment_outcome`, `set_appointment_notes`) + shared SQL helpers | **0173** | 4 | B3 (or swaps with it — §12.5) | **Yes, small** — the UI mount is ~12 lines in a 1D-owned file |
| **B5** | Appointment audit integrity (`studio_id`, FK re-point, derive trigger, append-only) | **0174** | 5 | B3, B4 | **No** |
| **B6** | Transition guard + `set_updated_at` + `capacity_enabled` trigger fix + legacy RPC retirement | **0175** | 6 | B5 (ordering is load-bearing) | **No** |
| **B7** | `/cancel` policy-acknowledgement atomicity + snapshot currency | **0176** | 7 | B4 (reuses `lock_appointment_for_command`) | **No** |
| **B8** | Postcare email-state command — retire the last seven direct writers | **0177** | 8 | **PR #517 must be merged** | **Yes, hard** |
| **B9** | Final census, docs reconciliation, findings-register refresh, vacuous-test repairs | none | 9 | B8 | **No** |

Nine PRs. Six migrations, `0172`–`0177`. Three PRs carry no migration.

> **Re-phased by §16.6.** The PR identities and contents above are unchanged, but the **order and the
> migration slots move**: additive attribution (`B5`, extended with `D4`/`D5`) takes `0172` and ships
> **before** the revocation (`B3`), so the boundary is not closed around commands that still do not record
> an appointment's creator. Subsequent numbers come from `npm run migration:state` at cut time. The cost —
> `P1-1` and `P1-2` stay open one extra migration cycle — is stated and bounded in §16.6.

---

### 12.2 The PRs

#### B1 — Appointment direct-DML census guard + unit-test repairs

**Why first.** It is green at `03e7dea`, it costs nothing to review, and it *freezes the seven known
writers* before anyone starts editing SQL. Every later PR in this program is safer because this one
landed: if B8's refactor accidentally leaves a direct write behind, or if a merge from `main` reintroduces
one, CI says so. Shipping it last — as the brief proposed — means the ratchet is installed after the thing
it was meant to ratchet.

**Exact scope**
* New `tests/security/appointment-direct-dml-guard.test.ts` implementing **T2.1–T2.7** (§14.4). Built on
  `tests/security/helpers/supabase-write-census.ts` (`supabaseWriteSites()` at `:365`), the
  TypeScript-compiler-API census — **not** the bracket-walking `directWriteSites()` local to
  `entry-direct-dml-guard.test.ts:96-131`, which is strictly weaker.
* `ALLOWED` list of exactly seven entries: `app/(app)/calendar/actions.ts:1114,1155,1211,1242` and
  `app/(app)/calendar/postcare-auto-send.ts:151,186,200`. Column assertion: each site's `columns` ⊆ the
  `postcare_email_*` set (T2.2), so a payload that grows `status`, `starts_at` or `practitioner_id` fails
  immediately. `appointment_audit` write sites must be **empty** (T2.3).
* Negative control (T2.5): `expect(found).toHaveLength(7)` with an explicit message, copying
  `entry-direct-dml-guard.test.ts:629-641`. Without it a broken analyzer produces a green suite.
* Receiver proof (T2.6/T2.7): every allowed site's client must originate from `createAdminClient()` via
  `clientFactoryProof()` / `insertReceiverProof()`. This is the **inverse** of the clinical guard, where
  admin-receiver is the failure; here it is the requirement.
* Fix `tests/app/calendar/postcare-auto-send.test.ts:44-69` — `b.from = () => b` (`:50`) discards the
  table name and `b.eq = () => b` (`:63`) discards `.eq("studio_id", …)`. Record both and assert
  `("appointments", "studio_id", studio.id)`. This is the unit coverage for three of the seven writers and
  today it cannot detect a wrong table.
* Fix `tests/security/service-role-allowlist.ts:38` — its `why` still claims *"The move goes only through
  `practitioner_move_appointment` (service_role-only)"*, while
  `app/(app)/calendar/move-appointment-actions.ts:352` calls `move_or_reassign_appointment` and
  `tests/app/calendar/move-reassign-source.test.ts:16` positively asserts the old RPC is absent. Add the
  P3-06 hardening: for entries whose file performs appointment DML, `scopeGuard` must be a *distinguishing*
  token (an `.eq("studio_id", …)` literal or the specific RPC name), not the generic
  `getCurrentPractitionerWithStudio` that appears in nearly every authenticated action.

**Likely files.** `tests/security/appointment-direct-dml-guard.test.ts` (new);
`tests/security/service-role-allowlist.ts`; `tests/security/service-role-allowlist.test.ts`;
`tests/app/calendar/postcare-auto-send.test.ts`.

**Migration.** None.

**Dependencies.** None. Buildable immediately.

**Test plan.** `npm run test:unit` (full — not scoped; see §13.4). Deliberate red run first: temporarily
add an eighth `.from("appointments").update(...)` to a scratch file, confirm the guard fails, remove it.
Then temporarily rename `appointments` → `appointmentz` in the guard's `TABLES` and confirm T2.5's negative
control fails — this proves the census is actually finding the seven, not vacuously finding none.
CI lane: sets `security=true` (`scripts/classify-changes.mjs:44`), so `db-integration` also runs.

**Rollback.** Revert the commit. No production surface, no schema, no data.

**Merge order.** 1. Parallel-safe with B2.

**Session 1D.** No collision. The census *walks* `app`, `lib`, `components`, `scripts` — including all
seven 1D-owned files — but none of them writes an appointment (`app/(app)/calendar/[id]/page.tsx` has no
`.update(`/`.insert(`/`.delete(`/`.rpc(` at all). After #517 merges, re-run this guard: it is the cheapest
possible confirmation that 1D added no writer.

---

#### B2 — Lifecycle, audit-invariant and cross-tenant behavioural coverage (verify + pin)

**This PR is where six of the brief's nine PRs went.** It builds no command. It proves the ones that exist
behave as §§4–8 claim, and it pins that behaviour before four migrations start changing the schema
underneath them.

**Exact scope**
* New `tests/db/appointment-lifecycle-commands.db.test.ts` — **T6.1–T6.7**. `mark_appointment_complete`,
  `mark_appointment_no_show` and `practitioner_cancel_appointment` have *no behavioural test anywhere*.
  Both 0033 commands **return sentinel strings rather than raising**, which makes untested branches
  especially dangerous: a caller that ignores the return value turns a refusal into a silent no-op. One
  case per sentinel — `not_authorized`, `already_cancelled`, `not_cancelable`, `wrong_status`, `too_late`,
  `too_early`, `marked`, `cancelled` — plus the `42501`/`P0002` raises from `mark_appointment_complete`,
  plus the EXECUTE-grant matrix (T6.6) and the rollback invariant on every refusal path (T6.7).
* New `tests/db/appointment-audit-invariant.db.test.ts` — **T5.1–T5.4, T5.6**. A table-driven sweep over
  all eight status-mutating commands asserting *status changed ⇒ audit count strictly increased*; the
  exact `action` vocabulary (a rename silently blanks the rendered surface at
  `app/(app)/calendar/[id]/page.tsx:135`, which filters on the literal `'cancelled'`); `actor_id` resolves
  to an active practitioner of the appointment's studio (the **only** place this correlation is asserted —
  `actor_id` is a bare uuid with no FK, `0010:221`); `created_at` ≈ `now()`; and audit rows are not
  UPDATE/DELETE-able by a member.
  **T5.5 ships as `it.fails(...)` with the reason inline** — a direct `service_role` status write produces
  no audit row today because no trigger writes the table, and encoding that as an expected-red test puts
  the goal in the suite instead of in prose. It flips to a normal `it()` in B5.
* Extend `tests/db/cross-studio-isolation.db.test.ts` — **T4.1–T4.4**. The suite covers `clients`,
  `sessions`, `session_blocks` and two record-keeping tables, all SELECT-only; appointments are absent
  entirely. Add the `service_role` composite-FK permutations for `client_id`, `service_id` and
  `practitioner_id` (`0151:83-99`) and the two authenticated read-isolation cases. **T4.5 is deliberately
  held for B3** — it asserts `42501`, which is false today.
* Rewrite the mis-named `tests/db/public-booking-concurrency.db.test.ts:259-287`
  (*"mark_appointment_complete on the source waits for the create"*), which executes a bare
  `select … for update` and never calls the RPC. Either invoke the command or rename the test to what it
  measures.

**Likely files.** `tests/db/appointment-lifecycle-commands.db.test.ts` (new);
`tests/db/appointment-audit-invariant.db.test.ts` (new); `tests/db/cross-studio-isolation.db.test.ts`;
`tests/db/public-booking-concurrency.db.test.ts`. Possibly a small `seedAppointment` addition to
`tests/db/helpers/harness.ts` — note that touching `tests/db/helpers/**` sets
`full_matrix_required` (`scripts/classify-changes.mjs:31`), so prefer a local helper inside the new file.

**Migration.** None.

**Dependencies.** None. Parallel-safe with B1 (zero file overlap).

**Test plan.** `npm run test:db` against the local stack. Every new test must be shown red-then-green by
deliberately breaking the thing it asserts (e.g. call `practitioner_cancel_appointment` twice and confirm
the second produces `already_cancelled` **and no second audit row** — the `0033:273-275` short-circuit).
Confirm T5.5 is reported as an expected failure, not a pass.

**Rollback.** Revert. Test-only.

**Merge order.** 2. Must merge **before** B3, because three of these tests establish the pre-revocation
baseline that B3's inversions are measured against.

**Session 1D.** No collision — `tests/db/**` only, and 1D's PR #517 is code-only.

---

#### B3 — Revoke `anon`/`authenticated` DML on `appointments` and `appointment_audit` — **migration 0172**

**The P1 closure.** One privilege migration, **zero application-code change**. The clinical precedent took
two steps 82 migrations apart (0087 split the `FOR ALL` policies, 0169 revoked the privileges) *because 25
authenticated clinical writers existed in between*. Appointments has **zero**, so the two steps collapse
into one migration with no compatibility window.

**Exact scope — the migration**, four separable groups inside the file's **own** `begin;`/`commit;` with
`set local lock_timeout = '5s'` armed inside it (`supabase db push` does not wrap a migration file in a
transaction; a bare `SET LOCAL` emits `25P01` and never arms — the 0159 lesson, recorded verbatim at
`0169:70-76`):

1. `revoke insert, update, delete on table public.appointments from authenticated;` and the same `from anon;`
2. the same two statements for `public.appointment_audit`
3. `drop policy "appointments_member_all"` + `create policy "appointments_member_select" … for select to
   authenticated using (public.is_studio_member(studio_id))`, **adjacent and in the same transaction**;
   `drop policy "appointment_audit_member_insert"`
4. `revoke truncate, references, trigger` on both tables from `anon, authenticated` (P3 doctrine)

**`SELECT` is never named.** `revoke all` is forbidden — it would take SELECT with it and break ~22
authenticated read sites, two of which Session 1D owns.

**Exact scope — the co-requisites.** None of these is optional; all ship in the same commit.

| | Item | Why it is a co-requisite |
|---|---|---|
| a | Invert `tests/db/public-appointment-command.db.test.ts:474-489` and `tests/db/public-reschedule-command.db.test.ts:1430-1443` | Both assert `has_table_privilege` INSERT/UPDATE/DELETE = **true** for `anon` **and** `authenticated` on a freshly-migrated chain. They go red the instant `0172` exists on disk — before any push. Delete the stale comment at `:484-485` ("the revocation is a LATER PR") with them |
| b | Re-target `tests/db/appointments-tenant-consistency.db.test.ts:131-147` | It asserts an authenticated INSERT fails `23503`; after 0172 it fails `42501`. **Do not just flip the code** — move the FK proof to `service_role` (T4.1) so the 0151 composite-FK guarantee stays covered, and add the `42501` case (T4.5) at the privilege layer |
| c | New `tests/db/appointment-boundary-revocation.db.test.ts` — **T1.1–T1.11** | Behavioural, cloned from `tests/db/l18-final-revocation.db.test.ts`. Zero-row predicates are mandatory (a retained privilege succeeds with `rowCount 0` and passes silently). `asRole()` always rolls back — assert the SQLSTATE, never a row count. **T1.5's message discriminator is mandatory and absent from the L18 template**: an RLS `WITH CHECK` failure also raises `42501`, so the probe must additionally assert the message does not match `/row-level security/i` |
| d | New `tests/migrations/0172-appointment-dml-revocation.test.ts` — **T3.2–T3.4** | Byte-level source contract cloned from `tests/migrations/0169-final-l18-revocation.test.ts`: the exact revoke statements; `revoke all` never appears; no revoke line matches `/select/i`; exactly two tables named; the migration contains no `grant`; **no `create or replace function` for any trigger function** (the standing prohibition — production's `snapshot_appointment_buffer` carries an out-of-band GUC bypass that exists in no migration, and replacing it from repo source would silently delete a live production behaviour) |
| e | Move the repo-max tripwire | `tests/migrations/0171-public-reschedule-command.test.ts:41-47` holds `isRepoMax("0171")` / `versionsAbove("0171")` and its own comment says *"when 0172 lands, this block moves there and this file drops it"*. Only the current max carries it |
| f | Correct two stale in-migration comments | `0170:1012-1019` and `0171:1501-1508` both say "EXPECT both roles still TRUE". They become false. These are the first thing a future reader trusts |
| g | Docs | `docs/09_DATABASE_AND_RLS.md:159-161` currently describes the appointments policy as INSERT-by-RPC-only and `appointment_audit` as service-role-write — claims that are FALSE today and that this migration is what makes true. Also `docs/production/known-limitations.md` L19 (the TRUNCATE breadth entry, now partially closed for these two tables) and `PRE_STRIPE_HARDENING_NOTES.md` |
| h | **After** the push applies, bump `docs/production/migration-state.json` `hosted_migration_max` to `"0172"` | Declared, not derived (`scripts/migration-state.mjs:96-121`). See §13.5 |

**Do NOT include:** the `appointment_audit_member_read` rewrite (that needs `studio_id`, which arrives in
0174); any function drop (widens the blast radius of a migration whose whole value is being a no-op); any
e2e spec (`scripts/browser-groups.mjs` is 1D-owned — §15); `appointment_payments`,
`appointment_policy_acknowledgements` or `studio_calendar_reservations` (all three are already
RLS-default-denied for row DML; folding them in costs 0172 its "exactly two tables" scope note).

**Likely files.** `supabase/migrations/0172_revoke_authenticated_appointment_dml.sql` (new);
`tests/migrations/0172-appointment-dml-revocation.test.ts` (new);
`tests/migrations/0171-public-reschedule-command.test.ts`;
`tests/db/appointment-boundary-revocation.db.test.ts` (new);
`tests/db/public-appointment-command.db.test.ts`; `tests/db/public-reschedule-command.db.test.ts`;
`tests/db/appointments-tenant-consistency.db.test.ts`; `docs/09_DATABASE_AND_RLS.md`;
`docs/production/known-limitations.md`; `PRE_STRIPE_HARDENING_NOTES.md`;
`docs/production/migration-state.json` + `docs/production/migration-ledger.md` (post-apply).

**Migration.** **Yes — 0172.** Owns 0172 outright.

**Dependencies.** B1 and B2 merged. **And the §13.2 read-only production probe run and reviewed** — the
no-audit-baseline count decides whether B3 or B4 goes first (§12.5).

**Test plan.** Full `npm run test:unit` **and** `npm run test:db` on a freshly reset local stack. The
migration must be applied from zero, not against an already-migrated database, or the revoke's
interaction with default privileges is untested. Then: verify `select count(*) from public.appointments`
as `authenticated` still succeeds (T1.6) — an over-reaching revoke must be caught here and not in
production. Production apply is §13.

**Rollback.** A **new** migration re-granting the four verb/table pairs and restoring the two 0010
policies verbatim — never an edit of an applied file. Shape in §13.6. The migration writes no data, so
rollback loses nothing. Realistically it is never needed: the only failure mode is "some path was actually
running as `authenticated`", and B1's census plus the 56-site `.from("appointments")` classification say
none exists.

**Merge order.** 3 (or 4 — see §12.5).

**Session 1D.** **No collision.** Migration + `tests/**` + `docs/**` only. 1D's two appointment reads both
survive: the `appointments` read at `app/(app)/calendar/[id]/page.tsx:99-107` is preserved by the
replacement `FOR SELECT` policy (predicate reused verbatim), and the `appointment_audit` read at
`:131-139` is untouched because `appointment_audit_member_read` (`0010:280-288`) is not modified here.

---

#### B4 — Appointment repair commands + shared SQL helpers — **migration 0173**

**Why this exists.** P2-11: there is no governed DELETE, no un-complete, no un-no-show, no import surface
and no admin repair path anywhere in `app/`, `lib/`, `scripts/` or 170 migrations. Appointments are
**export-only**. And `appointments.notes` (`0010:184`) is written only at creation — after B3 it becomes
permanently immutable. These are the two capabilities the revoke actually freezes.

**Exact scope**
* Four SQL helpers: `lock_appointment_for_command` (enforces the one lock order — `studios FOR UPDATE` →
  `acquire_studio_capacity_lock()` → `appointments FOR UPDATE` scoped `(id, studio_id)` — in one place, so
  a new command cannot improvise its own and deadlock against a concurrent booking);
  `appointment_actor_role`; `appointment_has_blocking_dependents`; `write_appointment_audit`.
* `revert_appointment_outcome(...)` — the single reverse edge `{completed, no_show, cancelled} → confirmed`.
  Owner-only (a deliberate tightening versus cancel/complete/no-show). 72-hour window measured off the
  audit row that set the current status; **no audit baseline ⇒ refuse** (`no_audit_baseline`). Refused when
  `appointment_has_blocking_dependents()` is non-NULL (live session, payment attempt, manual-fee attempt,
  postcare already sent). `length(btrim(p_reason)) >= 10` — **SQL is the only trimmer**; JS `.trim()`
  strips a wider Unicode set and that exact disagreement is already on the record from the 0171 work.
  Optimistic concurrency via `and status = p_expected_status` in the WHERE clause. Sentinels only.
* `set_appointment_notes(...)` — active member (not owner-only; correcting a booking note is ordinary
  work), `length(p_notes) <= 2000`, `notes = nullif(btrim(p_notes), '')`. Audit `details` carries
  **lengths, not text** — `appointment_audit` is member-readable and notes can carry client-identifying
  content. Verified to fire no trigger: `notes` appears in no appointment trigger's `UPDATE OF` column
  list (`0125:71-74`, `0134:124`, `0134:478`, `0152:241`).
* New server-action file `app/(app)/calendar/appointment-repair-actions.ts` — deliberately **not**
  `app/(app)/calendar/actions.ts` (already 1274 lines and holding every other lifecycle action).
* New owner-only panel component under `app/(app)/calendar/`.
* **Register the new `createAdminClient()` call site in `tests/security/service-role-allowlist.ts`** or CI
  fails: `service-role-allowlist.test.ts:50-64` asserts the grep set and the allowlist are *exactly equal*.
  Its `scopeGuard` must be a distinguishing token per B1's hardening — use the RPC name.

**Likely files.** `supabase/migrations/0173_appointment_repair_commands.sql` (new);
`tests/migrations/0173-*.test.ts` (new); `tests/db/appointment-repair-commands.db.test.ts` (new);
`app/(app)/calendar/appointment-repair-actions.ts` (new); a new panel component (new);
`tests/security/service-role-allowlist.ts`; `tests/app/calendar/appointment-repair-source.test.ts` (new).
**Held for a trailing commit:** the ~12-line mount in `app/(app)/calendar/[id]/page.tsx` (§15).

**Migration.** **Yes — 0173.**

**Dependencies.** B3 (or precedes it — §12.5). Moves the repo-max tripwire from 0172's test to 0173's.

**Test plan.** DB: every sentinel; the 72-hour boundary from both sides; `no_audit_baseline` refusal; each
blocking-dependent class refuses independently; self-idempotency (a second call returns
`stale_appointment` and writes **no** audit row); the rollback invariant on every refusal; the EXECUTE
matrix. The `23P01` mapping needs a real test: `cancelled → confirmed` re-inserts the shadow reservation
(`0152:123-140`) and **must** raise if the slot was rebooked — seed exactly that. Unit: assert the raw
untrimmed reason crosses the boundary (the `btrim` vs `.trim()` disagreement case).

**Rollback.** New migration dropping the two commands and the four helpers; revert the app files. Nothing
is mounted until the trailing commit, so an unshipped mount is a no-op for users.

**Merge order.** 4.

**Session 1D.** **Yes — small and fully avoidable.** The natural mount point is
`app/(app)/calendar/[id]/page.tsx`: the existing "Outcome" section is gated `typedStatus === "confirmed"`
(`:436`) and the revert panel is needed for the *terminal* statuses, so it cannot ride inside
`AppointmentLifecycleActions` without new props and a new gate. `isOwner` already exists at `:96`. Plan:
merge B4 without the mount; land the mount as a trailing 12-line commit after #517 merges. Full reasoning
in §15.

---

#### B5 — Appointment audit integrity — **migration 0174**

**Exact scope.** `appointment_audit.studio_id uuid not null references public.studios(id) on delete
cascade`, backfilled through `appointments`; `appointment_id` becomes nullable and its FK moves from
`on delete cascade` (`0010:219`) to `on delete set null`; `appointment_audit_member_read` (`0010:280-288`)
rewritten onto `using (public.is_studio_member(studio_id))`; a `BEFORE INSERT` derive trigger that
**overwrites** the caller-chosen `created_at` with `now()` and derives `studio_id`; `NOT VALID`
constraints correlating `actor_id` nullability with `actor_type` and an FK `actor_id → practitioners(id)`
(`NOT VALID` because production may hold rows written by commands since dropped, e.g.
`finalize_card_required_public_booking`, dropped at `0091:174`); and an append-only
`BEFORE UPDATE OR DELETE` trigger matching `stripe_payment_audit_immutable` (`0032:1411`) and
`clinical_audit_events_append_only` (`0120:219`).

**This is the structural answer to P1-2 that no privilege revoke can give you:** history that survives its
parent row.

**⚠️ Sequencing is load-bearing inside this migration.** The append-only **DELETE** arm is only safe
*after* the FK re-point. Applied before it, every appointment DELETE fails — including
`tests/db/practitioner-move-appointment.db.test.ts:117,124`,
`tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:285,294,415` and
`tests/db/google-calendar-c1-link-transition.db.test.ts:297,324`, all of which delete appointments and
rely on the `0010:219` cascade. And the `tests/db` lane is **conditional** in CI
(`.github/workflows/ci.yml:229`), so a PR touching no `supabase/**` path would not even reveal it.

**Likely files.** `supabase/migrations/0174_appointment_audit_integrity.sql` (new);
`tests/migrations/0174-*.test.ts` (new); `tests/db/appointment-audit-invariant.db.test.ts` (**T5.5 flips
from `it.fails` to `it`**); `tests/db/appointment-boundary-revocation.db.test.ts` (T1.11 re-pinned);
the six DB test files listed above if any needs its cascade expectation restated.

**Migration.** **Yes — 0174.** **Dependencies.** B3 and B4.

**Test plan.** Prove the FK re-point *before* the trigger in the same file: delete an appointment, assert
its audit rows survive with `appointment_id is null` and `studio_id` intact. Prove `created_at` is
overwritten by supplying a 1999 timestamp. Prove UPDATE and DELETE on an audit row both raise. Run the
**whole** `tests/db` lane, not a scoped subset — the six cascade-dependent files are in three unrelated
feature areas. Run §13.2's dangling-actor probe against production **before** writing the `NOT VALID`
constraints so their names describe reality.

**Rollback.** New migration dropping both triggers and the two `NOT VALID` constraints, restoring the
cascade FK, and restoring the 0010 read policy. `studio_id` can stay — it is additive and backfilled.

**Merge order.** 5. **Session 1D.** **No collision.** The only application read of `appointment_audit` is
`app/(app)/calendar/[id]/page.tsx:130-139`, filtered by `appointment_id` + `action='cancelled'`, selecting
`details` alone — unchanged, and it still passes the rewritten policy.

---

#### B6 — Transition guard, `set_updated_at`, `capacity_enabled` trigger fix, legacy RPC retirement — **migration 0175**

**Exact scope**
* `guard_appointment_status_transition()`, `BEFORE INSERT OR UPDATE OF status`, named `appointments_aaa_*`
  so it fires before the derived-column triggers (Postgres orders same-timing row triggers by **name**;
  the repo already uses `zzz_` for the opposite end at `0125:323`). INSERT arm: born `'confirmed'` only —
  free, because **no test file inserts a non-confirmed status directly**. UPDATE arm: the **full legal edge
  set**, forward `confirmed → {cancelled, completed, no_show}` and reverse
  `{cancelled, completed, no_show} → confirmed`. Every lateral edge raises.
* **No time gates and no `current_user`/GUC escape hatch.** A `completed`/`no_show` requires
  `ends_at <= now()` invariant breaks `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts:219-221`,
  which completes a **future** seeded appointment via `adminQuery` — and triggers fire for the superuser
  harness too. Keeping the reverse edges legal in the trigger is what keeps `:230-231`'s explicit
  `cancelled → confirmed` "defensive un-cancel" test green. The *commands* restrict who may traverse the
  reverse edges and under what conditions; the trigger only forbids the edges that are never legal.
* `set_updated_at` trigger on `public.appointments` — every other mutable table in the tree has one
  (`0015:74`, `0019:52`, `0034:98`, `0053:125`, `0058:179`, `0140:144`); `appointments.updated_at` has only
  `default now()` (`0010:189`), so the postcare writers leave it stale (P3-07).
* One word: add `capacity_enabled` to `appointments_set_capacity_enabled_trg`'s own `UPDATE OF` list
  (`0134:124-128`). The column is absent from its **own** trigger's column list, so a bare
  `set capacity_enabled = …` is never re-derived and silently migrates the row between the two partial
  GiST exclusions (P2-13).
* Drop the three caller-less legacy RPCs: `reschedule_appointment` (EFFECTIVE `0091:186`),
  `practitioner_move_appointment` (EFFECTIVE `0145:200`), `create_internal_appointment` (`0147:31`). All
  three are `service_role`-EXECUTE-able and strictly weaker than their replacements. The retention reason
  recorded at `0171:61-66` (deployment skew) has **expired** — PR #513 is merged and prod head is the
  pinned SHA. Precedent for the drop: `0091:166-176`.
  ⚠️ `tests/security/public-reschedule-command-guard.test.ts:438-446` positively asserts the legacy
  reschedule is *not* dropped, re-signed or revoked — but it binds `MIGRATION_CODE` to the text of 0171
  alone (`:27-42`), so it stays green. Confirm this by reading the binding, do not assume it.

**Likely files.** `supabase/migrations/0175_appointment_transition_guard.sql` (new);
`tests/migrations/0175-*.test.ts` (new); `tests/db/appointment-transition-guard.db.test.ts` (new);
`tests/db/practitioner-capacity-state.db.test.ts` (the `capacity_enabled` fix);
possibly `tests/db/google-calendar-b2-3a-enqueue-claim.db.test.ts` if any seeding path trips the guard.

**Migration.** **Yes — 0175.** **Dependencies.** B5 (the audit trigger ordering must already be settled).

**Test plan.** Every one of the 12 status-pair permutations, run as `service_role`, asserting legal edges
succeed and lateral edges raise. **Then run the entire `tests/db` lane**: this is the first
behaviour-changing migration in the program and it fires for every writer including the superuser test
harness. Specifically re-run the two Google enqueue tests named above.

**Rollback.** New migration dropping the two triggers and recreating the three functions from their
effective definitions. The function drops are the least reversible thing in this program — hence their own
migration, separate from the revoke.

**Merge order.** 6. **Session 1D.** No collision — migration + `tests/db/**`.

---

#### B7 — `/cancel` policy-acknowledgement atomicity and snapshot currency — **migration 0176**

**Not a boundary prerequisite.** It is the one lifecycle command the audit found genuinely defective, and
0171 already shipped the exact fix for the reschedule twin, so the design is a transcription rather than
an invention.

**Exact scope.** Add `p_acknowledged_policy` and `p_presented_policy_snapshot_hash` to
`public_cancel_appointment_with_token`; recompute the hash from `studios.cancellation_policy_text` +
`no_show_policy_text` **under the studio lock** and refuse on mismatch (`policy_changed`) or on a false ack
(`policy_not_acknowledged`) — the `0171:1121-1157` shape; move the
`appointment_policy_acknowledgements` INSERT **inside** the transaction and return its id. Today the ack is
written after the RPC commits and its failure is swallowed (`app/cancel/[token]/actions.ts:365-377`) while
`lib/billing/manual-fee-eligibility.ts:287-298` makes that row a **hard precondition** — so a lost write
permanently forfeits the studio's late-cancellation fee (P2-5), and an owner policy edit between page load
and submit produces a durable legal record asserting the client accepted text they never saw (P2-10).

Everything else stays byte-for-byte: the `already_cancelled` short-circuit (`0091:107-110`), the
started-appointment refusal, and — critically — the audit row shape at `0091:130-141`, which is *exactly*
what `app/(app)/calendar/[id]/page.tsx:130-139` renders. **No invented window classifier.** The
`studios.cancellation_window_hours` / `appointments.cancellation_window_class` pair proposed during design
was rejected: `0064:37` and `lib/billing/manual-fee-eligibility.ts:56` record, in the product's own words,
that Hone deliberately has no structured threshold. That is a pricing decision for the user (§11.7).

**Likely files.** `supabase/migrations/0176_public_cancel_policy_acknowledgement.sql` (new);
`tests/migrations/0176-*.test.ts` (new); `tests/db/public-cancel-command.db.test.ts` (new);
`app/cancel/[token]/actions.ts`; `app/cancel/[token]/CancelForm.tsx`;
`tests/security/public-cancel-command-guard.test.ts` (new, mirroring the reschedule guard).

**Migration.** **Yes — 0176.** **Dependencies.** B4 (reuses `lock_appointment_for_command`).

**Test plan.** Mirror `tests/db/public-reschedule-command.db.test.ts`'s acknowledgement section: stale hash
refused, false ack refused, ack row created in the same transaction as the status flip, rollback invariant
on every refusal. App-first ordering applies here (the RPC gains parameters), so ship the migration first
and keep the old signature callable until the deploy lands — or add the parameters with defaults.
**This is the one PR in the program with a real deploy-ordering constraint.**

**Rollback.** New migration restoring the `0091:75` signature. Revert the route file.

**Merge order.** 7. **Session 1D.** No collision — `app/cancel/**` is not 1D-owned.

---

#### B8 — Postcare email-state command: retire the last seven direct writers — **migration 0177**

**Exact scope.** `record_postcare_email_state` / `claim_postcare_email_send`, replacing the seven direct
`admin` UPDATEs at `app/(app)/calendar/actions.ts:1114,1155,1211,1242` and
`app/(app)/calendar/postcare-auto-send.ts:151,186,200`. Closes P2-6 (`is_resend`, a **browser-supplied
boolean**, disables the send-once claim: the resend branch is an unconditional UPDATE scoped only by
`id` + `studio_id`, so any active practitioner can POST `is_resend=true` N times concurrently against a
never-sent appointment and send N emails to the client), P3-14 (manual send has no status filter, so
postcare can be emailed for a cancelled appointment; its automatic twin carries
`.eq("status","completed")`) and P3-15 (four non-atomic UPDATEs, no actor, no audit row, no `updated_at`).

**Keep the columns on `appointments`.** Moving or renaming any `postcare_email_*` column breaks
`app/(app)/calendar/[id]/page.tsx:511-514` (1D-owned) and
`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx:188-197`. Change only the writer.

**Why it goes last, not with the revoke.** These are `service_role` → `service_role` writes scoped
`.eq("id").eq("studio_id")` touching only bookkeeping columns. They are *inside* the boundary B3 draws,
not outside it, so nothing about the P1 closure waits on them. What this PR buys is that
`rg` over `app/` + `lib/` returns **zero** direct appointment DML — which turns B1's seven-entry
`ALLOWED` list into an empty one and the boundary from an argument into a CI assertion.

**Likely files.** `supabase/migrations/0177_postcare_email_state_command.sql` (new);
`tests/migrations/0177-*.test.ts` (new); `app/(app)/calendar/actions.ts`;
`app/(app)/calendar/postcare-auto-send.ts`; `components/appointment/postcare-section.tsx` (**1D-owned**);
`app/(app)/calendar/PostcareSendButton.tsx`; `tests/app/calendar/postcare-auto-send.test.ts`;
`tests/security/appointment-direct-dml-guard.test.ts` (`ALLOWED` → empty, count → 0).

**Migration.** **Yes — 0177.** **Dependencies.** **PR #517 must be merged first.** Hard blocker.

**Test plan.** DB behavioural for the claim semantics under concurrency (two sessions, one wins);
`is_resend` no longer reaches the database as authority; the status filter now applies to both paths.
Then flip B1's guard to zero allowed writers and confirm it passes — that is the closing measurement of
the whole program.

**Rollback.** New migration dropping the commands; revert the app files; restore B1's seven-entry list.

**Merge order.** 8. **Session 1D.** **Yes — hard.** `components/appointment/postcare-section.tsx` is
1D-owned and both 1D-owned page reads consume the four `postcare_email_*` columns.

---

#### B9 — Final census, documentation reconciliation, vacuous-test repairs

**Exact scope**
* Re-run the full appointment writer census at the post-B8 head and record it — the closing artifact.
* Rewrite `tests/scripts/e2e-guardrails.test.ts:70-83`. Its `for (const dir of ["app","lib","components",
  "middleware.ts"])` ends in `void dir;` (`:79`), so the same four assertions run four times against the
  same four **e2e** files. `app/`, `lib/`, `components/` and `middleware.ts` are never read. Worse, it
  greps `process.env.E2E_AUTH_BYPASS` — a string whose only occurrence in the entire repository is that
  line itself. The real markers are `HONE_E2E_*`, and an app-side E2E hook route **does ship**
  (`app/api/google-calendar/e2e/authorize/route.ts`) which the `existsSync("app/api/e2e")` check at `:81`
  cannot see. Replace with a real directory walk grepping `HONE_E2E_`, allow-listing only
  `lib/google-calendar/e2e/`, `lib/email/e2e-fake-resend.ts`, `lib/stripe/e2e-fake-stripe.ts` and that
  route.
* Regenerate `docs/audits/2026-07-30/MASTER_FINDINGS_REGISTER.json` — it was generated at
  `395532489a`/0160 and is eleven migrations behind. **Do not touch
  `tests/audits/findings-register-consistency.test.ts:122,762`'s `"0160"` pins unless the register is
  actually regenerated** — those pin the register's frozen *baseline*, not live hosted state, and
  "fixing" them to 0177 would destroy the baseline-honesty model.
* Reconcile `docs/production/migration-ledger.md`, `docs/04_BOOKING_AND_PORTAL_FLOWS.md:105,187` (still
  calling 0170/0171 unapplied) and `docs/09_DATABASE_AND_RLS.md`.
* **Record, do not build,** the residue this program deliberately did not close: P2-1 (the owner override
  also disables the soft buffer, contradicting the UI promise), P2-2 (the capacity-OFF validator no-op),
  P2-3 (internal creation books archived clients, public creation refuses them), P2-7
  (`rematerialize_studio_reservations` writes buffer-EXPANDED intervals and can abort a capacity flip with
  `23P01` — **fix before capacity is ever enabled anywhere**), P2-9 (public commands ignore the booking
  pause), P2-13's silent override clear, P2-14 (the live-payment gate trusts a denormalised status string),
  P3-08/P3-09 (peripheral writer hygiene), P3-16 (one shared `CRON_SECRET`).
* Add the appointment e2e spec(s) here if any are wanted — this is the first point at which
  `scripts/browser-groups.mjs` is safe to edit (§15).

**Likely files.** `tests/scripts/e2e-guardrails.test.ts`; `docs/**`;
`docs/audits/2026-07-30/MASTER_FINDINGS_REGISTER.json`; optionally `scripts/browser-groups.mjs` +
`tests/ci/browser-selection.test.ts`.

**Migration.** **None.** **Dependencies.** B8. **Merge order.** 9. **Session 1D.** No collision by then —
#517 is long merged.

---

### 12.3 Migration ownership — explicit

| Migration | Filename (proposed) | Owning PR | Nothing else may claim it |
|---|---|---|---|
| **0172** | `0172_revoke_authenticated_appointment_dml.sql` | **B3** | The only migration in the program with zero application change |
| **0173** | `0173_appointment_repair_commands.sql` | **B4** | |
| **0174** | `0174_appointment_audit_integrity.sql` | **B5** | |
| **0175** | `0175_appointment_transition_guard.sql` | **B6** | |
| **0176** | `0176_public_cancel_policy_acknowledgement.sql` | **B7** | |
| **0177** | `0177_postcare_email_state_command.sql` | **B8** | |
| — | — | B1, B2, B9 | no migration |

`0158` is **permanently skipped** and must never be applied (`scripts/migration-state.mjs:42`,
`PERMANENTLY_SKIPPED = [158]`). Next free number today is **0172**; `grep -rn "0172"` over the repo returns
exactly one hit, the forward-looking comment at
`tests/migrations/0171-public-reschedule-command.test.ts:42`. Nothing else claims it.

**The repo-max tripwire moves with each migration.** Only the current maximum's own test carries
`isRepoMax(...)` / `versionsAbove(...)` — the convention documented at
`tests/migrations/0170-public-appointment-command.test.ts:41-46`. Each of B3–B8 moves that block from the
previous max's test into its own and deletes it from the old one. Forgetting this is how 0163, 0164 and
0165 each went red after push.

---

### 12.4 What is deliberately NOT a PR

| Not built | Why |
|---|---|
| `studios.cancellation_window_hours` + `appointments.cancellation_window_class` | A structured cancellation-fee policy engine. `0064:37` and `lib/billing/manual-fee-eligibility.ts:56` record the deliberate "not yet". A pricing decision for the user, not an audit remediation |
| `import_appointment(...)` / `appointments.external_ref` | A new product feature. No import surface exists and it would put an INSERT path into the scheduling table that skips every availability validator |
| `auto_mark_no_show_batch(...)` | `app/api/cron/no-show-check/route.ts:4-38` records an explicit decision to keep automatic no-show marking disabled until the manual path is validated in production, and re-enabling it manufactures fee-eligible states from a cron authorized by one shared secret (P3-16) |
| `void_appointment(...)` + a `voided_at is null` filter on ~43 read sites | The largest blast radius anyone proposed, for a capability `practitioner_cancel_appointment` already has in governed form. A missed read site leaves a voided appointment on a live calendar |
| `guard_appointment_command_origin()` keyed on `current_user` | Rests on an ownership assumption no one here could measure, and fails **closed for every command at once** if Supabase ever re-owns `public` tables. B1's static census catches the same threat at CI time |
| `appointments_span_matches_duration` CHECK | Correct in principle, correctly proposed `NOT VALID`. Its only violator is the legacy `reschedule_appointment` (`0091:186`, which takes end time and duration independently), and the whole pre-0171 lineage may have written mismatched pairs. Ship it after B6's retirement **and after a read-only violator count** (§13.2, probe 3) — never blind |
| A separate "shared foundations" PR | Four helpers with no consumer is dead SQL with a `service_role` grant |
| Revoking on `appointment_payments`, `appointment_policy_acknowledgements`, `studio_calendar_reservations` | All three are already RLS-default-denied for row DML. Good hygiene, own migration, not 0172's scope |

---

### 12.5 The one genuinely open sequencing question

**Does B3 (the revoke) precede B4 (the repair commands), or the reverse?**

§10 P2-11 rates the missing repair path as a *prerequisite* of P1-1: revoking direct DML removes the only
escape hatch anyone currently has. That is defensible. Against it: the revoke is scoped to `anon` and
`authenticated` and does **not** touch the operator's real channel (the Supabase SQL editor as `postgres`,
or a service-role script), and the hatch it closes was never an in-product capability — only a devtools
`PATCH` no practitioner has ever been asked to perform.

**Resolve it by measurement, not argument.** Run §13.2 probe 2 — one read-only
`supabase db query --linked` counting appointments with no audit row at all.

| Probe result | Meaning | Sequence |
|---|---|---|
| **Zero rows** | No appointment has ever been mutated outside the command layer. The direct path has never been used | **B3 = 0172, B4 = 0173.** Ship the revoke first |
| **Non-zero** | Someone has been correcting data by hand. Taking the hatch away before replacing it is an operational regression | **Swap: B4 = 0172, B3 = 0173.** Everything downstream keeps its relative order and its number |

Nothing else in the ladder is order-sensitive by argument; the rest is order-sensitive by fact (B5 before
B6; B5's DELETE arm after its own FK re-point; B8 after #517).

---

## 13. Migration and rollout strategy

### 13.1 The property that makes 0172 unusual

**The revocation is a privilege change with zero application-code change.** That is not a convenience
claim; it is the conclusion of an exhaustive census:

* 56 literal `.from("appointments")` chains in runtime source, classified by receiver and verb: 7 `admin`
  UPDATE, 27 `admin` SELECT, 22 authenticated SELECT, **0 INSERT/DELETE/UPSERT on any client**.
* Three additional searches — non-literal table expressions (`lib/onboarding/getting-started.ts:357`
  `.from(table)` is a `head: true` count), the bare string `"appointments"` outside `.from()`, and every
  `.rpc(` call site — return no further writer.
* All 19 SQL functions whose body contains `insert into`/`update`/`delete from public.appointments` have
  `EXECUTE` revoked from `public`, `anon` and `authenticated`.

**Consequences for rollout, all of which are real and none of which apply to a normal migration:**

1. There is **no app-first / DB-first ordering constraint**. 0164–0168 each had to be additive so the
   deployed application kept working during the window. 0172 has no window: nothing deployed uses the
   privilege it removes. It can be pushed at any time relative to any Vercel deploy, including with no
   deploy at all.
2. **Rollback restores no data**, because the migration writes none. The only thing a rollback restores is
   a capability, and the capability has no user.
3. The interesting risk is therefore *not* "will the app break". It is "is the repository's model of
   production's ACL actually correct". That is what §13.2 exists to answer.

**Every claim about production privileges in this audit is inferred, not measured.** It rests on the
absence of any GRANT/REVOKE on these two tables across 170 migrations, plus two repo tests asserting the
open posture **on a fresh local chain**. Neither is a production measurement. The repository already
documents one out-of-band production drift — production's deployed `snapshot_appointment_buffer` carries a
GUC bypass (`app.bypass_appointment_buffer_snapshot`) that exists in no migration and in no locally-reset
database (`tests/security/public-reschedule-command-guard.test.ts:460-464`) — so migration-derived state is
a strong inference, not a fact.

---

### 13.2 Pre-apply read-only production probes

All of these run through the **only** approved read-only channel: `supabase db query --linked`, from
`~/Hone` (the linked CLI vehicle). `supabase db dump` is classifier-blocked. Every query below returns
**scalars and counts only** — no client names, emails, phones, tokens or note text — matching the doctrine
that `scripts/verify-production.mjs:26-32` enforces on itself.

**Before every single command:** confirm `supabase/.temp/project-ref` carries the ref you intend. It holds
the **PROD** ref. Guard it, then run.

These are *ad hoc operator queries*, not additions to `scripts/verify-production.mjs`. That script is
pinned read-only by a source regex (`tests/scripts/verify-production.test.ts:41-42`) and adding probes to
it is a code change with its own review cost; the probes below are one-shot evidence gathering.

#### Probe 1 — the privilege matrix (the claim under test)

```sql
select r.rolname,
       has_table_privilege(r.oid,'public.appointments','SELECT')       as ap_sel,
       has_table_privilege(r.oid,'public.appointments','INSERT')       as ap_ins,
       has_table_privilege(r.oid,'public.appointments','UPDATE')       as ap_upd,
       has_table_privilege(r.oid,'public.appointments','DELETE')       as ap_del,
       has_table_privilege(r.oid,'public.appointments','TRUNCATE')     as ap_trunc,
       has_table_privilege(r.oid,'public.appointment_audit','SELECT')  as au_sel,
       has_table_privilege(r.oid,'public.appointment_audit','INSERT')  as au_ins,
       has_table_privilege(r.oid,'public.appointment_audit','UPDATE')  as au_upd,
       has_table_privilege(r.oid,'public.appointment_audit','DELETE')  as au_del,
       has_table_privilege(r.oid,'public.appointment_audit','TRUNCATE') as au_trunc
  from pg_roles r
 where r.rolname in ('anon','authenticated','service_role','postgres')
 order by 1;
```

and the raw ACL, which `has_table_privilege` cannot show you (it collapses inheritance):

```sql
select c.relname,
       case when a.grantee = 0 then 'PUBLIC' else a.grantee::regrole::text end as grantee,
       a.privilege_type
  from pg_class c
  join pg_namespace n on n.oid = c.relnamespace
  cross join lateral aclexplode(c.relacl) a
 where n.nspname = 'public'
   and c.relname in ('appointments','appointment_audit')
 order by 1, 2, 3;
```

**Expected:** `anon` and `authenticated` hold INSERT/UPDATE/DELETE (and TRUNCATE/REFERENCES/TRIGGER) on
both tables; `service_role` holds everything; PUBLIC holds nothing.
**If the expectation is wrong**, stop and re-derive the migration before writing anything. Two specific
surprises to watch for: a privilege already absent (making part of the revoke a documented no-op, exactly
as `0169:29-43` handled `session_block_areas`), or a grant on PUBLIC (which `revoke … from anon,
authenticated` would **not** remove).

**Also capture the policy inventory**, since 0172 drops and replaces two policies:

```sql
select tablename, policyname, cmd, roles, permissive,
       qual is not null as has_using, with_check is not null as has_check
  from pg_policies
 where schemaname = 'public'
   and tablename in ('appointments','appointment_audit')
 order by 1, 2;
```
**Expected exactly three rows:** `appointments_member_all` (ALL), `appointment_audit_member_read` (SELECT),
`appointment_audit_member_insert` (INSERT). A fourth policy is out-of-band drift and changes the migration.

#### Probe 2 — the no-audit baseline (**this is the one that decides the sequence**)

```sql
select a.status, count(*) as appointments_with_no_audit_row
  from public.appointments a
 where not exists (select 1 from public.appointment_audit x where x.appointment_id = a.id)
 group by a.status
 order by 1;
```

and the sharper form — a terminal appointment with no audit row *for that outcome* is a mutation that
happened outside the command layer:

```sql
select count(*) as terminal_without_matching_audit
  from public.appointments a
 where a.status <> 'confirmed'
   and not exists (select 1 from public.appointment_audit x
                    where x.appointment_id = a.id
                      and x.action in ('cancelled','completed','no_show'));
```

**Zero ⇒ the direct path has never been used; the revoke ships first as 0172 (§12.5).**
**Non-zero ⇒ someone has been correcting by hand; the repair commands become a genuine prerequisite and
B4 takes 0172 instead.** Interpret carefully in one direction: rows predating a command's introduction are
not evidence of a devtools `PATCH`. Cross-check `min(created_at)` of any offending appointment against
the migration that introduced its lifecycle command.

#### Probe 3 — the span invariant (pre-flight for the deferred CHECK)

```sql
select count(*) as span_mismatch
  from public.appointments
 where ends_at is distinct from starts_at + make_interval(mins => duration_minutes);
```

The `appointments_span_matches_duration` CHECK was **deferred, not rejected**. Its only possible violator
is the legacy `reschedule_appointment` (`0091:186`), which accepts `p_new_ends_at` and
`p_new_duration_minutes` independently and validates neither against the other. A non-zero count means the
CHECK must ship `NOT VALID` and the violators must be understood before any `VALIDATE CONSTRAINT`. A zero
count means the whole pre-0171 reschedule lineage happens to be consistent — worth knowing, not worth
assuming.

#### Probe 4 — override and capacity counters

```sql
select count(*)                                             as appointments,
       count(*) filter (where booked_outside_availability)  as outside_availability,
       count(*) filter (where capacity_enabled)             as capacity_enabled_rows
  from public.appointments;

select count(*)                                                     as studios,
       count(*) filter (where practitioner_capacity_enabled)        as capacity_on,
       count(*) filter (where practitioner_capacity_booking_enabled) as booking_enabled,
       count(*) filter (where google_calendar_outbound_sync_enabled) as gcal_outbound_on
  from public.studios;
```

Three separate reasons this matters, none of them about 0172:
* `capacity_enabled` **on any appointment row while every studio is capacity-OFF** would mean the
  P2-13 trigger-column gap has already been exercised, since the maintaining trigger omits the column from
  its own `UPDATE OF` list (`0134:124-128`).
* `booked_outside_availability = true` counts the rows an owner deliberately forced, which B6's
  `set_updated_at` and B9's P2-13 write-up both need.
* `capacity_on > 0` would invalidate the standing "the validator degenerates to buffer-only at every
  production studio" claim, and `gcal_outbound_on > 0` would make B4's Google revert edge (§11.8 risk 8)
  live rather than dormant. Both are currently asserted, **not measured**.

#### Probe 5 — audit-shape pre-flight for 0174's `NOT VALID` constraints

```sql
select count(*)                                                                  as audit_rows,
       count(*) filter (where actor_type='practitioner' and actor_id is null)    as prac_null_actor,
       count(*) filter (where actor_type='client'       and actor_id is not null) as client_with_actor,
       count(*) filter (where actor_type='practitioner' and actor_id is not null
                          and not exists (select 1 from public.practitioners p
                                           where p.id = appointment_audit.actor_id)) as dangling_actor,
       count(distinct action)                                                     as distinct_actions
  from public.appointment_audit;

select action, count(*) from public.appointment_audit group by 1 order by 2 desc;
```

Production may hold rows written by commands since dropped — `finalize_card_required_public_booking` was
dropped at `0091:174` — which is exactly why 0174's correlation CHECK and `actor_id` FK must be `NOT VALID`.
This probe tells you *how many* rows they would have rejected, so the migration's comment can state a
number instead of a hedge. The `action` histogram also validates T5.2's expected vocabulary against
reality rather than against the migration source.

#### Probe 6 — the additive-only baseline (capture immediately before the push)

```sql
select (select count(*) from public.appointments)                            as appointments,
       (select count(*) from public.appointments where status='confirmed')   as confirmed,
       (select count(*) from public.appointments where status='cancelled')   as cancelled,
       (select count(*) from public.appointments where status='completed')   as completed,
       (select count(*) from public.appointments where status='no_show')     as no_show,
       (select count(*) from public.appointment_audit)                       as audit_rows,
       (select count(*) from public.appointment_policy_acknowledgements)     as acknowledgements,
       (select count(*) from public.studio_calendar_reservations)            as reservations,
       (select max(updated_at) from public.appointments)                     as max_appt_updated_at;
```

This is the 0171 standard, and it is what turns "additive only" from an assertion into a measurement.
The 2026-08-05 reference values recorded in `docs/production/migration-state.json` are: appointments 139
(63 confirmed, 29 cancelled), `appointment_audit` 220, acknowledgements 12, reservations 117,
`max(appointments.updated_at)` = `2026-08-04T23:44:06Z`. Re-capture rather than reuse — the studio is live.

---

### 13.3 Apply order

```
  1.  B1 merges                          no production action
  2.  B2 merges                          no production action
  3.  Probes 1–5 run and reviewed        REQUIRES APPROVAL (read-only, linked CLI)
  4.  §12.5 decision recorded            revoke-first vs repair-first
  5.  B3 (or B4) merges to the base branch, CI green at the exact merged head
  6.  Probe 6 — baseline captured        minutes before the push
  7.  supabase migration list --linked   confirm hosted max = 0171, nothing pending but 0172
  8.  supabase db push --linked --dry-run  must list EXACTLY 0172 and nothing else
  9.  supabase db push --linked          REQUIRES APPROVAL
 10.  Post-apply verification (§13.5)    including the honest privilege probe
 11.  docs/production/migration-state.json hosted_migration_max -> "0172" + ledger entry
 12.  node --env-file=.env.local scripts/verify-production.mjs   must now pass again
```

Steps 5 → 9 are one sitting. See §13.4 for why.

Each subsequent migration (0173…0177) repeats steps 5–12 with its own baseline capture. **Never batch two
migrations into one push.** The 0171 record shows the dry run listing exactly one file, and that is the
property that makes "exit 0" mean something.

**Approval gates.** Nothing in steps 3, 9 or any later push happens without explicit user approval. That is
standing policy, and it is doubly true here because `~/Hone`'s `.env.local` points at production and
`supabase/.temp/project-ref` carries the production ref.

---

### 13.4 The full unit suite is mandatory, and why a scoped run is a trap

The repository migration max used to be hard-coded in **18 places** — `toBe(165)` here, a "trip on the next
one" regex there — spread across `tests/migrations/`, `tests/docs/` and `tests/scripts/`. A run scoped to
the obviously-relevant directory missed some, and CI went red **after** the push. That happened on 0163,
0164 **and** 0165. `scripts/migration-state.mjs:5-18` records the incident and the fix.

Repository state is now *derived* once (`scanMigrations()` at `:57`) and hosted state is *declared* once
(`docs/production/migration-state.json`). But the **consumers are still spread across four test
directories**, and each is gated by a different CI lane:

| Consumer | What it reads | CI lane |
|---|---|---|
| `tests/migrations/helpers/migration-state.ts:12,35` → `isRepoMax` / `versionsAbove` | derived repo max | `database` |
| `tests/migrations/0171-public-reschedule-command.test.ts:41-47` | asserts 0171 **is** the repo max | `database` |
| `tests/ci/ci-config.test.ts:332-333` | `hosted_migration_max` matches the canonical record, and forbids re-deriving it locally (`:350`) | `ci_workflows` |
| `tests/scripts/verify-production.test.ts:88,103` | asserts the script derives, never hardcodes | (unit) |
| `tests/audits/findings-register-consistency.test.ts:122,762` | pins the findings register's **frozen** `"0160"` baseline | (unit) |

`scripts/classify-changes.mjs:43-48` maps `supabase/migrations/**` to `database` only. A migration PR
therefore does **not** set `ci_workflows`, so `tests/ci/ci-config.test.ts` is only reached by the unit
lane. **Run `npm run test:unit` in full — never `-t` scoped, never a single directory — plus
`npm run test:db` on a freshly reset local stack.**

**Do not "fix" `tests/audits/findings-register-consistency.test.ts`'s `"0160"`.** That is the findings
register's own frozen generation baseline, not live hosted state. Bumping it to 0172 would silently
destroy the baseline-honesty model the register depends on. It changes only when the register is actually
regenerated (B9).

**Two more lane facts that decide what gets tested:**
* `db-integration` is **conditional** (`.github/workflows/ci.yml:229`): it runs only when `database`,
  `security` or `full_matrix_required` is true. A PR touching `app/**` alone never runs `tests/db/**`.
  This is why B1's static census must live under `tests/security/` — it is the tripwire for *application*
  drift; the DB probes are the tripwire for *schema/grant* drift, and the two lanes do not overlap.
* Touching `tests/db/helpers/**` or `lib/supabase/**` sets `full_matrix_required`
  (`scripts/classify-changes.mjs:29-31`). Prefer a local helper inside a new test file over extending
  `tests/db/helpers/harness.ts`, unless the full matrix is wanted.

**The merge → push window must be short.** `scripts/verify-production.mjs` derives its expected migration
max from disk (`deriveExpectedMigrationMax()`, `:56-62`, feeding `getMigrationState().repo_migration_max`)
and hard-FAILs while any file on disk is unapplied. Between merging 0172 and pushing it, the production
verifier reports FAIL — correctly. Do not merge a migration on a Friday and push it on Monday, and do not
let anyone run the verifier in that window and conclude production is broken.

---

### 13.5 Writing and pushing the migration

**The file must open its own transaction.**

```sql
begin;
set local lock_timeout = '5s';
  -- groups 1-4
commit;
```

`supabase db push` does **not** wrap a migration file in a transaction. A bare `SET LOCAL` outside an
explicit block emits `25P01` (*"there is no transaction in progress"*) and **never arms** — the 0159
lesson, recorded verbatim at `0169:70-76`. This matters more here than it did for 0169: `REVOKE` takes an
`ACCESS EXCLUSIVE` lock and `public.appointments` is the busiest table in the product. Without an armed
`lock_timeout` the statement queues behind any open transaction and blocks every reader behind it.

**Post-apply verification — measurement, not assertion.** The L18 precedent is an ACL-verified revoke that
was **never behaviourally probed in production**. `has_table_privilege` returning `false` is a catalog
read; it is not proof that a real JWT gets `42501`. Do not repeat it.

1. Re-run **Probe 1**. Expect `ap_ins`/`ap_upd`/`ap_del`/`ap_trunc` and the `au_*` equivalents `false` for
   `anon` and `authenticated`; `ap_sel` and `au_sel` still **true**; `service_role` unchanged.
2. Re-run **Probe 6**. Every count identical, `max(appointments.updated_at)` unchanged. This is the
   additive-only proof.
3. Re-run the policy inventory. Expect `appointments_member_select` (SELECT),
   `appointment_audit_member_read` (SELECT), and **no** `appointment_audit_member_insert`.
4. **Read-path proof:** as a real studio member, load the calendar grid and one appointment detail page.
   `lib/booking/queries.ts:237` (`getAppointmentsForRange`, `select("*")`) and
   `app/(app)/calendar/[id]/page.tsx:99-107` both run on the authenticated client, and the detail page
   **throws** on error. If SELECT were over-revoked, that page 500s — this is the fastest human check.
5. **The honest privilege probe.** Two forms, in increasing fidelity:
   * *Role-switch:* inside an explicit `begin; … rollback;` with a predicate matching no rows —
     `begin; set local role authenticated;
      update public.appointments set id = id where id = '00000000-0000-0000-0000-000000000000';
      rollback;` — expect `42501`. The zero-row predicate is load-bearing: with the privilege retained
     this **succeeds with rowCount 0** and looks identical to a refusal. Never assert on a row count.
   * *Real JWT:* a `PATCH /rest/v1/appointments?id=eq.00000000-0000-0000-0000-000000000000` from a genuine
     practitioner session against the production REST endpoint, expecting `42501`. This is the only form
     that tests PostgREST, the anon key and the JWT together. It requires its own explicit approval.
   Until form 2 has run, **do not write "production-verified" in the PR, the ledger or the memory note.**
6. Update `docs/production/migration-state.json` (`hosted_migration_max` → `"0172"`, `hosted_applied_at`,
   and a `hosted_note` recording the measured before/after counts, the dry-run output, the exit code, and
   which probes ran) plus `docs/production/migration-ledger.md`. Then run
   `node --env-file=.env.local scripts/verify-production.mjs` and confirm it passes again.

---

### 13.6 Rollback

**Rollback is always a NEW migration. Never edit an applied file** — `0169`'s own header states this, and
the migration-state spine assumes filenames are immutable once applied.

```sql
-- 0173_rollback_appointment_dml_revocation.sql   (number = whatever is next free at the time)
begin;
set local lock_timeout = '5s';

grant insert, update, delete on table public.appointments      to authenticated;
grant insert, update, delete on table public.appointments      to anon;
grant insert, update, delete on table public.appointment_audit to authenticated;
grant insert, update, delete on table public.appointment_audit to anon;

-- Only if 0172's GROUP 4 shipped:
grant truncate, references, trigger on table public.appointments      to anon, authenticated;
grant truncate, references, trigger on table public.appointment_audit to anon, authenticated;

-- Policies, restored VERBATIM from 0010:272-299.
drop policy if exists "appointments_member_select" on public.appointments;
create policy "appointments_member_all"
  on public.appointments
  for all
  using (public.is_studio_member(studio_id))
  with check (public.is_studio_member(studio_id));

create policy "appointment_audit_member_insert"
  on public.appointment_audit
  for insert
  with check ( /* the exact 0010:291-299 predicate, copied byte-for-byte */ );

commit;
```

**Four things to be honest about in the rollback:**

1. **It restores a capability, not data.** 0172 writes no rows, so nothing is lost by applying it and
   nothing is recovered by reversing it.
2. **The policy half is the part that actually matters.** Re-granting the privileges without restoring
   `appointments_member_all` leaves members unable to write, because a privilege with no permissive policy
   is still a closed door. Restore both, in the same transaction.
3. **The realistic trigger for a rollback is not "the app broke".** It cannot: the app has no authenticated
   appointment writer. The realistic trigger is discovering that some path *was* running as `authenticated`
   — an out-of-band integration, a Supabase Studio session, an unmerged branch. If that happens, roll back
   **and** find the writer; do not roll back and forget.
4. **A rollback of 0174/0175 is materially harder than a rollback of 0172.** 0174 backfills a column and
   re-points an FK; 0175 **drops three functions**. That asymmetry is the whole reason the revoke is its
   own migration and the function drops are theirs. A partial reversal of 0172 alone is always safe.

**Not reversible by re-grant:** nothing in 0172. Every other migration in this program has at least one
statement whose reversal is a rewrite rather than an inverse — which is exactly why 0172 goes first.

---

### 13.7 Standing prohibitions for every migration in this program

| Prohibition | Why |
|---|---|
| Do **not** `create or replace public.snapshot_appointment_buffer()` | Production's deployed body carries an out-of-band GUC bypass (`app.bypass_appointment_buffer_snapshot`) present in no migration and in no locally-reset database. Replacing it from repo source silently deletes a live production behaviour, with no diff and no test failure. The existing negative guards are scoped to 0171's text and do **not** generalise — each new migration must carry its own copy of that assertion |
| Do **not** use `revoke all` | It takes `SELECT` with it (~22 authenticated read sites) and silently absorbs any future privilege type instead of naming the verbs the cutover is about. `0169`'s header states the doctrine |
| Do **not** drop `appointments_member_all` without creating `appointments_member_select` in the same transaction | Identical blast radius to `revoke all`. That policy is the **only** thing granting members SELECT rows |
| Do **not** batch migrations into one push | The dry run listing exactly one file is what makes "exit 0" evidence |
| Do **not** touch `supabase/.temp/project-ref`, and check it before every CLI command | It carries the PROD ref |
| Do **not** run `supabase db dump` | Classifier-blocked. `db query --linked` is the read channel |
| Do **not** add an e2e spec before PR #517 merges | `scripts/browser-groups.mjs` is Session-1D-owned and `tests/ci/browser-selection.test.ts:64-71` hard-codes 55/26 (§15) |

---

## 14. Required negative-security tests

A negative-security test asserts that something is *refused*. The appointment domain has almost none: the
suite proves that the commands work, not that the ungoverned path is closed. Two shipped DB tests go
further and pin the open posture as a requirement.

### 14.1 What exists today, and what it actually proves

`tests/security/` contains exactly six files. None of them measures appointment table DML.

| File | Scope | Proves | Does NOT prove |
|---|---|---|---|
| `tests/security/service-role-allowlist.ts` (83 entries, `path: "` × 83) + `.test.ts` | every `createAdminClient()` call site under `app/`/`lib/` | the call-site set is exactly equal to the allowlist (`service-role-allowlist.test.ts:50-64`); `createAdminClient` is defined only in `lib/supabase/admin-server.ts` and nothing else builds a client from `SERVICE_ROLE_KEY` (`:66-77`); each entry's literal `scopeGuard` string is present in its file (`:97-111`) | anything about *table* DML; anything about tenancy scoping. The file says so itself: `service-role-allowlist.ts:10-11` — "an INVENTORY + DRIFT gate … not that every query is perfectly scoped" |
| `tests/security/public-booking-command-guard.test.ts` | one file, `app/book/[slug]/actions.ts` | no `.from("appointments")` chain within 400 chars of a DML verb (`:28-39`); no `.from("appointment_audit")` (`:41-43`); the route calls `rpc("create_public_appointment")` (`:45-47`) | nothing behavioural; nothing outside that one route. Its own header (`:14-19`) states "`authenticated` still holds direct appointment DML at the database layer" |
| `tests/security/public-reschedule-command-guard.test.ts` | `app/reschedule/[token]/actions.ts` + the *text* of migration 0171 | the route calls `reschedule_appointment_v2` and no longer touches `appointments`/`appointment_audit` (`:70-73`); 0171's three functions are `security definer` + `search_path=''` and granted to `service_role` alone (`:380-535`) | nothing behavioural. It pins 0171 as additive-only (`:448-451`) and pins the legacy `reschedule_appointment` as un-dropped and un-revoked (`:438-446`) |
| `tests/security/entry-direct-dml-guard.test.ts` | repo-wide static DML census over `app`, `lib`, `components`, `scripts`, `middleware.ts` (`:66-67`) | zero runtime direct writers on the six **clinical** tables, literal *and* `.from(variable)` forms, with a fail-closed refusal of unanalyzable shapes (`:678-691`) and a negative control (`:629-641`) | `TABLES` at `:35-42` is the six clinical tables. **`appointments` and `appointment_audit` are not in it.** The machinery is built and simply not pointed at them |
| `tests/security/clinical-rpc-grant-guard.test.ts` | clinical RPC EXECUTE grants | — | not appointments |

The one behavioural privilege probe in the repo is `tests/db/l18-final-revocation.db.test.ts`, and its
technique is the correct one to copy:

| Element | Location | Why it matters |
|---|---|---|
| `codeFor()` helper — run as a bare role, return SQLSTATE or `null` | `tests/db/l18-final-revocation.db.test.ts:37-45`, over `asRole()` (`tests/db/helpers/harness.ts:136-155`, which rolls back) | a probe that never persists |
| Predicate that matches **zero rows** | `:76-84` — `update … where id = '00000000-…'` | with the privilege retained the statement *succeeds* with `rowCount 0` and the test **fails**; with it revoked it raises `42501`. A zero-row RLS filter and a successful no-op are indistinguishable, which is exactly why the predicate must be empty |
| SELECT-retention half | `:47-58` | proves the revoke did not over-reach |
| `anon` and PUBLIC halves | `:102-126` | `aclexplode … grantee = 0` must be 0 |
| `service_role` baseline half | `:128-141` | proves the revoke did not touch the command path |

`TABLES` at `l18-final-revocation.db.test.ts:19-26` is again the six clinical tables.

### 14.2 Vacuous and mis-named tests

| Test | Why it is vacuous | Evidence |
|---|---|---|
| `tests/scripts/e2e-guardrails.test.ts:70-83` — *"no service-role browser route or app-side test hook exists"* | the outer `for (const dir of ["app","lib","components","middleware.ts"])` ends in `void dir;` (`:79`), so the same four assertions run four times against the same four **e2e** files (`SPEC`, `SEED`, `ENV`, `CONFIG`, bound at `:15-20`). `app/`, `lib/`, `components/` and `middleware.ts` are never read | the regex is `/process\.env\.E2E_AUTH_BYPASS/`; `grep -rn "E2E_AUTH_BYPASS"` over the whole repo returns **exactly one hit — that line itself**. The real markers are `HONE_E2E_*` (`lib/google-calendar/e2e/fake-google-guard.ts:47-52`, `lib/email/e2e-fake-resend.ts:23`, `lib/stripe/e2e-fake-stripe.ts:59`). The test greps for a token that does not exist, in files that are not the ones named |
| the same test's only real app-side check, `existsSync("app/api/e2e") === false` (`:81`) | true, but the path is wrong | an app-side E2E hook route **does ship**: `app/api/google-calendar/e2e/authorize/route.ts` — a `GET` handler that redirects into the real OAuth callback, gated only by `assertE2eFakeGoogleAllowed(process.env)` at `:19` (fail-closed, returns 404 in a deployed build). The assertion at `:81` cannot see it |
| `tests/db/public-booking-concurrency.db.test.ts:259-287` — *"mark_appointment_complete on the source waits for the create"* | the statement it runs is `select * from public.appointments where id=$1 for update` (`:275-277`). `mark_appointment_complete` is never called | it proves only that a row lock blocks a row lock. The neighbouring test (`:289-311`) reasons about lock ordering by scanning `prosrc` text, not by invoking anything |
| `tests/app/calendar/postcare-auto-send.test.ts:44-69` | the fake client is table- and filter-blind: `b.from = () => b` (`:50`) discards the table name and `b.eq = () => b` (`:63`) discards `.eq("studio_id", …)` | this is the unit coverage for three of the seven direct appointment DML statements (`app/(app)/calendar/postcare-auto-send.ts:152,187,201`); it cannot detect a wrong table or a dropped tenant filter |
| `tests/db/appointments-tenant-consistency.db.test.ts:103` | `const isFk = …` is defined, never called, and silenced with `void isFk;` at `:146` | harmless, but it is the residue pattern that precedes a vacuous pass |

### 14.3 The lane these tests live in is CONDITIONAL in CI

`.github/workflows/ci.yml:226` defines the `db-integration` job and `:229` gates it on
`needs.changes.outputs.database == 'true' || … security == 'true' || … full_matrix_required == 'true'`.
`scripts/classify-changes.mjs:43-44` sets `database` only for `supabase/migrations/`, `supabase/**.sql`,
`tests/db/`, `tests/migrations/` and three named scripts, and `security` only for `tests/security/`,
`lib/security/`, `lib/observability/` and `scripts/check-*gates`. A PR touching `app/**` alone sets
`application` and `browser_core` (`:49-50`) and **does not run `tests/db/**` at all**. Consequence for the
plan below: the static census (T2) belongs under `tests/security/` so that it runs on any security change,
but a *new appointment writer added under `app/`* would still not trigger the `db-integration` lane —
only T2's own lane. T2 must therefore be the primary tripwire for application drift, and T1 the primary
tripwire for schema/grant drift.

### 14.4 The required suite

Every test below is written so that it **FAILS at `03e7dee`** and passes only after the boundary closes.
A negative test that is green today proves nothing about tomorrow.

#### T1 — behavioural DB probe: `authenticated` is REFUSED DML on `appointments` and `appointment_audit`

**File:** `tests/db/appointment-boundary-revocation.db.test.ts` (new). Copy the structure of
`tests/db/l18-final-revocation.db.test.ts` verbatim; change `TABLES` to
`["appointments", "appointment_audit"]`.

| # | Assertion | Failure mode it detects |
|---|---|---|
| T1.1 | `has_table_privilege('authenticated','public.appointments','INSERT'\|'UPDATE'\|'DELETE')` is `false`; same for `appointment_audit` | the ACL itself. Red today — both are `true` (`tests/db/public-appointment-command.db.test.ts:475-489`) |
| T1.2 | same three flags are `false` for **`anon`** | 0169's template revokes from `authenticated` only (`0169:82-87`); copying it leaves `anon`'s grant standing |
| T1.3 | `codeFor("update public.appointments set id = id where id = '00000000-0000-0000-0000-000000000000'")` === `'42501'`; identical probe on `appointment_audit` | the **zero-row** predicate is load-bearing: with the grant retained this returns `rowCount 0` and no error, so the test fails. Mirrors `l18-final-revocation.db.test.ts:76-84` |
| T1.4 | `codeFor("delete from public.<t> where id = '00000000-…'")` === `'42501'` | same, for DELETE. Mirrors `:86-91` |
| T1.5 | `codeFor("insert into public.<t> default values")` === `'42501'` **and** the error message does not match `/row-level security/i` | an RLS `WITH CHECK` failure also raises SQLSTATE `42501`, so the code alone is ambiguous for a table that has a permissive `for all` policy (`0010:272-277`). The message discriminator is mandatory here and is **absent** from the L18 template. Today the probe should return `23502` (NOT NULL on `studio_id`/`client_id`/`starts_at`, `0010:183` region) because constraint checks precede WITH CHECK — UNPROVEN (static audit); the message assertion makes the test sound either way |
| T1.6 | `has_table_privilege('authenticated','public.appointments','SELECT')` is `true` **and** `select count(*) from public.appointments` raises nothing | SELECT is load-bearing across the app (16 read-only `.from("appointments")` chains outside the seven writers). An over-reaching revoke must be caught here, not in production |
| T1.7 | `has_table_privilege('authenticated','public.appointment_audit','SELECT')` is `true` | `app/(app)/calendar/[id]/page.tsx:130-139` reads it through the authenticated client |
| T1.8 | `service_role` retains SELECT/INSERT/UPDATE/DELETE on both tables | the entire command layer is `security definer` owned; a revoke that reached `service_role` would break every writer. Mirrors `:128-141` |
| T1.9 | PUBLIC holds no grant: `aclexplode(c.relacl) … grantee = 0` count is 0 for both tables | mirrors `:115-126` |
| T1.10 | `TRUNCATE` is `false` for `anon` and `authenticated` on both tables | P3 hygiene. No browser channel can issue TRUNCATE (PostgREST exposes no verb), so this is doctrine, not exploit — but `0092:106` and `0115:40-41` already name `truncate` in their revokes, and the appointment revoke should match that precedent |
| T1.11 | after revocation, the `appointment_audit_member_insert` policy (`0010:291-299`) is either dropped or provably unreachable: assert `count(*) from pg_policies where tablename='appointment_audit' and cmd='INSERT'` equals whatever the migration chose, and pin it | a policy left behind that grants nothing is a misleading artifact; whichever way it is resolved must be asserted, not left ambient |

#### T2 — static direct-DML census for `appointments` / `appointment_audit`

**File:** `tests/security/appointment-direct-dml-guard.test.ts` (new), built on
`tests/security/helpers/supabase-write-census.ts`.

Use `supabaseWriteSites()` (`supabase-write-census.ts:365`) — the **TypeScript-compiler-API** census that
walks `app`, `lib`, `components`, `scripts`, `middleware.ts` (`:35-37`) and reports `columns` and
`unresolved` per site (`:88-101`). Do **not** copy `entry-direct-dml-guard.test.ts`'s local
`directWriteSites()` (`:96-131`), which is a bracket-walking regex and is strictly weaker.

| # | Assertion | Notes |
|---|---|---|
| T2.1 | the set of write sites with `table === "appointments"` equals an `ALLOWED` list of exactly **seven** entries, keyed `file::fn::op` | `app/(app)/calendar/actions.ts:1115,1156,1212,1243`; `app/(app)/calendar/postcare-auto-send.ts:152,187,201`. (`postcare-auto-send.ts:118` is a `.select` and is not a writer) |
| T2.2 | for each allowed site, `site.columns` ⊆ the `postcare_email_*` column set | promotes the census from "which file" to "which columns". A payload that grows `status`, `starts_at` or `practitioner_id` fails immediately |
| T2.3 | write sites with `table === "appointment_audit"` is **empty** | the only runtime reference is the read at `app/(app)/calendar/[id]/page.tsx:132` |
| T2.4 | `sites.filter(s => s.unresolved !== null \|\| !s.tableResolved)` that could target either table is empty | fail-closed, matching the helper's stated contract (`supabase-write-census.ts:25-28`) and the L18 lesson that `.from(variable)` hid a live writer |
| T2.5 | **negative control:** the census must FIND all seven known writers; `expect(found.length).toBe(7)` with an explicit message | copies `entry-direct-dml-guard.test.ts:629-641` ("if this census ever stops finding the one writer we know exists, the analyzer is broken"). Without this, a broken analyzer produces a green suite |
| T2.6 | each allowed site's receiver is proven to originate from `createAdminClient()` via `clientFactoryProof()` / `insertReceiverProof()` (`supabase-write-census.ts:517,625`) | the inverse of `entry-direct-dml-guard.test.ts:552` ("no charting-table write runs through the admin client"): here service-role is the *requirement*, and an appointment write appearing on the authenticated client is the failure |
| T2.7 | zero write sites on either table use the authenticated client | encodes the zero-application-change property that makes T1 safe to ship |

T2 passes today (the census is accurate at this SHA); its value is as a ratchet. It should ship **before**
the revocation, so the seven-writer count is frozen while the migration is written.

#### T3 — grant-posture pin

**Files:** the ACL half in `tests/db/appointment-boundary-revocation.db.test.ts`; the migration-text half in
`tests/migrations/0172-appointment-dml-revocation.test.ts` (new).

| # | Assertion |
|---|---|
| T3.1 | full `aclexplode` dump of `public.appointments` and `public.appointment_audit` compared against an expected literal grantee→privilege map. Any future re-grant fails, not just the three verbs T1 names |
| T3.2 | the migration text names **both** `anon` and `authenticated` explicitly. `0169:82-87` names `authenticated` only; the two shipped pin tests prove `anon` holds all three on `appointments` today |
| T3.3 | the migration text contains no `grant` on either table and no `create or replace function` for any trigger function — the standing constraint from `tests/security/public-reschedule-command-guard.test.ts:459-470` (production's `snapshot_appointment_buffer` carries an out-of-band GUC bypass absent from this repo) |
| T3.4 | the migration opens its own `begin;`/`commit;` with `set local lock_timeout` inside it, matching `0169:78-89` |

**Posture note, UNPROVEN (static audit):** `tests/db/l18-final-revocation.db.test.ts:102-113` asserts `anon`
has **no** INSERT/UPDATE/DELETE on the six clinical tables, while
`tests/db/public-appointment-command.db.test.ts:475-489` asserts `anon` **has all three** on `appointments`
— both on a freshly-migrated chain. No migration in the tree revokes those verbs from `anon` on
`sessions` or `session_blocks` (`grep -n "from anon" supabase/migrations/*.sql`, filtered to table revokes,
returns lines only for `treatment_images`, `electrolysis_entries`, `laser_entries`, `session_block_areas`
and non-clinical tables). The two claims cannot both follow from a uniform default-privilege model. T3.1
must therefore **measure** the `anon` posture rather than assume it, and the revocation migration must name
`anon` regardless of what the measurement shows.

#### T4 — cross-tenant appointment write

**File:** `tests/db/cross-studio-isolation.db.test.ts` (extend). Today it covers `clients`, `sessions`,
`session_blocks`, `record_keeping_exposure_incidents` and `record_keeping_audit_events` — **SELECT only**
(`:84-137`). It contains no appointment case of any kind.

| # | Assertion |
|---|---|
| T4.1 | as `service_role`, an INSERT into `public.appointments` with studio A's `studio_id` and studio B's `client_id` raises `23503` — the composite same-studio FK from `0151_appointment_tenant_consistency.sql:83-99`. Running it as `service_role` keeps the 0151 guarantee under test after `authenticated` loses the verb |
| T4.2 | the same three-way permutation for `service_id` and `practitioner_id`, mirroring `tests/db/appointments-tenant-consistency.db.test.ts:120-129` |
| T4.3 | as `authenticated` member of A, a SELECT of B's appointment rows returns zero rows (the missing read half — `appointments` is absent from the existing isolation suite) |
| T4.4 | as `authenticated` member of A, a SELECT of `appointment_audit` rows belonging to B's appointments returns zero rows (`appointment_audit_member_read`, `0010:280-288`) |
| T4.5 | after revocation, an `authenticated` INSERT into `appointments` naming *own* studio raises `42501` — proving the refusal is the privilege layer, not the FK |

#### T5 — "every status change produces an audit row" invariant

**File:** `tests/db/appointment-audit-invariant.db.test.ts` (new). No test asserts this today; per-command
audit assertions exist in isolation (`tests/db/public-appointment-command.db.test.ts:143`,
`tests/db/public-reschedule-command.db.test.ts:292,739`,
`tests/db/practitioner-move-appointment.db.test.ts:97`) but nothing measures the invariant across commands.

| # | Assertion |
|---|---|
| T5.1 | a table-driven sweep over every command that mutates `status` — `create_internal_appointment_v2`, `create_public_appointment`, `reschedule_appointment_v2`, `move_or_reassign_appointment`, `public_cancel_appointment_with_token`, `practitioner_cancel_appointment`, `mark_appointment_complete`, `mark_appointment_no_show`: snapshot `(status, count(*) from appointment_audit where appointment_id=$1)` before and after; assert **status changed ⇒ audit count strictly increased** |
| T5.2 | the emitted `action` values are exactly the documented set — `'marked_complete'` (`0032:4091`), `'marked_no_show'` (`0033:378`), `'cancelled'` (`0033:299`) — so a renamed action is caught. `app/(app)/calendar/[id]/page.tsx:135` filters on the literal `'cancelled'`, so a rename silently blanks a rendered surface |
| T5.3 | `actor_type = 'practitioner'` **and** `actor_id` resolves to an active practitioner of the appointment's studio. `actor_id` is a bare `uuid` with no FK and no correlation to `actor_type` (`0010:220-221`); only `actor_type` is CHECKed. This is the only place the correlation gets asserted at all |
| T5.4 | `created_at` equals the row default (within a tolerance of `now()`), not a caller-supplied value. `created_at` is a plain writable column with only a default (`0010:224`) |
| T5.5 | **intent-encoding, expected RED until an audit trigger ships:** a direct `update public.appointments set status='completed' where id=$1` run as `service_role` produces an `appointment_audit` row. It does not today — no trigger writes the table; every audit row is written explicitly by a command. Mark it `it.fails(...)` (or skipped with the reason inline) so the goal is in the suite rather than in prose. The precedent exists in this codebase: `stripe_payment_audit_immutable` (`0032:1411`) and `clinical_audit_events_append_only` (`0120:219`) |
| T5.6 | `appointment_audit` rows cannot be UPDATEd or DELETEd by a member: as `authenticated`, both raise or return zero rows, and the row survives. RLS default-denies commands with no matching policy — `0010` creates only SELECT and INSERT policies — so this is already true; asserting it prevents a future permissive `for all` policy from re-opening it silently |

#### T6 — behavioural coverage for the three lifecycle commands

**File:** `tests/db/appointment-lifecycle-commands.db.test.ts` (new). `mark_appointment_complete`,
`mark_appointment_no_show` and `practitioner_cancel_appointment` have **no behavioural test anywhere**; the
only `tests/db` reference is a `prosrc` text scan (`tests/db/public-booking-concurrency.db.test.ts:299-300`)
and the mis-named lock test at `:259`. Application coverage is source-grep only
(`tests/app/calendar/appointment-lifecycle-mark-complete.test.ts:231-234`).

The two 0033 commands **return sentinel strings rather than raising**, which makes untested branches
especially dangerous — a caller that ignores the return value turns a refusal into a silent no-op.

| # | Command | Assertion |
|---|---|---|
| T6.1 | `mark_appointment_complete` (`0032:4052`) | non-member / inactive practitioner raises `42501` with `'practitioner is not an active member of this studio'` (`0032:4064-4069`) |
| T6.2 | `mark_appointment_complete` | unknown appointment, or one whose `studio_id` differs, raises `P0002` `'appointment not found'` (`0032:4072-4078`) |
| T6.3 | `mark_appointment_complete` | a non-`confirmed` appointment raises `P0002` (`0032:4079-4081`) and an appointment whose `ends_at > now()` raises `P0002` `'appointment has not yet ended'` (`0032:4082-4084`) — i.e. `cancelled → completed` and `no_show → completed` are both refused |
| T6.4 | `practitioner_cancel_appointment` (`0033:241`) | returns `'not_authorized'` for a non-member (`0033:256-261`), `'already_cancelled'` for a cancelled row (`:271-273`), `'not_cancelable'` for `completed`/`no_show` (`:275-277`) and for any appointment whose `starts_at <= now()` (`:286-288`), and `'cancelled'` on success (`:309`) — one case per sentinel, all five asserted |
| T6.5 | `mark_appointment_no_show` (`0033:334`) | returns `'not_authorized'` (`0033:347-354`), `'wrong_status'` for a non-`confirmed` row (`:364-366`), `'too_early'` while `ends_at > now()` (`:368-370`), `'marked'` on success (`:387`) |
| T6.6 | all three | EXECUTE is denied to `public`, `anon` and `authenticated` and granted only to `service_role`: `has_function_privilege` probes matching `0032:4099-4102`, `0033:314-317`, `0033:392-395`. This is the one negative property of these commands that source alone already claims and that no test measures |
| T6.7 | all three | on every refusal path, `status`, `cancelled_at`, `cancelled_by` and the `appointment_audit` row count are all unchanged — the rollback invariant, modelled on `tests/db/public-reschedule-command.db.test.ts:1310-1315` |
| T6.8 | app half | `app/(app)/calendar/actions.ts:432,550,608` branch on **every** sentinel each command can return. A missing branch renders a refusal as success in the UI |

### 14.5 Tests the revocation PR must INVERT — in the same commit

Three shipped tests assert the current open posture and will go red the moment the revoke lands. All three
must be edited in the migration's own PR, not chased afterwards.

| Test | Current assertion | Required change |
|---|---|---|
| `tests/db/public-appointment-command.db.test.ts:475-489` — *"THIS PR does not revoke any appointment table grant"* | `row.ins`/`upd`/`del` are `true` for `anon` **and** `authenticated` | invert to `false`, or delete and let T1 own the property. The stale comment at `:484-485` ("the revocation is a LATER PR") must go with it |
| `tests/db/public-reschedule-command.db.test.ts:1430-1443` — *"revokes NOTHING from the appointments table"* | identical three-flag assertion | same |
| `tests/db/appointments-tenant-consistency.db.test.ts:131-146` — *"an authenticated Alpha owner is likewise blocked (RLS passes, FK fails)"* | an `authenticated` INSERT rejects with `23503` | after revocation the error becomes `42501`, so this goes red too. Re-target the FK proof to `service_role` (T4.1) and keep an `authenticated` case asserting `42501` (T4.5), so the 0151 composite-FK guarantee stays covered rather than being lost in the edit |

`tests/security/public-reschedule-command-guard.test.ts:448-451` (*"revokes NO table DML — this migration
is additive only"*) does **not** need inverting: `MIGRATION_CODE` is bound at `:27-42` to the text of
migration 0171 alone, so a new migration revoking appointment DML leaves it green. It should be left as-is;
it correctly pins 0171's history.

### 14.6 Which gap each test closes

| Gap | Closed by | Red today? |
|---|---|---|
| `anon`/`authenticated` hold INSERT/UPDATE/DELETE on `appointments` (no GRANT/REVOKE in 170 migrations) | T1.1–T1.5, T3 | yes |
| Same on `appointment_audit`, where the INSERT policy (`0010:291-299`) constrains only `appointment_id` | T1.1–T1.5, T1.11, T5.6 | yes |
| No repo-wide static guard over appointment DML | T2 | no (ratchet) |
| `appointments` absent from `tests/db/cross-studio-isolation.db.test.ts` | T4 | yes |
| No trigger writes `appointment_audit`; a direct write is unaudited | T5.5 (intent-encoding) | yes, by design |
| `actor_id` uncorrelated with `actor_type`; `created_at` caller-writable | T5.3, T5.4 | yes |
| Zero behavioural coverage of the three lifecycle commands | T6 | yes |
| `tests/scripts/e2e-guardrails.test.ts:70-83` scans neither the trees nor the tokens it names | rewrite: walk `app`/`lib`/`components`/`middleware.ts` for real and grep `HONE_E2E_`, allow-listing only `lib/google-calendar/e2e/`, `lib/email/e2e-fake-resend.ts`, `lib/stripe/e2e-fake-stripe.ts` and `app/api/google-calendar/e2e/authorize/route.ts` | yes once rewritten |
| `postcare-auto-send` unit fake is table- and filter-blind | record `from()`'s argument and the `eq()` pairs; assert `("appointments","studio_id",studio.id)` | yes once fixed |

---

## 15. Conflicts and coordination with Session 1D

**The audit itself collides with nothing.** Its only repository change is the addition of this file; it
touched no code, test, migration, generated type or shared documentation index, and it was written in an
isolated worktree. Nothing in this section applies to the audit — it applies to the nine PRs §12 proposes.

Session 1D works in its own worktree. Its PR is **#517 — draft, code-only, migration max still
0171**. That worktree was never opened during this audit; everything below was determined from the
**production** versions of the 1D-owned files at the pinned SHA `03e7dea`. Collisions are therefore
predicted from file ownership and from what those files do at production HEAD — not from diffing 1D's
in-flight work. That is a real limitation and it is why §15.4 ends with a re-check step rather than a
guarantee.

---

### 15.1 Do any 1D-owned files mutate appointments? — **No. Not one.**

| 1D-owned file | Lines | Mutates `appointments` / `appointment_audit`? | Evidence |
|---|---|---|---|
| `app/(app)/calendar/[id]/page.tsx` | 1399 | **No** | `grep -n '\.update(\|\.insert(\|\.delete(\|\.rpc('` returns **nothing** in the entire file |
| `lib/sessions/charted-session.ts` | 180 | No | pure functions; zero `.from(`, zero `.rpc(`, no Supabase client import |
| `lib/sessions/last-treatment-loader.ts` | 187 | No | reads `session_blocks` only (`:112`), via `createClient()` at `:110` |
| `lib/sessions/point-of-care-memory.ts` | 607 | No | pure; zero `.from(`, zero `.rpc(` |
| `components/last-treatment-memory-card.tsx` | 307 | No | its own header at `:16` — *"it issues no query, owns no state"* |
| `components/appointment/mark-complete-control.tsx` | — | No | dispatches a server action; the **action** calls `mark_appointment_complete` |
| `components/appointment/postcare-section.tsx` | — | No | presentational |
| `scripts/browser-groups.mjs` | 242 | No | the Playwright spec→group manifest. Its only `appointments` reference is a CI path-matching regex at `:152` |

The nearest thing to a write is `mark-complete-control.tsx`, and the mutation lives one layer away in
`app/(app)/calendar/actions.ts:550` → `mark_appointment_complete` (`0032:4052`, `service_role`-only). That
file is **not** 1D-owned.

**Consequence:** the boundary program's central migration, 0172, removes a capability that no 1D-owned file
uses. There is no behavioural interaction to reason about.

---

### 15.2 Do any 1D-owned files READ appointments in a way the boundary changes?

Two reads, both in the same file, with **opposite failure modes**.

**Read 1 — `app/(app)/calendar/[id]/page.tsx:99-107`. Hard-fail.**

```ts
const { data, error } = await supabase          // createClient() -> role `authenticated`, :97
  .from("appointments")
  .select("*, client:clients(...), service:services(...), practitioner:practitioners(...)")
  .eq("id", id).eq("studio_id", studio.id).maybeSingle<Joined>();
if (error) throw new Error(error.message);
if (!data) notFound();
```

`select("*")`, typed as `Appointment & {…}` at `:65-72`, and it consumes
`data.postcare_email_sent_at / _send_attempts / _claimed_at / _failed_at` at `:511-514` — **the exact four
columns the seven remaining direct writers mutate.** It `throw`s on error, so this page becomes a 500 if
SELECT is ever lost.

**Read 2 — `app/(app)/calendar/[id]/page.tsx:131-139`. Fail-soft.**

```ts
.from("appointment_audit").select("details")    // gated on isCancelled, filtered action='cancelled'
```

`data` is destructured without `error`, so a privilege loss here silently blanks the cancellation-insight
card rather than erroring. The page's own comment at `:115-117` names the dependency: *"Studio members can
read appointment_audit via RLS (migration 0010); no service role needed."*

**This is the only application read of `appointment_audit` anywhere.** `grep -rn "appointment_audit"` over
`app/`, `lib/`, `components/` returns eight hits: six comments, plus these two lines. Session 1D owns the
sole consumer of the table.

**Does the boundary change either read? No — by construction.**

| Boundary change | Effect on read 1 | Effect on read 2 |
|---|---|---|
| 0172 groups 1–2 (revoke INSERT/UPDATE/DELETE) | none — `SELECT` is deliberately never named | none |
| 0172 group 3 (`appointments_member_all` → `appointments_member_select`) | none — the replacement reuses `public.is_studio_member(studio_id)` **verbatim**, so the same rows are visible to the same members | none — `appointment_audit_member_read` (`0010:280-288`) is not touched by 0172 |
| 0172 group 3 (drop `appointment_audit_member_insert`) | none | none — it is an INSERT policy; reads never consult it |
| 0174 (`appointment_audit.studio_id`, FK re-point, read-policy rewrite) | none | **Compatible, and worth stating precisely.** The policy moves from `is_studio_member` via the joined appointment to `is_studio_member(studio_id)` directly. The read filters by `appointment_id` + `action='cancelled'` and selects `details` alone; the backfill sets `studio_id` on every existing row, so the same rows pass. The FK moving to `on delete set null` only affects rows whose appointment was deleted — which by definition this read cannot be looking at |
| 0175 (transition guard, `set_updated_at`) | none — read-only page | none |

**The one failure mode that would break both:** `revoke all` instead of naming three verbs, or dropping
`appointments_member_all` without the adjacent replacement. Both are explicitly prohibited (§13.7), and
**read 1's hard-fail is the reason the prohibition has teeth** — the symptom would be an immediate 500 on
the appointment detail page, not a subtle degradation.

**Adjacent file, not 1D-owned but coupled to 1D:** `app/(app)/clients/[id]/sessions/[sessionId]/page.tsx`
imports `loadLastChartedTreatment`, `buildPointOfCareMemory` and `LastTreatmentMemoryCard` (`:65-67`)
**and** performs its own authenticated appointments read at `:188-197` selecting the same four
`postcare_email_*` columns. It is not owned by 1D, but a change to the 1D modules' signatures and a change
to the postcare columns would meet here. B8 is the only PR that touches both.

---

### 15.3 Which boundary PRs touch 1D-owned files

| PR | Touches a 1D-owned file? | Verdict |
|---|---|---|
| **B1** — census guard | **No.** `tests/security/**`, `tests/app/**` | **Parallel-safe.** Note it *reads* all eight 1D files as census input; none is a writer, so it is green today and stays green |
| **B2** — behavioural coverage | **No.** `tests/db/**` | **Parallel-safe** |
| **B3** — 0172 revoke | **No.** `supabase/migrations/**`, `tests/**`, `docs/**` | **Parallel-safe.** Both 1D reads survive unchanged (§15.2) |
| **B4** — 0173 repair commands | **Yes — one file, ~12 lines.** The UI mount belongs in `app/(app)/calendar/[id]/page.tsx` | **Split the PR** — see §15.4 |
| **B5** — 0174 audit integrity | **No.** But it changes the policy behind 1D's read 2 | **Parallel-safe**, with a smoke check on the cancellation-insight card after apply |
| **B6** — 0175 transition guard | **No** | **Parallel-safe** |
| **B7** — 0176 `/cancel` acknowledgement | **No.** `app/cancel/**` is not 1D-owned | **Parallel-safe** |
| **B8** — 0177 postcare command | **Yes — hard.** `components/appointment/postcare-section.tsx` is 1D-owned, and both 1D-owned page reads consume the four `postcare_email_*` columns | **Must wait for #517 to merge** |
| **B9** — final census + docs | **Possibly** `scripts/browser-groups.mjs`, if any e2e spec is added | Safe by then; #517 is long merged |

**Two collisions in nine PRs, one of them 12 lines.**

---

### 15.4 The concrete non-collision plan

**Build in parallel with #517, starting now (no coordination needed):** B1, B2, B3, B5, B6, B7.
Six of the nine PRs, including the entire P1 closure and three of the six migrations. None of them opens a
file 1D owns.

**B4 — split it, do not delay it.**

The natural mount point is `app/(app)/calendar/[id]/page.tsx`, and it is not avoidable by re-homing the
component. The existing "Outcome" section is gated `typedStatus === "confirmed"` (`:436`) and renders
`AppointmentLifecycleActions` (`:446`) with props `{appointmentId, status, endsAt}`. The revert panel is
needed for the **terminal** statuses — the exact complement of that gate — and it needs `isOwner`, which
the page already computes at `:96` but does not pass down. So riding inside `AppointmentLifecycleActions`
would require a new prop *and* a changed gate, i.e. the same page edit plus more.

Plan:

1. **B4a (merge any time):** migration 0173, the four SQL helpers, the two commands, their DB tests,
   `app/(app)/calendar/appointment-repair-actions.ts`, the panel component, the
   `tests/security/service-role-allowlist.ts` registration, and a source-grep test over the new action
   file. The component is written and tested but **not mounted**. This is standard app-first sequencing —
   the same shape 0164–0168 used — not dead code.
2. **B4b (after #517 merges):** the ~12-line insertion into `app/(app)/calendar/[id]/page.tsx` —
   one new `<section>` gated `typedStatus !== "confirmed" && isOwner`, rendering the panel.

Do the same for the two adjacent temptations §11.8 names, both of which want the same file:
* widening the audit reader so the operator can actually *see* the new `outcome_reverted` and
  `notes_edited` rows (today it is filtered to `action='cancelled'` and selects `details` alone).
  **A repair model whose audit trail the operator cannot see is not an operator tool** — but it is a
  B4c/B9 item, not a reason to hold 0173.
* the audit reader's missing `order by created_at desc limit 1` tie-break.

**B8 — hard-blocked on #517.** Do not start the postcare refactor until #517 is merged and the base branch
is green. Then, before touching anything: keep every `postcare_email_*` column **on `appointments` with its
current name**. Renaming or relocating one breaks `app/(app)/calendar/[id]/page.tsx:511-514` (1D-owned) and
`app/(app)/clients/[id]/sessions/[sessionId]/page.tsx:188-197` in the same stroke. Change the *writer*
only.

---

### 15.5 Shared-resource contention

These are not merge conflicts. They are two agents running against one machine.

| Resource | Contention | Rule |
|---|---|---|
| **The local Supabase stack** — one instance, `project_id = "Hone-0162"` (`supabase/config.toml:5`), API `127.0.0.1:54321`, DB `127.0.0.1:54322` | **Every worktree shares it.** `tests/db/helpers/harness.ts:31-65` pins `resolveLocalDbUrl()` to that one localhost DB and refuses any hosted host. Session 1D runs Playwright + seeds against the same database at the same time | **`supabase db reset` is the dangerous verb, not the tests.** Six of the nine boundary PRs require a reset (a migration must be proven from zero, §12 B3 test plan). A reset mid-flight destroys 1D's seeded Playwright state and produces a failure that looks like a code bug. **Announce every reset; never reset while a browser lane is running.** A failing lane in this setup is at least as likely to be shared-DB pollution as a real defect — check that first |
| **Playwright / the dev server on `localhost:3111`** (`e2e/helpers/local-env.ts:61`) | One port, one server. `npm run e2e:server` = `next build && next start -p 3111` | No boundary PR should run a browser lane while 1D is running one. And the standing local-lane hazard applies to both sessions: an orphaned `:3111` server is silently reused (so `next build` never runs) and the `.next` cache serves pre-edit modules — kill the port and clear `.next` before believing any browser result |
| **`scripts/browser-groups.mjs`** (1D-owned) + `tests/ci/browser-selection.test.ts` | Adding **any** e2e spec is a guaranteed textual conflict: the filename must be added to `BROWSER_GROUPS` (1D already added `point-of-care-memory.spec.ts` at `:50-57`) **and** the hard-coded counts at `tests/ci/browser-selection.test.ts:64-71` must be bumped — `expect(mapped).toHaveLength(55)` and `expect(specsForGroups(["calendar","sessions","smoke"])).toHaveLength(26)` — enforced by the "maps every spec on disk to exactly one group" assertion at `:15-21` | **No boundary PR adds an e2e spec before #517 merges.** Explicitly including 0172: the revoke needs no browser coverage, because its whole claim is that no browser path used the privilege. Defer any appointment e2e spec to B9 |
| **Migration numbers** | 1D's PR #517 is **code-only, migration max still 0171**, so it claims no number. `grep -rn "0172"` returns exactly one hit — a forward-looking comment at `tests/migrations/0171-public-reschedule-command.test.ts:42` | **No contention.** The boundary program owns 0172–0177 outright. Should 1D later need a migration, it takes the next free number *after* whatever the boundary program has merged, and moves the `isRepoMax` tripwire onto its own test |
| **`tests/db/helpers/harness.ts` and `lib/supabase/**`** | Either sets `full_matrix_required` (`scripts/classify-changes.mjs:29-31`), turning a small PR into a full-matrix CI run for both sessions | Prefer a local seed helper inside a new test file over extending the shared harness |
| **Commit identity** | Unrelated to 1D but fatal either way: commits must be authored `SaiSamyukthVemuri <samyukth.ssv@gmail.com>` or the Vercel check fails, and the base branch deploys to production (`hone.care`) | Applies to every PR in §12 |

---

### 15.6 Verdict, and the one thing to re-check

**Session 1D is not an obstacle to closing the P1.** Its eight files contain zero appointment mutations,
and its two appointment reads are preserved by construction — SELECT is never revoked, and the replacement
`FOR SELECT` policy reuses `is_studio_member(studio_id)` verbatim. Six of the nine boundary PRs, including
migration 0172 and the entire P1 closure, can be built and merged **in parallel with #517 with no
coordination beyond announcing local database resets**. One PR (B4) needs a 12-line mount deferred to a
trailing commit. One PR (B8) is genuinely blocked and belongs at the end of the sequence anyway.

**The re-check.** All of the above is derived from the **production** versions of 1D's files at
`03e7dea`; its own worktree was never opened, per the audit's hard rules. Before merging B3,
re-run three greps against the actual #517 head:

```
git -C <1D head> grep -n '\.from("appointments")'      # expect: reads only, no DML verb within 400 chars
git -C <1D head> grep -n '\.from("appointment_audit")' # expect: the single read at calendar/[id]/page.tsx
git -C <1D head> grep -n '\.rpc('                      # expect: nothing appointment-mutating
```

If #517 grew an appointment write while in draft, B1's census guard catches it the moment both branches
meet — which is the strongest argument for merging B1 **first**.

---

## 16. Reconciliation with the practitioner-attribution audit (PR #520)

Ingested input: `docs/audits/PRACTITIONER_ATTRIBUTION_INTEGRITY_2026-08.md` at PR #520 head
`5b50d3dcc50a75a7f58792b5ff5c273f46d6dc1b` (draft, documentation-only). PR #520 is **not** modified by
this audit and remains the owner of its own register.

The two audits ran in parallel from the same SHA and never met — PR #520 contains no reference to this
document, and §§1–15 above contain no reference to PR #520. This section is the merge. Its purpose is to
stop the same defect being counted twice, to carry across the parts of PR #520 that change what this
program must do, and to record where the two audits disagree.

### 16.1 Evidentiary status of the ingested findings

PR #520 is a **static, source-only** audit that ran zero database queries — the same limitation this
document declares in §2.2. Its findings are therefore **source-derived capability claims, not reproduced
facts**, and are carried here at that status. Nothing below is promoted to "verified in production"
merely by being restated. Every claim this section relies on was **re-opened against source in this
worktree** before being accepted; where re-verification changed the claim, §16.8 records it.

### 16.2 Finding merges — no double-counting

| PR #520 finding | This audit | Disposition |
|---|---|---|
| **`A-P1-02`** — "`public.appointments` is still outside the command boundary: any member can create, retime, reassign, cancel or delete an appointment with no actor and no audit row" | **`P1-1`** (direct DML makes the command layer optional) + **`P1-2`** (direct `DELETE` cascades the audit trail) | **MERGED into `P1-1` and `P1-2`.** Same root cause, same evidence (`0010:272-277`; no `GRANT`/`REVOKE` on the table in 170 migrations), same remediation (`revoke insert, update, delete … from authenticated`, `SELECT` retained). `A-P1-02` is **not** a separate finding and must not be counted as one. Its sub-claims `APC-001`, `APPT-001`, `APPT-012`, `APPT-013`, `RLS-001` are absorbed by `P1-1`/`P1-2` — `APPT-012` (DELETE cascades the audit) is exactly `P1-2`; `APPT-013` (`cancellation_token_hash` laundering) is an `UPDATE` on `public.appointments` and is closed by the same revoke, needing no separate treatment. |
| **`A-P1-03`** — "`appointment_audit` accepts browser-forged rows with an arbitrary actor, and it is the *only* record of who created, moved or cancelled an appointment" | **`P1-3`** (`appointment_audit` accepts forged rows: actor, action, `details` and `created_at` all caller-chosen) | **MERGED into `P1-3`.** `P1-3` is the stronger statement — it additionally establishes that `created_at` is caller-chosen. `A-P1-03` adds one thing `P1-3` should carry: the reason the forgery *matters* is that `public.appointments` has **no creator column at all** (`0010:174-190`) and `cancelled_by` is a role discriminator, so this audit row is the sole durable answer to "who did this". That justification is adopted; see `D4`/`D5` in §16.4. |

**Agreement worth stating explicitly**, because a reader comparing the two documents could mistake it for
a conflict: §2.2 above lists *"A studio member can UPDATE or DELETE existing `appointment_audit` rows"* as
a **rejected** claim. PR #520 reaches the identical conclusion — its `A-P1-03` says *"There is no `UPDATE`
or `DELETE` policy, so those are denied by default-deny — the forged row is permanent."* The two audits
**agree**: forged rows can be inserted and cannot afterwards be edited or removed, and the only erasure
path is the parent appointment's `ON DELETE CASCADE` (`P1-2`).

### 16.3 The cross-audit dependency neither audit could see on its own

This is the substantive result of the merge, and it is new to both documents.

PR #520's root finding **`A-P1-01`** — which this document does not cover — is that `public.practitioners`
has **no table-level `GRANT` or `REVOKE` in any of the 170 migrations**, and that its only write policies
are still the 0001 originals, whose `WITH CHECK` is `is_studio_owner(studio_id)` — a function of the
studio and the **caller's own** `auth.uid()`, so it pins the tenant and **no column**:

```sql
-- supabase/migrations/0001_init.sql:244-247
create policy "practitioners: owners update"
  on public.practitioners for update to authenticated
  using (public.is_studio_owner(studio_id))
  with check (public.is_studio_owner(studio_id));
```

Re-verified in this worktree. The consequence for **this** program is direct, and it is not addressed by
anything in §§11–14:

> **The `0172` revocation closes the appointment boundary. It does not secure attribution across it.**

The actor recorded by every appointment command survives the revoke unchanged, and every link in the
chain that produces it is downstream of a table a studio owner can rewrite:

| Step | Evidence |
|---|---|
| `auth.uid()` → practitioner row | `lib/supabase/queries.ts:71-72` — `.eq("user_id", userId).eq("active", true)` |
| practitioner row → the actor argument | `app/(app)/calendar/actions.ts:315` — `p_actor_practitioner_id: practitioner.id` |
| actor argument → the audit row, verbatim | `supabase/migrations/0152_actual_overlap_hard_buffer_soft.sql:515-517` — `insert into public.appointment_audit (…, actor_id, …) values (v_appt_id, 'practitioner', p_actor_practitioner_id, 'created', …)` |

The same dependency reaches `cancelled_by`, which §3 correctly describes as server-derived and
un-forgeable on the command path — it is read from the live practitioner row inside the command
(`0033:255-259`, written `0033:294` as `cancelled_by = v_role`). That derivation is only as trustworthy
as the row it reads.

So after `0172`, an owner who rewrites a colleague's `practitioners.user_id` acts through the commands —
with every lock, every gate, every validation and a correctly-written audit row — and the audit names the
colleague. **The boundary holds; the attribution across it is forged.** `is_studio_member` and
`is_studio_owner` (`0001:153-166`, `:169-183`) read the same table, so the membership predicate that the
retained `SELECT` policy and every command depend on is subject to the same rewrite.

**Requirement on this program.** `A-P1-01` is **not** in the appointment DML scope and must not be
absorbed into it — it is a `public.practitioners` boundary, closed by PR #520's own `PR-A1`. But it is a
**stated dependency of this program's claimed outcome**. §12 and §13 must not assert that `0172`
establishes trustworthy appointment attribution; the honest claim is that `0172` establishes a
*boundary*, and that attribution across it becomes trustworthy only once `PR-A1` lands. Recommended
handling: name `PR-A1` as a **co-requisite** of `B3` in the rollout record — not a blocker (the revoke is
independently valuable and independently reversible), but a condition on the outcome claim.

### 16.4 PR #520 §8 `D1`–`D7` consumed as requirements

Each is accepted, rejected or amended against source, and mapped onto the `B1`–`B9` sequence.

| Req | PR #520's requirement | Verdict | Where it lands |
|---|---|---|---|
| **`D1`** | Revoke `insert, update, delete, truncate` on `public.appointments` from `anon, authenticated`; retain `SELECT`; replace `appointments_member_all` with a `SELECT`-only member policy | **ACCEPTED, with one amendment.** `TRUNCATE` is correctly included as hygiene but is **not** browser-reachable — PostgREST does not expose it — so it must not be presented as part of the P1 closure | **`B3`** (`0172`), already scoped |
| **`D2`** | Revoke DML on `appointment_audit`; drop the vestigial member `INSERT` policy; add a composite `actor_practitioner_id`; change the parent FK from `CASCADE` to `RESTRICT` | **ACCEPTED — and it is already this program's `B3` + `B5`,** independently derived. `B3` revokes; `B5` adds `studio_id`, re-points the FK and makes the table append-only. PR #520 adds the `actor_practitioner_id` **composite same-studio FK with `ON DELETE RESTRICT`**, which `B5` should adopt: `actor_id` today is a bare `uuid` with no FK (`0010:221`) | **`B3`** + **`B5`** (`0174`) |
| **`D3`** | Make `booked_outside_availability` write-once-by-command via a `BEFORE INSERT OR UPDATE` trigger refusing a `true` value from a non-definer writer; persist the authorising actor and their role | **PARTLY REDUNDANT, PARTLY ACCEPTED.** The forge-the-flag path is closed by `D1`/`B3` outright, so the trigger is defence-in-depth, not a requirement. The *second* half — persisting **who** authorised the override and their role at the time — is **not** covered anywhere in this document and is a genuine gap. §12 already names `P2-1` and `P2-13` as override defects; add the actor to that work | override actor → **`B5`**; the trigger → optional, **`B6`** |
| **`D4`** | Add `created_by_practitioner_id` (composite same-studio FK, `ON DELETE RESTRICT`) to `public.appointments`, written by `create_internal_appointment_v2` / `create_public_appointment` (null + `actor_type='client'` for public bookings) | **ACCEPTED — and this is the single largest gap PR #520 contributes.** Re-verified: `public.appointments` (`0010:174-190`) has **no creator column**, and no later `ALTER TABLE … ADD COLUMN` adds one. Today the creator exists **only** in an `appointment_audit` row that `P1-2` shows is `CASCADE`-deletable and `P1-3` shows is forgeable | **new additive migration, phase 2** (see §16.6) |
| **`D5`** | Add `cancelled_by_practitioner_id` alongside the existing role discriminator; keep the role word | **ACCEPTED, with a correction to its premise.** PR #520 implies `cancelled_by` is weak attribution generally; §3 and `0033:255-259` show the role is **server-derived from the live practitioner row and is not browser-supplied on the command path**. The real defect is narrower and still real: *which* practitioner cancelled is recorded nowhere on the row. Keep the role word — it correctly distinguishes client- from practitioner-initiated | **same additive migration, phase 2** |
| **`D6`** | Decide: converge the appointment commands on actor-derived Style A, or retain service-role Style B with an explicit reviewed actor-verification model | **DECIDED — see §16.5.** PR #520 §10.3 recommends a blanket move to Style A. That recommendation is **partly impossible** for this command family | **§16.5**; implementation in **`B4`**/**`B6`** |
| **`D7`** | `cancellation_token_hash` is member-writable — covered automatically by `D1`'s revoke | **ACCEPTED, no separate work.** Confirmed: it is an `UPDATE` on `public.appointments` | **`B3`** |

**What `D1`–`D7` do not cover, and this program still must.** The merge does not shrink this document's
scope. `P1-2`'s policy-acknowledgement cascade (`0056:33-34`), the seven postcare direct writers (`B8`),
the `/cancel` acknowledgement atomicity fix (`B7`), the status-transition guard (`B6`), the legacy
`reschedule_appointment` retirement, and the residual sibling-table exposure below are all outside
`D1`–`D7`.

**Residual scope PR #520 did not see.** Independently verified in this worktree: **zero** table-level
`GRANT`/`REVOKE` statements exist for `studio_timed_blocks`, `studio_blockouts`,
`studio_calendar_reservations`, `studio_availability_default`, `studio_recurring_break_rules`,
`service_practitioners` or `appointment_policy_acknowledgements`. Revoking only `appointments` +
`appointment_audit` leaves the surrounding scheduling surface directly writable by any member — including
`studio_calendar_reservations`, the shadow table whose unconditional GiST exclusion (`0134:238-243`) is
the collision guarantee this audit relies on in §8 and in `P1-1`'s "what genuinely holds". That is
`F-SCHED-001` and it belongs in this program's backlog (`B9`), explicitly scoped as *not* closed by
`0172`.

### 16.5 `D6` decision — a split, not a convergence

**PR #520 §10.3 recommends converging every command family on Style A** (`authenticated` EXECUTE, actor
derived from `auth.uid()` inside the function, `anon` + `service_role` revoked — the 0164–0168 clinical
shape). For the appointment family that recommendation is **half impossible**, and the reason is
structural rather than a matter of effort.

Caller context, established by reading every call site in this worktree:

| Command | Call site | Caller identity | Style A possible? |
|---|---|---|---|
| `create_internal_appointment_v2` | `app/(app)/calendar/actions.ts:312` | authenticated practitioner (`getCurrentPractitionerWithStudio()` at `:158`) | **YES** |
| `move_or_reassign_appointment` | `app/(app)/calendar/move-appointment-actions.ts:352` | authenticated practitioner (`:249`) | **YES** |
| `mark_appointment_complete` | `app/(app)/calendar/actions.ts:550` and `app/(app)/clients/[id]/sessions/new/actions.ts:49` | authenticated practitioner (`:543`, `:10`) | **YES** |
| `practitioner_cancel_appointment` | `app/(app)/calendar/actions.ts:432` | authenticated practitioner | **YES** |
| `create_public_appointment` | `app/book/[slug]/actions.ts:776` | **anonymous** — public booking form | **NO** |
| `reschedule_appointment_v2` | `app/reschedule/[token]/actions.ts:774` | **token bearer** — no `auth.uid()` | **NO** |
| `public_cancel_appointment_with_token` | `app/cancel/[token]/actions.ts:253` | **anonymous** — token bearer | **NO** |

For the three public commands `auth.uid()` is **structurally null**. Style A cannot express their actor,
because the actor is not an authenticated user — it is the holder of a signed token. No amount of
refactoring changes that.

**Decision: split the family.**

* **Internal commands → Style A.** Grant `EXECUTE` to `authenticated`, revoke from `anon` **and**
  `service_role` by name, delete the `p_actor_practitioner_id` parameter, and derive the actor inside the
  function exactly as `session_actor_practitioner()` does (`0167:78-99`), raising when `auth.uid()` is
  null.

  **This is behaviour-preserving.** Every `p_actor_practitioner_id` call site in the repository passes
  `practitioner.id` from `getCurrentPractitionerWithStudio()` — verified across all eleven occurrences in
  `app/`; not one passes a different actor. The derived value would be identical to the value passed
  today. What changes is *who guarantees it*: an app-layer convention becomes a database invariant.

* **Public commands → Style B retained, with an explicit reviewed actor model.** Keep `service_role`-only
  `EXECUTE`. The token **is** the identity, so the requirement is that the token's subject be recorded
  rather than discarded. Today these paths write `actor_id` NULL. `appointment_audit.actor_type` already
  declares `'client'` and `'system'` (`0010:220`) and `'system'` is never written by any of the ~30
  insert sites. The model to adopt: `actor_type='client'` with a durable reference to the token subject
  (the appointment's `client_id`, plus the token hash already stored on the row), and `actor_type='system'`
  with a process identifier for cron and webhook writers.

**The strongest argument against the split**, stated so it is not lost: two styles in one command family
is exactly the inconsistency PR #520 §1 criticises, and a future maintainer may copy the wrong one. The
mitigation is that the split is not arbitrary — it tracks a real, checkable property (does an
authenticated user exist?), and it should be enforced by a test asserting that no `authenticated`-EXECUTE
appointment command accepts an actor parameter, and that no public command is reachable by
`authenticated`.

**What Style A does not fix.** It closes the case where the *application layer* passes a wrong actor — a
refactor, a bug, a compromised server action. It does **not** close `A-P1-01`: derivation reads
`practitioners.user_id`, so an owner who rewrites that column is resolved as someone else by the database
itself. Style A moves the trust from the app to the database and then rests it entirely on
`public.practitioners`. That is a strict improvement, and it is also precisely why §16.3 names `PR-A1` a
co-requisite.

### 16.6 Revised sequence — application-first

The sequence in §12 is correct in structure and ships the revocation **third** (`B3`, `0172`), arguing
that it is a zero-application-change migration and therefore the fastest P1 closure available. That
argument is sound on boundary grounds and this section does not retract it.

The merge changes the ordering on **attribution** grounds. `D4` and `D5` establish that at `03e7dea` the
commands do not yet record an appointment's creator or its cancelling practitioner. Revoking first would
freeze a boundary around commands that still do not record who acted — closing the door while the ledger
is still incomplete. The additive columns are cheap, carry no revocation risk, and are the thing that
makes the post-revoke record worth having.

The program is therefore re-phased into four gates. **PR identities and content from §12 are unchanged**;
only the order and the migration slots move.

| Gate | Content | PRs | Migration |
|---|---|---|---|
| **1 — commands and legitimate writers** | The static direct-DML census guard that freezes the seven known writers; behavioural coverage of the lifecycle commands; retirement of the last direct writers | `B1`, `B2`, and `B8` where PR #517 permits | none |
| **2 — additive attribution** | `appointments.created_by_practitioner_id` (`D4`) and `cancelled_by_practitioner_id` (`D5`), composite same-studio FK + `ON DELETE RESTRICT`, written by the commands and backfilled from `appointment_audit` where an actor row survives; `appointment_audit.actor_practitioner_id` + `studio_id` (`D2`); the override actor (`D3`) | `B5`, extended | **`0172`** |
| **3 — behaviour verification** | Prove the commands carry the traffic **before** removing the alternative. Not an ACL check — a behavioural probe, per this repository's own L18 lesson that a revocation verified by ACL was never behaviourally probed | `B2` completion + §13.2 operator probe | none |
| **4 — revocation** | `revoke insert, update, delete, truncate on public.appointments, public.appointment_audit from anon, authenticated`; `SELECT` retained; `appointments_member_all` replaced with a `SELECT`-only member policy | `B3` | next free after gate 2 |

**`0172` is preserved for this series and is claimed by gate 2**, the first migration the program ships.
Subsequent numbers must be taken from `npm run migration:state` at cut time and never hard-coded
(`CLAUDE.md` §2). This audit creates no migration.

**The cost of this ordering, stated plainly.** `P1-1` and `P1-2` stay open for one extra migration cycle
versus §12's ordering. That is a real cost and the owner should accept it deliberately. Two mitigations:
gate 2 is a small additive migration with no application change beyond the command bodies, so the delay is
short; and the exposure is bounded exactly as `P1-1` documents — no `anon` path, no cross-tenant write, no
double-booking, and no ability to edit or delete existing audit rows. If the owner prefers the faster
closure, §12's original ordering remains defensible and the only thing lost is that the first
post-revoke appointments still carry no creator column.

### 16.7 Negative tests added by the merge

§14 already specifies the behavioural probes for direct `INSERT`/`UPDATE`/`DELETE` and the
`has_table_privilege` pins. The merge adds the following; all are `npm run test:db`
(`vitest.db.config.ts:19-26`), and **each must assert a positive control in the same test** — a suite that
only asserts rejection passes equally well when the table does not exist. The repository trap that an
`asRole()` helper which always rolls back never exercises the policy applies to every case below.

| # | `asRole('authenticated')` as | Attempt | Assert | Positive control | Covers |
|---|---|---|---|---|---|
| `R1` | active member | `INSERT` into `public.appointments` in the caller's **own** studio, `booked_outside_availability: true` | refused (`42501`) | the same insert via `create_internal_appointment_v2` succeeds | `P1-1`, `A-P1-02`, `D1` |
| `R2` | active member | `UPDATE public.appointments SET status='completed'` on a **future** appointment | refused | `mark_appointment_complete` succeeds on a past one and refuses the future one | `P1-1`, `D1` |
| `R3` | active member | `DELETE FROM public.appointments` where the row has audit rows | refused | after the FK tightening, deleting via any path leaves `appointment_audit` intact | `P1-1`, `P1-2`, `D2` |
| `R4` | active member | `INSERT` into `public.appointment_audit` naming a **colleague** as `actor_id`, with a chosen `created_at` | refused | the command-written audit row exists with the caller as actor and a server `created_at` | `P1-3`, `A-P1-03`, `D2` |
| `R5` | active member | `UPDATE`/`DELETE` an existing `appointment_audit` row | refused **today** (default-deny) — pin it so a future permissive policy cannot silently open it | a `SELECT` of the same row succeeds | `P1-3`, agreement in §16.2 |
| `R6` | member of studios A **and** B | `UPDATE` moving `studio_id` + `client_id` + `service_id` + `practitioner_id` together | refused | a legitimate same-studio move succeeds | `P1-1` tenancy caveat (raw `F-DB-09`) |
| `R7` | — | create an appointment through each internal command after the `D6` Style-A conversion | `created_by_practitioner_id` is non-null and equals the **derived** actor, not any passed parameter | the public commands still create with `created_by_practitioner_id` null and `actor_type='client'` | `D4`, `D6` |
| `R8` | — | cancel through `practitioner_cancel_appointment` | `cancelled_by_practitioner_id` is the caller and `cancelled_by` is their live role | a client-token cancellation sets `cancelled_by='client'` and leaves the practitioner column null | `D5` |

`R7` and `R8` cannot be written until gate 2 ships; `R1`–`R6` are writable today and `R1`–`R4` **fail
today**, which is the point.

### 16.8 Disagreements between the two audits, resolved on source

| # | Disagreement | Resolution | Impact |
|---|---|---|---|
| 1 | **The writer census.** PR #520's `A-P1-02` closure hedges — *"there is none in `app/` or `lib/` today"* — and its own verifier corrected it to note live service-role writers. This document states the census exactly | **This document is correct and more precise.** Independently re-derived here across 26 files: **48 `SELECT`, 7 `UPDATE`, 0 `INSERT`, 0 `DELETE`** on `public.appointments`, and **all 7 `UPDATE`s run on the service-role client** (`app/(app)/calendar/actions.ts:1115,1156,1212,1243`; `app/(app)/calendar/postcare-auto-send.ts:152,187,201`). Zero appointment writes use the authenticated client | Strengthens both: the revoke is a **zero-application-change** migration. No change to either remediation |
| 2 | **Style A convergence.** PR #520 §10.3 recommends every command family converge on actor-derived Style A | **PR #520 is wrong for this family.** Three of the seven appointment commands have no authenticated caller — `create_public_appointment` (anonymous), `reschedule_appointment_v2` (token), `public_cancel_appointment_with_token` (anonymous). `auth.uid()` is structurally null; Style A cannot express their actor | Changes the `D6` decision from *converge* to *split* — §16.5 |
| 3 | **`appointment_audit` mutability.** §2.2 lists "a member can `UPDATE`/`DELETE` audit rows" as a **rejected** claim; PR #520 `A-P1-03` states the rows are permanent | **No disagreement — both are right.** RLS default-denies `UPDATE`/`DELETE` (only `SELECT` and `INSERT` policies exist, `0010:280`, `:291`). Recorded here only because the two documents' phrasings could be misread as conflicting | None. New test `R5` pins it |
| 4 | **`cancelled_by` semantics.** PR #520 `D5` treats `cancelled_by` as weak attribution | **This document is more precise.** `cancelled_by` is read server-side from the live practitioner row inside the command (`0033:255-259`) and written as `v_role` (`0033:294`) — it is **not** browser-supplied on the command path. The genuine defect is narrower: *which* practitioner is unrecorded | `D5` is accepted with its premise corrected; the remediation is unchanged |
| 5 | **Sequencing.** §12 ships the revocation third; PR #520 §8 and the reconciliation brief require additive attribution before revocation | **Resolved in favour of application-first (§16.6)**, on the ground that `D4`/`D5` show the commands do not yet record the creator, so revoking first freezes an incomplete ledger. §12's argument for speed is recorded, not discarded, and the cost of the delay is stated | Re-phases the program; `0172` moves to the additive migration |
| 6 | **Scope of `A-P1-01`.** PR #520 treats `public.practitioners` as an independent finding; this program could be read as closing appointment attribution without it | **Both scopings are right; the dependency was invisible to each audit alone.** `A-P1-01` stays in PR #520's queue as `PR-A1`. This document must stop short of claiming `0172` establishes trustworthy attribution — §16.3 | Adds `PR-A1` as a **co-requisite** of `B3`, not a blocker |

**No finding in either audit was refuted by the other.** The disagreements are of precision, scope and
sequencing. The only substantive reversal is #2 — PR #520's Style-A recommendation, which this
reconciliation replaces with the split in §16.5 on structural evidence.

---

## 17. Exact next implementation prompt

Two things can start immediately and independently.

**(a) An operator action, not an agent task.** Before PR **B3** (migration `0172`) can be scheduled, one read-only production query must be run through the approved channel to settle the single open sequencing question in §12.5 — whether the revocation ships before or after the repair commands. It is specified in §13.2. Nobody should argue about that ordering; it is a measurement.

**(b) The next implementation session.** PR **B1**. It has no dependencies, no migration, no production surface, and it freezes the seven known direct writers before any SQL in this program is edited. The prompt below is complete and ready to use.

---

### Prompt for the next session — PR B1

```text
# Hone Appointment Boundary PR B1 — direct-DML census guard + unit-test repairs

This is the first implementation PR of the appointment DML boundary program defined in
docs/audits/APPOINTMENT_DML_BOUNDARY_2026-08.md (audit branch audit/appointment-dml-boundary,
draft PR opened, not merged). Read that document's sections 3, 12 (PR B1) and 14 before
writing any code.

## Exact repository state

Repository:  SaiSamyukthVemuri/Hone
Production branch: claude/build-hone-saas-hOex7
Start from production HEAD at the time you begin — fetch and verify, do not assume
03e7deaa38a7646a1f19a3d883c0a2b07894cec0 is still head.

Required branch:   feat/appointment-direct-dml-census-guard
Required worktree: ~/Hone-DML-B1

This PR is TEST-ONLY. It adds no migration, changes no application code, and changes no
schema. Migration 0172 belongs to PR B3 and MUST NOT be created here.

## Parallel-work restrictions

Chloe Session 1D is active in ~/Hone-1D (draft PR #517). It owns:
  app/(app)/calendar/[id]/page.tsx, lib/sessions/charted-session.ts,
  lib/sessions/last-treatment-loader.ts, lib/sessions/point-of-care-memory.ts,
  appointment-prep components and tests, scripts/browser-groups.mjs,
  the local Supabase stack and the Playwright ports.
Do not edit any of those, and do not open that worktree. This PR adds NO e2e spec —
adding one would force edits to scripts/browser-groups.mjs and to the hard-coded counts
at tests/ci/browser-selection.test.ts:64-71, which is a guaranteed conflict with #517.

Do not run: supabase db reset, DB integration suites, Playwright, browser matrices,
fake Stripe or fake Google lanes, or broad process-killing commands.

## What to build

### 1. tests/security/appointment-direct-dml-guard.test.ts (new)

A static census guard for public.appointments and public.appointment_audit, implementing
T2.1–T2.7 from section 14 of the audit.

Build it on tests/security/helpers/supabase-write-census.ts — use supabaseWriteSites()
(the TypeScript-compiler-API census, at :365). Do NOT copy the bracket-walking
directWriteSites() that is local to tests/security/entry-direct-dml-guard.test.ts:96-131;
it is strictly weaker and will miss multi-line and aliased chains.

Scan app/, lib/, components/, scripts/ and middleware.ts.

The ALLOWED list is exactly seven sites, and no more:
  app/(app)/calendar/actions.ts          — the .from("appointments") at 1115, 1156, 1212, 1243
  app/(app)/calendar/postcare-auto-send.ts — the .from("appointments") at 152, 187, 201
(Line numbers WILL drift. Anchor on file + enclosing function name, and assert the count.)

Assertions:
  T2.1  every appointments write site is in ALLOWED
  T2.2  every allowed site's written columns are a subset of the postcare_email_* set.
        This is the load-bearing assertion: it fails the moment a payload grows
        status, starts_at, ends_at, practitioner_id, studio_id or client_id.
  T2.3  appointment_audit write sites must be EMPTY
  T2.4  no site writes appointments through a dynamically-computed table name
  T2.5  NEGATIVE CONTROL — expect(found).toHaveLength(7) with an explicit failure
        message, copying the shape at entry-direct-dml-guard.test.ts:629-641.
        Without this a broken analyzer produces a green suite. This codebase has
        shipped that exact vacuous pass four times; do not make it five.
  T2.6/T2.7  receiver proof — every allowed site's client must originate from
        createAdminClient(), via clientFactoryProof() / insertReceiverProof().
        NOTE this is the INVERSE of the clinical guard: there an admin receiver is
        the failure, here it is the requirement.

### 2. Repair tests/app/calendar/postcare-auto-send.test.ts:44-69

The fake at :50 is `b.from = () => b` — it discards the table name. At :63
`b.eq = () => b` discards every filter, including .eq("studio_id", …). This is the
only unit coverage for three of the seven writers and it currently cannot detect a
write to the WRONG TABLE or a DROPPED TENANT FILTER.

Record the arguments and assert the write targeted "appointments" and carried
("studio_id", studio.id). Prove the repair by mutating the source under test to the
wrong table, confirming red, then reverting.

### 3. Repair tests/security/service-role-allowlist.ts:38

Its `why` still claims the move "goes only through practitioner_move_appointment
(service_role-only)". That is stale: app/(app)/calendar/move-appointment-actions.ts:352
calls move_or_reassign_appointment, and tests/app/calendar/move-reassign-source.test.ts:16
positively asserts the old RPC is absent.

Correct the justification, then add the audit's P3-06 hardening: for allowlist entries
whose file performs appointment DML, scopeGuard must be a DISTINGUISHING token — an
.eq("studio_id", …) literal or the specific RPC name — not the generic
getCurrentPractitionerWithStudio that appears in nearly every authenticated action.

## Test plan

Run the FULL unit suite (npm run test:unit), not a scoped selection. Migration-max and
docs pins live in BOTH tests/docs/ and tests/migrations/, and a scoped run has hidden
breakage in this repo before.

Deliberate red runs, both required, both reverted before commit:
  1. Add an eighth .from("appointments").update(...) to a scratch file under lib/.
     The guard must fail. Remove it.
  2. Rename "appointments" to "appointmentz" in the guard's TABLES. T2.5's negative
     control must fail. This proves the census is finding the seven rather than
     vacuously finding none.

Report both red runs in the PR body with their output. A guard whose failure mode was
never observed is not a guard.

## Constraints

* Commits must be authored SaiSamyukthVemuri <samyukth.ssv@gmail.com> or the Vercel
  check fails.
* No migration. No application-code change. No e2e spec. No schema change.
* Do not modify the two DB tests that pin the open grant posture
  (tests/db/public-appointment-command.db.test.ts:475-489 and
  tests/db/public-reschedule-command.db.test.ts:1430-1443) — inverting them belongs to
  B3, in the same commit as migration 0172, and inverting them early takes CI red.
* Open a DRAFT PR. Do not merge, do not deploy, do not push any migration.

End with a PR body that states plainly: what the guard now proves, what it does NOT
prove (it is static — it cannot detect a write issued by a browser holding a JWT, which
is what B3's revocation closes), and the two deliberate red runs with their output.
```

---

### What comes after

`B2` (behavioural coverage for the three untested lifecycle commands) is parallel-safe with `B1` and needs no migration. `B3` — migration `0172`, the actual P1 closure — is gated on `B1`, `B2` and the operator probe in §13.2, and needs explicit approval to push. Nothing in this program may be pushed to production without it.
