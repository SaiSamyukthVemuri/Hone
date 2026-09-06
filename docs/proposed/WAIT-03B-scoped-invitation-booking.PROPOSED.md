# WAIT-03B — scoped waitlist invitation booking. **PROPOSED. NOT ACCEPTED.**

**Design only.** No runtime implementation, no migration authored or numbered,
no hosted mutation, no email or SMS sent, no PR.

Base: `ea70bd0543993937ba42259037c903fac6c6fc15` · worktree
`/srv/hone/worktrees/wait03-scoped-booking` · branch
`wait03/scoped-booking-contract`

**Revision 2** corrects two source errors in revision 1, replaces the crash
contract, and restates every product default as PENDING ACCEPTANCE.

---

## 0. Source corrections to revision 1

### 0.1 G6 was FALSE. The operator commands are callable today.

Revision 1 claimed "zero `grant execute`… uncallable". **That was a grep
artefact**: the grants are written `grant  execute` with **two spaces**, and the
pattern used required one. Absence of a match was reported as absence of a
grant. Re-read without the spacing assumption, the final source state is:

| Command | Final source state (last statement wins across 0188→0190) |
|---|---|
| `join_new_client_waitlist` | **granted → `service_role`** |
| `claim_new_client_waitlist_entries` | **granted → `service_role`** |
| `claim_new_client_waitlist_entry` | **granted → `service_role`** |
| `issue_new_client_waitlist_invitation` | **granted → `service_role`** (re-granted in 0189 and again in 0190) |
| `redeem_new_client_waitlist_invitation` | **granted → `service_role`** |
| `expire_new_client_waitlist_invitation` | **granted → `service_role`** |
| `release_new_client_waitlist_entry` | **granted → `service_role`** |
| `requeue_new_client_waitlist_entry` | **granted → `service_role`** |
| `record_new_client_waitlist_conversion` | **granted → `service_role`** |
| `remove_new_client_waitlist_entry` | **granted → `service_role`** |
| `new_client_waitlist_resolve_owner` | `revoke all` — **internal helper, no grant** |
| `*_server_timestamps`, `*_append_only`, `*_transition_guard`, `*_no_delete`, `*_record_event` | **0 grants — trigger/internal category, correctly unreachable** |

Each is revoked from `public`, `anon`, `authenticated`, `service_role` and then
re-granted **to `service_role` only**, which is the intended shape: reachable
from the server through `createAdminClient()`, never from a browser session.

**Evidence class, stated honestly.** The table above is **source evidence** —
what the migration files declare. It is **not** effective-privilege evidence.
Confirming what `service_role` actually holds in a given database requires
`has_function_privilege` against that database, which this pass did not run.
Source and effective state can diverge (a later migration, a manual grant, or a
CLI that strips grants on reset). **Before B2 relies on any of these, run the
effective check locally; before activation, run it against hosted.**

**What this changes for the design.** No blanket grant is proposed and none is
needed for existing commands. Only genuinely *new* commands (§3) require new
grants, and each is `service_role`-only. **Nothing is proposed for `anon` or
`authenticated`.**

### 0.2 G4's evidence was stale

Revision 1 quoted 0188's redemption (`set redeemed_at = now()`, a
transaction-start clock). **0189 redefines it and is the final implementation.**
It:

1. `select i.id … for update` — takes the invitation row lock **first**;
2. `v_decision_at := clock_timestamp()` — **post-lock wall clock**, not
   transaction-start;
3. updates and tests expiry against that same `v_decision_at`.

**The consumption point stands**: redemption still mutates, so a GET, preview
fetch or crawler that reaches it consumes the invitation. The temporal
characterisation is corrected: expiry is decided by the post-lock clock, which
is what makes a queued caller behind a lock evaluate against the time it
actually acted, not the time it started.

### 0.3 `claim_email_send` / `record_email_result` are NOT invitation delivery storage

Verified signatures (0080):

```
claim_email_send(p_appointment_id uuid, p_email_type text) returns boolean
record_email_result(p_appointment_id uuid, p_email_type text, p_success boolean)
```

Both take an **appointment id** and `update public.appointments`. They are
appointment-scoped claim columns. An invitation has no appointment, and
**creating a dummy appointment to borrow them, or overloading appointment
reminders, is explicitly rejected.**

