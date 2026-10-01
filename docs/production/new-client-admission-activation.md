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

**Rollback depends on whether the studio has been STAMPED, not on which step you
are on.** `new_client_admission_mode_set_at` is the test.

| studio state | how to roll back |
|---|---|
| **unstamped** (`set_at` NULL, still on the legacy bridge) | restoring its slug to `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` restores its previous waitlist behaviour, for as long as the bridge remains |
| **0204 applied, application not yet deployed** (between steps B and D) | nothing to roll back at the data layer: the deployed application calls none of the new RPCs and writes none of the new fields, so the migration is inert. Roll back by not deploying. |
| **stamped** (`set_at` non-null, an owner has chosen) | an explicit `set_new_client_admission_mode(<studio>, 'waitlist')` command. **The env list cannot do it.** |

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

## EXECUTION RECORD — 2026-10-01

**This section is a record of what was executed, not an instruction.** The plan
above is unchanged; nothing in it was rewritten to match the outcome. Steps A–D
and G are DONE, **E was never performed**, F is **partial by design**, and H is
**not started**.

Canonical cross-references: the migration apply and the release-level summary live
in [migration-ledger.md](./migration-ledger.md); hosted migration state lives in
[migration-state.json](./migration-state.json). Those are authority. This is the
step-by-step narrative.

| Step | State | What happened |
|---|---|---|
| **A** · verify baseline | **DONE** | Hosted max `0203`, 202 history rows, `0204` absent, nothing above `0203`, no remote-only migration, `studios` admission columns 0, all six new functions absent. `0204` confirmed the next free number and the only local-only migration. |
| **B** · apply `0204` | **DONE** | One `supabase db push --linked`, no `--include-all`, CLI pinned `2.102.0`, exit code 0, no retry. Dry-run named `0204` only and the set was re-asserted programmatically before the push. Recorded in the ledger and in `migration-state.json`; `hosted_migration_max` advanced `0203 → 0204`. |
| **C** · verify `0204` hosted | **DONE** | Max `0204`, recorded exactly once, nothing above it, 203 rows. Three columns present; `set_at` NULL on **every** row — nothing stamped. Exactly ONE FK between `studios` and `practitioners` (`practitioners_studio_id_fkey`), so the `studio:studios(*)` embeds survived. `set_new_client_admission_mode` executable by `authenticated` and nobody else — not `anon`, not `service_role`, not `PUBLIC`. `effective_new_client_admission` and `assert_new_client_admission` executable by **nobody**. The two composed commands `service_role`-only. **One deviation found and recorded, not fixed:** `studios_admission_mode_guard()` has no explicit revoke, so `anon`/`authenticated`/`service_role`/`PUBLIC` hold EXECUTE. Unexploitable — return type `trigger` — but it needs `0205`, because `0204` is frozen. |
| **D** · deploy #773 | **DONE** | Merged as `d7e712efa28c4c9ef8d2e224f9250cc68c4e6ae4` (true merge commit, parents `[a5e179f2, d8617859]`) at `2026-10-01T20:25:16Z`; production deployment `dpl_AQrWznf5fKqLKPZiH4RNCgDFwxsZ` READY at `2026-10-01T20:27:33.821Z` holding `hone.care`. Verified afterwards: all **7** studio booking pages HTTP 200 with **zero** UNKNOWN states — which is the proof the admission reader reaches the new column, since a failed read renders UNKNOWN. Two studios resolved WAITLIST, five resolved OPEN and still offered ordinary booking. Zero Vercel runtime errors. |
| **E** · read the live env lists | **NOT PERFORMED** | ⚠️ **The live `NEW_CLIENT_WAITLIST_STUDIO_SLUGS` and `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` values were never read, so NO SLUG SET IS RECORDED.** The plan requires this step to be the one moment the real configuration enters the written record; that has **not** happened and must still be done by the credential holder. **No slug set may be inferred from any document** — not from which studios are stamped, not from which hold waitlist rows. Consequence: the plan's "record which listed studios are absent from the durable list" is **outstanding**, so the set of studios whose commit point would move at F is **unknown and undocumented**. |
| **F** · cut each listed studio over | **PARTIAL — ONE studio** | Only **Willow Electrolysis** (`38cb3a8b-f0f1-409e-9ea4-ffa4b95cb4c6`, `willow-electrolysis`). Stored mode `open → waitlist`, `set_at` `2026-10-01T21:35:33.139540Z` (**server-generated**), `set_by` resolving to a `practitioners` row of that studio with `role = 'owner'` — matched on `practitioners.id`, since the command stores the resolved practitioner rather than `auth.uid()`. Written by **the owner through the product UI** (Settings → Booking, anchor `new-client-admission`, option "Use a waitlist"), which calls `set_new_client_admission_mode`. **The release controller could not and did not perform this write:** its connection is `postgres` with `auth.uid()` NULL, and the command re-derives authority through `is_studio_owner`, so it answers `not_authorized`. No column was direct-updated and `service_role` was not used to impersonate the owner. **What the write definitively did:** it moved new-client admission **authority** from the legacy env bridge to the persisted row. **Willow's effective admission mode did not change** — measured as WAITLIST on the public surface both before and after. ⚠️ **Whether its COMMIT POINT changed is UNKNOWN and must not be asserted.** The 48 pre-existing entries prove Willow used the durable path *when those rows were written*, not that it was still on `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` immediately before this write — **step E never read that value**. An earlier revision of this row claimed otherwise and is **withdrawn**: it was the exact inference *What must NOT be inferred* above already forbids. The remaining **6** studios are still stored `'open'` and **unstamped**. |
| **G** · verify a durable join | **PASSED** | One synthetic prospect joined through the **public** Willow waitlist form, committing entry `ff942ef2-a272-4549-a3b9-c5d000b05b69` at `2026-10-01T22:25:36.347700Z`: `status` `waiting`, `source` `public_booking`, `joined_at_provenance` `form`, and `removed_at`/`claimed_at`/`invited_at`/`converted_at`/`converted_client_id`/`created_by_practitioner_id` all NULL. Willow entries **48 → 49**, globally **51 → 52** — exactly one new row anywhere. **The row, not the email, was the check.** No appointment (330 → 330) and no client record (78 → 78), including no attach to the three pre-existing clients that happen to share the test address. No SMS: `sms_consent_at`, `sms_consent_source`, `mobile_verified_at` all NULL, and the waitlist surface carries no SMS field. Studio notification **provider-accepted**; client acknowledgement logged no failure. |
| **H** · retire the bridge machinery | **NOT STARTED** | **Both bridges remain intact** in the deployed tree: `envForcesWaitlist` in `lib/booking/new-client-admission.ts`, and `lib/booking/new-client-waitlist-durability-bridge.ts` with `isNewClientWaitlistDurableEnabled`. **No environment variable was deleted.** H is explicitly gated on every listed studio being stamped and verified, and only one is — so it is not merely undone, it is **not yet eligible**. |

