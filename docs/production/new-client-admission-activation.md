# NEW-CLIENT-MODE-01 — activation plan

**This document is the CUTOVER authority. The PR that adds the code is not.**
Nothing here has been executed. No production value has been read, written or
inferred while writing it.

## The rule this plan exists to honour

Code release and data/config cutover are **separate authorities**. Merging the
code changes no studio's behaviour, because the transition bridge keeps every
studio on exactly the mode its env list already gives it. A studio's mode moves
only when someone deliberately writes it.

## What the code already guarantees before any cutover step

- `studios.new_client_admission_mode` defaults to `open`, which reproduces
  today's behaviour for every studio **absent** from
  `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`.
- The bridge in `lib/booking/new-client-admission.ts` escalates **one way**: a
  listed studio resolves to `waitlist` even while its row still says `open`. It
  can never move a studio to `open`.
- Therefore **Willow stays WAITLIST through cutover** without anyone writing a
  row, because it is on the list today.
- `waitlist` now *means* durable. There is no second switch, so no cutover step
  can move a studio's submissions to email-only.

## What must NOT be inferred

The current value of `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` and
`NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` in production is a **Vercel secret**.
This plan does not read it, and no studio's mode may be derived from historical
rows, from `docs/`, or from what a waitlist entry's existence seems to imply. A
studio that has waitlist entries may have been opened since; a studio with none
may be waitlisted and simply unvisited.

**The authoritative source at cutover is the live env value, read at that
moment by whoever holds the credential.**

## The transition rule

**The env bridge protects only UNMIGRATED / UNCHOSEN rows. The first deliberate
owner write cuts that studio over to persisted authority.**

0204 adds `new_client_admission_mode` as `not null default 'open'`, so the moment
it applies every row reads `open` — and nobody chose that. The fact that
separates a backfill from a decision is `new_client_admission_mode_set_at`, which
`set_new_client_admission_mode` stamps on every successful write:

| stored mode | `set_at` | legacy slug listed | effective | authority |
|---|---|---|---|---|
| `open` | NULL | yes | `waitlist` | `legacy_bridge` |
| `open` | NULL | no | `open` | `legacy_bridge` |
| `open` | **non-null** | yes | **`open`** | `persisted` |
| `waitlist` | non-null | either | `waitlist` | `persisted` |
| `closed` | non-null | either | `closed` | `persisted` |
| column absent (pre-0204) | — | either | env decides | `legacy_bridge` |
| read failed | — | either | `unknown` | refuses |

So an owner who selects **Accept bookings** becomes OPEN immediately, even while
their slug is still in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, and `closed` → `open`
really reopens booking rather than reopening to a waitlist. That is not a
loophole; it is the point. The alternative — which shipped briefly and was caught
in review — reported a successful save and then silently refused the choice,
which is the one thing this control must never do.

The bridge remains ONE-WAY for unchosen rows: it may escalate a stamp-less `open`
to waitlist, and it may never make a studio less restricted than its own row
says.

## Steps, in order

1. **Merge and deploy the code.** No behaviour change, and that is now a
   property of the code rather than an assumption about the env.

   An earlier draft of this document claimed the same thing while the code
   committed **every** permitted join durably as soon as it deployed. That was
   false for a supported configuration: a studio named in
   `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` but **not** in
   `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` commits by email acceptance
   today, and the deploy would have moved its commit point before anyone chose
   to. Nothing here had established that such a studio does not exist, and
   nothing here can — those are Sensitive values, read only at step 3.

   The commit point now follows the studio's **current** configuration until
   its durable mode is actually persisted. See
   `lib/booking/new-client-waitlist-durability-bridge.ts`.

   Verify by checking that a listed studio still shows the waitlist form and an
   unlisted one still books.

   The verification now reads the ADMISSION state rather than the calendar:
   structural readiness (an active service plus an open availability day) no
   longer hides the waitlist, closed or unreadable surfaces, so a listed studio
   shows the waitlist form even if its calendar is not set up. Readiness still
   decides the OPEN surface, because for `open` the surface IS the booking form.
   Before this, a listed-but-unready studio showed the generic "still being set
   up" copy, and this step could have failed for a reason that had nothing to do
   with admission.
