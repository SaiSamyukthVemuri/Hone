# Financials — canonical domain and snapshot contract

| | |
|---|---|
| **Purpose** | Canonical FIN domain and snapshot contract for FIN-02 and later. |
| **Status** | Architecture decision, following the PR #666 prototype and its review. |
| **This document is** | An intended product/engineering contract. |
| **This document is NOT** | Proof of the current production implementation. |
| **Current implementation** | PR #666 is a **held prototype**. It does **not** satisfy the atomic-snapshot contract below. |
| **Next implementation vehicle** | **FIN-02 — atomic financial snapshot authority.** |

Derived from PR #666 (26 commits) and the review history that produced it.
Nothing here is a new invention: every rule was paid for once already — each was
a defect that reached review, was reproduced, and was closed. The purpose of this
document is that the next implementation should not have to pay again.

Historical review records are not rewritten. This document supersedes nothing;
it states the contract FIN-02 must meet.

---

## 0. The one property the current architecture cannot prove

> **A row that comes into existence after the snapshot instant must be incapable
> of affecting the snapshot — even when its business-event date is NULL, and
> even when it is a correction to a row that already existed.**

Application-side bounding cannot establish this. It can bound a row by a
timestamp the row *carries*, but it cannot bound a row by *when the row came into
existence*, because by the time the application can read a row, the row exists.
Several independently-timed HTTP reads have several different implicit snapshots,
and no amount of per-source filtering merges them into one.

This is the single reason the FIN read authority must move server-side. Every
other rule in this document is portable across architectures; this one decides
the architecture.

---

## 1. Money classes — four, never blended

A figure belongs to exactly one class. Two classes never share a total, a
subtotal, or a sentence.

| # | Class | Authority | What it is |
|---|---|---|---|
| 1 | **Provider-verified cash movement** | `payment_charge_attempts` | Money that moved through Stripe in the window — payments taken, refunds sent back, net movement. Not earnings. |
| 2 | **Provider-verified collected-on-delivered** | charges ∩ delivered visits | Money collected *on work delivered in this window*. Numerator and denominator are the same visits, so a per-hour figure over it is a rate over one population. |
| 3 | **Studio-attested external money** | `appointment_settlements` | Cash, e-transfer, other, waived, still-owed. The studio's own word. Hone did not verify it. |
| 4 | **Service value** | services / client pricing / settlement quotes | A price. **Explicitly not cash.** What work was worth, not what was collected. |

**Learned the hard way:** class 1 was once presented in a way that read as
earnings; class 4 was once labelled "at today's prices" while half its rows were
valued at a recorded historical price. A class boundary not visible on screen is
not a class boundary.

---

## 2. Payment states — eight, and UNKNOWN is one of them

Per appointment, reduced across **every** payment row visible at the snapshot:

| State | Meaning |
|---|---|
| `NO_PAYMENT_EVIDENCE` | No qualifying succeeded payment exists. |
| `PAYMENT_EVIDENCE_UNKNOWN` | The read failed. Not "no payment". |
| `PAID_IN_SELECTED_PERIOD` | A dated payment inside the window. |
| `PAID_IN_ANOTHER_KNOWN_PERIOD` | A dated payment outside it. Real money, wrong period. |
| `PAID_DATE_UNKNOWN` | Succeeded, `charged_at IS NULL`. Belongs to no period. Must never be filed as "another period". |
| `TERMINAL_MONEY_RETAINED` | At least one payment that stood at the snapshot. |
| `FULLY_REFUNDED` | See the law below. |
| `REFUND_TIMING_UNKNOWN` | A reversing refund carrying no `refunded_at`. |

### 2.1 The full-refund law

```
FULLY_REFUNDED(appointment) ⟺
      at least one qualifying succeeded payment exists
  AND every evaluable payment is reversed
  AND no terminal (non-reversed) charge remains
  AND no unreadable/unplaceable row prevents the conclusion
```

