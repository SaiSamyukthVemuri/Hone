# PR #481 — superseded by migration 0159

**Date:** 2026-07-29
**Status:** SUPERSEDED. PR #481 is closed without merging. Its branch
(`fix/p0-finalized-structured-areas-containment`, head `72448bb`) and its full review history are
**retained** as audit evidence and must not be deleted.
**Superseded by:** migration `0159_retire_signed_clinical_records.sql`, and the decision record
[clinical-finalization-retired.md](./clinical-finalization-retired.md).

---

## Why it is superseded, not merged

PR #481 was a correct, well-reviewed response to audit finding **F-CLIN-000** — *finalized
authoritative structured areas are mutable, unsigned and outside correction lineage*. Its entire
architecture rested on one premise: **that signed/finalized clinical records were a future Hone
capability**, and that the job was therefore to make them trustworthy.

That premise is now void. Hone will not offer signed or cryptographically finalized clinical
records. So the *problem* PR #481 solved — "a finalized record's areas can change while its
signature stays valid" — cannot occur, because no record will ever be finalized or signed again.

What survives is the half of PR #481 that was never really about finalization: **ordinary clinical
tables were reachable for direct browser DML, including `TRUNCATE`, which no RLS policy checks.**
That is a live security defect regardless of any product decision, and 0159 carries it forward.

Migration 0158 from that branch is **not applied anywhere** and never will be. 0159 deliberately
skips the number 0158 so the two artifacts never share one.

---

## Keep / drop, mechanism by mechanism