### Two findings from the execution worth carrying forward

**1 · `migration list --linked` is not a safe reconciliation source.** Run from a
worktree whose branch predates applied migrations, it reports them as *remote-only*.
During this release's preflight a worktree topping out at `0201` reported `0202` and
`0203` as remote-only — a branch artefact that reads exactly like a production
discrepancy. Reconcile by set arithmetic against the live version list in
`supabase_migrations.schema_migrations` instead, whenever the invoking tree may not be
the release tree.

**2 · `effective_new_client_admission` takes a row lock.** It is `volatile` and runs
`perform 1 from public.studios s where s.id = p_studio_id for no key update`. It is a
commit-time authority, **not** a presentation read, and must not be called casually
during verification. Effective mode was instead derived behaviourally from the public
page, so no verification step locked a studio row mid-cutover.

### Outstanding, and owned by whoever resumes this

- **Step E** — read the live env lists and record the exact slug sets, including which
  listed studios are absent from the durable list. Nothing else in F can be scoped
  correctly until this exists.
- **Step F for the remaining 6 studios** — each needs its own owner-authorized write.
- **`0205`** — close the `studios_admission_mode_guard()` grant deviation.
- **The step-G synthetic entry is RETAINED.** `ff942ef2-a272-4549-a3b9-c5d000b05b69`
  sits in Willow's **Waiting** queue at position **47 of 47** (`joined_at` ASC, `id`
  ASC, `SECTION_PAGE_SIZE` 100 — the last row on page one, visible without paging) and
  carries a submitted phone number. **It is synthetic test data in a real operator's
  live queue.** Remove it before Willow operates that queue for real.
