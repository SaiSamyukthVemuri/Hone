# Studio readiness (#824): contract, capability matrix and dependency map

**Status: preparation only.** Issue #824 authorizes preparation, isolated
implementation, tests and draft PRs. These all remain separate decisions:
- production merges;
- hosted migrations;
- feature activation;
- live provider configuration;
- invitations and customer messages.

**Baseline.** Production `claude/build-hone-saas-hOex7` at `6c5eac80`.
- Repository and hosted migrations are both at `0210`, with nothing pending (`npm run migration:state`, 2026-10-11).
- No open PR, remote branch or worktree on this host carries a migration above `0210`. This is from a census taken when this branch was cut; re-run it before writing any migration.

The three capabilities are independent at the product level. They are **not**
independent in the code: they share the scheduling commands, the membership
helper and the payment tables. Section 4 orders them for that reason.

---

## 1. Five-plus-practitioner operation: reuse, prove, fill gaps

### 1.1 What exists (source, not history)

| Concern | Where | Notes |
|---|---|---|
| Collision model | `0134` | `resource_key` per practitioner on capacity-ON studios. Studio-wide blocks fan out to every practitioner, and one GiST exclusion covers all four collision rules (`docs/roadmap/PRACTITIONER_CAPACITY_ARCHITECTURE.md`). |
| Flags | `0134`, `0136` | `practitioner_capacity_enabled` is the structure. `practitioner_capacity_booking_enabled` gates the **internal** commands only: on a structure-ON studio with it OFF, `create_internal_appointment_v2` and `move_or_reassign_appointment` return `booking_paused` (`0174`). `create_public_appointment` (`0170`) never reads it, so it is **not** a public-intake switch (§1.4). A CHECK forbids booking ON while structure is OFF. Both are operator-only: browser writes raise `42501`. |
| Per-practitioner availability, scoped blocks and breaks | `0135`, `0137`–`0139`, `0149` | `save_weekly_availability(studio, scope, days)`. A scoped source on a capacity-OFF studio is retained but **dormant**. |
| Service eligibility | `0134` (`service_practitioners`) | Default trigger: every **active** practitioner becomes eligible for a new service. |
| Internal booking | `create_internal_appointment_v2` (`0146` → `0152` → `0174`) | The actor must be an active member. A non-owner may book only themselves, with no duration or outside-hours override. |
| Move and reassign | `move_or_reassign_appointment` (`0143`–`0148` → `0152` → `0174`) | A non-owner may move only their own appointment and may not reassign. Stale snapshots return `stale_appointment`. |
| Cancel | `practitioner_cancel_appointment` (`0033` → `0174`) | The actor must be an active member of the studio. |
| Public booking | `create_public_appointment` (`0170`, slots `0209`) | **Studio-wide only.** It assigns the studio's single active owner, or `NULL` when there are zero or several owners (`0170` lines 790–828). The public slot loader always builds capacity-OFF slots and passes no practitioner (`lib/booking/slots.ts`). |

**Existing proof.** Each of these suites runs on synthetic studios of three or
fewer practitioners in a UTC timezone:
- the capacity suites: `practitioner-capacity`, `practitioner-capacity-state`, `practitioner-availability` and `scoped-blocks-breaks`;
- the booking suites: `internal-booking-command`, `move-reassign-appointment`, `move-preserve-target-race`, `reassignment-integrity`, `schedule-lock-order`, `public-booking-concurrency` and `cross-studio-isolation`;
- the integrated journey, `integrated-onboarding-capacity-journey`, which turns all three flags ON.

**Hosted state.** This is a read-only census from 2026-10-11, quoted in #824:
- capacity is ON for one studio;
- public practitioner booking is ON for zero studios.

None of that is customer acceptance.

### 1.2 The proof this package adds

`tests/db/five-plus-practitioner-acceptance.db.test.ts` sets up one synthetic
studio:
- `America/Los_Angeles`;
- an owner and five treating practitioners, plus an inactive sixth;
- capacity and booking both ON.

It drives only the authoritative commands named above. The mapping from the
#824 checklist to its tests is in §1.3; an item that has no command is
recorded as a gap, not as a pass.

### 1.3 Checklist → proof or gap