**Reuse the pattern and the transport, not the storage**: claim-before-send /
record-after, `sendEmailSafely`, `studioEmailIdentity` (COMMS-01A, merged). The
smallest missing piece is an **invitation-owned delivery authority** — see G8.

---

## 1. Requirements vs proposed defaults

### Chloe's requirements
R1 selected recipients, not public access · R2 enforceable appointment-date/day
restrictions · R3 a secure booking experience · R4 decline this round without
leaving the waitlist.

### Proposed defaults — **RECOMMENDED, PENDING ACCEPTANCE**
None of these is confirmed by Chloe. They are engineering proposals awaiting a
product decision, and are marked so wherever they appear.

| # | Proposal | Consequence if accepted |
|---|---|---|
| P1 | **One owner-selected eligible service per booking round.** No hardcoded consultation/non-consultation assumption | The service is a parameter everywhere; local synthetic tests may parameterise it freely |
| P2 | **Fixed studio-local appointment dates**, with **selected dates / weekday restrictions representable and enforced inside the outer range** | "Next 14 days, Tuesdays and Thursdays only" is expressible; enforcement is server-side at commit |
| P3 | **Separate bounded response deadline**, proposed default **72 hours** | Matches `issue_`'s existing default; independent of the appointment window |
| P4 | **Explicit per-round manual intake allowance** | Chloe sets a number per round; nothing is inferred from calendar emptiness |
| P5 | **Outstanding invitations must fit the remaining allowance** by default. **Invitations reserve admission permission, not calendar slots** | No slot is held; the calendar is never blocked; over-issue is refused at issue time |
| P6 | **Replacement must not double-count.** Declined/expired permission may be reused. **Booked permission remains consumed** unless a separately defined owner action deliberately authorises a replacement | Permission accounting is stable across reissue and race |
| P7 | **No automatic 30-day exclusion.** A decline excludes **this round**; later manual offers remain possible **without losing waiting history** | Revision 1's cool-off is withdrawn |
| P8 | **No automatic unrestricted ongoing access** from client-record creation | Creating a client row grants nothing beyond the booked appointment |
| P9 | **Prefer verification of the stored invited contact, or a matching verified session, for book/decline.** Bare bearer access requires **explicit risk acceptance** and must never be described as intended-recipient identity | Raises the security floor above forwardable-link semantics; costs one verification step |
| P10 | **Email first**; SMS added independently after Twilio readiness | Nothing in this design depends on SMS |

---

## 2. Service policy — the deferral is preserved

**Standing source, `docs/production/current-state.md:470–475`:**

> **The direct new-client consultation booking route is `Deferred by product
> decision` (2026-07-27).** It is not built, not a launch blocker, and not the
> next engineering task.
>
> **That deferral is not the whole picture for new-client intake — see §5b.**
> New-client booking at Willow is currently **refused and routed to a waitlist**,
> which is a different capability from a direct booking route and is live today.

Restated at line 932.

**The proposed distinction — a private invitation is not a public route.** The
deferred capability is a *direct, unrestricted, publicly reachable* new-client
consultation route. WAIT-03B proposes the opposite shape on every axis:
owner-selected recipients, a fixed date window, one appointment, an explicit
per-round allowance, revocable, expiring. The same document already records
new-client intake as *"refused and routed to a waitlist"*; this is the mechanism
for admitting people **from** that waitlist, which §5b anticipates.

**This document does not assert that Chloe chose any service.** P1 leaves it
owner-selected. **If the selected service turns out to be a consultation, that
is an explicit amendment to the 2026-07-27 record**, to be written down — not a
silent divergence. The service stays parameterised, which also lets local
synthetic tests exercise the mechanism without prejudging the decision.

---

## 3. Contract

### 3.1 Offer scope
Stored on the invitation, resolved at issuance, studio-local:
`scope_service_id`, `scope_start_date`, `scope_end_date`, and a representable
**allowed-day restriction** (P2) enforced *inside* the outer range. The response
deadline (`expires_at`, existing) stays separate. Scope is re-read server-side
at commit; a substituted URL parameter, service or date cannot widen it.
Availability inside the scope stays live — **an invitation reserves admission
permission, not a calendar slot** (P5).

