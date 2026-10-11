# WAIT-ROUND-01 v4 — PR1: contract, ownership and compatibility

**Design only. No behaviour, no migration, no number claimed.**

**Authoritative target behaviour:** the frozen **WAIT-ROUND-01 v4** contract
(roadmap edition of 2026-10-07), reproduced as target in §2 below.

**§14.5.7 "WAIT-04 — frozen Chloe launch contract" is v4's PREDECESSOR, not its
target.** Where the two differ, v4 governs; §5 lists each supersession explicitly.
An earlier revision of this document mistakenly treated §14.5.7 as the target and
recorded reservation and cohort as unspecified. **Both are specified in v4. That
gate was false and is removed.**

**Compatibility constraints are labelled separately, in §3.** They are verified
observations about production at
`6c5eac80537d67118ae2d5df581fa52dbf25d691` — what the code does today. They
constrain *how* v4 is reached; they never qualify *what* v4 requires.

---

## 1. Scope of PR1

PR1 owns this document and one correctness fix (§6). It implements nothing.
**PR2 is unstarted.** `0209` and `0210` are applied and frozen. Waitlist SMS is off.

---

## 2. v4 TARGET BEHAVIOUR

### 2.1 Round identity and shape

* **One live round per studio**, belonging to **one practitioner** and **one
  consultation service / duration**.
* **Drafts reserve nothing.**
* A **launched** round has **K** real, mutually non-conflicting **buffered**
  consultation times and **M** distinct people, with **1 ≤ M ≤ K**.
* **One weekday OR weekend pool.** The cohort is **fixed** — no additions after
  launch.

### 2.2 The invariants

| Symbol | Meaning |
|---|---|
| **R** | remaining **unbooked reservations** |
| **U** | **active unbooked invitations**, *including pending/uncertain delivery* |
| **C** | **admission consumption** — **not** calendar inventory |

**While the round is open: `R ≥ U` and `C ≤ M`.**

### 2.3 Automatic proposals

* Driven by **queue priority**, **weekly intake room**, and a default **14-day
  horizon**.
* **Kind** follows the **longest-waiting eligible person**. **Both** looks ahead to
  the next single-kind person; otherwise the **greater clean-time count**, with
  **weekday winning ties**.
* **K = min(weekly room, compatible times, eligible people).**
* **Weekly room** counts new-client consultation bookings **committed in the
  trailing seven days, across all channels**.

### 2.4 Candidate times and ranking

* Candidates begin **no earlier than `now + 48 hours + authoritative booking
  notice`**.
* Ranking: **protect treatment capacity**, then **spread days**, then **prefer
  earlier times**.
* **Treatment-length** means the **longest active treatment duration plus its
  buffer**.
* **Launch revalidates against its actual instant** — a proposal is not a promise.

### 2.5 Changing people, and the waitlist picker

* "Change people" and the picker use the **same eligibility and the same weekly-room
  cap** as automatic proposal.
* **Opposing weekday/weekend selections produce two proposals; only one launches.**
* **Skipped people retain priority.**
* Automatic and final cohorts are **audited**.
* **No count override.**

### 2.6 Launch

* **One scheduling-locked database transaction** creating **the reservations and the
  invitations together**.
* **Provider delivery happens only after commit.**
* **One shared 48-hour deadline** for the round.
* A **failed or stale launch leaves no partial state.**

### 2.7 Recipient booking

* Booking **atomically converts one reservation to an appointment AND redeems the
  invitation**.
* **Failure leaves both untouched.**
* **"Consume first, then create appointment" is LEGACY behaviour to replace** — it is
  not the v4 target. *This sentence is the v4 contract's own clarification, quoted,
  not an inference from the repository;* the repository evidence for what that legacy
  path does is kept separately in §3.4.

### 2.8 What a recipient sees and may do

* Recipients see **only the current remaining reserved times**.
* **Keep-place / availability-update** closes **this** offer and **preserves queue
  priority**.
* **Leaving the waitlist is a separate recipient action.**

### 2.9 Withdrawal — a studio write that removes reserved time

Withdrawal is **any studio write removing reserved time**: availability changes,
blocks, **service / buffer / timezone / notice** changes, **owner booking**, or
**moves into reservations**.

* Removing **q** rows requires **`R − q ≥ U`** — **or** the named offers must be
  **resolved in the same transaction**.
* **Owner status is not a bypass.**

### 2.10 Cancellation and move restoration

* Cancelling or moving a **round-derived** appointment **while its round is live**
  **restores its OWN original reservation, atomically**.