Results are from the isolated local stack (`hone-studio-824`) at production
`6c5eac80`, with migrations `0001`–`0210`:
- the **existing full DB suite passes first**: 176 files and 3,534 tests;
- the five-plus file then passes **31/31** on three consecutive runs, leaving no synthetic studio behind;
- the recovery-procedure file (§1.4) passes **10/10** on three consecutive runs, also leaving none behind. The admission suite it cites passes 20/20 on the same stack.

| #824 requirement | Proof (test id) | Result |
|---|---|---|
| Different eligible practitioners treat simultaneously | A: all six treating members are booked concurrently at one LA instant, each on its own `resource_key` | ✅ |
| Same practitioner cannot double-book, including buffers and concurrent writes | B1: overlap `23P01`. B2: the buffer is per practitioner (`buffer_conflict`). B3: two concurrent writes give exactly one row. B4: the owner override never bypasses a real overlap. | ✅ |
| Per-practitioner availability, breaks, eligibility, assignment, move, cancel, deactivation | C1–C3, D1–D2, E1, F1–F5, F7 | ✅ |
| Studio-wide closures hit every resource; practitioner closures hit only theirs | E1 (scoped), E2 (fan-out to every member, the inactive one included), E3, E4 (full-day blockout, owner override included) | ✅ |
| Public practitioner or any-available booking with authoritative assignment | K pins today's behaviour | ❌ **GAP G1** (below) |
| Explicit owner and practitioner permissions; same-studio and cross-studio negatives | G1–G4, C3, F3, D2 | ✅ (one rule flagged: **F6**) |
| LA date boundaries and DST; Canadian behaviour unchanged | H1: both 2031 US DST days. H2: UTC-midnight crossing. H3: Toronto EST/EDT, capacity OFF, still studio-wide. | ✅ |
| Failed or stale operations leave no partial appointment or reservation | J: nine refused operations change zero appointment, reservation or audit rows | ✅ |
| A per-studio activation and recovery plan whose steps the real commands support (§1.4) | `capacity-recovery-procedure.db.test.ts` §1–§3. The `closed` refusals and the unstamped cutover are from `new-client-admission-commit-authority.db.test.ts` §1B–§3B and its UNSTAMPED block. | ✅ procedure; ❌ **GAP R1** (no dedicated pause; client self-reschedule continues) |

**F6, a permission rule for decision.** A non-owner may create or move only
their **own** booking. `practitioner_cancel_appointment` (`0174`) and the
calendar cancel action, however, let **any** active member cancel **any**
future confirmed booking in the studio. Both layers agree, so this is a
deliberate-looking rule, not a leak. At five-plus practitioners, and with a
receptionist coming, it should be decided explicitly: keep it, or narrow
non-owners to their own bookings. F6 pins today's rule, so a change has to be
deliberate.

**GAP G1: public practitioner selection and "any available" assignment do not
exist.** `create_public_appointment` takes no practitioner and assigns the
single active owner, or `NULL`. On a capacity-ON studio, a `NULL` confirmed
booking violates `appointments_capacity_requires_practitioner` (`0134`). So a
public booking either lands on the owner's resource or fails. The July
architecture note planned this as "PR C" (fair rule: *eligible + available →
lowest booked minutes → oldest last assignment → stable id*), and it was never
built. It is a **bounded follow-up PR**. It touches shared scheduling and the
public booking surface, so it needs WAIT coordination (§5). Until it ships,
public bookings on a capacity studio land on the owner's resource, and no flag
changes that: the public command never reads
`practitioner_capacity_booking_enabled` (§1.4).

### 1.4 Per-studio activation and recovery plan

These steps are an operator plan, run under separate per-studio authorization.
Nothing here is automatic.

1. **Preflight (read-only).** The studio has:
   - no confirmed or completed appointment with `NULL practitioner_id`;
   - every treating practitioner active, with weekly availability saved;
   - service eligibility reviewed (the default makes every active practitioner eligible).
2. **Structure ON** (`practitioner_capacity_enabled = true`) through the operator path. `rematerialize_studio_reservations` re-keys every reservation inside one transaction. Verify with `scripts/verify-practitioner-capacity.mjs`, which checks:
   - zero orphan reservations;
   - every appointment's `resource_key` equals its practitioner;
   - studio-wide blocks fanned out to every practitioner.
