# NEW-CLIENT-MODE-01 — activation plan

**This document is the CUTOVER authority. The PR that adds the code is not.**

⚠️ **SCOPE OF THIS PREAMBLE: THE PLAN, NOT THE RECORD.** When the plan below was
written, nothing in it had been executed and no production value had been read,
written or inferred. **That is no longer true of the document as a whole**, and the
sentence is kept — scoped — rather than deleted, because it states the condition the
plan was authored under. **Steps A–D and G HAVE since been executed**, and the
**EXECUTION RECORD** — now a separate file,
[new-client-admission-execution-record.md](./new-client-admission-execution-record.md)
— documents real production reads and writes: migration `0204` applied, PR #773
deployed, one studio's mode written by its owner, and a public durable join. An
earlier revision left this preamble unqualified while the execution record was
appended below it, so the document asserted both that nothing had been executed and
that steps had been — **that contradiction is withdrawn.** The plan text itself is
unchanged, and was never retrofitted to match the outcome, so **read this file as the
procedure and the execution record as what happened to it.**

**THIS FILE IS THE CONTRACT; THE RECORD FILE IS EVIDENCE.** This file is frozen by
sha256 in `tests/lib/booking/new-client-admission.test.ts`, end to end, and holds the
declared `claim-status` directives. Execution records append to the other file and
**cannot redefine anything here** — on any apparent conflict, this file wins.

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
- Therefore **a listed studio stays WAITLIST through cutover** without anyone
  writing a row, because it is on the list today — for as long as it remains
  UNSTAMPED. A deliberate owner write stamps `set_at` and from then on its stored
  mode wins, including `open`. See *The transition rule* below.
- `waitlist` MEANS durable as the long-term law, **but not yet everywhere.**
  During the bridge there is still a SECOND switch,
  `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS`, and a studio listed for waitlist
  but absent from it commits joins through the legacy EMAIL-ACCEPTANCE path
  rather than writing `new_client_waitlist_entries`.

  That is deliberate: a code deploy must not move a studio's commit point before
  anyone chose to. `newClientWaitlistCommitIsDurable` is the decision, a stamped
  studio is always durable regardless of that list, and step H retires the second
  switch. Until then this document must not claim there is only one.

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
separates an INITIALIZED authority from a row that never had one is
`new_client_admission_mode_set_at`.

**Since 0205, non-null `set_at` does NOT mean "an owner chose".** It means the
persisted admission authority **has been initialized**, and there are two
writers that initialize it:

| `set_at` | `set_by` | what the row is |
|---|---|---|
| NULL | NULL | never initialized — a **pre-0204 legacy row**. Unstamped transition semantics apply. |
| non-null | NULL | **system-initialized at studio creation** by 0205's column default. Persisted `open`, no cutover ceremony. |
| non-null | set | an **owner changed the mode** through `set_new_client_admission_mode`. |

`set_by` is NULL at creation because the owner practitioner does not exist when
the studio row is inserted — `handle_new_user()` (0081) creates it on the
owner's first sign-in — so that NULL is structural, not a convention.

Effective-admission resolution asks only "initialized or not", so both
initialized states resolve identically:

| stored mode | `set_at` | legacy slug listed | effective | authority |
|---|---|---|---|---|
| `open` | NULL | yes | `waitlist` | `legacy_bridge` |
| `open` | NULL | no | `open` | `legacy_bridge` |
| `open` | **non-null** | yes | **`open`** | `persisted` |
| `waitlist` | non-null | either | `waitlist` | `persisted` |
| `closed` | non-null | either | `closed` | `persisted` |
| column absent (pre-0204) | — | either | env decides | `legacy_bridge` |
| read failed | — | either | `unknown` | refuses |

A studio created since 0205 therefore lands on the `persisted` / `open` row from
birth, and its owner can select Open, Waitlist or Closed immediately.

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