### 3.2 Controlled admission
Per-round allowance (P4). Consumed = live invitations + bookings from this
round. Enforced at issue under the studio lock and **re-validated at the commit
boundary**. Replacement does not double-count; declined/expired permission
returns to the pool; **booked permission stays consumed** unless an owner action
deliberately authorises a replacement (P6).

### 3.3 Client outcomes
Booked · not this round (decline) · no response · owner revocation · no suitable
slots. Decline returns the entry to `waiting` with its original `created_at`
intact and promises **no numbered queue position**. A decline excludes **this
round only** (P7). Leaving the waitlist stays a separate explicit action
(`remove_new_client_waitlist_entry`, unchanged).

### 3.4 Security and identity
- **No mutation on view.** Redemption consumes (§0.2), so the landing page must
  use a **read-only resolver** (G4) and never call `redeem_` on GET.
- **Narrow authority**: view this offer, book one appointment in scope, decline
  this offer. **No clinical-record access, no portal session, no history.**
- **Bearer possession ≠ verified recipient identity.** A bearer link is
  **forwardable**; holding the URL is not evidence of being the intended person.
  P9 therefore prefers verification of the stored invited contact, or a matching
  verified session, before book/decline. If bare bearer access is accepted, it
  must be recorded as an explicit risk acceptance and never described as
  identity.
- **No identity attachment from a typed email.** A typed address matching an
  existing client must not bind to that clinical identity.
- **Existing-client exemption.** Existing clients keep their normal rights and
  normal booking route, untouched. The exemption is achieved by **scoping this
  authority to the invitation**, not by matching typed emails: an invitation
  authorises exactly one appointment for one entry, and never widens or narrows
  any existing client's permissions. A16 pins that no established client's
  behaviour changes.

### 3.5 Atomic booking
Reuse `create_public_appointment` (0170) as the sole commit authority. Validate
scope, day restriction, invitation liveness and remaining allowance **inside the
commit transaction**. One lock order: `studios` → entry → invitation →
appointment/slot. **Never consume the invitation on a failed slot attempt.**
Idempotent on a caller-minted request key so retries return the original
appointment. Appointment, invitation outcome and entry status are written in one
transaction so no contradictory triple exists.

### 3.6 Decline authority
A prospect must not call `release_new_client_waitlist_entry` — it takes
`p_actor_user_id` (owner authority). A new token-authorised command closes that
invitation and returns the entry to `waiting`, writing no owner attribution and
refusing if the token is not the entry's current live invitation (so an old link
cannot decline a newer one).

### 3.7 Reschedule and ongoing access
Invitation-created appointments are scope-bound; the ordinary reschedule route
clamps to the authorised window (`free-consult-reschedule-policy.ts` is the
precedent). Cancellation stays available under existing policy. **No ongoing
unrestricted booking from client-record creation** (P8).

### 3.8 Delivery, and the corrected crash contract

**Five distinct states, never collapsed:**
`not_attempted` · `in_progress` · `outcome_unknown` · `provider_accepted` ·
`delivered` (only where a provider event supports it).

**UNKNOWN is never rewritten as "not sent".** There is **no atomic transaction
across the database and the email provider**, and **exactly-once delivery is not
claimed or achievable.**

**An idempotent recorder does not reconstruct a lost provider response or a lost
raw token.** The raw token exists in memory for one request; `token_hash`
persists. So a send whose outcome is unknown cannot be retried by re-reading the
row.

**Crash behaviour at each boundary:**

| Crash point | Durable state after | Correct handling |
|---|---|---|
| Before the provider call | invitation live, delivery `not_attempted` | attempt delivery; no ambiguity |
| **During the provider call** | invitation live, delivery `in_progress` → must become **`outcome_unknown`** | **Stays UNKNOWN.** Recovery is *controlled replacement* (below), never a silent "not sent" and never a blind resend |
| After acceptance, before local persistence | provider accepted; local row still `in_progress` | **Remains UNKNOWN unless authoritative evidence is durably available or recoverable** — e.g. a provider id captured before the crash, or a provider-side lookup. If neither exists, it is UNKNOWN, not accepted |
| After the result was recorded | terminal | nothing to recover |

**Controlled replacement — the required properties:**

1. **Identify the exact invitation being replaced** by id, not by entry or email.
2. **Atomically**, in one transaction: verify eligibility, **revoke the old
   credential**, and **issue the new one**.
