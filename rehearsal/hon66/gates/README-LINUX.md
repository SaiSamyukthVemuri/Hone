# HON66 Linux gates — notes (HON66-LINUX-GATES + HON66-PROOF)

Rehearsal-proven on Linux CI against a LOCAL Supavisor only. Nothing here has run against a hosted project; nothing here is custody.
Custody is Team's hone-release layer (root-owned launcher, root manifest, secret on fd 3, single-use root-written approval). These
scripts enter that manifest as ACTIONS after review; they are not installed on their own.

## What changed in HON66-PROOF (Insurance PEER-HON66-PACKAGE-END)

| finding | change |
|---|---|
| M1 launcher is not custody | `hone-gate-launch.sh` is DELETED. The read gates take the PAT on **fd 3** (exactly one non-empty line, ≤ 4096 bytes, then closed). No credential file is ever opened by a gate. |
| M9 reads need no DB password | reads use a FIXED NON-SECRET placeholder (`hone-read-placeholder-not-a-secret`) only so the CLI never creates a login role. CI experiment H6c checks the CLI never authenticates with it; if that proof does not pass, the real password must come back (see the END). |
| M3 guard scope | the guard cancels only pooled (`application_name = 'Supavisor'`) postgres-role statements that started after arming and ran past the limit; direct sessions are never touched; every cancel is recorded (pid, secs, app, addr, query_start, md5 and length of the query, never its text); it exits when its parent is gone and after 900 s; the wrapper requires a pre-arm census of ZERO non-idle postgres-role sessions. **Not achievable through the pooler:** limiting the guard to "the push's own backend" (the pooler makes every pooled session `Supavisor`). Another pooled postgres-role statement that starts during the window and runs past the limit WOULD be cancelled: run attended, keep other pooled postgres-role work off. |
| M4 login storm | one login per poll; default poll 2 s; failed polls back off (×2, cap 8 s); an authentication failure or 3 consecutive failed polls writes `FAILED-LOGIN` and stops; the wrapper refuses while `FAILED-LOGIN` exists and never retries a login. |
| M6 resume | resume is a DELIBERATE, REVIEWED EXCEPTION to no-retry, reachable only through the reconcile rules (clean contiguous prefix; dry run equals the remaining suffix; nothing non-idle twice; history stable). `IN-FLIGHT` is written before the push and cleared only by a state-derived verdict; a run that finds it prints `RESUME …` and records `resume-of-in-flight` in `RUN-RECORD` against the same `--approval-id`. |
| M7 attended gates | `window-s0a` / `window-row4` stay **attended on the Mac** for the first routine releases (their typed values are interactive). The Linux copies exist and pass their tests but are NOT proposed as routine manifest actions. Only the credentialed reads (`window-s1read`, `window-gap-read`, `pitr-backups`) are proposed as actions. |
| M5 | no `ALTER ROLE` timeout is proposed. The earlier local result (a role-level `lock_timeout` applies to new pooled backends) is recorded as a fact only; using it would be a production setting change needing its own exact-stage approval with a mandatory RESET and read-back. |

## Apply wrapper (not a custody layer; to be folded into release-apply v2)

    hone-push-linux.sh --go ~/hone-s1/supabase-cli/supabase-go --url-base 'postgresql://postgres.<ref>@<pooler-host>:5432/postgres?sslmode=require' \
      --workdir DIR --expected LIST --approval-id ID [--tombstone-dir DIR] [--limit 120] [--every 2]  3< password-source

It binds NO sha or approval itself: it checks only that the migrations directory equals the expected list by NAME, so it is safe only
when called by a layer that already verified the bytes (Team's intake).

## Why the old watchdog never PINNED (2026-10-27)

It pins by SAMPLING. A fast 34-file push through the session pooler is visible as `postgres | Supavisor | active | holds an xid` for
~0.1 s of ~0.35 s, so a 5 s poll sees it ~2% of the time (0 of 3 in CI, also 0 of 3 at 1 s). The predicate was right. `application_name`
and `options=-c …` in the db-url never reach the session through the pooler, so neither a nonce pin nor a client-set timeout exists.
