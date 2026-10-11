# Studio readiness (#824): contract, capability matrix and dependency map

**Revision 2 (2026-10-11).** Refreshed for the owner's expanded direction in
#824:
- owner-managed team RBAC;
- a studio owner console;
- restricted platform support;
- dedicated CA/US studio SMS numbers;
- delivery monitoring with actionable owner and support notifications.

LEAD-ALERT-01 (#826) is the first slice. Revision 1 is the PR #825
checkpoint. Its five-plus proof and recovery procedure (§1) carry over
unchanged.

**Status: preparation only.** Issue #824 authorizes preparation, isolated
implementation, tests and draft PRs. These all remain separate decisions:
- production merges;
- hosted migrations;
- feature activation;
- live provider configuration, and any billable provider operation;
- invitations and customer messages.

The expanded scope brings no deadline and no launch claim. It also brings no
additional agents, no combined PR, no activation, no customer send and no
provider spending.

**Baseline.** Production `claude/build-hone-saas-hOex7` at `6c5eac80`. Re-read
the tip before each slice. Migration state is derived (`npm run
migration:state`), never quoted here. Each slice takes its number from a fresh
census when it is pushed (§11).

**How to read a claim.** Every claim here is one of:
- **Implemented**: present in production source at the baseline;
- **Verified**: executed by a named test on an isolated stack;
- **Source-read**: read in source, not yet executed by any test;
- **Reproduced gap**: a defect or missing capability shown against the real commands (G1, R1);
- **Proposed**: design not built. This covers §3–§5, §7 and the unbuilt parts of §2 and §6;
- **PRODUCT AUTHORITY REQUIRED**: undecided; proposed, never implemented.

Where a section mixes them, each claim is labelled.

**Shape.** Eight capability areas, each delivered as bounded draft PRs (§10):

| § | Area | First slice |
|---|---|---|
| 1 | Five-plus-practitioner operation | #825, this contract's checkpoint |
| 2 | Team access: fixed roles, owner-managed RBAC, receptionist | the receptionist membership foundation |
| 3 | Studio owner console | a console shell over the existing readiness modules |
| 4 | Restricted platform support | the support capability model |
| 5 | Dedicated studio SMS numbers, CA/US | the sender eligibility gate |
| 6 | US/USD payments | per-studio country and currency |
| 7 | Delivery monitoring and notifications | the email ledger and Resend webhook (DELIVERY-EVENTS-01) |
| 8 | Lead alerts | LEAD-ALERT-01 (#826), first overall |

The areas share code: the scheduling commands, membership resolution, the
studio row, the SMS and email paths, and the migration sequence. §10 orders
them for that reason, and §11 records who owns each shared file.

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
- the recovery-procedure file (§1.4) passes **11/11** on three consecutive runs, also leaving none behind. The two suites it cites pass on the same tree: the admission commit-authority suite (20/20, same stack) and the booking-action gate test (20/20).

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
| A per-studio activation and recovery plan whose steps the real commands support (§1.4) | `capacity-recovery-procedure.db.test.ts` §1–§3. The `closed` refusals and the unstamped cutover are from `new-client-admission-commit-authority.db.test.ts` §1B–§3B and its UNSTAMPED block. The existing-client action branch under CLOSED is from `tests/app/book/new-client-waitlist-gate.test.ts`. | ✅ procedure; ❌ **GAP R1** (no dedicated pause; client self-reschedule continues) |

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
public booking surface, so it needs WAIT coordination (§11). Until it ships,
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
4. **Recovery.** Turning structure OFF is **not** an instant rollback once parallel appointments exist (`known-limitations.md` L7). It would re-key them into one studio bucket, where they overlap. `retire_practitioner_capacity` (`0136`, `0138`) therefore refuses while any two participating appointments overlap **in time** anywhere in the studio, whichever practitioners they belong to (`0138`:294–302). The booking flag is **not** an intake pause either: the public command never reads it, and turning it OFF pauses the moves that recovery needs. Every step below is run against the real commands in `tests/db/capacity-recovery-procedure.db.test.ts` unless another test is named; its sections are cited below as recovery test §1–§3.
   1. **Pause new clients with `closed`.**
      - The owner sets it in Settings → Booking (`set_new_client_admission_mode`, owner only, `0204`).
      - The database then refuses every new-client booking, an invited one included, and every new waitlist join (`assert_new_client_admission`). The refusals are proven in `new-client-admission-commit-authority.db.test.ts` §1B, §2B and §3B; in §3B a *valid* invitation is refused and nothing is spent.
      - `waitlist` is **not** a pause: it still admits a valid scoped invitation (`app/book/[slug]/actions.ts`:614–646).
      - If the studio's mode is unstamped (`new_client_admission_mode_set_at` is null), `closed` returns `legacy_waitlist_cutover_required` and writes nothing. Set `waitlist` first, which stamps it, then `closed` (the same file's UNSTAMPED block).
      - It governs **public** admission only. Staff can still add a client and book them in the app (`create_internal_appointment_v2` reads no admission mode).
      - **Returning clients are unaffected.** A booker on the existing-client path whose email matches an active client still books, reschedules and cancels through their own links:
        - at the **action** layer, `publicBookAppointmentAction` leaves an existing client outside the CLOSED refusal and still runs the booking command (`tests/app/book/new-client-waitlist-gate.test.ts`, "CLOSED: an EXISTING client is completely outside this authority");
        - at the **command** layer, `0170`, `0171` and `0176` read no admission mode (recovery test §1).
      - They can also rebook from the portal, which has no admission gate by design (`app/portal/rebook-actions.ts`:92–97). An unmatched email on the existing-client path is refused (`actions.ts`:964–967), so it is no way around `closed`.
   2. **If needed, freeze all new bookings by hiding every active service** (Settings → Services, owner only). **Record the menu order first**, because the restore in step 5 needs it.
      - **Stops** everything that creates through `create_public_appointment`: the public page, portal rebook and invited bookings all get `public_booking_unavailable` (`0170`:690–710). An invited booking is refused before its invitation is spent: the active-service read (`actions.ts`:727–733) runs before consumption (`:841`–`869`). Staff cannot create appointments either (`invalid_service`, `0174`).
      - **Does not stop** staff moves, reassignments or cancellations; completion and no-show marking; or payments, refunds and charting on existing appointments (`lib/billing` reads no `services.active`).
      - **Does not stop a client's self-reschedule** through an existing link. `reschedule_appointment_v2` (`0171`) reads neither `services.active`, the admission mode nor the booking flag. With every service hidden and booking OFF, a reschedule onto another practitioner's time still succeeds, and retirement then refuses (recovery test §3).
      - **While frozen**, staff service pickers and the readiness panels show no bookable service.
      - **Does not stop an owner's outcome repair** *(source-read, not yet exercised by a test)*. `revert_appointment_outcome` (`0173`:350–448, called from `app/(app)/calendar/appointment-repair-actions.ts`) restores a cancellation or no-show from the last 72 hours to `confirmed`. It reads neither `services.active`, the admission mode nor the booking flag, and its exclusion refuses only a same-resource overlap (23P01). So it can recreate a studio-wide overlap (Codex P2 `4242755461` on #825).
      - **GAP R1: no dedicated public-booking pause exists, and nothing pauses client self-reschedule or an owner's outcome repair.** Until a pause exists, the owner must not repair outcomes between steps 3 and 5.
   3. **Remove each overlap in time, with booking still ON.**
      - A **future** appointment can be moved to a time that does not overlap (by the owner, or by a practitioner for their own), or cancelled.
      - Once an appointment has **started**, both refuse (`appointment_not_movable`, `not_cancelable`), so close its lifecycle instead:
        - `mark_appointment_no_show`, once it has ended, stops it participating at once;
        - `mark_appointment_complete`, once it has started, stops it only when its blocked end has passed (`appointment_participates_in_capacity`, `0136`).
      - Reassignment alone never clears an overlap.
      - A cleared overlap does not stay cleared: a client's self-reschedule or an owner's outcome repair can recreate one (step 2), so re-check the count immediately before step 4.
      - A past appointment left `confirmed` blocks indefinitely, because the no-show cron does not mutate anything (`app/api/cron/no-show-check/route.ts`; recovery test §3).
   4. **Then turn booking OFF and retire structure** with `retire_practitioner_capacity`. It refuses while booking is ON, and the CHECK requires booking OFF before structure goes OFF.
      - Keep this window short. With booking OFF, staff moves pause (`booking_paused`), while client reschedules continue (and public bookings, unless frozen).
      - If retirement still refuses, cancellation, completion and no-show all still work with booking OFF (recovery test §3). A move needs booking back ON.
   5. **Restore only after retirement succeeds**, or once the recovery is abandoned. Restoring earlier lets public and staff creation resume mid-recovery, which can add a new overlap and make retirement fail again.
      - Show the services again **in the recorded order**, because each service shown goes to the bottom of the menu (`show_studio_service`, `0161`; recovery test §2).
      - Then reopen admission (`open`, or `waitlist`).

### 1.5 Every writer of `appointments` (census)

Mechanical census of the **latest** definition of every `public` function whose
body inserts into `appointments` or updates its status, times or practitioner
(all migrations through `0210`). **Implemented** means present in production
source. Nothing in this table is new behaviour.

Method: overloads are keyed by their full signature, because two `0176`
overloads share a name and a name-keyed pass hid the writer. Superseded
overloads are excluded: the `0145` move signature is dropped in `0148`, and the
two-argument token cancel in `0091`.

The direct-write paths are closed: `authenticated` holds no `insert`, `update`
or `delete` on `appointments`, and no RLS write policy exists. The application
code that names the table only reads it (for example
`app/(app)/clients/[id]/sessions/new/actions.ts`:146 and
`app/(app)/dashboard/prep-memory-actions.ts`:63).

| Writer (latest) | Writes | Reads the booking flag | Reads `services.active` | Reads admission | Reached from the app | Can create a participating overlap during recovery | Evidence |
|---|---|---|---|---|---|---|---|
| `create_internal_appointment_v2` (`0174`) | insert | ✅ (`booking_paused`) | ✅ (`invalid_service`) | ❌ | staff booking | only with booking ON and a visible service | **verified** (recovery test §2; five-plus) |
| `move_or_reassign_appointment` (`0174`) | time, practitioner | ✅ | ❌ (eligibility only) | ❌ | staff move | only with booking ON | **verified** (recovery test §3) |
| `create_public_appointment` (`0170`) | insert | ❌ | ✅ (`public_booking_unavailable`) | ❌ | public page, portal rebook; wrapped by `create_public_appointment_for_new_client` (`0204`) and `create_waitlist_public_appointment` (`0195`) | while any service is visible | **verified** (recovery test §2) |
| `reschedule_appointment_v2` (`0171`) | insert + status | ❌ | ❌ | ❌ | client reschedule link | **yes, always** | **verified** (recovery test §3, retirement window) |
| `revert_appointment_outcome` (`0173`) | status → `confirmed` | ❌ | ❌ | ❌ | owner outcome repair (72-hour window) | **yes, always** | **source-read** (`0173`:350–448) |
| `practitioner_cancel_appointment` (`0174`) | status → cancelled | ❌ | ❌ | ❌ | staff cancel | no (removes) | **verified** |
| `public_cancel_appointment_with_token` (`0176`) | status → cancelled | ❌ | ❌ | ❌ | client cancel link | no (removes) | **verified** (recovery test §1) |
| `mark_appointment_complete` (`0175`), `mark_appointment_no_show` (`0033`) | status | ❌ | ❌ | ❌ | calendar, session start | no (removes, completion once its blocked end passes) | **verified** (recovery test §3) |
| `reschedule_appointment` (`0091`), `finalize_card_required_public_booking` (`0032`) | insert (+ status) | ❌ | ❌ | ❌ | **no application caller** found by name | not from the app; still granted at the database | **source-read** |

So **two writers can recreate an overlap whatever the freeze or flag says**: the
client reschedule and the owner's outcome repair. That is GAP R1's full extent
for appointments. The two legacy writers have no application caller, but stay
granted; whether to revoke them is a follow-up, not part of this contract.

---

## 2. Team access: fixed roles, owner-managed RBAC and the receptionist

### 2.1 Fixed role definitions

A person holds **one role per studio**. Each role's capabilities are fixed in a
single definition. An owner chooses a person's role, never their individual
capabilities, and the readable per-user access summary is rendered from that
same definition.

| Role | Kind | Today | Purpose |
|---|---|---|---|
| Owner | studio | `practitioners.role = 'owner'` | full administration of their own studio, with clinical and financial access |
| Practitioner | studio | `practitioners.role = 'practitioner'` | treating clinician: creates and moves only their own bookings; cancel follows F6 |
| Receptionist | studio | new, `studio_receptionists` (§2.4) | operational scheduling with minimum contact data; never clinical, never financial, never treating capacity |
| Platform support | platform | **does not exist** | bounded, audited operational help across studios (§4) |
| Platform admin | platform | the `ADMIN_EMAILS` allowlist (`lib/admin.ts`, fail-closed in production) | the whole `/admin` console |

No studio role can grant, hold or reach a platform role. Platform roles live
outside every studio table, and no studio-scoped command writes them.

### 2.2 Capability matrix

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
| Invitations, role changes, service assignments, deactivation | ✅ | ❌ | ❌ | owner-only commands (§2.4) | owner guard |
| Read a per-user access summary | ✅ every member | ✅ own | ✅ own | rendered from the role definition (§2.1) | — |
| Owner console (§3) | ✅ own studio only | ❌ | ❌ | owner-gated reads; no studio id accepted from the client | owner guard |
| Sender and payment readiness (§3, §5, §6) | ✅ | ❌ | ❌ | read-only projections | owner guard |
| Notification recipients and preferences (§7.6) | ✅ | ❌ (until decided) | ❌ | owner-only | owner guard |
| Operations inbox: actionable delivery failures (§7.5) | ✅ | ❌ (until decided) | ❌ (until decided) | studio-scoped incident reads | owner guard |
| Security, provider, billing and studio administration | ✅ | ❌ | ❌ | unchanged | unchanged |
| Grant or hold platform support or admin | ❌ | ❌ | ❌ | no studio-scoped path writes a platform role | — |
| Be a treating resource, eligible for a service, an assignment candidate or capacity | ✅ | ✅ | ❌ **never** | no `practitioners` row, so none of these is possible | — |

**Decisions still open (product authority):**
- whether pronouns are part of the contact projection;
- whether appointment notes (`set_appointment_notes`) are visible to a receptionist;
- whether a receptionist may mark arrival or completion status;
- whether a receptionist sees service prices;
- whether a receptionist may manage waitlist entries;
- whether practitioners or receptionists see delivery failures for bookings they made;
- ownership transfer, and changes between owner and practitioner.

All of these stay denied until decided.

### 2.3 Where access is granted today (implementation inventory)

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
- **Clinical-access census** (latest policy per table, through `0210`). **56** tables carry a SELECT policy that admits any active `practitioners` membership (`is_studio_member`), clinical ones included: `sessions`, `session_blocks`, `session_block_areas`, `client_clinical_notes`, `client_intake_forms`, `client_consent_signatures`, `clinical_record_snapshots`, `clinical_record_amendments`, `clinical_audit_events`, `treatment_images`, `photos`, `treatment_goals`, `treatment_plan_stages`, `imported_treatment_memories`, `clients` and more. **10** are owner-only: the WAIT tables, `studio_sms_senders` and two record-keeping audit tables. This census is the reason a receptionist must never hold a `practitioners` row.
- **Storage.** *Corrected from revision 1, which said the bucket policies use membership.* `0093` drops every authenticated policy on `storage.objects` for treatment images, so the objects are **service-role only**. Upload and signing go through the admin client in `app/(app)/clients/[id]/images/actions.ts`, after the action authorizes the caller (:28–29). Image access therefore rests on that server guard, plus the member-readable `treatment_images` metadata table.
- **Search.** `app/(app)/global-search-actions.ts` reads `clients`, `sessions`, `session_blocks`, `session_block_areas`, the record-keeping tables, `services` and `appointments`.
- **Export.** `app/(app)/settings/data/actions.ts` is owner-gated, and some resources also carry an owner-only RLS policy.
- **Service-role paths.** Every admin-client read reached from a member action must re-check the role, because RLS does not apply to it.
- **Team lifecycle.** `invitePractitionerAction`, `revokeInvitationAction` and `removePractitionerAction` (`app/(app)/settings/team/actions.ts`). `pending_invitations.role` is `check (role in ('owner', 'practitioner'))` (`0007`:14). Acceptance is `admin_accept_pending_invitation` (`0141`).
- **Platform.** `app/admin/layout.tsx` redirects any user outside the `ADMIN_EMAILS` allowlist (`isAdmin`, `lib/admin.ts`), and every `/admin` action re-checks it.

### 2.4 Enforcement design: a separate membership, denied by construction

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
   - No browser writes. The owner lifecycle commands, `add_studio_receptionist` and `set_studio_receptionist_active`, are `service_role`-only and re-verify the active owner. Invitation and conversion come with the team slice (S3, §10).
2. **`receptionist_actor_id(studio_id)`.** Resolves the signed-in user's active row. It is internal (revoked from every role) and used **only** inside the new definer objects below, never added to an existing policy.
3. **Projection RPCs** (`SECURITY DEFINER`, revoked from `public`/`anon`/`service_role`, granted to `authenticated` only):
   - **The receptionist calendar.** Appointment times, status, service name, the treating practitioner's display name and colour, and the client's display name. It excludes appointment notes and every price (undecided, §2.2).
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
7. **Invitations.** `pending_invitations.role` (`0007`) widens to admit `'receptionist'`. Acceptance (`admin_accept_pending_invitation`, `0141`) creates a `studio_receptionists` row for that role, and never a `practitioners` row.
8. **Owner-managed role changes.** A change between practitioner and receptionist is one owner command that deactivates one kind and activates the other, atomically, with audit. Proposed rules:
   - a practitioner becoming a receptionist is refused while they are the practitioner on any future confirmed appointment, so the owner reassigns those first and no booking is left on an inactive resource;
   - a receptionist becoming a practitioner gets service eligibility from the owner, exactly as an invited practitioner does;
   - an owner cannot change their own role, and a studio always keeps at least one active owner;
   - ownership transfer and owner ↔ practitioner changes stay out until decided (§2.2).
9. **Changes take effect on the next privileged action.** Every database gate reads the membership rows at call time: there is no JWT role claim and no cached capability. Server guards re-resolve membership per request. A deactivated or re-roled person's next call is refused, even from a page that is already open.
10. **Server (follow-up PR).**
   - Existing guards (`getCurrentPractitionerWithStudio`, `requirePractitionerWithStudio`) are unchanged, and they refuse a receptionist because there is no practitioner membership.
   - A new `requireReceptionistWithStudio()` serves only the receptionist calendar, contacts and booking routes.
   - Middleware and the shell admit a receptionist **only** to those routes.
   - Multi-studio selection extends to receptionist memberships and is re-validated per request.

This trades a little duplication (two membership tables) for an access model
in which forgetting something fails **closed**.

**Status.** Items 1–3 and 6 (the table, the dual-membership guards, the
projections and the owner lifecycle) are **built on a local, unpushed branch
and verified on an isolated stack**: 17 behavioural tests, including a
zero-row read of every studio-scoped table as a receptionist, and the full DB
suite green. They are **not in production** and not in any PR, and are held
until their migration number is free (S2, §10; §11). Items 4, 5 and 7–10 are
**proposed**.

### 2.5 Tests required (real database roles)

- Raw PostgREST reads of every clinical table, `clients` columns, storage objects and signed URLs, as a receptionist JWT: denied.
- Forged server-action calls (clinical, payment, settings): refused.
- Search excludes clinical sources. Export is refused. Dashboard previews hold no clinical fields.
- Bookings: a receptionist creates, moves and cancels a practitioner's booking; may not target themselves or override.
- Lifecycle: invitation, acceptance, role transition (practitioner to receptionist and back), deactivation, forged studio and identity, and cross-studio access.
- Receptionist exclusion from eligibility, fan-out, assignment and capacity counts.
- Role changes: a change or deactivation made between two calls on one open session refuses the second call; an owner's self-demotion and the removal of the last active owner are refused.
- No studio path can write a platform role, and every access summary matches the role definition.

---

## 3. Studio owner console

**One console, scoped to the selected studio, for its owner only.** It
aggregates and does not duplicate: each panel reuses the module that already
owns its truth.

| Panel | Reuses |
|---|---|
| Setup readiness | `app/(app)/settings/launch/page.tsx`; `lib/booking/readiness.ts`, `lib/booking/new-client-readiness.ts`, `lib/consent/launch-readiness.ts`, `lib/google-calendar/readiness.ts`, `lib/onboarding/*` |
| Team: invitations, roles, service assignments, deactivation, access summaries | `app/(app)/settings/team/*`, plus the §2 commands |
| Services, hours and booking policy | `app/(app)/settings/services`, `…/availability`, `…/booking` |
| Phone and sender readiness | `lib/sms/sender-status.ts`, extended to the §5 vocabulary |
| Payment readiness | `app/(app)/settings/payments`, extended by §6 |
| Notification recipients and preferences | new (§7.6) |
| Operational failures and recovery | the operations inbox (§7.5) |

**Rules.**
- **Owner only**, on the server and in the database.
- **No studio id from the client.** A console page resolves the selected studio from the signed-in owner's membership on every request, so an owner cannot administer another studio.
- **No platform console.** Owners never reach `/admin`: `app/admin/layout.tsx` redirects any user outside the `ADMIN_EMAILS` allowlist, and every `/admin` action re-checks it.
- **Reads never call a provider.** Status comes from durable rows. A provider check or a configuration change is a separate, explicit, audited action.
- **UNKNOWN is shown as unknown, never as ready.** This is the three-state rule `lib/booking/new-client-readiness.ts` already applies.

**Slices.** The console shell and readiness aggregation come first, with no
migration. Each other panel lands with the slice that creates its truth.


---

## 4. Restricted platform support

**Today there is one platform power.** The `ADMIN_EMAILS` allowlist
(`lib/admin.ts`, fail-closed in production) opens all of `/admin`:
- the lead console (`app/admin/page.tsx`);
- studio creation and welcome resend (`app/admin/studios/**`);
- audit;
- payment manual review;
- ops alerts.

There is no narrower support role.

**Design.**
- **A distinct support capability**, separate from admin. It is a database-backed membership, granted and revoked only by a platform admin through an audited command. No studio role can grant it.
- **Operational metadata by default**: studio name, slug and status; readiness states; sender, registration and payment states; and delivery incidents with safe context (§7.5).
- **Never bundled**: clinical notes, images, health answers, signed documents, card or payment-method details, raw provider payloads and signed client tokens. Any elevated access would be a separate, time-bound, audited grant. That is **PRODUCT AUTHORITY REQUIRED** and is not proposed here.
- **Every privileged support or configuration action is attributable and audited**: who, what, which studio, and a safe before/after summary.
- **The cross-studio queue is permission-filtered.** An incident whose studio attribution is unresolved stays platform-admin only (§7.5).

---

## 5. Dedicated studio SMS numbers, CA/US

### 5.1 What exists (reuse, do not rebuild)

- **Sender and provisioning (`0191`, `0194`, `0199`, `0207`).** Each `studio_sms_senders` row carries:
  - `country` and `requested_area_code`;
  - the claimed and active number, `phone_number_sid` and `messaging_service_sid`;
  - a durable spending claim: `provisioning_claim_key`, its time, its actor and its lease generation;
  - `provisioned_at`, `last_test_ok_at`, the last error, and `released_at`.
- **Engines (`lib/sms/`).**
  - `provisioning.ts` and `provisioning-store.ts`: the spending claim;
  - `adoption.ts`: adopting and reconciling an existing provider resource;
  - `claim-phone-number.ts`;
  - `sender-status.ts`: the status projection;
  - `studio-sender.ts`: `resolveStudioSmsSender`;
  - `phone.ts`: normalization;
  - `suppression*.ts`;
  - the provider adapters in `provider/` (fake, Twilio, fenced).
- **Ledger and callbacks.** `sms_outbound_messages` (`0206`) via `lib/sms/delivery-ledger.ts`, and two signed Twilio routes: `app/api/twilio/inbound-sms` (STOP/HELP) and `app/api/twilio/message-status`.
- **Held, and not revived blindly:** the number-search PR (#775) and the studio-sender routing PR (#716).

### 5.2 Findings

All three are **source-read**. None has been reproduced by a test yet; the
sender-eligibility slice (§5.4, slice 1) must open with a failing test for
F-SMS-1.

- **F-SMS-1: the send path does not use the studio sender.**
  - `sendSmsSafely` (`lib/sms/twilio.ts`:148–188) sends from the platform's environment sender: `TWILIO_MESSAGING_SERVICE_SID`, else `TWILIO_FROM_NUMBER`.
  - `lib/sms/send-appointment.ts`:708 passes no sender, and waitlist delivery uses the same function.
  - `resolveStudioSmsSender` (`lib/sms/studio-sender.ts`:83) exists but is not on the path.
  - The studio switches (`send_confirmation_sms` and the rest) have no owner-side writer; only an operator sets them.
  - **So today, any studio whose switches an operator turns on sends from the shared platform sender.** That is the cross-studio substitution #824 forbids, and for a US studio it would be unregistered US traffic.
- **F-SMS-2: A2P 10DLC and toll-free verification are unmodelled** (`capability-register.md`:195; `CANONICAL_ROADMAP.md`:2446). No brand, campaign or sender-association record exists.
- **F-SMS-3: a failed SMS raises only a `warning` ops alert** (`app/api/twilio/message-status/route.ts`:137–139). Warnings email no one, because `lib/ops/alert-email.ts` sends only for `critical`.

### 5.3 Design

- **Sender eligibility is a send-time precondition.** An independently onboarded studio sends only through its own sender row, and only while that row is active **and** registration-eligible for the traffic. For example, a US recipient on 10DLC needs an approved campaign associated with that messaging service. There is no platform fallback and no other studio's sender.
- **Willow is the one documented legacy exception**, by an explicit operator-only marker, until its own separate cutover runbook. Its behaviour is otherwise unchanged.
- **Registration model**, under Hone's ISV account. Each studio has brand → campaign → sender association, with provider ids, state, the last provider check and the information still required.
  - Toll-free verification is the alternative path, and its requirements are verified before it is chosen.
  - A number is never relabelled to bypass registration.
  - Buying a number, or one passing test send, does not establish readiness.
- **Owner-facing status**: Not configured, Pending, Requires information, Active, Suspended or Failed, each with the next owner or support action. It is derived from the sender and registration rows, and reads never call the provider (§3).
- **CA and US recipients.**
  - E.164 storage and matching stay as they are, and so do the phone-wide STOP and consent contract.
  - A `+1` prefix says nothing about whether the business or sender is Canadian or US. The sender's country comes from the studio's configuration, never from the number or the timezone.
  - Which routing rules apply to each pair of sender country and recipient country is a **verification gap**. It is closed against the provider's current requirements, not assumed.
- **Inbound STOP/HELP and status events** route by provider resource: the messaging service or number, then its sender row, then its studio.
  - An unknown resource is quarantined for platform review.
  - There is no automatic consent backfill and no join-acknowledgement catch-up.
- **Before any billable step**, two packets are prepared for approval:
  - a cost and registration packet: number price, brand and campaign fees, vetting and timelines;
  - a controlled acceptance packet.

### 5.4 Slices

1. The sender eligibility gate and the legacy marker (migration). The send path is coordinated with the Willow lane (§11).
2. The registration model and the owner-facing status vocabulary (migration).
3. Inbound and status routing by provider resource, extending the existing signed routes.
4. Owner number selection and the provisioning request, reusing the provisioning engine. The billable step stays gated.
5. The cost and registration packet (docs).

---

## 6. US/USD payments: per-studio country and currency

### 6.1 Inventory of CA/CAD assumptions

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

### 6.2 Design

- **Configuration.** Two explicit per-studio values, `payment_country` (`CA`|`US`) and `payment_currency` (`cad`|`usd`).
  - Only the allowed pairs (CA/cad and US/usd) are permitted.
  - The values are written by an operator-protected path, never inferred from timezone, and read by the server from the selected studio.
  - Existing studios are backfilled to CA/cad. The read-only census comes first (§6.3).
- **Account creation.** Uses the studio's country. An existing account whose provider country differs fails closed and is never replaced.
- **Prepared attempts.** Currency and integer cents are written once at preparation. Execution, refunds and reconciliation read those facts and nothing later or browser-supplied. The `CHECK`s widen to `('cad','usd')` per row, consistent with the studio's configuration at preparation.
- **Changes.** Changing country or currency after an account exists, or after any monetary history, is refused except through an explicit protected policy. Old prices and transactions are never reinterpreted.
- **Displays and receipts.** Format from each row's own currency, and say USD or CAD explicitly. Canadian output must stay byte-identical.
- **Out of scope:** FX, conversion, payout-model changes and provider migration. Existing consent, idempotency, readiness and ledger-recovery rules are unchanged.

### 6.3 Read-only census before the legacy migration

The census reports counts only. For each studio it gathers:
- payment country and currency in effect;
- Stripe account presence and mode;
- monetary history (attempts, settlements, refunds).

It also confirms every existing row is `cad`. The result shapes the backfill and the protected-change policy. Provider eligibility of Hone's Connect platform for US Express onboarding is a **verification gap**, closed in an authorized sandbox step, not by documentation.

### 6.4 Tests (fake-provider lanes)

On the fake-provider lanes, with the existing CAD suites as regression:
- USD prepare, execute, receipt, refund and webhook recovery;
- duplicate and concurrent requests;
- mismatched provider currency or country;
- stale configuration;
- a Canadian regression with byte-identical receipts.

---

## 7. Delivery monitoring and actionable notifications

### 7.1 What exists

- **Ops alerts.** `ops_alerts` (`0067`) holds severity (`info`, `warning` or `critical`), the event, a redacted message, safe ids, `safe_details` and resolution fields. `recordOpsAlert` (`lib/ops/alerts.ts`) writes it, with redaction in `lib/ops/redact.ts`, and `/admin/ops-alerts` shows it.
- **Operator email** is best-effort and critical-only (`lib/ops/alert-email.ts`, `OPS_ALERT_EMAILS`). It never throws and never recurses into another alert.
- **SMS** has a durable attempt ledger (`0206`) and a signed status callback (§5.1).
- **Email** goes through Resend (`lib/email/client.ts`). The waitlist sender uses provider idempotency keys (`lib/email/new-client-waitlist-send.ts`). Most other email has **no durable delivery record**: appointment, reminders, intake, welcome, postcare and receipts. **No Resend webhook route exists.**
- **Job health.** Heartbeats live in `lib/cron/reminder-heartbeat.ts` and `lib/google-calendar/sync/{worker,reconcile}-heartbeat.ts`; the cron routes live under `app/api/cron/`.

### 7.2 The model: intent → attempt → provider event

- **One shape across channels.**
  - The **intent** belongs to the workflow that decided a message should go (LEAD-ALERT-01's outbox, for example). It is the **only retry authority**.
  - Each provider call is one **attempt**, claimed before the call and settled after it.
  - **Provider events** are stored durably, deduplicated and applied forward-only.
  - Email gets the shape that `0206` already gives SMS. There is no second queue and no second sender.
- **States are reported separately:**
  - queued;
  - provider-accepted;
  - delivered: the provider reports the recipient's mail server or carrier (not the inbox, and not read);
  - delayed;
  - bounced or undelivered;
  - failed;
  - suppressed;
  - unknown or stale.

  **Accepted is not delivered, and UNKNOWN is never success.**
- **No payload PII** in the ledger: no body, address or subject.

### 7.3 Resend signed webhook (DELIVERY-EVENTS-01, a parallel lane)

- The Svix signature is verified, and the receipt row is durable **before** the 2xx.
- Events are deduplicated on the provider's event id, so replays are safe. Out-of-order events apply forward-only.
- Events are associated through the attempt id sent as a message tag. Unknown events and unassociated messages are quarantined as platform-only.
- Twilio ingestion is not replaced; it keeps its own routes (§7.4).

### 7.4 Twilio

The existing signed status and inbound routes write the same event shape into
the SMS ledger. Their current behaviour is preserved.

### 7.5 Incidents, the owner operations inbox and the support queue

- **Incidents.** Actionable failures roll up into incidents, deduplicated by studio, workflow, failure class and subject. Each carries the last attempt and its time, the reason, the next action and its resolution history.
- **The owner** sees their studio's incidents (§3).
- **Platform support** sees a permission-filtered cross-studio queue (§4).
- An incident whose studio attribution is unresolved is platform-only.

### 7.6 Notifications

- **Who is told.** The owner, for an actionable delivery failure. Sam and support, for critical, repeated or unattended incidents.
- **No storms.** One notification per incident, not per event. Retry-in-progress is distinct from terminal failure, so one outage does not become an email storm.
- **Recipients and preferences** are owner-managed per studio (§3).
- **Content.** An alert email carries minimum operational metadata and an authenticated console link. It never carries health answers, clinical notes or images, card details, raw provider payloads or signed client tokens.

### 7.7 Safe retry and resend

- **Re-check before resending:** the booking or invitation state, its deadline, current consent, STOP/suppression and sender readiness. A cancelled or expired opportunity is never resent.
- **No side effects.** A delivery problem never becomes a duplicate charge, a released reservation or a non-response penalty.
- **Bounded recovery.** Automatic recovery is bounded. An attempt whose provider acceptance is uncertain is **reconciled before any resend**.
- **Durable claims.** Claims and dedupe survive concurrent workers, crashes and the provider's finite idempotency window.

### 7.8 "Client says they did not receive it"

An owner can record that concern against the intent, as its own auditable
record. Receipt is never inferred from open pixels.

### 7.9 Job and callback health

Each of these has a purpose-specific threshold:
- scheduler lag;
- exhausted retries;
- dead queues;
- missing or failed callback processing.

UNKNOWN is not false success.

### 7.10 When the alert channel itself fails

- A failed notification email stays visible in the durable console.
- It never recurses into an alert chain, and never erases the underlying incident.
- An email-provider outage is not "resolved" by sending another email through the same provider.

### 7.11 Workflow slices

Each workflow joins the ledger as its own bounded slice:
- booking confirmations;
- appointment and intake reminders;
- consent and intake invitations;
- waitlist messages, through WAIT-owned code (§11);
- welcome and account invites;
- postcare;
- payment receipts;
- Google Calendar sync;
- payment reconciliation;
- scheduled job health.

---

## 8. LEAD-ALERT-01 (#826): the first slice

The requirements are in #826. This section records only how it fits the rest.
- **Scope.** It is **platform** lead capture: `app/actions/demo.ts` → `demo_requests`, and `app/actions/waitlist.ts` → Hone's own early-access `waitlist`. It is not a studio client's waitlist (`lib/waitlist/**`), and it sends nothing to prospects.
- **Capture.** The lead and its notification **intent** commit in one transaction. The email goes after commit through the existing Resend client, to a server-configured, allowlisted operator recipient. It never goes to an address from the form.
- **Retries.** The intent is the retry authority (§7.2): a durable claim, stable provider idempotency, and bounded recoverable retries.
  - A duplicate early-access email creates no new intent.
  - A rate-limited or rejected submission creates none either.
- **Visibility.** Status, failure and a missing recipient configuration are all visible to the platform operator in `/admin`. None is silently treated as success.
- **Join point with DELIVERY-EVENTS-01.** Once that lane's ledger exists, each send also records an attempt through its join point (`begin_email_message` and `settle_email_message`), so delivered and bounced arrive from the webhook. Either landing order works.
- **Migration.** It takes the **lowest free migration number at its push** (§11).

---

## 9. Expanded acceptance: two synthetic studios

Two independent synthetic studios:
- **A**: US, `America/Los_Angeles`, five-plus practitioners, USD;
- **B**: Canadian, `America/Toronto`, CAD.

On the existing fake-provider lanes, together they must prove:
- **Number and provider-resource isolation.** Neither studio's message can leave on the other's sender, and an unknown resource is quarantined.
- **The CA and US paths** through payments (§6) and SMS routing (§5).
- **Permission negatives** for receptionist, owner, support and platform admin, including forged identity and cross-studio access (§2, §4).
- **Delivery events** (§7):
  - signature, replay and out-of-order handling;
  - lost events;
  - a provider outage;
  - the client-reported concern;
  - crash and retry recovery;
  - alert-channel failure.
- **No regressions** in Canadian payments, Willow's SMS behaviour or any frozen WAIT v4 invariant.

---

## 10. Dependency map and PR sequence

Each line is one separately reviewable draft PR. Migration numbers are not
reserved here (§11).

```text
S0   #825          five-plus proof, recovery procedure, contract r1   tests/docs   checkpoint
S0b  this PR       contract r2, stacked on #825                        docs         -
S1   #826          LEAD-ALERT-01: platform lead alerts                 migration    FIRST
S2   STUDIO-READY-02a  receptionist membership foundation             migration    built; held for its number
S3   STUDIO-READY-02b  team RBAC: receptionist invitation and         migration    after S2
                       acceptance, role changes, access summaries
S4   STUDIO-READY-02c  receptionist scheduling over a shared core     migration    WAIT PR6 seam (§11)
S5   STUDIO-READY-02d  receptionist server paths and UI               none         after S3, S4
S6   STUDIO-READY-03a  owner console shell, readiness panels          none         after S3
S7   STUDIO-READY-04   US/USD payments                                migration    payment lane
D1   DELIVERY-EVENTS-01  email ledger and Resend webhook             migration    parallel lane
D2   Twilio events in the shared vocabulary                           maybe        after D1; Willow
D3   incidents, operations inbox, owner/support notifications         migration    after D1
D4   platform support capability and queue                            migration    after D3
D5+  workflow slices (§7.11)                                          varies       after D1
M1   studio sender eligibility gate, Willow legacy marker             migration    Willow, #716
M2   SMS registration model, owner status vocabulary                  migration    after M1
M3   inbound and status routing by provider resource                  maybe        after M1
M4   owner number selection, provisioning request                     maybe        billable step gated
G1   public practitioner selection, with a dedicated pause (R1)       migration    after WAIT v4 PR5
```

**Order, and why.**
- **S1 goes first.** #826 asks for it ahead of the owner-console and messaging work, and it is small.
- **S2 is already built:** the table, the projections, the owner lifecycle and the dual-membership guards. The full DB suite is green on an isolated stack. It is held only for its migration number.
- **S7 (USD) is independent of every other slice in code.** It shares only the migration sequence.
- **M1–M4 wait for coordination with the Willow lane**, because they change the shared send path (F-SMS-1).
- **D1 belongs to a parallel session**, coordinated through #824. This lane does not implement it.
- **Activating anything above** is a separate decision, outside this sequence.

---

## 11. Coordination: WAIT, Willow, DB and the parallel #824 lanes

- **Migration numbers.**
  - A number is held only by a **pushed PR with a claim comment on #824**. A local commit or an untracked file holds nothing.
  - Each slice runs a fresh census at push time, covering hosted, the repository, this host's worktrees and open PRs.
  - Pending migrations must form one **contiguous suffix** (the parity guard). So a later number stacks on the earlier PR's branch, or renumbers if the order changes.
  - No lane ever edits another lane's migration. `0209` and `0210` stay frozen.
  - **Agreed order for #824 lanes:** LEAD-ALERT-01 first, then DELIVERY-EVENTS-01, then the receptionist foundation. A non-#824 lane that pushes first simply holds its number.
- **WAIT v4: the frozen round contract is preserved.** One live round per studio, belonging to **one practitioner** and one consultation service and duration (#823 §2.1). Nothing in #824 changes it. Five-plus team scheduling does not authorize multi-practitioner rounds or several live rounds, and no #824 slice touches round reservation storage or its lock primitives (v4 PR2), or the launch transaction (v4 PR4).
- **WAIT v4 boundary, as #823 §9 states it at `455bd639`:**

  | Surface | Owner |
  |---|---|
  | Round reservation storage; lock primitives and their mode/ordering | WAIT v4 PR2 |
  | The scheduling-locked launch transaction | WAIT v4 PR4 |
  | Multi-practitioner **appointment** correctness: double-book prevention with buffers, per-practitioner availability, assignment, any-available | #824 / #825 |
  | `lib/booking/slots.ts`, `lib/booking/public-slot-range.ts` (the candidate and exclusion path) | **SHARED**: whoever lands first; the other composes and does not re-derive |
  | "No partial appointment/reservation state" | one approach agreed between the lanes before either writes it |

  WAIT also lists `new-client-admission.ts`, `waitlist-invitation.ts`, `lib/waitlist/**`, `app/book/[slug]/**`, `app/(app)/settings/waitlist/**` and `components/waitlist/**` as its runtime surfaces (§7). **#824 claims none of them.** Consequences:
  - **G1** (public practitioner selection) composes on the shared candidate path after WAIT v4 PR5, or under an explicit hand-off. It must keep #823 §3.3's lock ordering and `0209`'s buffered candidate window.
  - **S4** (receptionist scheduling over a shared core) is the one command-level seam with WAIT's PR6. Whichever lane lands second re-emits on top of the other's body, and behaviour for existing callers stays identical.
  - **Neither lane writes a partial-state implementation in a shared file** without the agreement in the table.
  - WAIT messages join the delivery ledger (§7.11) only through WAIT-owned code.
  - Revision 1 listed the two slot files as WAIT-owned. #823 has since made them shared, and this revision follows #823.
- **Willow SMS.** The Willow lane owns `lib/sms/**`, `lib/waitlist/delivery/**`, `app/api/twilio/**` and the SMS migrations.
  - #824's SMS slices change them only under explicit integration coordination.
  - Willow's current sending is preserved until its own separate cutover.
  - Waitlist SMS switches stay off.
- **Shared files that need coordinated review:**
  - `lib/supabase/queries.ts` membership resolution and `middleware.ts`, which every authenticated page uses;
  - the `studios` row;
  - `lib/email/**`, because every lane sends email;
  - `lib/ops/**` (alerts);
  - `lib/types/database.ts` and `lib/email/e2e-fake-resend.ts`.

  Edits to these are additive, and the second lander rebases.
- **DB test stacks.** Each lane uses its own isolated stack and never resets another lane's.

## 12. Release gates (each PR)

- Exact-head required CI, a Codex review and a read-only shepherd receipt.
- Production integration one PR at a time, after exact-head approval.
- Hosted migrations applied migration-first, under separate per-change authorization.
- No activation, provider configuration, billable provider operation, invitation or message without its own approval.