* Its **invitation stays used**; **U and C do not increase**; **weekly room returns**.
* This is the **only post-launch operation allowed to increase R**.
* **Closed rounds never revive.**
* **Scope note:** this rule governs calendar and invitation state, and applies
  whatever the client's intent was. It does **not** address the person's **queue
  priority**, which §14.5.7C governs and which **depends on the intent**: "cancel and
  return to waitlist" gives a NEW waiting-time priority, while "cancel and leave"
  returns them to no queue at all. Neither is superseded. See §3.5 and §5.

### 2.11 Freed time that is not round-derived

* **Ordinary freed time never joins a live round.**
* **Far-out** freed time feeds **future proposals**.
* **Near-term** freed time goes to **REBOOK-01**, for compatible **active, due,
  unbooked existing clients with no future appointment**.

### 2.12 Deadline, close and reminder

* **Deadline enforcement works even if cleanup is late.**
* **Close is idempotent.**
* **Uncertain or failed delivery is NOT non-response.**
* **One reminder at 24 hours after launch**, for still-active unbooked invitations.
* **Messages never list appointment times.**

### 2.13 The join disclaimer stays true

**Joining the waitlist alone STILL does not reserve an appointment.** Anonymous
calendar reservations arise **at round launch**, not at join. The existing join
disclaimer is therefore **correct under v4** and must **not** be classified as
false. (An earlier revision of this document implied it was. It is not.)

---

## 3. COMPATIBILITY CONSTRAINTS — verified production findings

Each verified at `6c5eac80`. These say what today's code does. They are inputs to
sequencing, not amendments to §2.

### 3.1 Reservation storage does not exist for WAIT, and the calendar primitive is appointment-scoped

`studio_calendar_reservations`, with `ReservationRow` / `ReservationExclusion`
(`lib/booking/slots.ts`), holds protected intervals for **appointments and timed
blocks**. v4's **anonymous, round-launch reservations (§2.1, §2.6)** are new storage.
Their exclusion surface is the one **`0209`** has just corrected to cross local
midnight, so §2.4's buffered candidate window must **compose with** that corrected
window rather than re-deriving it.

### 3.2 The join disclaimer is duplicated — do not "fix" one copy

`NOT_A_RESERVATION` is exported from `lib/waitlist/join-copy.ts:40` **and
re-declared as a local literal** at `app/book/[slug]/NewClientWaitlistForm.tsx:102`
(rendered `:160`, `:411`); `components/waitlist/waitlist-join-form.tsx:17` imports
the shared constant but is not routed.

Under §2.13 the sentence **stays**. This is recorded so that nobody later edits one
copy believing they have changed the live promise — **the routed surface renders the
duplicate.**

### 3.3 Lock-mode divergence that §2.6's scheduling-locked transaction inherits

Counted as **executable statements that lock `public.studios`**, excluding comment
lines — a raw phrase count is misleading here (0193 has 11 lines containing
`for no key update`, of which **2 are comments**, and 0192 has 20 lines containing
`for update` of which only 3 lock `studios`):

| Migration | `for update` on `public.studios` | `for no key update` on `public.studios` |
|---|---|---|
| 0192 (round + recipient proof) | **3** | 0 |
| 0193 (admission authority) | 0 | **9** |
| 0204 | 0 | 1 |

`for update` on a parent row conflicts with the FK key-share locks taken by inserts
referencing it; `for no key update` does not. §2.6's launch transaction must declare
its **mode** and its **ordering** against 0192's commands. Lock mode is pinned by
`tests/db/waitlist-admission-authority.db.test.ts` and the 0202/0206/0207 migration
tests, so a change is visible rather than silent.

**`requeue_new_client_waitlist_entry` (0200) deliberately takes no row lock** — and
under §2.10 it is **not** the restoration mechanism (§3.5), so nothing in v4 should
add one to it.

### 3.4 The legacy booking path is the one §2.7 replaces

`§14.5.5B` records the shipped limitation: **B2 consumes the invitation before the
appointment exists**, so the current client outcome must distinguish confirmed
booked / definitively consumed without booking / indeterminate transport.

**That is the legacy behaviour §2.7 replaces**, not a constraint on v4. v4's
convert-and-redeem is one atomic step whose failure leaves both untouched, which
**removes** the consumed-without-booking state for round-derived bookings. The
legacy three-way outcome remains the truth for **legacy invitations** (§4) until
they drain.

### 3.5 Restoration is a new operation, not requeue

`requeue_new_client_waitlist_entry` (0200) returns a **released or expired** prospect
to waiting and refuses `already_redeemed` — *"that entry has spent an admission
seat."*