3. **Preserve the same logical recipient and round allowance** — replacement is
   not a second admission (P6).
4. **Do not replace an invitation that already won a concurrent race** — if it
   booked, or was redeemed, replacement is refused.
5. **A failed replacement leaves a consistent prior state** — either the old
   invitation remains live, or the new one exists; never both, never neither.
6. **A stale delivery worker cannot overwrite a newer invitation's status** —
   delivery writes are conditioned on the invitation id *and* a generation/
   version, so a late worker for the replaced invitation is a no-op.
7. **Late arrival of the old email grants no renewed permission** — the old
   credential was revoked at replacement, so the old link fails closed.

**Stated plainly:** if the original email *did* arrive, the recipient may hold a
link that no longer works while a newer one does. That is the accepted cost of
replacement, and it is the honest alternative to pretending the outcome was
known.

---

## 4. Reuse map

| Need | Reuse | Location |
|---|---|---|
| Appointment commit | `create_public_appointment` | migration 0170 |
| Studio-local window | `horizonRangeInStudioTz`, `isWithinPublicBookingHorizon` | `lib/booking/horizon.ts` |
| Slots/availability | existing authority | `lib/booking/slots.ts`, `queries.ts` |
| Token mint + hash-at-rest | `generateRawToken`, `hashToken`, `timingSafeHashEqual` | `lib/portal/tokens.ts` |
| Verified session / recipient proof (P9) | portal magic-link + session | `lib/portal/magic-link.ts`, `session.ts` |
| Email transport + studio identity | `sendEmailSafely`, `studioEmailIdentity` | `lib/email/*` |
| Delivery **pattern** (claim → send → record) | `claim_email_send` / `record_email_result` **as a pattern only** | migration 0080 — **not** as invitation storage |
| Existing lifecycle (all `service_role`-granted) | `join_`, `claim_`, `issue_`, `redeem_`, `expire_`, `release_`, `requeue_`, `record_…conversion`, `remove_` | 0188–0190 |
| Entry audit trail | `new_client_waitlist_entry_events` | 0188 |
| Reschedule clamp precedent | `free-consult-reschedule-policy.ts` | `lib/booking/` |
| Practitioner surface | existing waitlist settings page | `app/(app)/settings/waitlist/` |

---

## 5. Remaining genuine schema gaps

No migration number is claimed. Applied 0185/0188/0189/0190 are frozen.

| # | Gap | Why it is genuine |
|---|---|---|
| **G1** | Offer scope columns + representable allowed-day restriction | Nothing on the invitation carries service or dates; permission must be enforced server-side |
| **G2** | Decline outcome (`declined_at`, declined scope) | Status set has no declined state; `released_at` is owner-attributed |
| **G3** | Token-authorised decline command (+ `service_role` grant) | The only close path requires `p_actor_user_id` |
| **G4** | Read-only token resolver (+ `service_role` grant) | Final redemption (0189) consumes under a row lock using the post-lock clock; GET must render without consuming |
| **G5** | Per-round admission allowance + enforcement at issue and commit | Nothing counts admissions; capacity is not inferable |
| **G6** | ~~blanket grants~~ **WITHDRAWN — false.** Existing commands are already `service_role`-granted (§0.1). **New commands (G3, G4, G8) each need one `service_role`-only grant**; nothing for `anon`/`authenticated` | corrected |
| **G7** | Scope-bound appointment marker for the reschedule clamp | `create_public_appointment` has no scope concept |
| **G8** | **Invitation-owned delivery authority** — claim/record keyed by invitation id, carrying the five states and a generation for stale-worker rejection | `claim_email_send`/`record_email_result` are appointment-keyed and update `appointments`; dummy appointments are rejected |

---

## 6. Slices, ownership, and dependencies

**Correction:** revision 1 said server work must wait for a production migration.
That is wrong. **Local dependency integration may precede production.** B2 can be
developed and tested against a local database carrying B1's schema. Only
**deployment and activation** must respect schema readiness and the human apply
gate.

