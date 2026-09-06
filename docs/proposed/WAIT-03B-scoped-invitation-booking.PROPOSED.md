# WAIT-03B — scoped waitlist invitation booking. **PROPOSED. NOT ACCEPTED.**

**Design only.** No runtime implementation, no migration authored, no migration
number claimed, no hosted mutation, no email or SMS sent, no PR opened.

Base: `ea70bd0543993937ba42259037c903fac6c6fc15` (production at time of writing)
Worktree: `/srv/hone/worktrees/wait03-scoped-booking`, branch
`wait03/scoped-booking-contract`

---

## 0. What the code actually says — read first, and it changes the plan

**"Backend complete, UI only" is FALSE, twice over.** Verified against the
production tree, not comments:

| Claim | Evidence |
|---|---|
| The invitation lifecycle has **no runtime caller** | `issue_`, `redeem_`, `release_`, `requeue_`, `record_…conversion`, `claim_…entry` — **0** files in `app/` or `lib/` reference any of them |
| It is not merely uncalled but **uncallable** | **0** `grant execute` statements exist for any of them across 0188/0189/0190. Every one is revoked from `public`, `anon`, `authenticated` **and** `service_role`. A forward grant migration is mandatory before a single line of UI can work |
| The invitation carries **no offer scope** | `new_client_waitlist_invitations` columns are `id, studio_id, entry_id, token_hash, issued_at, expires_at, issued_by_practitioner_id, redeemed_at, expired_at, released_at`. There is **no service, no date range, no day list** |
| There is **no decline outcome** | `released_at` exists, but `release_new_client_waitlist_entry(p_studio_id, p_entry_id, p_actor_user_id)` is an **owner-actor** command. A prospect calling it would impersonate the studio |
| `redeem_` **mutates on call** | its body is `update … set redeemed_at = now() …`. Any GET, link preview or crawler that calls it consumes the invitation |
| Booking needs a client row that does not exist | `create_public_appointment(p_studio_id, p_client_id, p_service_id, p_starts_at, p_cancellation_token_hash, …)` requires `p_client_id`; a waitlist entry is an email, not a client |

So the honest position: **0188–0190 built a durable lifecycle skeleton; WAIT-03B
must add offer scope, a decline outcome, an admission limit and execute grants
before any of it is reachable.**

---

## 1. Requirements vs proposed defaults — labelled, not blended

### Chloe's requirements (not negotiable here)
R1. Selected recipients, not unrestricted public access.
R2. Enforceable appointment-date/day restrictions.
R3. A secure booking experience.
R4. Decline this round **without leaving the waitlist**.

### Our proposed defaults (evaluate, confirm or reject)
D1. **Email first**; SMS added independently once Twilio is ready. *Recommend
    accept* — SMS is blocked on registration and provider readiness, and nothing
    in this design depends on it.
D2. **One initial appointment per invitation.** *Recommend accept* — it keeps
    the admission limit countable and matches "bring people in", not "grant
    ongoing access".
D3. **One existing eligible service** per invitation. *Recommend accept.*
D4. **A manual intake limit**, not an algorithmic capacity claim. *Recommend
    accept* — Hone cannot infer treatment capacity, and §2 explains why.
D5. **Small selected groups**, not a mass first-come race. *Recommend accept* —
    it is also what makes the limit enforceable without a queueing system.

### PRODUCT DECISION, NOT ASSUMED
**Which service does an invitation authorise?** This document does **not**
assume "consultation". `lib/booking/consultation.ts` exists and
`current-state.md` records the *direct new-client consultation route* as
**deferred by product decision**, so picking it here would quietly reverse a
standing decision. Chloe must name the service. The contract is written so the
service is a parameter, not a constant.

---

## 2. The contract

### 2.1 Offer scope (contract point 1)

An invitation carries **explicit fixed dates**, resolved at issuance:

```
scope_service_id     uuid    -- exactly one existing service
scope_start_date     date    -- studio-local
scope_end_date       date    -- studio-local, inclusive
response_deadline_at timestamptz  -- SEPARATE from the dates above
```

- "Next 14 days" is a **UI convenience that resolves to two literal dates** at
  issue time, in the studio's timezone via `horizonRangeInStudioTz`
  (`lib/booking/horizon.ts`). It is never stored as an offset, so it cannot
  drift when read later.