Under §2.10 a cancelled round-derived appointment's **invitation stays used** and
**C does not increase**, so the entry is *supposed* to stay redeemed. **v4
restoration therefore does not go through requeue at all**: it restores the
**reservation**, not the queue position. The two must not be conflated, and requeue's
refusal is not an obstacle to §2.10.

**But the queue position is still governed** — by §14.5.7C, which §2.10 does not
replace. So a cancellation has **two independent effects, and only the first is
intent-free**:

1. **The reservation returns to the live round** (§2.10) — this follows from the
   appointment being round-derived and the round being live, whatever the client
   chose.
2. **The queue consequence depends on which intent the client chose**, and §14.5.7C
   offers two:
   * **"Cancel and return to waitlist"** → a **NEW** waiting-time priority; the
     previous spot is not held.
   * **"Cancel and leave"** → **no queue return at all.** The contract is explicit:
     cancel *"without forcing someone back into waitlist contact"*, an explicit
     separate intent.

**Do not apply the queue return to every cancellation.** An earlier revision of this
section said "a cancellation has two separate effects that must both be implemented",
which wrongly swept cancel-and-leave into the queue return.

### 3.6 The shared deadline is set at launch, and then protected

The append-only trigger `new_client_waitlist_invitations_append_only` (`0200:261`)
refuses any update changing `id`, `studio_id`, `entry_id`, `token_hash`, `issued_at`,
**`expires_at`** or `issued_by_practitioner_id`.

Because §2.6 creates invitations **inside the launch transaction**, the one shared
48-hour deadline is stamped at creation and the trigger then **protects** it. This is
**supporting**, not blocking — but it does mean a deadline can never be *amended*
later by writing to invitations; anything post-launch must read a round-level clock
or amend the trigger by a new forward migration (`0200` is frozen).

### 3.7 Today's deadline authority and the absent reminder

`WAIT_INVITATION_TTL_HOURS = 48` (`lib/waitlist/invitation-window.ts:63`); the
composer reads the constant and offers no choice; pinned by
`tests/lib/waitlist/wait-48-fixed-window.test.ts`. The fixed window is therefore
already the per-invitation law, which §2.6's **shared** deadline generalises to the
round.

`studio_waitlist_admission_rounds` (`0192:81`) has **no deadline column** — a round
closes **by actor**. §2.6's shared deadline and §2.12's idempotent close are new
round-level state. The **24-hour reminder of §2.12 does not exist** for WAIT.

### 3.8 Admission consumption already exists, and §2.2 keeps it distinct

`allowance` on `studio_waitlist_admission_rounds`, `waitlist_admission_round_consumed`
(0192) and the gateway `read_waitlist_admission_round_consumed` (0197) are the shipped
consumption authority. §2.2's **C is admission consumption, not calendar inventory** —
so C maps onto this existing authority while **R** is new reservation state. Keeping
them separate is a contract requirement, not an implementation preference.

### 3.9 Weekly room has no shipped counter

§2.3's weekly room — new-client consultation bookings committed in the trailing seven
days **across all channels** — has no existing counter. "All channels" spans the
public booking path, practitioner booking and owner booking, so it cannot be derived
from the waitlist tables alone.

---

## 4. Legacy invitation compatibility versus new-round authority

These are two regimes and must not be merged:

| | **Legacy invitation** (shipped) | **v4 round** (target) |
|---|---|---|
| Origin | practitioner issues one invitation | round launch creates reservations + invitations in one transaction (§2.6) |
| Reserved time | **none** | K buffered times, anonymous until booked (§2.1) |
| Deadline | per-invitation fixed 48h (§3.7) | **one shared** 48h for the round (§2.6) |
| Booking | consume, then create appointment (§3.4) | **atomic** convert + redeem (§2.7) |
| Cancellation | §14.5.7C, **two intents**: "cancel and return to waitlist" → new priority, spot not held; **"cancel and leave" → no queue return at all** | **restore its own reservation**, invitation stays used (§2.10) — and the queue consequence stays §14.5.7C's, by intent |
| Grouping | admission round allowance | fixed cohort M, with R/U/C invariants (§2.2) |

**Existing live offers and appointments must not be invalidated by installing v4
authority.** Legacy invitations keep legacy semantics until they drain; v4 semantics
apply to round-derived objects. Any shared surface (the recipient page, the delivery
path, the close/expiry job) must branch on which regime an object belongs to rather
than assuming one.

---

## 5. Where v4 supersedes §14.5.7 (WAIT-04)