3. **Booking ON** (`practitioner_capacity_booking_enabled = true`) in the same operator window as step 2. While structure is ON and booking is OFF, staff cannot create or move appointments: both internal commands return `booking_paused` (`0174`). Booking ON does **not** open practitioner-aware public booking. Public bookings keep landing on the single active owner until G1 ships, whatever this flag says.
4. **Recovery.** Turning structure OFF is **not** an instant rollback once parallel appointments exist (`known-limitations.md` L7). It would re-key them into one studio bucket, where they overlap. `retire_practitioner_capacity` (`0136`, `0138`) therefore refuses while any two participating appointments overlap **in time** anywhere in the studio, whichever practitioners they belong to (`0138`:294–302). The booking flag is **not** an intake pause either: the public command never reads it, and turning it OFF pauses the moves that recovery needs. Every step below is run against the real commands in `tests/db/capacity-recovery-procedure.db.test.ts` (§1–§3) unless another test is named.
   1. **Pause new clients with `closed`.**
      - The owner sets it in Settings → Booking (`set_new_client_admission_mode`, owner only, `0204`).
      - The database then refuses every new-client booking, an invited one included, and every new waitlist join (`assert_new_client_admission`). The refusals are proven in `new-client-admission-commit-authority.db.test.ts` §1B, §2B and §3B; in §3B a *valid* invitation is refused and nothing is spent.
      - `waitlist` is **not** a pause: it still admits a valid scoped invitation (`app/book/[slug]/actions.ts`:614–646).
      - If the studio's mode is unstamped (`new_client_admission_mode_set_at` is null), `closed` returns `legacy_waitlist_cutover_required` and writes nothing. Set `waitlist` first, which stamps it, then `closed` (the same file's UNSTAMPED block).
      - It governs **public** admission only. Staff can still add a client and book them in the app (`create_internal_appointment_v2` reads no admission mode).
      - **Returning clients are unaffected.** A booker on the existing-client path whose email matches an active client still books, reschedules and cancels through their own links (§1; `0170`, `0171` and `0176` read no admission mode). They can also rebook from the portal, which has no admission gate by design (`app/portal/rebook-actions.ts`:92–97). An unmatched email on the existing-client path is refused (`actions.ts`:964–967), so it is no way around `closed`.
   2. **If needed, freeze all new bookings by hiding every active service** (Settings → Services, owner only).
      - **Stops** everything that creates through `create_public_appointment`: the public page, portal rebook and invited bookings all get `public_booking_unavailable` (`0170`:690–710). An invited booking is refused before its invitation is spent: the active-service read (`actions.ts`:727–733) runs before consumption (`:841`–`869`). Staff cannot create appointments either (`invalid_service`, `0174`).
      - **Does not stop** staff moves, reassignments or cancellations; completion and no-show marking; or payments, refunds and charting on existing appointments (`lib/billing` reads no `services.active`).
      - **Does not stop a client's self-reschedule** through an existing link. `reschedule_appointment_v2` (`0171`) reads neither `services.active`, the admission mode nor the booking flag, so a reschedule can create a new overlap (§2).
      - **While frozen**, staff service pickers and the readiness panels show no bookable service.
      - **To restore**, record the menu order first and show the services again in that order, because each service shown goes to the bottom (`show_studio_service`, `0161`; §2). Then reopen admission.
      - **GAP R1: no dedicated public-booking pause exists, and nothing pauses client self-reschedule.**
   3. **Remove each overlap in time, with booking still ON.**
      - A **future** appointment can be moved to a time that does not overlap (by the owner, or by a practitioner for their own), or cancelled.
      - Once an appointment has **started**, both refuse (`appointment_not_movable`, `not_cancelable`), so close its lifecycle instead:
        - `mark_appointment_no_show`, once it has ended, stops it participating at once;
        - `mark_appointment_complete`, once it has started, stops it only when its blocked end has passed (`appointment_participates_in_capacity`, `0136`).
      - Reassignment alone never clears an overlap.
      - A past appointment left `confirmed` blocks indefinitely, because the no-show cron does not mutate anything (`app/api/cron/no-show-check/route.ts`; §3).
   4. **Then turn booking OFF and retire structure** with `retire_practitioner_capacity`. It refuses while booking is ON, and the CHECK requires booking OFF before structure goes OFF.
      - Keep this window short. With booking OFF, staff moves pause (`booking_paused`), while public bookings and client reschedules continue.
      - If retirement still refuses, cancellation, completion and no-show all still work with booking OFF (§3). A move needs booking back ON.