- **Response deadline ≠ appointment window.** `expires_at` already exists for
  the deadline; the scope dates are new and independent. A prospect may respond
  on day 1 and book on day 13.
- **Slots stay live inside the scope.** The offer authorises a *window*, not a
  held time. Availability is computed at view and re-validated at commit by the
  canonical authority, so an invitation never blocks the calendar (see §2.2).
- **Scope is server-side and re-read at commit.** The URL carries only the
  token. Service, dates and studio are read from the invitation row. Changing a
  query parameter, posting a different `service_id`, or editing a date cannot
  widen permission because the client never supplies those values authoritatively.

### 2.2 Controlled admission (contract point 2)

**The smallest reliable limit is a count of live invitations plus conversions,
enforced at issue time and re-checked at commit.**

```
studio_waitlist_admission_limit  -- per studio, operator-set integer, nullable
consumed = live invitations (not redeemed/expired/released)
         + entries converted within the current round
```

- Enforced in the **issue** command under the studio row lock, so two
  simultaneous issues cannot both take the last seat.
- **Re-checked at the booking commit**, because an invitation may sit unredeemed
  while the limit is lowered. Remaining permission is validated at the commit
  boundary, never only at issue.
- **Do not infer capacity from empty slots.** An empty consultation slot says
  nothing about whether Chloe can absorb another ongoing client; treatment
  capacity is a human judgement. The limit is a number Chloe sets and changes.
- **Interactions**
  - *Replacement invitation*: blocked by the existing
    `new_client_waitlist_invitations_one_live_per_entry` unique index — one live
    invitation per entry. Issuing a replacement requires releasing the first,
    which returns its seat.
  - *Revocation*: releases the seat immediately.
  - *Expiry*: releases the seat when the expiry command runs — **and the seat is
    computed from live state, so an unexpired-but-past-deadline invitation must
    not count**. Use `expires_at > now()` in the count, not a status flag.
  - *Simultaneous bookings*: two invitations racing for the final seat are
    serialised by the same studio lock the commit already takes; the loser gets
    a distinct "round is full" outcome, not a slot error.
- **An invitation never reserves a time.** The prospect is told plainly that a
  time is confirmed only at booking.

### 2.3 Client outcomes (contract point 3)

Five terminal-ish outcomes, all representable:

| Outcome | Mechanism | Waitlist effect |
|---|---|---|
| **Booked** | appointment created; entry → `converted` | leaves the waiting set, by conversion |
| **Not this round** (decline) | invitation → declined; entry returns to `waiting` | **stays on the waitlist** |
| **No response** | deadline passes; invitation → expired; entry returns to `waiting` | stays |
| **Owner revocation** | invitation → released by owner | stays |
| **No suitable slots** | prospect books nothing and the deadline passes | identical to no-response |

- **Decline preserves the original waiting history.** The entry keeps its
  original `created_at`; nothing is rewritten. It does **not** promise a numbered
  queue position, because no ranking exists and none is proposed.
- **Re-invitation guard.** A declined offer must not be immediately re-sent as
  the same offer. Proposal: record `declined_at` and the declined scope, and have
  the issue command refuse an identical (service, start, end) offer to the same
  entry within a cool-off the operator can override deliberately.
- **Leaving the waitlist is a separate explicit action** —
  `remove_new_client_waitlist_entry` already exists and is unchanged. Decline
  never removes.

### 2.4 Security and identity (contract point 4)

- **No mutation on view.** `redeem_` as written mutates. The invitation landing
  page must therefore **not** call it. Proposal: split into a **read-only
  resolver** (token → scope, status, studio, service; no writes) used by GET,
  and keep redemption inside the booking/decline commands. GET, preview
  fetchers, crawlers and reloads then cannot redeem, book, decline or remove.
- **Narrow authority.** An invitation authorises exactly: view this offer, book
  one appointment inside this scope, or decline this offer. It grants **no**
  clinical-record access, no portal session, no client history.