| Slice | Content | Owns | Depends on |
|---|---|---|---|
| **B1 — schema** | G1–G5, G7, G8 in one forward migration (number assigned at authoring) + DB acceptance tests | `supabase/migrations/<unassigned>_*.sql`, `tests/db/waitlist-scoped-invitation.db.test.ts` | none |
| **B2 — server** | issue/resolve/book/decline actions; scope + day enforcement; allowance accounting; delivery state machine | `app/(app)/settings/waitlist/actions.ts`, `lib/booking/waitlist-invitation.ts` (new) | B1 **locally**; production apply only for deployment |
| **B3 — prospect surface** | token landing, in-scope picker, decline; recipient proof per P9 | `app/invite/[token]/` (new) | B2 |
| **B4 — practitioner surface** | "Invite to book" flow, outcome column | `app/(app)/settings/waitlist/page.tsx` + one component | B2 |

**First implementation slice: B1**, and its only hard dependency is the product
acceptance of P1–P9 — because the schema encodes those decisions.

---

## 7. Acceptance matrix — corrected layers, extended

**This matrix is a set of cases known to matter, not a completeness proof.** A
hand-enumerated list cannot demonstrate that no other failure exists, and no new
proof framework is proposed here.

| # | Case | Expected | Layer |
|---|---|---|---|
| A1 | Date outside `scope_start/end` | refused; invitation still live | DB |
| A2 | Substituted `service_id` posted | refused; scope re-read server-side | DB |
| A3 | Cross-studio token use | refused; zero rows | DB |
| A4 | Typed email matches existing client | no clinical-identity attachment | DB |
| A5 | GET / preview / reload ×3 | no redeem, book, decline, remove | route + e2e |
| A6 | Replayed booking submit | one appointment; second returns the first | DB |
| A7 | Two tabs, different slots | exactly one appointment | DB |
| A8 | Two invitations race the final allowance | one books; other gets "round full" | DB |
| A9 | Slot taken before commit | invitation **not** consumed | DB |
| A10 | Booking races decline / revoke / expiry | one outcome; no contradictory triple | DB |
| A11 | Reschedule outside scope | clamped/refused | DB + unit |
| A12 | Provider timeout then controlled replacement | no second live invitation; old credential dead | DB |
| A13 | Declined prospect invited in a later round | permitted; history intact | DB |
| A14 | Expired prospect invited in a later round | permitted | DB |
| A15 | Decline excludes **this round** only | later manual offer permitted (P7) | DB |
| A16 | Established client books normally throughout | rights and behaviour unchanged | e2e |
| A17 | Old link declines a newer invitation | refused | DB |
| A18 | Decline attribution | no owner actor; entry → `waiting` | DB |
| **A19** | **Excluded weekday inside the allowed date range** | refused, even though the date is in range | **DB** |
| **A20** | **Full appointment interval + studio-timezone boundary** — appointment starting in scope but ending outside, and a slot at the local midnight edge | scope decided on the studio-local interval, not a UTC instant | **DB** |
| **A21** | **Wrong or replayed recipient proof** (where P9 is accepted) | refused; no book, no decline | **DB + route** |
| **A22** | **Issuance exceeding the round allowance** | refused at issue, before any send | **DB** |
| **A23** | **Replacement racing a booking** | if the invitation already booked, replacement refused; never both | **DB** |
| **A24** | **Lost provider response, then stale-worker completion** | state stays `outcome_unknown`, never "not sent"; the stale worker cannot overwrite the newer invitation | **DB + unit** |
| **A25** | **Post-booking unrestricted-access bypass** | a booked prospect cannot book again without a new invitation | **DB + e2e** |

**Negative controls:** delete the scope check → A1, A19, A20 red. Delete the
allowance check → A8, A22 red. Delete the generation guard → A24 red. A matrix
that stays green when enforcement is removed proves nothing.

---

## 8. Open product decisions (unaccepted) and technical blockers

**Unaccepted product decisions:** P1–P10 above, each RECOMMENDED / PENDING
ACCEPTANCE. **B1 cannot begin until they are accepted**, because the schema
encodes them.

**Technical blockers, distinct from the above:**
- Effective-privilege verification (§0.1) must be run locally before B2 relies
  on the existing grants, and against hosted before activation.
- A migration number free of #674's 0192, assigned at authoring.
- SMS remains out of scope (P10) and independently blocked.

---

**PROPOSED ONLY. Nothing implemented, no migration authored or numbered, no
hosted mutation, no email or SMS sent, no PR.**