---

## 2. Receptionist: restricted operational access

### 2.1 Capability matrix

The proposal below follows #824's initial set. Every cell outside it is
**denied by default** and needs an explicit decision to add. Enforcement means
**both** a database check (RLS, privilege or RPC gate) **and** a server-path
check. Navigation is presentation only.

| Capability | Owner | Practitioner | Receptionist | DB enforcement | Server enforcement |
|---|---|---|---|---|---|
| View the operational calendar (appointment times and status, service, practitioner names and colours, client display name) | ✅ | ✅ | ✅ projection | **no** raw `appointments` or reservation SELECT (RLS reads `practitioners` membership). The receptionist calendar RPC returns the fixed columns. | receptionist route guard |
| Client minimum contact (name, phone, email) for scheduling | ✅ | ✅ | ✅ projection | **no** raw `clients` SELECT. The contacts RPC returns only these columns. | the receptionist picker uses the projection |
| Other client columns (date of birth, address, Fitzpatrick type, skin notes, contraindications, notes, photo consent) | ✅ | ✅ | ❌ | raw `clients` SELECT denied by construction | — |
| Create, move and cancel bookings for treating practitioners | ✅ any | ✅ own | ✅ any treating practitioner | receptionist commands over the shared booking core. The target must be an active owner or practitioner, and there are no duration or outside-hours overrides. | receptionist actions only |
| Intake and consent **completion status** | ✅ | ✅ | ✅ status only | the contacts RPC returns booleans and dates; raw intake, signature and template rows are denied | — |
| Health answers and signed document content | ✅ | ✅ | ❌ | `client_intake_forms`, `client_consent_signatures` denied by construction | — |
| Treatment notes, settings, history, sessions, blocks, areas, clinical notes, treatment memory, plans and goals | ✅ | ✅ | ❌ | every clinical-table policy reads `practitioners` membership, so all are denied by construction | existing guards refuse (no practitioner membership) |
| Clinical images (`treatment-images` bucket, `treatment_images`, `photos`) | ✅ | ✅ | ❌ | `storage.objects` and table policies denied by construction | the existing images page and signing action refuse |
| Clinical recording, completion, signing, machine and probe defaults, treatment attribution | ✅ | ✅ | ❌ | every write command's actor check reads `practitioners`, so all refuse | existing actions refuse |
| Card or payment details, charge preparation and execution, refunds, pricing overrides, financial reports | ✅ | per current rules | ❌ | payment commands and tables denied by construction | existing actions refuse |
| Search | ✅ | ✅ | ❌ (until decided) | clinical sources denied by construction | the existing search action refuses |
| Exports | ✅ | ❌ (today) | ❌ | unchanged owner-only | unchanged |
| Invitations, roles, removals, capability changes | ✅ | ❌ | ❌ | owner-only commands | unchanged |
| Security, provider, billing and studio administration | ✅ | ❌ | ❌ | unchanged | unchanged |
| Be a treating resource, eligible for a service, an assignment candidate or capacity | ✅ | ✅ | ❌ **never** | no `practitioners` row, so none of these is possible | — |

**Decisions still open (product authority):**
- whether pronouns are part of the contact projection;
- whether appointment notes (`set_appointment_notes`) are visible to a receptionist;
- whether a receptionist may mark arrival or completion status;
- whether a receptionist sees service prices;
- whether a receptionist may manage waitlist entries.

All of these stay denied until decided.

### 2.2 Where access is granted today (implementation inventory)

- **Database.**
  - `public.is_studio_member(studio_id)` gates SELECT and write policies in **58** migration files. `public.is_studio_owner` appears in 21.
  - Adding a `receptionist` membership row **without** changing these would grant every clinical read. This is the risk #824 names.