- **No identity attachment from a typed email.** A prospect typing an address
  that matches an existing client must **not** bind to that clinical identity.
  Reuse the portal's verified-recipient mechanism (`lib/portal/tokens.ts`,
  `magic-link.ts`, `session.ts`) if identity binding is ever needed; until then
  the invitation creates or matches only within its own narrow lane, and any
  ambiguity is resolved by the practitioner, not by the form.
- **Forwarding, stated honestly.** The link is a bearer token. **Anyone holding
  the URL can act within its scope.** It is *not* non-forwardable, and this
  design will not claim otherwise. Mitigations are: short response deadline,
  one live invitation per entry, single appointment, narrow scope, and a visible
  audit trail of who booked. If Chloe needs true recipient binding, that is a
  separate decision requiring a verification step.

### 2.5 Atomic booking (contract point 5)

- **Reuse `create_public_appointment`** (migration 0170) as the commit
  authority. It already re-validates studio/client/service tenancy and the full
  availability contract under the studio lock. Do not write a second booking path.
- **Validate at the commit boundary**: scope dates, service identity, invitation
  liveness and remaining admission — all re-read inside the same transaction as
  the appointment insert, not in a pre-check.
- **One lock order**, matching the existing lifecycle: `studios` → waitlist
  `entry` → `invitation` → appointment/slot. Every new command takes locks in
  that order to avoid deadlock with `issue_`/`release_`/`requeue_`.
- **Never consume the invitation on a failed slot attempt.** Redemption is
  committed only in the same transaction that creates the appointment. A taken
  slot returns the prospect to the picker with the invitation still live.
- **Safe retries.** The command is idempotent on a caller-minted request key, so
  a double submit or a network retry returns the original appointment rather
  than creating a second. (Same shape as the SMS provisioning claim key in 0191.)
- **No contradictory triple.** Appointment existence, invitation outcome and the
  entry's `converted` status are written in one transaction. A booked
  appointment with a still-live invitation, or a `converted` entry with no
  appointment, must be unrepresentable.

### 2.6 Decline authority (contract point 6)

- A prospect decline **must not** call `release_new_client_waitlist_entry` —
  that command takes `p_actor_user_id` and is owner authority.
- Proposal: a new narrow command authorised **by the token**, not by a user:
  `decline_new_client_waitlist_invitation(p_raw_token)`, which closes **that**
  invitation and returns the entry to `waiting`. It writes no owner attribution
  and cannot touch any other entry.
- **Version safety**: the command resolves the invitation by token hash and
  refuses if that invitation is not the entry's current live one. An old link
  therefore cannot decline a newer invitation.

### 2.7 Reschedule and ongoing access (contract point 7)

- An invitation-created appointment **must not escape its scope** through the
  ordinary reschedule route. Proposal: mark the appointment as scope-bound
  (origin invitation + its date window) and have the existing reschedule path
  clamp to that window. `free-consult-reschedule-policy.ts` is the precedent for
  a route-specific reschedule rule.
- **Cancellation stays available** under whatever policy already applies. Being
  invited does not remove a client's normal cancellation rights.
- **No unrestricted ongoing booking.** Creating an appointment — and possibly a
  client record — does **not** grant open booking. Any further access is a
  separate deliberate decision.
- **Existing clients are untouched.** No change to any current client's booking
  rights is proposed, and the acceptance matrix pins that.

### 2.8 Email delivery (contract point 8)

- **Delivery state is separate from invitation state.** Reuse the existing
  `claim_email_send` / `record_email_result` contract (migrations 0080/0098)
  which already separates claim → provider call → result. Never derive
  "invited" from "email sent".
- **A provider timeout must not create a second live invitation.** The claim is
  taken before the provider call; a timeout leaves the invitation live and the
  delivery attempt recoverable. The `one_live_per_entry` index is the backstop.
- **The raw-token-once problem is real and must be designed around.**
  `token_hash` is stored; the raw token exists only in memory at issue time, so
  **a failed send cannot be retried by re-reading the row** — the original link
  is unreconstructable by design. Two honest options, and the choice is a
  product decision:
  - **(a) Controlled reissue** — release the failed invitation and issue a new
    one with a fresh token. Simple, auditable; the old link dies.
  - **(b) Deliver-then-commit** — hold the raw token in the request scope until
    the provider accepts, and treat provider rejection as "no invitation
    issued". Narrower window, more complex failure handling.
  *Recommend (a)*, because it reuses existing lifecycle commands and never keeps
  a raw token beyond one request.
