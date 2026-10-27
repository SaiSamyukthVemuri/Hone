# Window reads for S0a (rollout 0213–0246)

Prepared by Machines and **not run against any database**. OPS runs them at the window under the S0a authorization (decision package A6).

**How to run:** `cd` to the linked checkout, then `HONE_WINDOW_PROJECT_REF=<ref> <this dir>/run-window-read.sh <file>`. The runner checks each file's sha256 (`MANIFEST.sha256`) and the linked project ref. It accepts only one read-only SELECT per file, and it executes only `npx --yes supabase@2.102.0 db query --linked -o json -f <file>`.

Each file's header names its gate, the expected pass result and the stop condition. Every file except G2 refuses to run (division-by-zero error) unless the hosted migration history max is 0212.

| File | Gate | Pass |
|---|---|---|
| g02-history.sql | G2 | 211 rows; max 0212; none ≥ 0213; the 0212 row has 73 statements and stored-statement hash `bc13731b…` |
| g06-payment-drain.sql | G6 D1–D4 (pre-0245 form) | every `d*` column is 0 |
| g07-sms-claimed-number-duplicates.sql | G7 (0226) | `duplicated_numbers` is 0 |
| g09a-0214-reach-summary.sql | G9 summary | 7 / 3 / 3 / 1, the same as the 19:00Z census |
| g09b-0214-reach-per-studio.sql | G9 per studio | ordinals 2, 4 and 5 are reachable and no others; needs_ack is true for 1, 3, 6 and 7 |
| g09c-0214-bound-account-mode.sql | G9 account-mode form (D-E input) | per ordinal: bound_live and bound_test (summing to g09b's bound_account_rows), `bound_unknown_mode` 0, `observed_country_column_present` false |
| g09d-0214-currency-history.sql | G9d (predicts the 0214 history-initialization command per studio) | no pass value; read to learn. Per ordinal and per source table: rows, NULL-currency rows, rows not CAD, rows not USD; unverifiable-history rows; account evidence; `predicted_ca_cad` and `predicted_us_usd` (`initializable`, `needs_ack`, `refused_currency_history`, `refused_unverifiable_history`, `refused_account_unverified`, `refused_unlisted_money_table`). Any NULL-currency row makes both pairs `refused_currency_history` permanently. |
| g10-constraint-names.sql | G10 | `present_total` is 7 |
| g11-0244-legacy-laser-types.sql | G11 / T-0244-4 | `wrong_type_rows` is 0 |
| g11b-0244-legacy-laser-classes.sql | G11 class split (Photos section 4, re-verified) | `reconciles` is true; every class count is 0. Counts are given per class (N, X1, X2, H1, H2) and per key, plus a row-level partition. Whether to stop on a class count above 0 is the package rule unless OPS/Sam adopt Photos section 3. |
| g12-0243-intake-definers.sql | G12 | `callable_total` is 0 |

The Insurance object census (`insurance/1035-HOSTED-OBJECT-CENSUS.sql`) and the `pg_stat_activity` read are not part of this set.

## Census at the P-2 head, and the comparator

`census-0213-0246.sql` is the P-2 form (sha 4817b78e…): the 0214 row counts **30** objects, adding `initialize_studio_payment_jurisdiction_from_history`, `studio_account_acceptable_for_jurisdiction` and `studio_named_stripe_accounts`. Everything else is unchanged from the 9f558064… version. The manifest has 13 files (w03-table-sizes.sql adds the table-size and timeout-setting read).

`compare-preflight.mjs` (tests: `node --test compare-preflight.test.mjs`, synthetic fixtures only) reads the 13 result files, one per manifest file, named `<basename>.json` in one directory, plus a baseline file and an attestation file, and prints PASS/FAIL per S0 stop check. Any FAIL, unreadable or missing file, missing input or unknown required check is an overall FAIL. `--stage s1` checks the S1 read-back (0214 `present_now = 30`, the closures including the three new 0214 functions). It makes no database or network call and reads no path it is not given.

## Comparator peer-review fixes (F1-F8, Insurance `PEER-COMPARATOR-END.json`)

The comparator is now two files: `compare-preflight.mjs` (the command; runs `main`
unconditionally, exit code preset to 3 and cleared only after the exact line
`OVERALL PASS` is printed) and `compare-preflight-lib.mjs` (all checks).
Exit codes: 0 PASS, 1 FAIL (including any internal error), 2 DATA-ONLY, 3 usage or no verdict.

    HONE_WINDOW_RESULT_DIR=<existing dir> ./run-window-read.sh <file>     # once per file; refuses to overwrite
    node compare-preflight.mjs --results <dir> --baseline <b.json> --attest <a.json> \
         --window-start <UTC> --window-end <UTC> [--max-age-min N] [--manifest MANIFEST.sha256]

- **F2** The runner, with `HONE_WINDOW_RESULT_DIR`, writes `<stem>.json` and `<stem>.meta.json`
  (sql/result/runner/manifest shas, start and capture UTC, exit code). New check **S0-14**
  fails any file with no sidecar, a changed result, a different runner or manifest, a start before
  the window, a capture after it or in the future, or a capture older than N minutes
  (default 30, at most 120). The runner and manifest shas are pinned in the baseline.
- **F4** S0-8 uses the real clock (injected in tests only; there is no `--now`): it must lie
  inside the window, leave at least the planned duration, and neither it nor the window may touch 07:45-10:00 UTC.
- **F5** The grants of the three new 0214 functions, the 0239/0245 service_role pins and the
  `audit_logs` privileges are constants in the comparator, checked against the read-back
  and against `expected`.
- **F6** Literal 8 studios; per-ordinal reachability, money/account class, `bound_live`, `bound_test`.
- **F7** Attestations are itemised (see the test file for each field); a bare boolean fails.
- **F3** `s1-open-transactions` needs exactly the ten names, each `table_present = true`.

## Pin the decision tool before use (Insurance F10) and the LOW items (F9, D1, D2)

The comparator is the least-pinned file in the rollout, so the GO package should name its
hashes and the operator should check them before the window:

    sha256sum compare-preflight.mjs compare-preflight-lib.mjs run-window-read.sh MANIFEST.sha256
    # (superseded by COMPARATOR-PITR, below) compare-preflight.mjs      0ac9195f316df2ccb4423f711946caad1b75e8f07d19bc9546d2adb095264541
    # compare-preflight-lib.mjs  9ce96442c94db9c7a99d4d166a501c414b3afd895ee80b9048e7371927358c32

## G4 under PITR (COMPARATOR-PITR, supersedes the two hashes above)

`baseline.recovery_regime` is `daily` (the default when absent: the original S0-10, all 126 original tests unchanged) or `pitr`.
Under `pitr`, S0-10 requires `g4_pitr` and rejects the daily `g4`; the selected pre-migration restore point is checked at
row 4 by `compare-preflight.mjs --stage row4` (rows R4-0..R4-2), never at S0a. See `WINDOW-COMMAND-MACOS.md`.

    # compare-preflight.mjs       147b5c67aa78ef80621c64eefe86755916d58dec284fdbe69f943348f8ba6058
    # compare-preflight-lib.mjs   636bd85d5863df8aa6e852f7c35f837b47551c17ed1ec75f5c5d14403b6d3fe9
    # compare-preflight.test.mjs  804c4f430cdb7b6c31311b928e6081f289d5d87b116131a287fe82bf994afd5f   (274 tests: the 126 original plus 148)
    # BASELINE-W1-MACOS-CANDIDATE-3.json  efc94a51f02bd2116a806229c8910b9ac48c2e5da6c0ff6556a3671e957301dd
    # G3-CHECKSUMS-d189768b.txt   bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6

Proofs: `baseline-candidate3-proof.test.mjs` (diff against candidate 2: only planned_duration_minutes 60 to 110, recovery_regime and g4_pitr) and
`pitr-mutation-proof.test.mjs` (removing any one PITR rule line turns the suite red). Templates: `ATTEST-TEMPLATE-PITR.json`, `ATTEST-TEMPLATE-ROW4.json`.

- **D1** The entry hashes the MANIFEST.sha256 file text and S0-14 requires it to equal `baseline.manifest_sha256`.
- **D2** The amended 0214 checksum (a8bdcefe...) is a constant in the comparator; the baseline and the attestation must both name it. The other 33 come from the baseline.
- **F9** The blackout end is exact (10:00 UTC) on both the clock and window checks and is tested from the end side.


## G9d: does a studio with history ever initialize? (g09d-0214-currency-history.sql)

Added after the manifest of 13: the manifest has **14** files and its sha is
`2b1608a9ec43caf97bd9ead3fe1d10895652a080a4b8ae0a891a17be3038cd94` (was `c2af651c...`). The comparator's code and tests are unchanged (it requires its own 13 files and ignores an extra manifest line), but any baseline file must pin the NEW manifest sha, and the comparator does not check a g09d result: Sam reads it directly.

**How to read g09d (Insurance PEER-G09D F1).** Only the currency verdict is final at 0212: `refused_currency_history`, `refused_unverifiable_history` and `refused_unlisted_money_table` decide "can this studio ever be initialized"; a predicted `refused_account_unverified` or `needs_ack` means "not yet", because unobserved accounts can clear after the 0214 observation step.

**How to capture g09d (Insurance PEER-G09D F2).** g09d is not one of the comparator's 13 files, so nothing checks its capture. Run it with `HONE_WINDOW_RESULT_DIR=<dir> ./run-window-read.sh g09d-0214-currency-history.sql`, and have OPS check its `.meta.json` by hand: `sql_sha256` `0eff4a70...`, `manifest_sha256` `2b1608a9...`, `exit_code` 0, and a capture time inside the window.

**Baseline re-pin (BASELINE-REPIN).** The comparator's baseline `manifest_sha256` must be `2b1608a9...` (proposal: `BASELINE-PROPOSED.json`). With the old `c2af651c...`, S0-14 fails on D1. Proof, with no change to the comparator or its tests: `node --test baseline-repin-proof.test.mjs` (5 tests: new baseline PASS on a correctly bound set, old baseline FAIL, and the reverse against the old 13-line manifest). The 126 comparator tests pass unchanged.
The predicate is copied from the command body (0257 lines 211-386, same text as the amended 0214) and proved equal to the command in CI (J9-I in tests/db/studio-payment-jurisdiction-history-init.db.test.ts, with two negative controls).

## macOS variant of the runner (RUNNER-MACOS)

`run-window-read-macos.sh` sits beside the pinned `run-window-read.sh` and replaces nothing. It uses `shasum -a 256` where there is no `sha256sum` and works on bash 3.2. `HONE_SUPABASE_BIN` is MANDATORY and is gated by SHA-256 of the file against the pinned `supabase-go` constant `dce26b75c9c233274239041b4e426821e7728f025a365e54ea2512df442e4b7b` (R5; the binary is hashed before anything runs, `--version` is never called because it dials api.github.com, and there is no override). Refusals: `SUPABASE_DB_PASSWORD` unset or empty (otherwise the CLI creates a login role, a hosted write); `./supabase/.temp/pooler-url` not exactly the `aws-1-us-east-1` session pooler on 5432 for `postgres.<project-ref>` without a password; any `SUPABASE_*` variable other than `SUPABASE_DB_PASSWORD`, `SUPABASE_ACCESS_TOKEN`, `SUPABASE_TELEMETRY_DISABLED` (R1, e.g. `SUPABASE_PROJECT_ID`, `SUPABASE_PROFILE`); `cli-latest` missing, not exactly `v2.102.0`, or older than 9 hours (R4, so the CLI does not fetch it); a result that is not a JSON array (R3, exit 3). The CLI is called as `env -u GITHUB_TOKEN -u GH_TOKEN SUPABASE_TELEMETRY_DISABLED=1 DO_NOT_TRACK=1 $BIN --agent no db query --linked -o json -f <file>`. Prerequisite: `SUPABASE_ACCESS_TOKEN` (or a prior login) must exist for the linked query. Tests: `bash run-window-read-macos.test.sh` (244; also run on macOS arm64 under /bin/bash 3.2.57 and zsh, CI rehearsal PR #1171). Because it hashes its own file, the sidecar `runner_sha256` is the variant's hash, so `baseline.runner_sha256` must be `471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357` when the variant runs (earlier: `891119ac...`, `d7cc1b24...`). The manifest, the gate files, the pinned runner and the comparator are unchanged.

## Candidate 4 (CANDIDATE-4: S0-10 under PITR)
See `WINDOW-COMMAND-MACOS-C4.md` (authoritative). Baseline `BASELINE-W1-MACOS-CANDIDATE-4.json` = candidate 3 + `g4_pitr_base`, `g4_pitr_api`, `g4_pitr_idle`; installs into `~/hone-s1/window-reads-c4`; candidate-3 files in `../window-reads/` are untouched.