- **Server.**
  - `requirePractitionerWithStudio()` and `getCurrentPractitionerWithStudio()` (`lib/supabase/queries.ts`) admit any active membership.
  - About 57 files gate on `role === 'owner'`. All the rest admit any member. Clinical actions are in that "any member" set today.
- **Capacity.** The `practitioners` row is both the membership and the treating resource.
  - The eligibility default trigger (`0134`) adds every active practitioner.
  - Studio-wide fan-out covers every practitioner.
  - Owner-capacity dashboards count members.
- **Storage.** The `treatment-images` bucket policies use membership (`0092`/`0093`). Signing happens in `app/(app)/clients/[id]/images/`.
- **Search.** `app/(app)/global-search-actions.ts` reads `clients`, `sessions`, `session_blocks`, `session_block_areas`, the record-keeping tables, `services` and `appointments`.
- **Export.** `app/(app)/settings/data/actions.ts` is owner-gated, and some resources also carry an owner-only RLS policy.
- **Service-role paths.** Every admin-client read reached from a member action must re-check the role, because RLS does not apply to it.

### 2.3 Enforcement design: a separate membership, denied by construction

**Decision: a receptionist is NOT a `practitioners` row.** The obvious design
adds `'receptionist'` to `practitioners.role`. It would then have to:
- narrow `is_studio_member`, which 58 migration files read;
- re-audit every `SECURITY DEFINER` command whose actor check is `practitioners.active` without a role test. That covers session, image and note writes, intake review, payments and record keeping;
- re-audit every server action that admits "any member".

Missing one of those exposes clinical data, which is the exact risk #824 names.

A **separate receptionist membership** inverts that. Every existing policy,
command and server path keeps reading `practitioners`, so a receptionist is
**refused everywhere by construction**. The only access is what the new
objects explicitly grant:

1. **`studio_receptionists`.**
   - Columns: `id`, `studio_id`, `user_id`, `display_name`, `email`, `active` and timestamps.
   - `unique (studio_id, user_id)`.
   - A guard refuses one user being both an active practitioner and an active receptionist in the same studio.
   - RLS: a receptionist reads only their own row; the owner reads the studio's rows.
   - No browser writes. Owner-only definer commands invite, activate, deactivate and convert.
2. **`is_studio_receptionist(studio_id)`.** True for the signed-in user's active row. It is used **only** by the new objects below, never added to an existing policy.
3. **Projection RPCs** (`SECURITY DEFINER`, revoked from `public`/`anon`/`service_role`, granted to `authenticated` only):
   - **The receptionist calendar.** Appointment times, status, service name, the treating practitioner's display name and colour, and the client's display name. It excludes appointment notes and every price (undecided, §2.1).
   - **Client contacts.** Client id, name, phone and email, plus intake and consent *completion* as booleans and dates.
4. **Scheduling commands for a receptionist.** These are separate definer commands that take the receptionist actor and then apply the **same** authoritative booking, move and cancel logic:
   - the same validator, exclusion, buffer and lock order;
   - the target must be an active owner or practitioner;
   - no duration or outside-hours override.

   To do this without forking that logic, the existing commands are re-emitted over a shared internal core that receives a server-resolved actor kind. Their behaviour for existing callers stays byte-identical, pinned by the existing suites.
5. **Audit and attribution.**
   - `appointment_audit.actor_type` gains `'receptionist'`, with a same-studio FK column to `studio_receptionists`. Today the type is constrained to `practitioner|client|system` (`0010`), and `0174` ties `actor_practitioner_id` to practitioners only.
   - `appointments` gains receptionist creator and canceller columns, beside 0174's practitioner columns, with a CHECK that a row names at most one creator kind.
   - The human actor is recorded, never a borrowed practitioner.
6. **Not a treating resource, by construction.** There is no `practitioners` row, so the receptionist cannot be:
   - an eligibility row (the FK targets `practitioners`);
   - a fan-out key;
   - an assignment candidate;
   - a capacity count;
   - a booking target.
