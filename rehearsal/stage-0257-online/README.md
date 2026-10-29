# REHEARSAL - NEVER MERGE. STAGE-0257-ONLINE

The reviewed 0254 online scripts (apply `d966c055`, reconcile `6d6832bf`, g02 read `870cbba5`) re-pinned for the sealed **0257**
(`0257_studio_payment_jurisdiction_failed_attempt_ack.sql`, sha256 `170b5ddaf851c4e6d2900162ccdf47d048b2cf49a4ed7f4c6e0f79217b5ad20f`, #1267 head `38d29dcf`).
Sam's decision: 0257 goes ALONE, first. 0254 stays HELD. Nothing here touches a hosted project; the guard is not weakened.

**Review the constants, not the logic.** `*.vs-<sha>.diff` is each script against its 0254 original. `check.sh` proves the delta mechanically:
`g02-read` has no remaining difference after pins and numbers are normalised, `reconcile` has exactly ONE changed line (the read-back verdict wording), and
the apply script has exactly the declared stage data (`DELTA-NONCONSTANT-*.txt`).

## Stage constants (0254 online -> 0257 online)

| | 0254 online | 0257 online |
|---|---|---|
| hosted before / after | 246 rows, max 0248 -> 247 rows, max 0254 | 246 rows, max 0248 -> 247 rows, max 0257 |
| bundle | hosted files + 0254 (247 files) | hosted files + 0257 (247 files); 0247 and 0249..0256 absent |
| bundle / list sha256 | `ca45aa3b` / `841e8dca` | `82af08f0` / `69d0a331` |
| push | plain forward push (0254 above the hosted max) | plain forward push (0257 above the hosted max); NO `--include-all` anywhere |
| pre-push reads | g02, g12 (0254 preflight), open-tx (5 tables), w03 (5 tables) | g02, g12 (0257 preflight: tables, helpers, v1, attempt columns, new objects absent), open-tx (1 table), w03 (1 table) |
| read-back | history + 5 function bodies + owner-only read-policy proof | history + v2 exists + v2 body md5 + shape-and-grants proof (definer, pinned search_path, service_role-only EXECUTE, two columns, validated CHECK, no acknowledged row) |

## Two proofs

1. `check.sh` (macOS bash 3.2 launched from zsh, and Linux): the real script text against a stub `supabase-go`, a FIFO terminal and canary secrets.
2. `scripts/ci/stage-0257-push-rehearsal.sh` (Linux and macOS): the real pinned CLI v2.102.0 against a disposable PostgreSQL holding exactly the hosted prefix
   (246 rows with the real hosted file names, max 0248, 0247 absent). A PLAIN dry run lists only 0257; a plain push applies the REAL sealed file; the real read-back
   queries and the shipped checker pass on the applied database; the PostgreSQL `md5(prosrc)` equals the read-back script's pinned md5; a re-run is idempotent;
   a stray 0254 is listed (and refused by the exact-list assertion), a stray 0247 is refused by the CLI, a missing 0257 lists nothing.

## What this does not prove

The synthetic database holds a one-column stand-in for the one table 0257 alters, not the real hosted schema, so the preflight read (`g12`) and the real lock behaviour
are not exercised here; they are the apply script's pre-push reads against the hosted database. The sealed file's own behaviour on the full chain is #1267's CI.
