# Verify-bundle authoring (HON66-OPENS 2)

`make-verify-bundle.py --migrations DIR --first 0247 --last 0250 --out OUTDIR [--capture FILE.json]` derives, from the APPROVED migration files of one stage, the read-only checks
the `verify` action can run after the push, builds `verify.tar` reproducibly (same files -> byte-identical tar -> same `verify_sha`), and writes `review.md` for OPS.

* Derived from the text: functions created (existence), tables created, row level security enabled, and the FINAL EXECUTE / table privilege per (object, role) after the last GRANT/REVOKE.
* Needs a reference database: function-body hashes. The tool writes the SQL to `needs-reference/`; a CI step on a disposable database that already holds the stage runs it and passes the rows back with `--capture`.
* Not covered: every other statement kind is listed in `review.md` with a count, so OPS can decide whether a hand-written check is needed. A derived check that errors on the target (for example a function signature the tool mis-parsed) makes `verify` STOP, never pass.
* OPS reviews `review.md` per stage, then puts `verify_sha.txt` into the approval (`verify_sha=`) and copies `verify.tar` to `/srv/hone-release-inbox/verify.tar`.

`templates/stage-0247-0250/` is the tool's output for the current 0247-0250 files in the worktrees (read only; those files are held and NOT edited by this work). Regenerate it from the exact approved bytes before use: the file shas in `review.md` must match the approved list.