**Fully-refunded is an ABSENCE of standing money, never the sighting of a
reversal.** Written as a sighting, one reversed charge on a multi-charge visit
reported "refunded in full" while the studio had kept money.

**This is not a per-row property.** The active-charge unique is
`(session_id, stripe_livemode)` — per *session* — and migration 0068 states in
its own header that one appointment may legitimately carry several sessions. Any
derivation mapping rows to appointment ids without reducing is wrong.

### 2.2 Set coherence

Derived appointment-id sets must be **structurally** incapable of contradiction,
not merely unlikely to contradict. Verify exhaustively over the reachable state
space, not by example.

- `FULLY_REFUNDED ∩ TERMINAL_MONEY_RETAINED = ∅`
- `PAID_IN_*_PERIOD ∩ PAID_DATE_UNKNOWN = ∅`

---

## 3. Precedence

1. **Terminal retained card money outranks a stale `still_owes`.** A debt
   followed by a card payment is the ordinary progression, and migration 0187
   ranks Hone-verified money above the attestation.
2. **Fully-refunded money does not outrank `still_owes`** — the money did not
   stay, so it cannot discharge a debt.
3. **The other four settlement methods block a card charge at the database**, so
   a card success beside one is a genuine conflict, not a progression. It stays
   explicit.
4. **UNKNOWN never collapses** to zero, to "no payment recorded", or to a
   confident state. A withdrawn count is correct; a count quietly short is not.
5. **An unknown that is not load-bearing must not be propagated.** If standing
   money already answers the question a count asks, an undatable row elsewhere on
   the same visit does not withdraw it. Withdrawing there hides a fact rather
   than protecting one.

---

## 4. Time — four separate concepts, never conflated

| Concept | Example | Question it answers |
|---|---|---|
| **Business-event timestamp** | `charged_at`, `refunded_at` | When did the money move? |
| **Row-existence timestamp** | `created_at`, `recorded_at` | When did Hone learn of it? |
| **Snapshot timestamp** | the published instant | What was true when this page was prepared? |
| **Version interval** | `recorded_at` → `superseded_at` | Which version of this record was live then? |

**The defect this table exists to prevent:** a succeeded payment with
`charged_at IS NULL` was treated as unbounded by the snapshot, on the reasoning
that it "belongs to no period". It belongs to no *business* period — but the row
still came into existence at a knowable moment (`created_at`), and a row created
after the snapshot changed the snapshot's answer. Business-event time and
row-existence time are different questions and need different bounds.

### 4.1 Instants are compared as instants

**Never order timestamps as strings.** One instant has several valid ISO
spellings: PostgREST renders `2026-08-01T04:00:00+00:00` (no fractional part when
zero, microseconds when not) while `toISOString()` renders
`2026-08-01T04:00:00.000Z`. These do not order lexicographically —
`'+'` (0x2B) < `'.'` (0x2E) < `'Z'` (0x5A) decides the answer instead of the
clock.

Observed failures: a visit on the period boundary vanished from every money
figure while remaining in the calendar census; a refund 123µs after the snapshot
read as though it had already happened.

- Parse to epoch before comparing. An unparseable value is `null` — **never 0,
  never the epoch**, because a zero there is a real 1970 that sorts malformed
  time before everything.
- An unreadable instant must be *disclosed*, never silently bucketed. Dropping a
  row with an unreadable start silently decides it fell before the floor.
- Keep this as a guard, not a sweep. Two instances existed; only one was found by
  review. The next one will look just as reasonable.

---

## 5. Settlement — a version store, with exactly one truth per instant

`appointment_settlements` (migration 0187) is genuinely versioned, and the
guarantees are load-bearing:

- `recorded_at` is stamped by the insert trigger and frozen by the append-only
  guard;
- `superseded_at` is write-once — never re-pointed, never returned to NULL;
- no role holds DELETE;
- every payload column is immutable. A correction inserts a new row and retires
  the old one.

### 5.1 The version-selection law

```
live_at(T) ⟺ recorded_at < T AND (superseded_at IS NULL OR superseded_at >= T)
```

