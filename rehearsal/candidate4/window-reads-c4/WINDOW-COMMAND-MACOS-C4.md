# Window commands, macOS, candidate 4: S0a and row 4 under PITR

> **CANDIDATE 5 (2026-10-27).** Sam accepts a minimum OBSERVED recovery span of 6 days (configured retention unchanged). S0-10's API span minimum now comes from the baseline field `g4_pitr_api.min_span_days = 6`; the typed dashboard retention minimum stays `g4_pitr.min_retention_days = 7`. Lag 30 min, earliest margin 5 min, read age 60, pre-point age 30, capture age 60, the 1 s dashboard tolerance, row-4 coverage, labels, ack and idle settings are unchanged. The S0-10 line now also says the observed span and whether the earliest point is the 7 d clamp or a later base-backup step (information only). A candidate-4 baseline (no `min_span_days`) is refused by this comparator. The c4 originals are kept as `*.c4`. Install path unchanged: `~/hone-s1/window-reads-c4`.


Candidate 4 replaces candidate 3 for today's window. The Management API lists **no base backup under PITR** (Insurance `S0-10-UNDER-PITR-END.json`), so the scripts no longer ask for one. The comparator reads the captured `pitr-backups.sh` result itself; typed dashboard values are only cross-checked (within 1 s). Candidate-3 files stay untouched in `window-reads/`; candidate 4 installs into its **own directory**, `~/hone-s1/window-reads-c4` (the S1 read-back script keeps its pinned candidate-3 comparator).

| Script | sha256 |
|---|---|
| `window-s0a.sh` | `ca0450d34daff4b51a1df067f2cb366ff5ddf98ace9e67719afd0b248e4293e6` |
| `window-row4.sh` | `804a7ed3b9fc21a61b2bd7d42aa49f901a4cc10172b6f15ec155db532bad2f31` |

Pinned: comparator entry `c9b0f102980104d5bd1d59c2127439dacc419ed1c7db235ad7f5acedf9205825`, lib `f0f13c80d91a5d23a69410d220b444db6935e915bd5f3f9319a5e67602b106ab`, baseline `BASELINE-W1-MACOS-CANDIDATE-5.json` `1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82`, plus the runner, manifest, G3 file and 14 gate files (unchanged bytes).

## What the PASS means
A bare `OVERALL PASS` is never accepted by the scripts. The only accepted lines are:
- S0a: `OVERALL PASS (provider range; base backup UNVERIFIED; restore not tested)`, or the same with `; idle path)`.
- Row 4: the same bare-label line, or `...; idle path, restore target L)`.
The PASS is **not** evidence that a base backup exists or that a restore works. Only an S0b restore test shows that.