**MIGRATION FIRST. The application is deployed AFTER 0204 is applied and
verified, not before.**

An earlier version of this plan deployed the code at step 1 and applied 0204 at
step 2. That order became wrong the moment new-client booking started calling
`create_public_appointment_for_new_client`: between those two steps the function
does not exist, so every ordinary new-client booking would have failed. The fix
is the order, not a permanent missing-RPC fallback in the booking path.

The order is safe in the other direction, and that is why it is the clean one:

- the production application does not call the new 0204 RPCs, so adding the
  columns, functions and grants is **inert** to every path it does run;
- it never writes the new admission fields, so every row stays unstamped and
  `set_at IS NULL`;
- the legacy env behaviour therefore remains authoritative until the new
  application is deployed.

**A. Verify the production migration baseline.** `npm run migration:state --
--json` for the repository view, and `docs/production/migration-state.json` for
what production has actually applied. Confirm 0204 is the next free number and
that nothing else has claimed it.

**B. Apply 0204.** One migration, its own transaction, its own
`lock_timeout`. Record the apply in `docs/production/migration-ledger.md` and
update `docs/production/migration-state.json` in the same change.

**C. Verify 0204 is hosted, and that its functions and grants are right.**
Read-only, `supabase db query --linked`, never `db execute`. Confirm:

- the three `studios` columns exist, and `new_client_admission_mode_set_at` is
  NULL on every row — nothing has been stamped yet;
- exactly ONE foreign key still relates `studios` and `practitioners`
  (`practitioners_studio_id_fkey`), so the `studio:studios(*)` embeds are intact;
- `set_new_client_admission_mode` is executable by `authenticated` and by
  NOBODY else — not `anon`, not `service_role`, and **not `PUBLIC`**;
- `effective_new_client_admission` and `assert_new_client_admission` are
  executable by **nobody**;
- the three composed commands are executable by `service_role` only.

**D. Deploy the #773 application.** Only now does anything call the new RPCs.
Behaviour is unchanged at this point: every row is unstamped, so the legacy
bridge still decides, and the durable list still decides each studio's commit
point. Verify a listed studio still shows the waitlist form and an unlisted one
still books.

**E. Read the live bridge configuration.** Read both env lists from Vercel and
record the exact slug sets in the apply record — this is the only moment the
real configuration enters the written record. **Record which listed studios are
absent from the durable list:** those are the studios whose commit point moves at
step F, and that is the one behaviour change in this plan.

**F. Cut each listed studio over, one at a time**, by writing `waitlist`
through `set_new_client_admission_mode`, owner-authenticated. This write is the
cutover: it stamps `set_at`, so from then on the stored mode is authoritative,
the legacy list no longer moves that studio, and its joins commit durably.

A studio whose owner has already chosen a mode is already cut over and needs no
write here — check `set_at` before assuming otherwise.

Note the order this forces, and it is deliberate: **until a studio is cut over,
its owner cannot switch to OPEN or CLOSED.** The command answers
`legacy_waitlist_cutover_required`, because the legacy email-only path commits
through an external provider and no check can make an owner transition and an
in-flight join mutually exclusive. Writing `waitlist` is the way out.

**G. Leave Willow in WAITLIST, and verify a DURABLE join.** Willow is in the
listed set and must remain WAITLIST through and after cutover. After its step-F
write, confirm the public form still offers the waitlist AND that a join writes a
`new_client_waitlist_entries` row — the row, not the email, is the check. Its
owner mode control is fully available only once that is true.

**H. Retire the bridge machinery only after acceptance.** After every listed
studio is stamped and verified, delete together:
`lib/booking/new-client-waitlist-durability-bridge.ts`, `envForcesWaitlist` and
its call, `NewClientAdmissionSource`, `newClientAdmissionIsCutOver`, the
`p_legacy_bridge_waitlist` and `p_legacy_email_only` command arguments, and the
legacy email-only submission path.