- **Three distinct states, never conflated:** `queued` (claimed, not yet sent),
  `provider_accepted` (Resend returned an id), `delivered` (only if a provider
  event says so). The practitioner UI shows which one it actually has.
- **No real messages in this pass.**

### 2.9 Practitioner experience (contract point 9)

- **One flow**: select waitlist people → "Invite to book" → choose service +
  date window + response deadline → review → send.
- The list shows, per invitation: **exact permitted dates**, **service**,
  **response deadline**, and **current outcome**.
- **Reuse existing components only.** `app/(app)/settings/waitlist/page.tsx` is
  the host surface; reuse the existing table, buttons and the
  `CONTROL_MIN_TOUCH` primitive. **No new dashboard, no new design system.**
- **Minimal practitioner-add path**: Chloe has email-only prospects who are not
  clients. Since `create_public_appointment` requires `p_client_id`, a client
  row must exist at commit. Proposal: create it **at booking time** from the
  invitation's own data, not in advance. **Do not fabricate a joining date** —
  the client's `created_at` is the real creation instant, and the waitlist
  entry's original `created_at` remains the record of when they asked.

---

## 3. Exact authorities and components to reuse

| Need | Reuse | Location |
|---|---|---|
| Appointment commit | `create_public_appointment` | migration 0170 |
| Studio-local date window | `horizonRangeInStudioTz`, `isWithinPublicBookingHorizon`, `HorizonRange` | `lib/booking/horizon.ts` |
| Slot computation | existing slot/availability authority | `lib/booking/slots.ts`, `queries.ts` |
| Token generation + hash-at-rest | `generateRawToken`, `hashToken`, `timingSafeHashEqual` | `lib/portal/tokens.ts` |
| Verified recipient (if identity binding is ever required) | portal magic-link/session | `lib/portal/magic-link.ts`, `session.ts` |
| Email send + retry state | `claim_email_send` / `record_email_result` | migrations 0080 / 0098 |
| Email transport + studio identity | `sendEmailSafely`, `studioEmailIdentity` | `lib/email/*` (COMMS-01A, merged) |
| Waitlist lifecycle | `join_`, `claim_`, `issue_`, `expire_`, `release_`, `requeue_`, `record_…conversion`, `remove_` | migration 0188 |
| Entry audit trail | `new_client_waitlist_entry_events` | migration 0188 |
| Route-specific reschedule clamp precedent | `free-consult-reschedule-policy.ts` | `lib/booking/` |
| Practitioner surface | existing waitlist settings page | `app/(app)/settings/waitlist/` |

---

## 4. Genuine forward-schema gaps

Each is required; none can be worked around in application code. **No migration
number is claimed here** — 0192 is spoken for by #674.

| # | Gap | Why it cannot be avoided |
|---|---|---|
| G1 | **Offer scope columns** on the invitation (`scope_service_id`, `scope_start_date`, `scope_end_date`) | The permission must be enforced server-side at commit; storing it client-side or in the URL would let a substituted parameter widen it |
| G2 | **Decline outcome** (`declined_at`, and the declined scope for the re-invite guard) | `released_at` is owner-attributed; a prospect decline needs its own representable outcome |
| G3 | **Token-authorised decline command** | The only existing close path requires `p_actor_user_id`, which a prospect does not have and must not borrow |
| G4 | **Read-only token resolver** | `redeem_` mutates; GET must be able to render an offer without consuming it |
| G5 | **Admission limit** (per-studio integer) + its enforcement in issue/commit | Nothing today counts admissions; capacity cannot be inferred |
| G6 | **EXECUTE grants** for every command the application must call | All are currently revoked from all four roles — literally uncallable |
| G7 | **Scope-bound appointment marker** for the reschedule clamp | Otherwise the ordinary reschedule route escapes the authorised window |

Applied migrations 0185/0188/0189/0190 are **frozen and not edited**; everything
above is forward-only.

---

## 5. Acceptance matrix