## 1. Download (once; stage, verify, then install into `~/hone-s1/window-reads-c4`)
Paste this one line (no secret, no project ref). It verifies every sha256 and `shasum -c MANIFEST.sha256` before installing the complete directory:

    ( set -u; S=$(mktemp -d) && D=sam@100.123.145.56:/home/sam/hone-handoffs/2026-10-18/machines/window-reads-c4 && scp -q "$D/window-s0a.sh" "$D/window-row4.sh" "$D/compare-preflight.mjs" "$D/compare-preflight-lib.mjs" "$D/BASELINE-W1-MACOS-CANDIDATE-5.json" "$D/G3-CHECKSUMS-d189768b.txt" "$D/MANIFEST.sha256" "$D/run-window-read-macos.sh" "$D/g02-history.sql" "$D/g06-payment-drain.sql" "$D/g07-sms-claimed-number-duplicates.sql" "$D/g09a-0214-reach-summary.sql" "$D/g09b-0214-reach-per-studio.sql" "$D/g09c-0214-bound-account-mode.sql" "$D/g09d-0214-currency-history.sql" "$D/g10-constraint-names.sql" "$D/g11-0244-legacy-laser-types.sql" "$D/g11b-0244-legacy-laser-classes.sql" "$D/g12-0243-intake-definers.sql" "$D/census-0213-0246.sql" "$D/s1-open-transactions.sql" "$D/w03-table-sizes.sql" "$S/" && for p in window-s0a.sh:ca0450d34daff4b51a1df067f2cb366ff5ddf98ace9e67719afd0b248e4293e6 window-row4.sh:804a7ed3b9fc21a61b2bd7d42aa49f901a4cc10172b6f15ec155db532bad2f31 compare-preflight.mjs:c9b0f102980104d5bd1d59c2127439dacc419ed1c7db235ad7f5acedf9205825 compare-preflight-lib.mjs:f0f13c80d91a5d23a69410d220b444db6935e915bd5f3f9319a5e67602b106ab BASELINE-W1-MACOS-CANDIDATE-5.json:1b22730afd845aa50358a4fe3fb5f68aa36d22293329c7d16ba2effce7a50d82 G3-CHECKSUMS-d189768b.txt:bbdcd917da77f750f7987d6a5fdca172c6a564fc029d10d19a6ae1e51190f0f6 MANIFEST.sha256:2b1608a9ec43caf97bd9ead3fe1d10895652a080a4b8ae0a891a17be3038cd94 run-window-read-macos.sh:471ecb9d18116f9b5c898400d9dae0aa898be5aa795b2788c44eacdefeb27357 g02-history.sql:4a1005351b9c2aa7d7d354cfcb2f38196f5257a42f53d1b1224b9d7a50bea65f g06-payment-drain.sql:1c1281fb50eca974409ec8add028ac6b040539aa840dbea09e61e7e47877de15 g07-sms-claimed-number-duplicates.sql:c2e8c4d51a53cb9c3e4208f323b6ce200b41c86b3e3788b476b167222ab2548e g09a-0214-reach-summary.sql:94f72719a4888eb9750e82ac03c1b721cc046942fb5f6190d347776f2c6c8308 g09b-0214-reach-per-studio.sql:3a9399d61e2a1419fd837007d91c1ac2244415ee76988265986b1d898f3d20e6 g09c-0214-bound-account-mode.sql:677777c5a97187fc0731359f96eafdaa7623ae04652542cbc58fc4678fbeeac2 g09d-0214-currency-history.sql:0eff4a70bfdafb9938880a7907556f9b307ef35e6b9cbe4394ee278065465f4d g10-constraint-names.sql:87dffeb4f64583b49dfe9aae49aeb9e0014cff5156ed7186aa17312c4a1ddc46 g11-0244-legacy-laser-types.sql:c072bea00a4ecd71723aa42113a444805d33fbb48378cddf33eddd3590be5f75 g11b-0244-legacy-laser-classes.sql:8b509208ee7d830b445dfc9730ff8159b0a23e76c713c2a6f4762135ff562a26 g12-0243-intake-definers.sql:2c852e304c57a0193a644092b38a672de68e94a86908970a373a58ad6e7e0d57 census-0213-0246.sql:4817b78e8d0d7d1350c5337645f275bba4c799bdeadd4a93e776783f31aa5879 s1-open-transactions.sql:37aef615ead1b88b3b8405d52ab33bdefaaca3b1dc3628ae77436d24deddf7e0 w03-table-sizes.sql:7c7a1e09ee7d6572f9093a91c1ca41f9da427d153ded59595a1e14274053ee09; do [ "$(shasum -a 256 "$S/${p%%:*}" | cut -d" " -f1)" = "${p#*:}" ] || { echo "STOP: sha256 mismatch for ${p%%:*}"; exit 1; }; done && ( cd "$S" && shasum -a 256 -c MANIFEST.sha256 >/dev/null ) && W="$HOME/hone-s1/window-reads-c4" && mkdir -p "$W" && chmod 700 "$W" && for f in window-s0a.sh window-row4.sh compare-preflight.mjs compare-preflight-lib.mjs BASELINE-W1-MACOS-CANDIDATE-5.json G3-CHECKSUMS-d189768b.txt MANIFEST.sha256 run-window-read-macos.sh g02-history.sql g06-payment-drain.sql g07-sms-claimed-number-duplicates.sql g09a-0214-reach-summary.sql g09b-0214-reach-per-studio.sql g09c-0214-bound-account-mode.sql g09d-0214-currency-history.sql g10-constraint-names.sql g11-0244-legacy-laser-types.sql g11b-0244-legacy-laser-classes.sql g12-0243-intake-definers.sql census-0213-0246.sql s1-open-transactions.sql w03-table-sizes.sql; do cp "$S/$f" "$W/$f" || exit 1; done && chmod 0755 "$W/window-s0a.sh" "$W/window-row4.sh" "$W/run-window-read-macos.sh" && echo "candidate 4: complete directory sha256 OK, installed in $W" ) || echo "STOP: download, sha256 check or install failed; run nothing"