**AND RETIRE THE DURABLE ENV GATE WITH IT, because deleting the bridge is what
makes it dead.** The bridge is the only runtime consumer of
`isNewClientWaitlistDurableEnabled` — pinned by a call-site guard in
`tests/lib/booking/new-client-waitlist-durability-bridge.test.ts` — so once it
goes, these control nothing and must not be left for operators to maintain:

- the `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` Vercel variable;
- `NEW_CLIENT_WAITLIST_DURABLE_SLUGS_ENV` and
  `isNewClientWaitlistDurableEnabled` in `lib/booking/new-client-waitlist.ts`;
- its row in the deploy-time env report (`scripts/check-production-env-gates.mjs`)
  and that script's test;
- its row in `docs/10_DEPLOYMENT_AND_ENV.md`;
- the containment guard that keeps the list of files naming it closed.

This is not a new decision: `waitlist` MEANS durable, and the second list was
accepted only as migration/rollback compatibility with a clean deletion point.
This is that point. **Deleting the variable is the LAST act**, after the code
that reads it is gone, so no deploy can land a build expecting a value nobody is
setting.

**`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` CANNOT BE DELETED HERE, AND NEITHER CAN
`isNewClientWaitlistEnabled`.** A second, separate policy still depends on them:
EMERG-01's free-consult reschedule restriction
(`lib/booking/free-consult-reschedule-policy.ts`) reads that env list as its own
authority, deliberately, so that an owner changing new-client admission cannot
move the rights of an appointment that is already confirmed.

That policy is **bounded follow-up debt**. Retiring or replacing its legacy
mechanism needs its own product decision and its own durable authority, and
until that decision exists this step removes the admission bridge only. Doing
otherwise would silently restore self-service movement of free consultations at
every studio EMERG-01 currently covers.

Steps A-C and E-G require production credentials and are **not** in scope for
the implementation PR.

## Rollback

⚠️ **READ THIS FIRST: "ROLLBACK" MEANS TWO DIFFERENT THINGS HERE, AND ONLY ONE OF THEM
EXISTS FOR A CUT-OVER STUDIO.**

<!--
  DECLARED CLAIM STATUS. The directive on the next line is machine-read and
  pinned by tests/lib/booking/new-client-admission.test.ts - same idiom as the
  canonical-facts:ignore-* directives elsewhere in docs/production. It carries
  exactly two assignments and no prose; this comment is where the prose goes,
  because a directive that accepts commentary also accepts a second assignment.

  Retiring the rule below means editing that directive, which fails the test and
  is legible in the diff. Prose cannot reverse it. The verdict row must appear
  EXACTLY ONCE in this document with the directive sitting on it.

  AND THIS WHOLE ROLLBACK SECTION IS FROZEN by sha256 in that same test, so any
  edit here - a reworded row, an appended paragraph, a footnote - fails until the
  hash is updated deliberately. That is the point: this section has already
  shipped two false operator procedures.
-->
<!-- claim-status id=commit-point-rollback-supported value=active -->
| what you want to undo | is it supported? |
|---|---|
| **ADMISSION MODE** — open / waitlist / closed | **YES**, through `set_new_client_admission_mode`, by the studio's owner. |
| **COMMIT POINT** — returning a studio to WAIT-01 **email-only** intake | **NO — not supported by any existing mechanism for a cut-over studio.** |

**Why the commit point is a one-way door.** `newClientWaitlistCommitIsDurable` is explicit
that *persisted WAITLIST is durable, independent of the legacy durable list*. So of the
three modes: `waitlist` keeps the studio **durable** (that is the law, not a bug);
`open` gives ordinary new-client booking with **no waitlist at all**; `closed` shuts
new-client intake. **None of them restores email-only intake.** Clearing either env list
does not either — for **new-client commit-point routing** it governs only a studio
still on the legacy bridge. ⚠️ **That scope is new-client routing only.**
`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` is read independently by EMERG-01's free-consult
reschedule restriction, so editing it at a **cut-over** studio still changes whether an
already-confirmed free consultation can be self-service moved. See the step-H note.

