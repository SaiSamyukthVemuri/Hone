# NEW-CLIENT-MODE-01 — execution record

**DATED HISTORICAL EVIDENCE. NOT AN OPERATOR CONTRACT.**

Everything in this file is a record of what was executed, at the date each entry
carries. It describes production reads and writes that happened; it does **not**
define, qualify or redefine current operator behaviour, and **nothing appended here
can change what the contract says.**

**THE CONTRACT WINS ON CONFLICT.** The current operator contract — the plan, the
rollback table, and the declared `claim-status` directives that say which claims are
active and which are withdrawn — lives in
[new-client-admission-activation.md](./new-client-admission-activation.md) and is
frozen by sha256 in `tests/lib/booking/new-client-admission.test.ts`. If an entry
below appears to contradict it, **the contract is authoritative and the entry is
wrong or stale.** Read the plan as the procedure and this file as what happened to
it.

**WHY THE SPLIT EXISTS.** These records were previously appended to the end of the
activation plan. One file cannot hold both a frozen contract and an indefinitely
appendable record while a test claims nothing in the document contradicts that
contract: the appendable region is unfrozen by construction, so a contradiction
appended there passed every guard. The contract is now frozen end to end and the
history lives here, append-only.

The entries below were **moved verbatim** from the activation plan — byte for byte,
not re-edited, not retrofitted to the outcome.

---

## EXECUTION RECORD — 2026-10-01

