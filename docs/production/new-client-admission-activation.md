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
6. **Only then remove the env vars.** After this the bridge is dead code.
   Delete, together: `lib/booking/new-client-waitlist-durability-bridge.ts`,
   `envForcesWaitlist` and its call, the two exported env predicates,
   `NewClientAdmissionSource`, and `newClientAdmissionIsCutOver`. The durable
   path then becomes unconditional, which is what `waitlist` means.

Steps 3-6 require production credentials and are **not** in scope for the
implementation PR.

## Rollback

Before step 6 the env list is still authoritative-by-escalation, so restoring a
slug restores waitlist behaviour immediately. After step 6 rollback is a row
write through the same command, which an owner can perform themselves.

## What this plan deliberately does not do

- It does not delete any environment variable as part of the code PR.
- It does not set any studio's mode from a guess.
- It does not touch existing-client, portal or rebook behaviour at any step.