| PR #481 mechanism | Verdict | Reasoning |
|---|---|---|
| `revoke all` on `session_block_areas` from `public`/`anon`/`authenticated`, then `grant select` back to `authenticated` | **KEPT verbatim** in 0159 §5c | Pure active security. The table is the authoritative area record and the app has **zero** direct writes to it — every write already goes through `create_session_block_with_areas` / `update_session_block_with_areas` / `copy_session_setup`. Nothing to do with finalization. |
| Narrowing the 0128 `FOR ALL` policy to a SELECT-only policy | **KEPT verbatim** in 0159 §5c | Defence in depth: a future accidental re-grant cannot silently reopen direct DML. |
| Widening the 0128 studio-derive trigger to `update of session_block_id, studio_id` | **KEPT verbatim** in 0159 §5d | Closes a real re-tenanting gap — a `studio_id`-only UPDATE previously escaped the anti-spoof derivation, leaving a row readable by the wrong studio. Independent of finalization. |
| Revoking `TRUNCATE` / `REFERENCES` / `TRIGGER` from `service_role` on `session_block_areas` | **KEPT, and generalised** in 0159 §5a–5b | 0159 goes further: it removes those three from `anon` **and** `authenticated` on **all six** clinical tables, and removes every remaining `anon` write privilege. The investigation showed `sessions` and `session_blocks` were worse than `session_block_areas` — no migration in the entire 0001–0157 history ever named them, so both roles held the full Supabase default grant including `TRUNCATE`. |
| `assert_session_chartable(uuid, uuid)` — the server-derived studio/session authority preamble | **INTENT KEPT, mechanism dropped** | Its *lineage* half is exactly what we want, but it is already satisfied: the ACL inventory found all 26 application call sites derive `studio_id` server-side, validate `(studio, client, session)` lineage, and never write `studio_id`/`session_id`/`client_id`/`record_status` from a payload. Its *other* half required the parent to be a `draft`, which under the new decision is a restriction on ordinary editing rather than a protection. Re-imposing it would have been the retired product leaking into live charting. |
| `session_has_been_signed(uuid)` | **DROPPED** | Its entire purpose was to decide whether a signed artifact exists so writes could be frozen around it. With signing retired, the question is only ever asked about the single legacy record, and the 0119 guard already answers it. |
| `guard_finalized_structured_area_write` + its trigger on `session_block_areas` | **DROPPED** | It froze structured areas when the parent was finalized. No parent can become finalized, so the trigger would be permanently inert — dead code that reads as an active protection, which is worse than nothing. The legacy record's areas are already frozen by the 0119 `guard_finalized_clinical_write` triggers, which 0159 deliberately keeps. |
| `guard_signed_record_block_write` on `session_blocks` (block INSERT / reparent / soft-delete / DELETE when ever-signed) | **DROPPED** | Same reasoning. Its four routes only mattered because a signed snapshot could be contradicted. 0119's existing guard already blocks every one of them for the one legacy record. |
| `FOR NO KEY UPDATE` instead of `FOR UPDATE` in the charting RPCs, with its deadlock reasoning | **DROPPED as code, KEPT as knowledge** | Since `assert_session_chartable` is not carried forward, the charting RPCs take no session lock and there is no cycle to avoid. **The finding itself must not be lost**: a session-level `FOR UPDATE` taken inside a charting path deadlocks (`40P01`, reproduced) against `soft_delete_session_area` (0123), which locks a `session_blocks` row *first* and then inserts a `session_audit` row needing `FOR KEY SHARE` on the session. That is recorded here, in the 0159 header, and in the PR B design notes so the next person to add a session lock does not rediscover it the hard way. |
| `set local lock_timeout` on the migration | **KEPT** in 0159 | Good practice for any migration taking short exclusive locks on live clinical tables. |
| `tests/db/session-block-areas.db.test.ts` posture update (member SELECT yes, direct DML denied `42501`, service_role derive coverage, `studio_id`-only re-tenant denied) | **KEPT verbatim**, relabelled 0158 → 0159 | Proves the privilege posture 0159 actually ships. |
| `tests/db/finalized-structured-area-containment.db.test.ts` (46 tests) | **DROPPED**, replaced | It is an excellent suite for a capability that no longer exists — reparent-into-signed-record, cascade-erase, status round-trip, four finalization-concurrency proofs. Replaced by `tests/db/clinical-finalization-retired.db.test.ts` (17 tests), which proves the capability is *unreachable*, the legacy artifact is preserved, and ordinary charting is editable. |
| `tests/migrations/0158-*.test.ts` (33 source assertions) | **DROPPED**, replaced | Superseded by `tests/migrations/0159-*.test.ts` (24 assertions) against the retirement migration. |
| `docs/runbooks/0158-finalized-structured-area-containment.md` | **DROPPED** | Its §8 "MANDATORY FOLLOW-UP — snapshot v2 + structured-area corrections" is precisely what the product decision rejects. Keeping it would leave a runbook instructing a future operator to build the retired system. |
| `scripts/audit-structured-area-integrity.sql` | **DROPPED as a shipped script** | It is a read-only integrity report for signed snapshots (hash re-derivation, projection drift against a signed artifact). Nothing to audit once nothing is signed. Its one still-useful check — that the single legacy snapshot's `content_hash` re-derives — is preserved as an assertion in the retirement DB suite and as a one-off command in the rollout notes. |
| The migration-max tripwire edits across ~11 test files | **KEPT, re-pointed** to 0159 | Same mechanical need; the absolute pin now lives in the 0159 test. |
| `known-limitations.md` L18 (structured areas contained but not signed) | **DROPPED / rewritten** | Its "next gate" was snapshot v2. Replaced by the retirement entry. |
| `known-limitations.md` L19 (`anon` holds full DML + `TRUNCATE` on `public.session_blocks`) | **KEPT and acted on** | 0159 closes the `anon` write privileges and the `TRUNCATE`/`REFERENCES`/`TRIGGER` grants on all six clinical tables. The remaining part — `authenticated` row DML on the five tables the app still writes directly — is PR B. |

---

## What this means for the audit finding

**F-CLIN-000 is not "fixed" — its precondition is removed.** The finding described a signed record
diverging from its signature. There will be no signed records. The finding is reclassified as
**eliminated by permanent capability retirement**, with the genuinely product-independent half of it
(unsafe direct clinical-table authority) reclassified as an **active production-security defect** and
carried into 0159 and PR B.

Full reclassification of every related finding is in
[clinical-finalization-retired.md](./clinical-finalization-retired.md).