Any failure prints STOP; run nothing after it.

## 2. Before S0a: capture the recovery range (read-only)
Run `pitr-backups.sh` (sha `85407d0b...`, unchanged) so a fresh `~/hone-s1/pitr-backups.<random>` exists: mode 700, yours, `backups.json` + `backups.meta.json`. The scripts take the **newest** such directory (refuse a symlink, wrong owner or mode, missing file). The capture must be at most 60 minutes old when S0a runs and not in the future.
**Open the dashboard at the same moment and read earliest/latest then** (refresh the page): they must agree with the capture within 1 second; `latest` advances, so reading minutes later fails the cross-check.

## 3. S0a
    /bin/bash ~/hone-s1/window-reads-c4/window-s0a.sh

Typed: operator label, window start/end (UTC), the two holds, maintenance flag decision, PITR enabled (`true`), retention days, earliest and latest recovery point (UTC; dashboard shows local time, convert: EDT +4 h, EST +5 h), "Use the idle proof (yes/no)", r6 choice (`S0b` or `accept_rpo`), answer and reference, and the 0242 disposition. Base backup status/time/source are **not asked and not accepted**. The r6 acknowledgement must be typed exactly `base backup unverified, restore not tested`; with `accept_rpo` the answer text must also contain the words "unverified base backup". The same S0-10 PASS needs: PITR and WAL-G enabled, range at least 7 days, earliest before latest, latest not in the future, no COMPLETED physical backup listed (otherwise the mode must be `listed`), and either latest within 30 min of the read or the idle proof.

**Idle proof at S0a only** (only if the latest point lags more than 30 min): run `pitr-wal-twice.sh` first (two reads of the WAL archiver, then a ready count); the comparator applies Insurance's A0-A8 rules. Nothing typed counts as an idle assertion.

## 4. Row 4 (immediately before S1)
    /bin/bash ~/hone-s1/window-reads-c4/window-row4.sh

`select` stamps the restore point; AFTER that stamp run `pitr-backups.sh` again and wait until the dashboard's latest recovery point is at or after the stamp. Bases offered: `latest_at_or_after` and `named_restore_point`. **The idle basis is not offered for this window** (typing it stops the script): S1 accepts only the latest-at-or-after result and does not enforce the idle path's `valid_until`, so an idle row 4 could never start S1. The idle proof remains available at S0a only, as the lag waiver. Start S1 within 10 minutes of the PASS.

## 5. Open items (outside this change)
- `s1-apply.sh` does not enforce an idle path's `valid_until`; the comparator still supports `idle_proven_latest`, but window-row4.sh no longer offers it.
- **Keep the candidate-3 install in `~/hone-s1/window-reads`**: `window-s1read.sh` uses it. Candidate 4 does not replace or modify it.
- The dashboard/API 1 s agreement is brittle when `latest` advances.
- The C3 README sections still describe candidate 3; this document is authoritative for candidate 4.