**This section is a record of what was executed, not an instruction.** The plan
above is unchanged; nothing in it was rewritten to match the outcome. Steps A–D
and G are DONE and **E was never performed**. **F wrote ONE studio; its
completeness is UNKNOWN pending step E.** **H is NOT STARTED; its eligibility is
also UNKNOWN pending step E** — "not started" and "not eligible" are different
claims and only the first is supported. This summary deliberately carries no
"partial" verdict for F: because step E never read `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`,
Willow may have been its only member, in which case **F is already COMPLETE**. An
earlier revision of this line said F was "partial by design" and is **withdrawn** —
it contradicted the table below it, and it was the same inference that table exists
to refuse.

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
| **F** · cut each listed studio over | **ONE STUDIO WRITTEN · completeness UNKNOWN** | One studio was written: **Willow Electrolysis** (`38cb3a8b-f0f1-409e-9ea4-ffa4b95cb4c6`, `willow-electrolysis`). Stored mode `open → waitlist`, `set_at` `2026-10-01T21:35:33.139540Z` (**server-generated**), `set_by` resolving to a `practitioners` row of that studio with `role = 'owner'` — matched on `practitioners.id`, since the command stores the resolved practitioner rather than `auth.uid()`. Written by **the owner through the product UI** (Settings → Booking, anchor `new-client-admission`, option "Use a waitlist"), which calls `set_new_client_admission_mode`. **The release controller could not and did not perform this write:** its connection is `postgres` with `auth.uid()` NULL, and the command re-derives authority through `is_studio_owner`, so it answers `not_authorized`. No column was direct-updated and `service_role` was not used to impersonate the owner. **What the write definitively did:** it moved new-client admission **authority** from the legacy env bridge to the persisted row. **Willow's effective admission mode did not change** — measured as WAITLIST on the public surface both before and after. ⚠️ **Whether its COMMIT POINT changed is UNKNOWN and must not be asserted.** The 48 pre-existing entries prove Willow used the durable path *when those rows were written*, not that it was still on `NEW_CLIENT_WAITLIST_DURABLE_STUDIO_SLUGS` immediately before this write — **step E never read that value**. An earlier revision of this row claimed otherwise and is **withdrawn**: it was the exact inference *What must NOT be inferred* above already forbids. The other **6** studios were read as stored `'open'` and **unstamped** on 2026-10-01. **That is their row state, not a work list.** ⚠️ **STEP_F_COMPLETENESS = UNKNOWN pending step E, and STEP_H_ELIGIBILITY = UNKNOWN pending step E.** Step F applies only to studios in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`; **step E never read that list.** So it is not known whether Willow was the list's only member — **if it was, F is already COMPLETE and H is already ELIGIBLE.** Neither fact can be settled from stamped or unstamped rows, and **unstamped must never be read as unlisted or as listed**. Read the list; it alone decides both. **This row deliberately carries no "PARTIAL" verdict**: an earlier revision did, and that verdict was itself the inference — it presumed the list has more members than the one studio written. |
| **G** · verify a durable join | **PASSED** | One synthetic prospect joined through the **public** Willow waitlist form, committing entry `ff942ef2-a272-4549-a3b9-c5d000b05b69` at `2026-10-01T22:25:36.347700Z`: `status` `waiting`, `source` `public_booking`, `joined_at_provenance` `form`, and `removed_at`/`claimed_at`/`invited_at`/`converted_at`/`converted_client_id`/`created_by_practitioner_id` all NULL. Willow entries **48 → 49**, globally **51 → 52** — exactly one new row anywhere. **The row, not the email, was the check.** No appointment (330 → 330) and no client record (78 → 78), including no attach to the three pre-existing clients that happen to share the test address. No SMS: `sms_consent_at`, `sms_consent_source`, `mobile_verified_at` all NULL, and the waitlist surface carries no SMS field. Studio notification **provider-accepted**; client acknowledgement logged no failure. |
| **H** · retire the bridge machinery | **NOT STARTED** | **Both bridges remain intact** in the deployed tree: `envForcesWaitlist` in `lib/booking/new-client-admission.ts`, and `lib/booking/new-client-waitlist-durability-bridge.ts` with `isNewClientWaitlistDurableEnabled`. **No environment variable was deleted.** H is explicitly gated on **every listed studio** being stamped and verified. ⚠️ **Whether that gate is already satisfied is UNKNOWN.** One studio was stamped and verified; because step E never read `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, it is not known whether that was the whole list. **If it was, H is already ELIGIBLE.** An earlier revision called H "not yet eligible" on the strength of one stamped row and is **withdrawn** — a row count cannot settle a question about a list nobody read. H is **NOT STARTED**; its eligibility is **UNKNOWN**, and the two are different claims. |

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
- **Step F for whichever studios are actually LISTED — a set that is UNKNOWN until
  step E is done.** ⚠️ **Do NOT read this as "the other six studios".** Step F applies
  only to studios in `NEW_CLIENT_WAITLIST_STUDIO_SLUGS`, and that list has not been
  read. **Unstamped does not mean listed**: a studio can be unstamped simply because it
  was never on the list, and stamping such a studio `waitlist` would move a currently
  **OPEN** studio to WAITLIST — a real behaviour change to a studio this release never
  concerned. An earlier revision of this bullet said "the remaining 6 studios ... each
  needs its own owner-authorized write" and is **withdrawn**: it inferred list
  membership from row state, which is the same error as inferring durable membership
  from historical rows. **Read the list first; it alone defines the set.**
- **`0205`** — close the `studios_admission_mode_guard()` grant deviation.
- **The step-G synthetic entry is RETAINED.** `ff942ef2-a272-4549-a3b9-c5d000b05b69`,
  recorded as **two dated observations** with nothing claimed after the second:
  - **2026-10-01T22:25:36Z, at step-G acceptance** — status **`waiting`**, position
    **47 of 47** (`joined_at` ASC, `id` ASC, `SECTION_PAGE_SIZE` 100 — then the last row
    on page one), a submitted phone number and no SMS consent.
  - **2026-10-02T00:14:55Z, controlled invitation-acceptance exercise** — **claimed**
    then **invited by a practitioner**; status **`invited`**, therefore **out of the
    Waiting section**. Invitation `delivery_disposition` **`accepted`**, stored
    `expires_at` **2026-10-04T00:14:55Z**, with `redeemed_at` / `declined_at` /
    `expired_at` / `released_at` / `closed_at` all NULL. **Inbox receipt was
    OPERATOR-OBSERVED**, not measured here.
  ⚠️ **Its state after 2026-10-02T00:14:55Z is not asserted**, and the expiry is a
  stored value rather than a prediction. **Find it by id**, never by position or status.
  **Origin, which does not change: created by a synthetic acceptance test, not by a
    real prospect, against a real inbox.** **No cleanup was performed in this
    change.** **Re-read the entry and its invitation by id before acting**; if either
    is still outstanding then, removal or release is a **separately authorized**
    action. This record makes **no claim about whether they are outstanding now** —
    an earlier revision said it "now carries a live invitation" and is **withdrawn**.