7. **Invitations.** `pending_invitations.role` (`0007`) widens to admit `'receptionist'`. Acceptance (`admin_accept_pending_invitation`, `0141`) creates a `studio_receptionists` row for that role, and never a `practitioners` row. Role transition between practitioner and receptionist is one owner command that deactivates one kind and activates the other, atomically, with audit.
8. **Server (follow-up PR).**
   - Existing guards (`getCurrentPractitionerWithStudio`, `requirePractitionerWithStudio`) are unchanged, and they refuse a receptionist because there is no practitioner membership.
   - A new `requireReceptionistWithStudio()` serves only the receptionist calendar, contacts and booking routes.
   - Middleware and the shell admit a receptionist **only** to those routes.
   - Multi-studio selection extends to receptionist memberships and is re-validated per request.

This trades a little duplication (two membership tables) for an access model
in which forgetting something fails **closed**.

### 2.4 Tests required (real database roles)

- Raw PostgREST reads of every clinical table, `clients` columns, storage objects and signed URLs, as a receptionist JWT: denied.
- Forged server-action calls (clinical, payment, settings): refused.
- Search excludes clinical sources. Export is refused. Dashboard previews hold no clinical fields.
- Bookings: a receptionist creates, moves and cancels a practitioner's booking; may not target themselves or override.
- Lifecycle: invitation, acceptance, role transition (practitioner to receptionist and back), deactivation, forged studio and identity, and cross-studio access.
- Receptionist exclusion from eligibility, fan-out, assignment and capacity counts.

---

## 3. US/USD payments: per-studio country and currency

### 3.1 Inventory of CA/CAD assumptions

- **Schema `CHECK`s pinned to `'cad'`:**
  - `studio_payment_settings.default_charge_currency` (`0032`);
  - `payment_charge_attempts.currency` (`0032` default; `0073` CHECK);
  - `manual_fee_charge_attempts.currency` (`0064`);
  - `appointment_settlements.currency` (`0187`).
- **Application constants:**
  - `currency: "cad"` (`app/(app)/clients/[id]/sessions/[sessionId]/payment-actions.ts:326`);
  - `currency = "cad"` (`lib/billing/manual-fee-eligibility.ts:392`);
  - the default `"CAD"` in `lib/billing/payment-manual-review.ts:55`.
- **Provider:** `STRIPE_CONNECT_COUNTRY` (env, default `CA`) is read by `lib/stripe/account.ts:110` for **every** Express account.
- **Documents and displays:**
  - receipts (`lib/billing/payment-receipt.ts`, `lib/email/templates/payment-receipt.ts`, which assumes the CHECK);
  - fee and charge cards (`app/(app)/calendar/[id]/ManualFeeChargeCard.tsx`);
  - financial reports (`lib/finance/*`).
- **Webhooks and reconciliation:** currency identity checks already exist. Refund and dispute currency mismatches route to manual review (`0032`; `lib/billing/payment-webhook-reconciliation.ts`).
- **Out of scope:** `lib/marketing/content.ts` `CURRENCY = "CAD"` is Hone's own plan pricing, not studio payments.

### 3.2 Design

- **Configuration.** Two explicit per-studio values, `payment_country` (`CA`|`US`) and `payment_currency` (`cad`|`usd`).
  - Only the allowed pairs (CA/cad and US/usd) are permitted.
  - The values are written by an operator-protected path, never inferred from timezone, and read by the server from the selected studio.
  - Existing studios are backfilled to CA/cad. The read-only census comes first (§3.3).
- **Account creation.** Uses the studio's country. An existing account whose provider country differs fails closed and is never replaced.
- **Prepared attempts.** Currency and integer cents are written once at preparation. Execution, refunds and reconciliation read those facts and nothing later or browser-supplied. The `CHECK`s widen to `('cad','usd')` per row, consistent with the studio's configuration at preparation.
- **Changes.** Changing country or currency after an account exists, or after any monetary history, is refused except through an explicit protected policy. Old prices and transactions are never reinterpreted.
- **Displays and receipts.** Format from each row's own currency, and say USD or CAD explicitly. Canadian output must stay byte-identical.
- **Out of scope:** FX, conversion, payout-model changes and provider migration. Existing consent, idempotency, readiness and ledger-recovery rules are unchanged.

### 3.3 Read-only census before the legacy migration

The census reports counts only. For each studio it gathers:
- payment country and currency in effect;
- Stripe account presence and mode;
- monetary history (attempts, settlements, refunds).