2. **Apply migration 0204.** Every row gets `open`; the bridge keeps listed
   studios on `waitlist`. Still no behaviour change — the column is written but
   nothing reads it as an owner's decision yet, so every studio is still
   `source: "legacy_bridge"`.
3. **Read the live env lists** from Vercel. Record the exact slug set in the
   apply record — this is the only moment the real configuration enters the
   written record. **Record both lists**, including which listed studios are
   absent from the durable list: those are the studios whose commit point
   changes at step 4, and that is the one behaviour change in this plan.
4. **Write each listed studio's mode** to `waitlist` through
   `set_new_client_admission_mode`, owner-authenticated, one studio at a time.

   This write is also what CUTS THAT STUDIO OVER: it stamps `set_at`, so from
   then on its stored mode is authoritative and the legacy list no longer moves
   it. A studio whose owner has already chosen a mode is therefore already cut
   over and needs no write here — check `set_at` before assuming a studio is
   still on the bridge.
   Willow is in this set.

   This is the cutover, and for a studio that was NOT in the durable list it
   moves the commit point from email acceptance to a durable row. Intended, and
   deliberate per studio — it is why this step is one studio at a time.
5. **Verify each written studio** still shows the waitlist form and still
   writes a durable row on join. The row, not the email, is the check.

   `newClientAdmissionIsCutOver` is the structural check: after step 4 a
   written studio resolves `source: "persisted"`, and from then on the durable
   path is unconditional for it — removing its legacy durable slug cannot
   return it to email-only.
6. **Only then remove the NEW-CLIENT ADMISSION bridge.** After every waitlisted
   studio is stamped, delete, together:
   `lib/booking/new-client-waitlist-durability-bridge.ts`, `envForcesWaitlist`
   and its call, `NewClientAdmissionSource`, and
   `newClientAdmissionIsCutOver`. The durable path then becomes unconditional,
   which is what `waitlist` means.

   **`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` CANNOT BE DELETED AT THIS STEP, AND
   NEITHER CAN `isNewClientWaitlistEnabled`.** A second, separate policy still
   depends on them: EMERG-01's free-consult reschedule restriction
   (`lib/booking/free-consult-reschedule-policy.ts`) reads that env list as its
   own authority, deliberately, so that an owner changing new-client admission
   cannot move the rights of an appointment that is already confirmed.

   That policy is **bounded follow-up debt**. Retiring or replacing its legacy
   mechanism needs its own product decision and its own durable authority, and
   until that decision exists this step removes the admission bridge only. Doing
   otherwise would silently restore self-service movement of free consultations
   at every studio EMERG-01 currently covers.

Steps 3-6 require production credentials and are **not** in scope for the
implementation PR.

## Rollback

**Rollback depends on whether the studio has been STAMPED, not on which step you
are on.** `new_client_admission_mode_set_at` is the test.

| studio state | how to roll back |
|---|---|
| **unstamped** (`set_at` NULL, still on the legacy bridge) | restoring its slug to `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` restores its previous waitlist behaviour, for as long as the bridge remains |
| **stamped** (`set_at` non-null, an owner has chosen) | an explicit `set_new_client_admission_mode(<studio>, 'waitlist')` command. **The env list cannot do it.** |

**Never claim that restoring an env slug overrides an explicit owner choice.** It
does not, by design: `resolveAdmission` returns a stamped mode before it consults
the bridge at all, so for a studio whose persisted choice is `open`, restoring
its slug changes nothing while the operator believes the rollback succeeded.

This matters precisely because step 4 lets an already-stamped studio be skipped:
a studio can be stamped without anyone running step 4 for it, simply because its
owner used the Settings control first. Check `set_at` before choosing a rollback
route, not the step number.

## What this plan deliberately does not do

- It does not delete any environment variable as part of the code PR.
- It does not set any studio's mode from a guess.
- It does not touch existing-client, portal or rebook behaviour at any step.
  This is load-bearing and was briefly violated: an earlier version of this PR
  routed EMERG-01's free-consult reschedule policy through the new admission
  mode, so an owner flipping OPEN / WAITLIST / CLOSED moved the rights of
  already-confirmed appointments. That policy now keeps its own authority.
- It does not retire EMERG-01's env authority. See step 6.