| # | Case | Expected | Layer |
|---|---|---|---|
| A1 | Book a date outside `scope_start/end` | refused; no appointment; invitation still live | **DB** |
| A2 | Post a substituted `service_id` | refused; server re-reads scope from the row | **DB** + route |
| A3 | Cross-studio: token from studio A used against studio B | refused, zero rows, no leak | **DB** |
| A4 | Identity substitution: typed email matching an existing client | no attachment to that clinical identity | **DB** + unit |
| A5 | GET the link / preview / reload ×3 | no redeem, no book, no decline, no remove | **DB** + e2e |
| A6 | Replay the same booking submit twice | one appointment; second returns the first | **DB** |
| A7 | Two tabs submit different slots simultaneously | exactly one appointment; other gets a clean retry | **DB** |
| A8 | Two invitations race for the final admission seat | one books; other gets "round is full", not a slot error | **DB** |
| A9 | Slot taken between view and commit | invitation **not** consumed; prospect re-picks | **DB** |
| A10 | Booking races decline / revoke / expiry | exactly one outcome wins; no contradictory triple | **DB** |
| A11 | Reschedule an invitation-created appointment outside scope | clamped/refused | **DB** + unit |
| A12 | Email provider timeout, then reissue | no second live invitation; `one_live_per_entry` holds | **DB** + unit |
| A13 | Declined prospect invited in a later round | permitted; original waiting history intact | **DB** |
| A14 | Expired prospect invited in a later round | permitted | **DB** |
| A15 | Immediate re-invite of the same declined offer | refused by the cool-off guard | **DB** |
| A16 | Existing client books normally throughout | unchanged rights, unchanged behaviour | **e2e** |
| A17 | Old link tries to decline a newer invitation | refused | **DB** |
| A18 | Decline attribution | no owner actor recorded; entry returns to `waiting` | **DB** |

**Negative control for the whole matrix:** with the scope check removed, A1 and
A11 must go red. A matrix that stays green when the enforcement is deleted is
proving nothing.

---

## 6. Bounded implementation plan and proposed file ownership

Four slices; each independently reviewable, none starting until the product
decisions in §7 are settled.

| Slice | Content | Owns |
|---|---|---|
| **B1 — schema** | G1–G7 in one forward migration (number assigned at authoring), plus its DB acceptance tests A1–A18 | `supabase/migrations/<unassigned>_*.sql`, `tests/db/waitlist-scoped-invitation.db.test.ts` |
| **B2 — server** | issue/resolve/book/decline server actions; scope validation; admission counting | `app/(app)/settings/waitlist/actions.ts`, `lib/booking/waitlist-invitation.ts` (new) |
| **B3 — prospect surface** | token landing page, slot picker within scope, decline control | `app/invite/[token]/` (new), reusing existing booking components |
| **B4 — practitioner surface** | "Invite to book" flow and outcome column on the existing waitlist page | `app/(app)/settings/waitlist/page.tsx` + one new component |

B1 must merge and apply before B2 is meaningful, and the migration-first
sequencing already used for 0191 applies unchanged.

---

## 7. Unresolved product choices (NOT technical blockers)

1. **Which service does an invitation authorise?** Not assumed. Consultation is
   deferred by a standing product decision; Chloe must name it.
2. **Default response deadline.** `issue_` currently defaults to 72 hours. Keep,
   or make it per-invitation?
3. **Admission limit value**, and whether it is per-round or standing.
4. **Failed-delivery policy**: controlled reissue (a) or deliver-then-commit (b).
   Recommend (a).
5. **Re-invite cool-off length** after a decline.
6. **Does a booked prospect get ongoing booking access?** Recommend no by
   default; requires an explicit decision.
7. **Forwarded-link tolerance.** Accept bearer semantics, or add a verification
   step? This is a risk decision, not an engineering one.

## 8. Technical blockers (distinct from the above)

- **B1 cannot start** until a migration number is free of #674's 0192.
- **Nothing is callable** until G6 grants EXECUTE; this is the single largest
  "it looks built but isn't" trap in the existing work.
- SMS is out of scope by D1 and blocked independently on Twilio registration.

---

**PROPOSED ONLY. Nothing implemented, no migration authored or numbered, no
hosted mutation, no email or SMS sent, no PR opened.**