It also confirms every existing row is `cad`. The result shapes the backfill and the protected-change policy. Provider eligibility of Hone's Connect platform for US Express onboarding is a **verification gap**, closed in an authorized sandbox step, not by documentation.

### 3.4 Tests (fake-provider lanes)

On the fake-provider lanes, with the existing CAD suites as regression:
- USD prepare, execute, receipt, refund and webhook recovery;
- duplicate and concurrent requests;
- mismatched provider currency or country;
- stale configuration;
- a Canadian regression with byte-identical receipts.

---

## 4. Dependency map and PR sequence

```text
PR 1   five-plus proof + this contract             tests/docs only, no migration (#825)
 │
 ├─ PR 2   receptionist DB foundation               studio_receptionists, projection RPCs,
 │         migration N                              receptionist scheduling commands, audit
 │         └─ PR 2b receptionist server paths + UI  requireReceptionistWithStudio, middleware,
 │                                                  calendar/contacts routes (no migration)
 │
 ├─ PR 3   US/USD per-studio currency               payment settings, CHECKs, immutable attempt
 │         migration N+1 (stacked on N, or          currency, account country, receipts
 │         renumbered after N lands)
 │
 └─ PR 4   public practitioner selection (G1)       after WAIT v4 PR5, or under an explicit
           migration N+2                            ownership hand-off (§5)
```

- **PR 2 re-emits the three internal scheduling commands** over a shared core. That is the one seam shared with WAIT v4 PR6 (§5).
- **PR 2 changes no existing policy.** A receptionist is denied by construction (§2.3). Its proof is the full DB lane plus the security guards, and the new tests that read every clinical table as a receptionist.
- **PR 3 is independent of PR 2 in code.** It shares only the migration sequence: pending migrations must stay a contiguous suffix (§5).

## 5. Coordination with DB, WAIT and SMS lanes

- **Migration numbers.** They are allocated at write time from a fresh census of hosted state, the repository, this host's worktrees and open PRs. Pending migrations must form one **contiguous suffix** (the parity guard). So only one lane can hold pending migrations at a time unless they are stacked; the next lane takes N+1 only on top of N.
- **WAIT v4: file ownership (this answers #823 §9's open item).** WAIT v4 lists these runtime surfaces as its own (#823 §7, §9):
  - `lib/booking/slots.ts`, `lib/booking/public-slot-range.ts`, `new-client-admission.ts`, `waitlist-invitation.ts`;
  - `lib/waitlist/**`, `app/book/[slug]/**`, `app/(app)/settings/waitlist/**`, `components/waitlist/**`;
  - the reservation exclusion path that its PR2 extends.

  **#824 claims none of them.** Consequences:
  - **G1 (public practitioner selection) is sequenced after WAIT v4's public-booking work** (its PR5, recipient flow and atomic booking), or is built only under an explicit ownership hand-off. Until then G1 stays a documented gap. Public bookings on a capacity studio stay owner-assigned. New-client intake pauses with `closed`. New bookings of every kind stop only when every service is hidden, and even that leaves client self-reschedule running (§1.4, GAP R1).
  - **#824 owns** the receptionist objects (§2.3) and its server routes. It also owns `lib/supabase/queries.ts` membership resolution, which is shared with every authenticated page, so it goes to coordinated review.
  - **The shared-core re-emission of the three internal commands** (`create_internal_appointment_v2`, `move_or_reassign_appointment`, `practitioner_cancel_appointment`) is the **one** shared scheduling seam. WAIT v4's withdrawal paths (its PR6) also act on owner bookings and moves. Whichever lane lands second re-emits on top of the first's body and never edits the other's migration. These functions stay behaviourally identical for existing callers.
  - **US/USD** touches payment tables, RPCs, receipts and Stripe only. It has no WAIT overlap.
- **Willow SMS.** No file under `lib/sms/**`, `lib/waitlist/delivery/**` or the SMS migrations is touched here. Waitlist SMS switches stay off.

## 6. Release gates (each PR)

- Exact-head required CI, a Codex review and a read-only shepherd receipt.
- Production integration one PR at a time, after exact-head approval.
- Hosted migrations migration-first, under separate per-change authorization.
- No activation, provider configuration, invitation or message without its own approval.
