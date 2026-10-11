# WAIT-v4 PR1 — contract ownership and compatibility design

**Design only. No behaviour, no migration, no number claimed.** Basis: production
`6c5eac80537d67118ae2d5df581fa52dbf25d691` (the #821 merge). Every repo fact below
was re-verified at that head; nothing is restated from an earlier packet or from
memory.

## 0. What this document is, and the one input it does not have

The frozen contract for the eight limbs below is **[§14.5.7 WAIT-04 — frozen Chloe
launch contract](./CANONICAL_ROADMAP.md)**, with its accepted architecture in
§14.5.5A (clocks) and §14.5.5B (atomicity). Those are in this repository and are
cited here by section.

**Two limbs are NOT specified there: reservation and cohort.** Their specifications
are in the v4 plan, which is not in evidence in this repository — the same verified
absence the PR4/PR8 handoff recorded on 2026-10-02, still true at this head. This
document therefore states, for those two, **what the repo can support and what any
contract answer must satisfy**, and does not invent their content. If the v4 plan
defines them differently, the plan wins and §3.1 / §3.3 must be re-derived.

**Migration availability, rechecked at this head:** repo max **0210**, hosted
**0210**, pending **none** (PARITY), next free **0211**, permanently skipped 0158,
no duplicates, nothing malformed. **`0209` and `0210` are applied and FROZEN.**
PR1 claims **no** number; any later v4 PR must re-derive at the moment of claim.

---

## 1. One correction this PR makes, because v4 would otherwise land on a false premise

`docs/production/current-state.md:579` asserts:

> **Fixed/no-choice 48h policy remains open** because the composer still permits
> alternate TTLs

**That is false at this head**, and it matters because §14.5.7D makes it a
precondition: *"WAIT-04C / dual-channel delivery — Precondition: fixed/no-choice
48h policy already enforced."* Reading the claim literally, WAIT-04C is blocked.
It is not.

Verified:

| Evidence | At `6c5eac80` |
|---|---|
| `lib/waitlist/invitation-window.ts:24` | "THE WINDOW IS FIXED AT 48 HOURS, AND NOBODY CHOOSES IT." |
| `lib/waitlist/invitation-window.ts:63` | `export const WAIT_INVITATION_TTL_HOURS = 48;` |
| `components/waitlist/invite-composer.tsx` | reads the constant — no TTL choice surface |
| TTL-choice surface (24 / 72 / 168 / custom) | **none** — the only `24`/`72` hits are the join-ack rate limit and Resend idempotency |
| Guard | `tests/lib/waitlist/wait-48-fixed-window.test.ts`, plus `tests/lib/waitlist/invitation-window.test.ts` |

PR1 corrects that one clause and nothing else in that file.

---

## 2. Ownership model — who may change what

| Authority | Owner | Shipped location |
|---|---|---|
| Admission allowance and round lifecycle | **practitioner**, by command | `open_/close_new_client_waitlist_admission_round` (0192) |
| Seat consumption count | **database**, derived | `waitlist_admission_round_consumed` (0192), gateway `read_waitlist_admission_round_consumed` (0197) |
| Invitation issuance and its immutable facts | **practitioner**, once | `new_client_waitlist_invitations_append_only` (0200:261) |
| Response (book / decline / update / remove) | **recipient**, proof-bound | §14.5.7B; B3 `/invitation/[token]` |
| Response deadline | **server**, fixed | `WAIT_INVITATION_TTL_HOURS = 48` |
| Expiry outcome | **server**, after the deadline | §14.5.7B "only after authoritative deadline" |
| Suppression / STOP | **recipient**, channel-scoped | existing suppression authority (#767), LIVE |
| Clinic-initiated move | **practitioner**, no penalty | §14.5.7C |

**The ownership law this implies:** every WAIT state transition is owned by exactly
one actor class, and §14.5.7B's "Authority / race condition" column requires that
the owner be re-established *at mutation time*, not inherited from the surface that
rendered. §14.5.5A adds the read/write split: **"Open/preview/reload/GET must never
book, consume, decline or remove."**

---

## 3. The eight limbs

### 3.1 Reservation ownership — a v4 ADDITION that contradicts shipped copy

* **Contract in repo:** §14.5.7A "Public response — no exact position guarantee or
  fabricated wait-time estimate"; an invitation is sent "when matching consultation
  times become available".
* **Shipped:** `studio_calendar_reservations` with `ReservationRow` /
  `ReservationExclusion` (`lib/booking/slots.ts`) are **appointment and timed-block**
  protected intervals. There is **no WAIT reservation authority.**
* **The live promise says the opposite:** `NOT_A_RESERVATION` — *"Joining the
  waitlist does not reserve an appointment."*

> ⚠️ **The promise is duplicated, and the routed surface renders the duplicate.**
> `lib/waitlist/join-copy.ts:40` exports the constant, and
> `app/book/[slug]/NewClientWaitlistForm.tsx:102` **re-declares the same sentence as
> a local literal**, rendering it at `:160` and `:411`.
> `components/waitlist/waitlist-join-form.tsx:17` imports the shared constant but
> that component is not routed. **A contract that introduces a reservation must
> change both, and changing only the shared constant leaves the live page making the
> old promise.**

* **Constraints any contract answer must satisfy:** it owns the copy change and its
  disclosure consequence; it must say what a prospect is being promised; and its
  exclusion surface is the one `0209` just tightened, so a reservation must compose
  with the buffer-protected candidate window rather than re-deriving it.

### 3.2 Scheduling locks — a shipped divergence any v4 lock inherits

| Migration | `for update` on `public.studios` | `for no key update` |
|---|---|---|
| 0192 (round + recipient proof) | **3** | 0 |
| 0193 (admission authority) | 0 | **11** |
| 0204 | 0 | 1 |

* `for update` on a parent row conflicts with the FK key-share locks taken by inserts
  that reference it; `for no key update` does not. The **shipped round commands take
  the stronger lock**, so a v4 round-level or cohort-level lock composed with them
  inherits that contention.
* **`requeue_new_client_waitlist_entry` (0200) deliberately takes no row lock.** Any
  v4 limb must not add one there.
* **Constraint:** a v4 lock must declare its **mode**, its **position in the ordering**,
  and the ordering it shares with 0192's commands. Lock mode is pinned by
  `tests/db/waitlist-admission-authority.db.test.ts` and the 0202/0206/0207
  migration tests, so a change is visible, not silent.

### 3.3 Cohort limits — not in this repo, and not necessarily the round

* **Contract in repo:** §14.5.7B "one opportunity and one response deadline, **not
  two invitations**".
* **Shipped grouping primitive:** `studio_waitlist_admission_rounds` (0192) —
  `allowance integer NOT NULL CHECK (allowance >= 0)`, refusals `round_already_open`,
  `no_round_open`, `no_admission_round`, `round_full`.
* **"Cohort" exists nowhere** in `lib/`, `app/` or `supabase/migrations/` — the only
  match is `lib/security/headers.ts`, an unrelated sense.
* **Constraint:** whether the v4 cohort **is** the admission round, a superset of it,
  or something else is **not derivable from this repo. Do not assume it is the
  round.** Until it is specified, `DeliveryKind` must not widen and no per-channel
  truth number may be claimed, because the disposition's grain may depend on it.

### 3.4 The shared deadline — blocked by an immutability law, not merely absent

* **Contract in repo:** §14.5.7B — "one opportunity and **one response deadline**";
  "Fixed 48 hours; no expiry question in Chloe's composer".
* **Shipped:** fixed per-invitation 48h (§1 above).
* **No round-level deadline exists.** `studio_waitlist_admission_rounds` (0192:81)
  holds `allowance`, `opened_at`, `opened_by_practitioner_id`, `closed_at`,
  `closed_by_practitioner_id`, `updated_at` — **a round closes by actor, not clock.**

> ⚠️ **`expires_at` is IMMUTABLE on an issued invitation.** The append-only trigger
> `new_client_waitlist_invitations_append_only` (0200:261) refuses any update that
> changes `id`, `studio_id`, `entry_id`, `token_hash`, `issued_at`, **`expires_at`**
> or `issued_by_practitioner_id`. **A shared deadline therefore cannot be implemented
> by rewriting issued invitations' expiry.** It must be either a new round-level
> column composed at read time, or a new forward migration that amends the trigger —
> and `0200` is applied and frozen, so it is never edited in place.

* **Unresolved seam, already flagged by the contract:** §14.5.7E — the 48-hour clock's
  threshold, "sent" versus "delivered/accepted". *"Provider acceptance does not prove
  inbox visibility."* A shared deadline inherits this question, it does not settle it.

### 3.5 Atomic launch and booking — the contract forbids overstating it

* **Contract in repo:** §14.5.5B, titled **"DO NOT OVERSTATE ATOMICITY"**:
  *"Atomic admission is not atomic appointment creation."* #685 rolls back partial
  claiming if issuing an invitation fails; separately, **B2 consumes the invitation
  before the appointment exists.**
* **Required client outcomes — three, not two:** confirmed booked · definitively
  consumed without booking · indeterminate transport outcome. *"'Already used' alone
  does not prove"* booked.
* **Explicitly forbidden:** inventing a second booking engine, and silently calling
  release/reissue.
* **Shipped discipline to reuse:** 0193's atomic waiting→claimed→invited wrapper;
  `claim_new_client_waitlist_entry(_ies)`; and 0207, where
  `claim_waitlist_invitation_sms` holds the invitation **`FOR NO KEY UPDATE`** — the
  claim-before-provider-call pattern.
* **Constraint:** a v4 launch is a fan-out over many invitations. The accepted
  single-invitation limitation does not become acceptable *n* times over in silence;
  a launch must report per-invitation outcomes in the same three-way split.

### 3.6 Withdrawal — the explicit opt-out event is not shipped

* **Contract in repo:** §14.5.7B "Remove me from the waitlist → leave the active list
  and **stop further automated waitlist invitation/contact attempts**. Explicit
  opt-out event."
* **And the distinction that must not be collapsed:** *"**SMS STOP is not, by itself,
  leave-waitlist** or consent to another channel. Respect distinct policies."*
* **Shipped:** the STOP / suppression authority is LIVE and wired (#767);
  `close_unbooked_new_client_waitlist_invitation` (0200) closes an offer. There is
  **no `withdraw` authority** anywhere in `lib/`, `app/` or `supabase/migrations/`.
* **Constraint:** withdrawal is a **waitlist-scoped** opt-out event, distinct in
  storage and in effect from channel suppression. It must not permanently ban the
  person (§14.5.7B's expiry rule says the same of non-response).

### 3.7 Cancellation and move restoration — two different priority rules, easy to get backwards

> **The contract deliberately separates these, and reversing them would be a product
> defect, not a style choice.**

| Event | Contract | Priority result |
|---|---|---|
| "These times don't work — keep my place" (§14.5.7B) | close the current offer, return/remain waiting | **ORIGINAL** waiting-time priority |
| "Update my availability — keep my place" (§14.5.7B) | update preference, close this offer | **preserve** waiting-time priority |
| "Cancel and return to waitlist" (§14.5.7C) | client confirms cancellation | **NEW** waiting-time priority; **previous spot is NOT held** |
| "Cancel and leave" (§14.5.7C) | separate explicit intent | leaves; no forced waitlist contact |
| Clinic-initiated / practitioner-approved move (§14.5.7C) | authorized practitioner command | **no waitlist penalty** |
| Request to reschedule online (§14.5.7C) | **not permitted** for first consultations | enforce in confirmation / reminder / portal / old-link routes **and server mutation** |

* **Shipped:** `requeue_new_client_waitlist_entry` (0200) returns a **released or
  expired** prospect to waiting.

> ⚠️ **Requeue cannot serve the cancellation case.** It refuses with
> `already_redeemed` — *"that entry has spent an admission seat"* — which is exactly
> the state of an entry that booked and then cancelled. The §14.5.7C NEW-priority
> restoration therefore needs a **different** path, and that path must also not add a
> row lock to requeue (§3.2).

### 3.8 Expiry authority — server-owned, after the deadline, never a ban

* **Contract in repo:** §14.5.7B "No response at 48 hours → remove from the active
  waitlist under the disclosed policy, **not permanently ban the person**. Only after
  authoritative deadline, no qualifying response."
* **Shipped:** the fixed 48h window; `close_unbooked_new_client_waitlist_invitation`
  (0200); the live-invitation read (0198).
* **Not shipped:** WAIT-specific 24-hour reminder eligibility, which §14.5.7B
  requires ("one reminder through eligible channels if the invitation is still
  awaiting response"), and which has **no round-level expiry counterpart**.
* **Constraint:** expiry is evaluated against the **authoritative** deadline, so if a
  shared deadline is introduced (§3.4) the expiry authority must read the same clock,
  and §14.5.5A requires it stay distinct from the appointment date range, the
  proof-challenge expiry and the verified-capability expiry — **four clocks, kept
  separate.**

---

## 4. Affected existing paths

**Database (applied, frozen — compose, never edit):** 0192 round + recipient proof ·
0193 admission authority · 0197 consumed-count gateway · 0198 live invitation read ·
0200 redeemed-unbooked exit, append-only trigger, requeue · 0202 profile + consent
authority · 0203 mobile verification · 0204 admission mode · 0207 serialized SMS
claim · 0208 consent + signup answer · **0209 slot-candidate buffer window** ·
**0210 join acknowledgement**.

**Runtime:** `lib/waitlist/` — `invitation-window.ts`, `invitation-capacity.ts`,
`round-consumption-server.ts`, `invite-to-book-contract.ts`,
`invite-to-book-adapter.ts`, `b4-invitation-draft.ts`, `join-profile.ts`,
`join-copy.ts`, `invitation-offer.ts`, `delivery/*` · `lib/booking/slots.ts`,
`public-slot-range.ts`, `new-client-admission.ts`, `waitlist-invitation.ts` ·
`app/book/[slug]/` — `NewClientWaitlistForm.tsx`, `waitlist-actions.ts`, `page.tsx` ·
`app/(app)/settings/waitlist/` · `components/waitlist/` — `invite-composer.tsx`.

**Docs:** §14.5 of the roadmap (the integration surface) ·
`docs/production/current-state.md` (§1 correction) ·
`docs/roadmap/CAPABILITY_MANIFEST.json`, which carries **no** WAIT entry at all and
is stale (`as_of` 2026-07-30, `hosted_migration_max` 0160 against an actual 0210) —
v4 **adds** an entry there; it supersedes nothing.

**Do not retire `CANCEL-RECOVERY-01`** as a side effect. It is about *existing*
clients and released appointment capacity, not the new-client waitlist, and line
1466 says explicitly "Not Cancellation Recovery." Retiring it is a cross-domain
decision needing an owner ruling that names it by id.

---

## 5. Boundaries of later PRs

| PR | Owns | Entry gate |
|---|---|---|
| **PR1 (this)** | contract ownership, compatibility surface, the §1 correction | none — docs only |
| **PR2** | reservation authority **or** cohort authority, whichever the v4 plan specifies first | **the v4 plan's text for §3.1 / §3.3.** Blocked without it. |
| **PR3** | shared deadline at round level | PR2's grain; and a forward migration for §3.4's immutability law |
| **PR4** | post-commit initial email + eligible SMS (the **SMS limb only** — the email half ships) | reservation **and** cohort both implemented; `DeliveryKind` must not widen before then |
| **PR8** | 24h reminder + expiry / delivery-evidence gating | §14.5.7E's sent-vs-delivered threshold decided |
| PR5-PR7, PR9-PR11 | response UX, restoration paths, acceptance | not scoped here |

**Anti-scope for PR1:** no change to the composer, `invitation-window.ts`, delivery,
consent, or any round command; no migration; no `lib/`, `app/` or `components/`
change. Every behavioural limb belongs to a later PR.

---

## 6. Not established

The v4 plan's text for **reservation** and **cohort** (§3.1, §3.3) — recorded as
verified absence, not guessed. §14.5.7E's six bounded seams remain open as the
contract leaves them. No hosted database was read for this document; the migration
figures are the committed record plus the derivation at this head. Nothing was
implemented, no number claimed, and `0209`/`0210` are untouched and frozen.