**The upper bound is inclusive, and this is forced, not chosen.** A correction
retires the predecessor with `superseded_at = now()` and inserts its successor in
the *same transaction*, where the insert trigger stamps `recorded_at = now()`.
Both are `transaction_timestamp()`, so predecessor-end and successor-start are
the same value to the microsecond. With an exclusive upper bound, a `T` landing
exactly on a supersession selects **neither** version and the visit's settled
money disappears.

Under the snapshot authority in §7 this reconstruction becomes unnecessary: the
snapshot *is* `T`, so "currently live" is exactly "live at `T`". The law is
retained here because it is what any application-side reader must do, and because
it documents why the boundary is what it is.

### 5.2 Ambiguity

| Versions live at T | Meaning | Behaviour |
|---|---|---|
| exactly 1 | normal | use it |
| 0 | honest absence — nothing was attested yet | absence, **completeness intact** |
| more than 1 | the history itself is malformed | UNKNOWN / fail closed |

**No arbitrary row-order winner, anywhere.** Ambiguity must fail closed in
**every** consumer derived from the settlement rows, not only in the
attested-money total. A known defect of this shape: the money loop skipped
ambiguous visits while the recorded-price map still took the last row by
iteration order, feeding service value, chargeability and unresolved value from a
version that money had already refused. **Any consumer of a version store needs
the same guard.**

---

## 6. Reads

- **Every studio-wide read is page-safe.** Unique-`id` ordering, short-page stop,
  whole-read failure. A read reporting more rows than it returned fails the
  census; it never caps silently. Three separate 1000-row cliffs were found this
  way, each a total silently truncated.
- **Fail closed, and fail whole.** A census assembled from the reads that happened
  to succeed is the exact shape of a confident understatement. One bad read
  withdraws every figure, carrying the cause.
- **Studio-wide rather than `.in(id, [...])`.** An id list grows with the period,
  and an over-long generated URL is a live production failure on this codebase,
  not a hypothesis.
- **Stripe livemode scoping on every money read.** Migration 0105 permits one TEST
  and one LIVE succeeded attempt per session; an unscoped read double-counts.

---

## 7. The required authority — pinned architecture decision

**`RECOMMENDED_FIN_AUTHORITY` = a single transaction-scoped database read.**

All financial input rows are observed inside **one** database transaction
snapshot, with the snapshot instant taken from that same transaction.

```
SNAPSHOT_INSTANT       transaction_timestamp() (or equivalent) inside the one
                       read transaction

PAYMENT VISIBILITY     the row must EXIST in the snapshot

UNDATED PAYMENT        charged_at NULL does NOT mean invisible; the row's
                       existence is decided by the MVCC snapshot

REFUND VISIBILITY      refund state observed inside the same snapshot; unknown
                       chronology remains UNKNOWN where chronology matters

SETTLEMENT VERSION     the current/live settlement inside that same snapshot

AMBIGUOUS SETTLEMENT   UNKNOWN for EVERY derived consumer — money, service
                       value, chargeability, unresolved value

SERVICE PRICE BASIS    the settlement quote where frozen; otherwise the price
                       visible in the same snapshot

UNKNOWN                withdraw the affected fact with its cause; never
                       manufacture 0, "no payment", or "no refund"
```

Under this authority, most of §4 and §5.1 stop being application concerns:

- a row created after the snapshot is **invisible by construction** — snapshot
  visibility *is* the bound, including for `charged_at IS NULL` rows;
- "currently live" is exactly "live at the snapshot" again;
- appointments, services and client pricing are read at the same instant as the
  money, so cross-source figures cannot disagree;
- the published instant is true of *every* figure on the page rather than of some
  of them.

### 7.1 Execution rights — INVOKER, not `SECURITY DEFINER`

**`EXECUTION RIGHTS = INVOKER RIGHTS.`**

`SECURITY DEFINER` must **not** be used unless a future, separately reviewed
security decision proves it necessary.

