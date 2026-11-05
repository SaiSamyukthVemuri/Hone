# REHEARSAL - NEVER MERGE. STAGE-0254-ONLINE

The 0248 online scripts (apply `3f2fac3f`, reconcile `b9bd0dc4`, g02 read `ac9c866a`) re-pinned for the sealed **0254** (`0254_perm_hon44_role_enforcement.sql`, sha256 `77f34d5c9b677faad344b5b1afc2c3f26321f9060db5653a2176d9a239bbba23`, #1226). No hosted call, no database: the scripts run as real text against a stub `supabase-go` and a FIFO terminal with canary secrets, exactly as the 0248 rehearsal did.

**Review the constants, not the logic.** `*.vs-<sha>.diff` is each script against its 0248 original. `check.sh` proves the delta mechanically: after normalising pins, migration numbers and counts, `g02-read` has **no** remaining difference, `reconcile` has **one** (the read-back verdict wording), and `apply` has exactly the lines in `DELTA-NONCONSTANT-apply.txt` (43 normalised lines: the pre-push g12 rule columns, the scanned and sized table lists, the absent-version list, the pending range, step text).

## Stage constants (0248 -> 0254)

| | 0248 online | 0254 online |
|---|---|---|
| hosted before | 245 rows, max 0246 | 246 rows, max 0248 (0247 unhosted by design) |
| hosted after | 246 rows, max 0248 | 247 rows, max 0254 |
| bundle | `0001..0246` + 0248 (246 files) | `0001..0248` + 0254 (247 files); 0247 and 0249..0253 absent |
| pending range | 248..248 | 249..254 (only 0254) |
| bundle sha256 / list sha256 | `c9ebfcec` / `c71fb767` | `ca45aa3b94b3e8f6...` / `841e8dca1b797feb...` (full values in the apply script) |
| pre-push reads | g02, g12 (intake definers), open-tx (10 tables), w03 (10 tables) | g02, g12 (0254 preflight), open-tx (5 tables), w03 (5 tables) |
| read-back | history + 2 verify checks | history + functions-exist (5) + body md5 (5) + **owner-only read-policy proof** (c03) |

## New pinned artifacts (`reads/`, `reads-s1/`)

`g02-history-0254.sql`, `g12-0254-preflight-0254.sql`, `s1-open-transactions-0254.sql`, `w03-table-sizes-0254.sql` (+ `MANIFEST.sha256`); `s1-history-0254.sql`, `c01_functions-exist.sql`, `c02_function-bodies.sql`, `c03_read-policies.sql` (+ `MANIFEST.sha256`), `window-s1read-0254.sh`. The runner `run-window-read-macos.sh` (`471ecb9d`) and `supabase-go` (`dce26b75`) are unchanged. The five function-body md5 values are **derived from the sealed source** (the same method reproduces the hosted 0248 `advance_intake_revision` md5 `48669dd8`), and `check.sh` re-derives them from `reference/0254_perm_hon44_role_enforcement.sql` on every run.

## What the read-back proves, and what it does not

The owner-only proof is a **catalog** proof: each of `payment_charge_attempts`, `manual_fee_charge_attempts`, `appointment_settlements` has exactly one SELECT policy, named `*_owner_*`, whose expression calls `is_studio_owner(` and never `is_studio_member(`. It does not execute a member read against production (that would need real tenant identifiers). The behavioural proof (a non-owner member reads zero rows) is `tests/db/perm-hon44-owner-only.db.test.ts` on the exact chain in CI.
