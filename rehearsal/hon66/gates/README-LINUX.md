# HON66-LINUX-GATES — operator notes (Linux x86_64 / VPS)

Status: rehearsal-proven on Linux CI against a LOCAL Supavisor. Nothing here has run against a hosted project. A hosted push needs the
operator's per-change, exact-stage authorization; this file does not grant it.

## 1. Install (verifies before it copies)

    install-linux-gates.sh STAGE-DIR MANIFEST-SHA256 [--archive supabase_2.102.0_linux_amd64.tar.gz]

`MANIFEST-SHA256` is typed from the reviewed END file, never taken from the stage. The stage's `LINUX-MANIFEST.sha256` must match it,
every file must verify, no unlisted file may exist, and the archive's `supabase` member must be the pinned linux_amd64 2.102.0 binary
(`174a90e2…`). Nothing is installed on any mismatch. A different existing file at a target is refused, never overwritten.

## 2. Credentials

Files only, mode 600, owner you, one hard link, one non-empty line, absolute path, not a symlink, directory not group/other-writable.
Paths travel as arguments to the launcher and as environment NAMES (`HONE_GATE_TOKEN_FILE`, `HONE_GATE_PASSWORD_FILE`); values are
never printed and never on a command line.

    hone-gate-launch.sh [--token-file P] [--password-file P] -- GATE-SCRIPT

| gate | token | password |
|---|---|---|
| window-s0a.sh, window-s1read.sh, window-gap-read.sh | required | required (present, so the CLI never performs a login-role write) |
| pitr-backups.sh | required | forbidden |
| window-row4.sh | forbidden | forbidden |

Apply path (`db push --db-url`): password only, NO token. Reads: one PAT (Database Read + Backups Read). No `supabase link`.

## 3. row 4 / restore point

`window-row4.sh` uses basis `latest_at_or_after` only. The named restore point is EXCLUDED from routine automation. The outcome of
`hs1-20261027014041` is recorded as UNKNOWN.

## 4. Apply: hone-push-linux.sh (replaces the manual yes/yes and the pin watchdog)

    HONE_GATE_PASSWORD_FILE=/abs/pw hone-push-linux.sh --go ~/hone-s1/supabase-cli/supabase-go \
      --url-base 'postgresql://postgres.<ref>@<pooler-host>:5432/postgres?sslmode=require' \
      --workdir DIR-WITH-supabase/migrations --expected LIST-OF-34-FILE-NAMES [--limit 120] [--every 1]

Refuses unless: history at/after 0213 is a contiguous PREFIX of the expected list; the dry run lists exactly the remaining suffix;
no postgres-role statement is active (twice, 3 s apart) and history is stable; a canary statement is cancelled by a short-limit guard on
the same role and path; the real guard has completed a poll. It then pushes, and always ends by re-reading history and printing
COMPLETE / PARTIAL k/N / INCONSISTENT / ALREADY-COMPLETE / UNKNOWN. **Resume = run the same command again**: state is re-derived, only
the remaining files are pushed, and a file that may be in flight is never re-pushed.

What the guard does and does not claim: it cancels any postgres-role statement that started after it armed and has run longer than
`--limit` seconds (default 120), polling every `--every` seconds. It proves it was polling (zero blind polls) and able to act (canary);
it does not claim to have seen the push session, which the pooler makes indistinguishable from any pooled postgres session.

Never Ctrl-C the wrapper expecting it to stop a running statement: signals are recorded and the push is left to finish.

## 5. Why the old watchdog never PINNED (2026-10-27)

It pins by SAMPLING the first new active postgres-role backend. Measured on a fast 34-file push through a local Supavisor: the push is
visible as `postgres | Supavisor | active | holds an xid` for ~0.1 s of a ~0.35 s run, so a 5 s poll sees it about 2% of the time and a
1 s poll about 10%. The match predicate was correct; the sampling was the defect. `application_name` and `options=-c …` in the db-url
do NOT reach the session through the pooler, so a nonce pin and a client-set session timeout are both impossible on that path. A
role-level `ALTER ROLE postgres SET lock_timeout/statement_timeout` does apply to NEW pooled backends (a hosted write: proposal only).