<!--
  DECLARED CLAIM STATUS, as above. The paragraph below is HISTORY: it records a
  promise this plan used to make and no longer makes. Do not restate it as
  guidance anywhere in this section, and do not append a retraction after it -
  the section hash covers both.
-->
<!-- claim-status id=commit-point-rollback-via-mode-write value=withdrawn -->
**Do not describe a mode transition as a commit-point rollback.** An earlier revision of
this section did: it listed `set_new_client_admission_mode(<studio>, 'waitlist')` as the
rollback for a stamped studio, which changes the mode and leaves the commit point durable.
That is **withdrawn**. An operator following it would believe a commit-point rollback had
succeeded while durable rows kept being written — the same failure as the env-edit
instruction it replaced.

**If legacy email-only intake is ever genuinely required again, it needs a NEW, explicitly
designed and supported mechanism** — a product decision with its own authority and its own
proof, not an operator workaround and not a mode write.

**Rollback depends on whether the studio has been STAMPED, not on which step you
are on.** `new_client_admission_mode_set_at` is the test — but read `set_by`
alongside it, because since 0205 a stamped row may have been initialized by the
system at creation rather than by an owner.

| studio state | what can be undone |
|---|---|
| **unstamped** (`set_at` NULL, still on the legacy bridge) | restoring its slug to `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` restores its previous waitlist behaviour, for as long as the bridge remains — **this is the only state in which an env edit changes NEW-CLIENT ADMISSION OR THE COMMIT POINT** — it is *not* the only state in which an env edit changes anything, because `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` still drives EMERG-01's free-consult reschedule restriction at a stamped studio too (see the step-H note below) |
| **0204 applied, application not yet deployed** (between steps B and D) | nothing to roll back at the data layer: the deployed application calls none of the new RPCs and writes none of the new fields, so the migration is inert. Roll back by not deploying. |
| **system-initialized** (`set_at` non-null, `set_by` NULL — created since 0205, never owner-changed) | **ADMISSION MODE only**, through an explicit `set_new_client_admission_mode(<studio>, <mode>)` command — the env list cannot do it. There is nothing to "roll back" to: `open` is this studio's intended starting state and it was never on the legacy bridge, so no commit point has been passed. |
| **stamped by an owner** (`set_at` non-null, `set_by` non-null) | **ADMISSION MODE only**, through an explicit `set_new_client_admission_mode(<studio>, <mode>)` command — the env list cannot do it. ⚠️ **The COMMIT POINT cannot be undone at all**: writing `waitlist` leaves the studio durable, and `open` / `closed` remove the waitlist instead of restoring email-only. See the one-way-door note above. |

**Never claim that restoring an env slug overrides an explicit owner choice.** It
does not, by design: `resolveAdmission` returns a stamped mode before it consults
the bridge at all, so for a studio whose persisted choice is `open`, restoring
its slug changes nothing while the operator believes the rollback succeeded.

This matters precisely because step F lets an already-stamped studio be skipped:
a studio can be stamped without anyone running step F for it, simply because its
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
- It does not retire EMERG-01's env authority. See step H.
- It does not deploy application code before the migration it depends on. The
  order is A-H above, and the migration comes first because the new RPCs do not
  exist until it lands.
- It does not pretend the legacy email-only path can be made atomic with an
  owner mode change. While a studio is still on that path its owner simply
  cannot switch to OPEN or CLOSED; the command answers
  `legacy_waitlist_cutover_required` and the way out is the cutover write.

---

## Where the execution history lives

Records of what was actually executed are in
[new-client-admission-execution-record.md](./new-client-admission-execution-record.md),
append-only and dated. They are evidence, not instruction: **this file is
authoritative on any conflict.**
