# Preparing the verify bundle and the S0a record for a stage (existing tools only; nothing new is built)

## verify.tar (OPS reviews, Sam types the sha)

1. Take the APPROVED migration files of the stage (for 0247-0250 the sealed set: sha256 `9f76565a...`, `1f6f9ad0...`, `36941328...`, `09e54285...`; identical in `b2b6e4966` and `be402353c`).
2. `python3 -I tools/make-verify-bundle.py --migrations <dir of those files> --first 0247 --last 0250 --out <outdir>` (pure Python, no database). It was run twice on the sealed files: byte-identical `verify.tar`, `verify_sha` `0d299a1699cdc94ee78e21cb8c670b0971fc8b93cf1836472b342dff57b116f2`, and the output equals `templates/stage-0247-0250/` exactly.
3. OPS reads `review.md` (what is checked, what is listed as NOT covered) and decides whether a hand-written check is needed. Function-body hashes need a disposable reference database that already holds the stage (CI); until then they are listed in `needs-reference/`, not claimed.
4. `verify_sha=<64 hex>` goes into the approval; `verify.tar` goes to `/srv/hone-release-inbox/verify.tar`.

## The S0a record (Machines' attended gate; the launcher only binds what Sam types)

1. S0a is Machines' reviewed gate `window-s0a` (Linux copy `machines/linux-gates/window-s0a-linux.sh`; it stays ATTENDED for the first routine releases). It reads the recovery range, the 14 gate files and the idle/WAL evidence, runs the pinned comparator and prints `WINDOW S0a: ...` into `verdict.txt` in its work directory, together with the results and attestation.
2. The record Sam binds is that work directory's `verdict.txt` (proposed, see below): `s0a_sha` = `sha256sum verdict.txt` (full 64 hex); `s0a_at` = the UTC time of that run (`YYYY-MM-DDTHH:MM:SSZ`, not in the future); `recovery_stamp` = the recovery point S0a saw (not after `s0a_at` and not more than 7 days before it).
3. `quiet_db=idle`: `s0a_writes` = the user-table write counter seen at S0a (digits; the same quantity `idle-probe` reads: the sum of inserts, updates and deletes over user tables). Run the package's `wal-capture` action at the S0a moment (it stores `S0A-WAL.json` and prints its sha) and `idle-probe` within 30 minutes of it; the apply refuses if the counter has moved since S0a. `quiet_db=heartbeat`: `recovery_stamp=none`, `s0a_writes=none`.
4. `approve-package.sh` / the apply refuse an `s0a_sha` that is not a full hex sha, an `s0a_at` that is malformed or in the future, a stamp outside that range, and a changed write counter.

Two points are for Machines/OPS to CONFIRM, because no tool here depends on them (only on the typed values): (a) that `verdict.txt` is the file whose sha is "the record"; (b) which line of the S0a evidence names the write counter. Until confirmed, the S0a record preparation is documented, not exercised.
