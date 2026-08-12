# Runbook — 0180 card-on-file replacement integrity rollout

**0180 IS MIGRATION-FIRST (DB-FIRST). This is not a preference.**

See [migration-first-process.md](./migration-first-process.md) for the general
sequence. This file records why 0180 in particular cannot be app-first, and the
exact order for its rollout.

---

## Why DB-FIRST is mandatory here

The new application code calls `save_client_card_on_file` **unconditionally**.
That command exists only after 0180 is applied. So the two skew directions are
not symmetric:

| Skew | Result | Verdict |
|---|---|---|
| **OLD app + NEW db** | 0180 is purely additive — it creates one new command and changes no table, index, policy or existing grant. The old two-write code path is untouched and keeps working. | **SAFE** |
| **NEW app + OLD db** | `setup_intent.succeeded` calls a command that does not exist. The RPC errors, the handler throws, the parent releases the claim and returns 500, Stripe retries. No card can be persisted for the duration. | **NOT OPERATIONALLY SAFE** |

New-app-on-old-db is **data-safe** — nothing is written, nothing is corrupted,
the previous active card is untouched, and Stripe keeps retrying so the events
are not lost. But it is a **live card-on-file availability outage**: for as long
as the skew lasts, no client can add or replace a card, and the portal will
correctly report "not confirmed" to every one of them.

Since the safe direction is DB-first and the unsafe direction is app-first, the
migration goes first. 0179 was deliberately the opposite (app-first) because it
*removed* privileges; 0180 *adds* a command, so the shape of the change decides
the order — as it always does.

### Two things deliberately NOT done

* **No fallback to the old two-write implementation.** A fallback would
  reintroduce the exact zero-active-card failure 0180 exists to remove, and it
  would do so silently, on the rarest path, where it is least likely to be
  noticed.
* **No "merge quickly and hope Vercel finishes after the apply".** That is a
  race, not a rollout order. The apply completes and is verified *before* the
  application that needs it is allowed to deploy.

---

## Order (after final independent approval)

1. **Freeze** the exact PR head and the 0180 hashes (raw + executable). Record
   them in the apply authorization.
2. **Read-only production preflight** — confirm hosted max is 0179, exactly one
   pending migration (0180), the command does not already exist, the
   `client_payment_methods_one_active_per_pair` invariant is intact, and the
   activity/lock snapshot is quiet.
3. **Apply 0180** from the reviewed PR head's exact bytes, **while the OLD
   application is still deployed**. Use the pinned CLI.
4. **Verify** hosted max is 0180; `save_client_card_on_file` exists exactly
   once; EXECUTE is `service_role` only with PUBLIC/anon/authenticated all
   false; the partial unique index is unchanged; zero business rows changed.
5. **Confirm the old application is still healthy.** It is, by construction —
   0180 is additive and the old code path does not reference the new command —
   but confirm rather than assume.
6. **Only then merge PR #562**, allowing the application that calls the new RPC
   to deploy.
7. **Verify production application health** — portal loads, and a card-on-file
   surface renders.
8. **Create the separate production-state reconciliation PR** recording the
   0180 apply (`migration-state.json` + ledger + test hand-off).
9. **0181 becomes available only after that reconciliation is merged.**

## Stop conditions

Stop and do not proceed if: the production SHA moved; the dry run lists anything
other than 0180; `save_client_card_on_file` already exists; hosted max is not
0179; the preflight finds an unexpected `client_payment_methods` state; or the
apply exits non-zero.

## Rollback

0180 is additive, so the rollback for step 3 is "do nothing" — the old
application ignores the new command entirely. If the *application* misbehaves
after step 6, roll the application back; the command can stay. Never drop the
command while the new application is deployed.