**Reason:** the `authenticated` RLS policies already represent the
tenancy/security boundary. Verified while writing this document: `authenticated`
holds `SELECT` on `appointment_settlements` under an RLS policy, while
`service_role` is deliberately denied it (migration 0187). An invoker-rights
function keeps every existing policy in force. A definer-rights function bypasses
RLS and would require re-implementing studio scoping by hand — strictly more
privilege risk, and against the grain of 0187's own design.

**Do not hand-roll studio scoping inside a definer function.** The read authority
must not bypass RLS for convenience.

**Grants must revoke explicitly from `anon`, `authenticated` and `service_role`
by name.** Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to all three at
function-create time. This was missed in migration 0129 (`anon`) and again in
0164 (`service_role`).

---

## 8. What the page may claim

- A point-in-time claim may only be printed over figures whose sources can
  actually be read as of that instant.
- Sources mutated in place with no version history — `appointments.status`,
  `services.price_cents`, `client_pricing` — cannot carry a *historical* claim.
  Under §7 they can carry an *as-at-the-snapshot* claim, which is a different and
  achievable statement.
- Where a total mixes two bases, the label states the **population**; only the
  accompanying sentence can state the basis, because the basis is exactly what
  varies row by row.
- Never claim earnings. Cash movement is not earnings; service value is not cash.

---

## 9. PR #666 reuse plan

PR #666 is held as a prototype. Its failure is confined to the **read authority**;
its domain logic, presentation and surface work were reviewed extensively and
stand.

**Reuse**

- `lib/finance/financial-briefing-model.ts` — the pure census, arithmetic,
  precedence and state matrix
- `lib/finance/financial-copy.ts`
- `lib/finance/financial-fact.ts`
- `app/(app)/financials/financial-spine.tsx`
- `app/(app)/financials/page.tsx`
- `app/(app)/business/page.tsx`
- higher-level and e2e truth tests where still semantically valid

**Supersede**

- `lib/finance/financial-briefing.ts` — the multi-read loader architecture
- loader tests whose purpose is per-read bounding, pagination, or version
  reconstruction; those concerns move into the snapshot authority or disappear

**Estimated reuse: ~75% of runtime code.** This is the architecture-stop
**estimate**, not a formal line-count guarantee. The model's *inputs* simplify
under §7 — the bounding sets and version parameters largely disappear — while its
arithmetic, precedence and Fact semantics carry over intact.

---

## 10. FIN-02 acceptance contract

FIN-02 must prove, at minimum:

| # | Must prove |
|---|---|
| 1 | **One DB snapshot** — all financial input rows come from one transaction snapshot |
| 2 | **Post-snapshot insert** cannot affect the current result |
| 3 | **Post-snapshot refund** cannot affect the current result |
| 4 | **Post-snapshot settlement correction** cannot affect the current result |
| 5 | **An undated payment inserted after the snapshot** cannot affect the current result |
| 6 | **Ambiguous settlement** yields no arbitrary quote winner and no arbitrary money winner |
| 7 | **RLS** — the same studio/tenant protections remain effective |
| 8 | **UNKNOWN** — a failed or unprovable fact never becomes zero |

Cases 2–5 are the properties the current architecture cannot establish, and are
the reason FIN-02 exists. They must be proven against a real database, not a stub.

FIN-02 must also **retain the domain-state matrix already paid for in #666** —
§1 money classes, §2 payment states and the full-refund law, §3 precedence, §4
time separation, §5 settlement versioning and ambiguity.

---

## 11. Non-negotiables for the next implementation

1. **Reproduce before repairing.** Every defect above was reproduced first, and
   two "obvious" ones turned out to be false.
2. **Mutation-check every fix, and treat a surviving mutation as a finding about
   the tests.** Two surviving mutations in this history each exposed a test
   asserting something the defect did not change.
3. **Never let a stub prove a query shape.** A stub returns whatever it is
   handed; projections, filter syntax and timestamp formats need the real
   database.
4. **When a defect class is found, census the class.** Both times a class was
   patched at its reported site only, a second instance was already present.