| Limb | §14.5.7 (predecessor) | v4 (target) |
|---|---|---|
| Reservation | not addressed; join is explicitly not a reservation | anonymous reservations **at launch**; join still reserves nothing (§2.13) |
| Cohort | **no cohort rule.** (§14.5.7B's "one opportunity and one response deadline, not two invitations" at `CANONICAL_ROADMAP.md:1373` is a **dual-channel delivery** rule — email plus eligible SMS are *one* opportunity — **not** a cohort rule, and it is **not** superseded.) | v4 **introduces** the fixed cohort **M**, `1 ≤ M ≤ K`, no additions (§2.1) |
| Deadline | fixed 48h **per invitation** | **one shared** 48h per round (§2.6) |
| Booking atomicity | consume-then-create, three outcomes accepted | **atomic** convert + redeem; failure leaves both untouched (§2.7) |
| Cancel → waitlist, **calendar and invitation state** | not addressed | **restores its own reservation**; invitation stays used; U and C unchanged; weekly room returns (§2.10) |
| Freed time | not addressed | never joins a live round; far-out → proposals, near-term → REBOOK-01 (§2.11) |
| Withdrawal | recipient opt-out event | **also** a studio write removing reserved time, gated by `R − q ≥ U` (§2.9) |

**NOT superseded, and still binding:**

* **§14.5.7C's cancellation rules are not replaced.** §2.10 governs only the
  **calendar and invitation state** of a round-derived appointment (its reservation
  restored, invitation still used, U and C unchanged). It says nothing about the
  person's queue position, so the **queue consequence remains §14.5.7C's and remains
  intent-dependent** — see rows 2 and 3 below, and §3.5. **This bullet deliberately
  does not restate the rule**; two earlier revisions stated it unqualified here and
  swept cancel-and-leave into a queue return it does not get.
* **§14.5.7B — all eight rows bind, except where §5's table above records v4 as
  generalising one.** Listed in the contract's own row order, because a partial
  summary reads as exhaustive:
  1. **Send invitation** — email plus eligible consented SMS are **one** opportunity,
     not two invitations; delivery failure does not fabricate an issuance failure.
     *(v4 generalises only the per-invitation 48h to one shared round deadline; the
     dual-channel rule itself is untouched.)*
  2. **24-hour reminder** — **one** reminder through eligible channels if the
     invitation is still awaiting response, with per-invitation / per-channel /
     per-event dedupe and a re-check of consent and lifecycle at send time.
     *(v4 §2.12 anchors it at 24 hours **after launch** and restricts it to
     still-active unbooked invitations; the dedupe and send-time re-check stand.)*
  3. **Book a time** — only permitted live consultation slots, and the result is
     recorded; proof-bound capability **plus** current admission, identity, scope and
     booking authority. *(v4 §2.7 adds atomicity; these authority requirements stand.)*
  4. **"These times don't work — keep my place"** — close the current offer, return or
     remain waiting with **original** waiting-time priority; no repeat invitation.
  5. **"Update my availability — keep my place"** — update the structured preference,
     close this offer, preserve waiting-time priority; one governed response path, and
     no mutation of another person's record.
  6. **"Remove me from the waitlist"** — leave the active list and stop further
     automated waitlist invitation and contact attempts; an **explicit opt-out event**.
  7. **No response at 48 hours** — remove from the active waitlist under the disclosed
     policy and **never permanently ban the person**, and **only** after the
     authoritative deadline with no qualifying response. *(v4 §2.12 adds
     late-cleanup safety, idempotent close, and that uncertain or failed delivery is
     not non-response.)*
  8. **SMS STOP** — stop SMS through the existing suppression authority. **STOP is
     not, by itself, leave-waitlist**, and not consent to another channel.
* **§14.5.7C in full — all nine rows bind, not only the ones v4 touches.** Listed
  here because a partial summary reads as an exhaustive one:
  1. **Request to reschedule online** — no client-controlled rescheduling of first
     consultations, enforced in confirmation / reminder / portal / old-link routes
     **and** server mutation.
  2. **Cancel and return to waitlist** — NEW waiting-time priority; previous spot not held.
  3. **Cancel and leave** — cancel without forcing the person back into waitlist contact.
  4. **Clinic-initiated / practitioner-approved move** — no waitlist penalty.
  5. **Consultation no-call / no-show** — permanent clinic-scoped self-service booking
     restriction, with **no automatic expiry or reinstatement**.
  6. **Owner exception** — a manual booking of an exceptional case **does not clear**
     the restriction; audit the exception.
  7. **Incorrect no-show / protected need** — explicit owner correction and a private
     accommodation/review path; **correction and exception are distinct records**.
  8. **Client identity / scope** — the restriction belongs to the clinic's
     authoritative client/person identity; never an unverified browser email alone,
     and never leak blocked-person state.
  9. **Existing treatment clients** — preserve unrelated treatment
     booking/cancellation/rescheduling semantics, via a canonical first-consultation
     classification rather than a service-name heuristic.
* §14.5.5A — **open/preview/reload/GET never book, consume, decline or remove**, and
  the response deadline, appointment date range, proof-challenge expiry and
  verified-capability expiry are kept **distinct**.

---

## 6. One correction PR1 makes

`docs/production/current-state.md:579` claimed *"Fixed/no-choice 48h policy remains
open because the composer still permits alternate TTLs."* **False at this head**:
`WAIT_INVITATION_TTL_HOURS = 48`, the composer reads that constant, no
24/72/168/custom surface exists, and `wait-48-fixed-window.test.ts` pins it. One
clause corrected; nothing else in that file.

---

## 7. Affected existing paths

**Database (applied, frozen — compose, never edit):** 0192 round + recipient proof ·
0193 admission authority · 0197 consumed-count gateway · 0198 live invitation read ·
0200 redeemed-unbooked exit, append-only trigger, requeue · 0202 profile + consent ·
0203 mobile verification · 0204 admission mode · 0207 serialized SMS claim · 0208
consent + signup answer · **0209 slot-candidate buffer window** · **0210 join
acknowledgement**.

**Runtime:** `lib/booking/slots.ts`, `public-slot-range.ts`,
`new-client-admission.ts`, `waitlist-invitation.ts` · `lib/waitlist/` —
`invitation-window.ts`, `invitation-capacity.ts`, `round-consumption-server.ts`,
`invite-to-book-contract.ts`, `invite-to-book-adapter.ts`, `b4-invitation-draft.ts`,
`join-profile.ts`, `join-copy.ts`, `invitation-offer.ts`, `delivery/*` ·
`app/book/[slug]/` · `app/(app)/settings/waitlist/` · `components/waitlist/`.

**Docs:** §14.5 of the roadmap · `docs/production/current-state.md` (§6) ·
`docs/roadmap/CAPABILITY_MANIFEST.json`, which carries **no** WAIT entry and is stale
(`as_of` 2026-07-30, `hosted_migration_max` 0160 against an actual 0210) — v4 **adds**
an entry; it supersedes nothing there.

---

## 8. The frozen PR sequence

| PR | Scope |
|---|---|
| **0** | buffer fix — **COMPLETE** (#820, `0209` applied) |
| **1** | **contract / compatibility — this PR** |
| **2** | reservation storage, calendar integration, locks |
| **3a** | automatic proposal |
| **3b** | manual cohort authority |
| **3c** | picker |
| **4** | atomic launch + post-commit delivery |
| **5** | recipient flow + atomic booking |
| **6** | withdrawal paths |
| **7** | cancellation / move restoration |
| **8** | expiry / close / reminder |
| **9** | practitioner UI |
| **10** | REBOOK-01 |
| **11** | controlled acceptance |

**CANCEL-RECOVERY and Fast Fill are excluded from the v4 launch.** Excluded is not
retired: **no unrelated backlog ID is retired globally** by v4, and
`CANCEL-RECOVERY-01` in particular is about existing clients and released appointment
capacity (roadmap line 1466 says explicitly "Not Cancellation Recovery"), so any
retirement would be a cross-domain decision needing an owner ruling that names it by id.

---

## 9. Scheduling ownership — coordination

PR2's reservation storage, the calendar integration and the lock discipline of §3.3
are **shared scheduling surfaces**. Ownership must be settled with **#824** before PR2
opens, so that two lanes do not both claim `lib/booking/slots.ts`,
`public-slot-range.ts` or the reservation exclusion path.

**At the time of writing, #824 is not open** and no branch for it exists on the
remote, so its file ownership could not be read. This is recorded as an open
coordination item, not as a settled boundary. PR0's superseded draft **#781** also
remains open and untouched.

---

## 10. Migration availability, and what stays frozen

Rechecked at this head: repo max **0210**, hosted **0210**, pending **none**
(**PARITY**), **next free 0211**, permanently skipped 0158, no duplicates, nothing
malformed. **`0209` and `0210` are applied and FROZEN.** PR1 claims **no** number;
PR2 and later must re-derive at the moment of claim.

---

## 11. Not established

§2 is reproduced from the supplied frozen v4 contract; where this document paraphrases
it, the contract governs. The six bounded seams of §14.5.7E remain as the predecessor
left them, except where §2 settles them. No hosted database was read for this
document. Nothing was implemented, no number claimed, PR2 is unstarted, and waitlist
SMS is off.
