# HON-66 acceptance: one consolidated package, two clearly separated outcomes

Package head and CI run: see the END record HON66-CONSOLIDATE-END.json (a file cannot name the commit that contains it). Rehearsal PR #1193 (DRAFT, NEVER MERGE). Nothing here was run against a hosted system with a credential. No hosted migration, credential installation or host-access change is approved by this document.

## The two outcomes are not the same thing

| | ATTENDED FALLBACK | AUTONOMOUS |
|---|---|---|
| Who is at the keyboard | Sam is present for the stage. | Nobody after Sam's exact-stage approval. |
| Recovery gate | `recovery_basis=waiver` with a recorded `WAIVER-YYYYMMDD-N` (Sam's own act; **not a pass**). No provider evidence is required. The run record says `path attended-fallback`. | `recovery_basis=row4`: the launcher STOPs unless the custody-recorded provider evidence is present and fresh (see section C below). The run record says `path autonomous`. |
| Connection / timeout | Either mode. `pooler` needs every approved file to carry its own bounded `set local statement_timeout` (B2), so it cannot carry today's files. | `direct` (db.<ref> host, startup options, verify-full): server-enforced, no file change. |
| Operator Mac | `s1-apply.sh` on the Mac (macOS) remains the reviewed attended script (unchanged here). Whether the Mac can reach the IPv6-only direct host is an OWNER check; if it cannot, this column needs B2 or B3. | not used |

Cell labels: **PROVEN** = demonstrated on THIS host (the VPS) with the artifact named. **PROVEN-ON-CI-RUNNER-NOT-THIS-HOST** = a disposable CI runner with real users/sudo/PostgreSQL; **STUB** marks a rehearsal whose CLI is a stub. **OWNER ACTION** = exact action. **OPEN** = not done.

"CI" below means the CI run named in the END record at the PR head named there; the test names are the lines printed by `rehearsal/hone-release/ci/custody-test.sh` (job `release-custody`, stub CLI), `ci/e2e-test.sh pg` (job `release-apply-pg`, REAL CLI, plain PostgreSQL 16 with TLS from a test CA) and `ci/e2e-test.sh supavisor` (job `release-apply-e2e`, REAL CLI, local Supavisor).

## A. HON-66 "Meaningful acceptance" bullets

| # | Acceptance bullet | ATTENDED FALLBACK | AUTONOMOUS |
|---|---|---|---|
| A1 | Happy path with exact manifest and result binding | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody "apply with the approved package: 34 applied", run record binds PR, PR head, receipt sha; e2e pg and e2e supavisor "34 migrations applied ... history 245, max 0246". Real Mac script: run 40571681931 macOS 116/116 (unchanged, not rerun). | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody "AUTONOMOUS path, E4(a) idle" and "E4(b) heartbeat" (stub CLI, run record says `path autonomous`); real-CLI apply with `direct` in e2e pg. The autonomous path with REAL provider evidence: OWNER ACTION (install + PAT, section D). |
| A2 | Wrong target / hash / history drift refuses before writes | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody T2/T5 cases (bundle, list, head, host, user, password in URL, port 6543, other project's host), dry run listing a wrong range (`CUST-MISMATCH`: consumed, nothing pushed). | same cases (the checks are mode-independent). |
| A3 | Two simultaneous runners: only one owns execution | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody "two simultaneous launches: the second is refused by the single release lock"; push completed exactly once. | same. |
| A4 | Short and long statements prove the selected timeout mechanism | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: e2e supavisor B2: a per-file `set local statement_timeout = 2s` makes the server cancel a 30 s statement through the REAL CLI and the pooler (57014); the REAL 34 files are REFUSED by the pooler gate. Short statements: every file of the 34-file apply. | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: e2e pg B1: a 30 s statement in a file with no timeout text is cancelled by the SERVER at the 3 s startup `statement_timeout` through the REAL CLI (its `RESET ALL` before each file keeps the startup values); client wall clock kills a 600 s-bounded statement at 10 s. **OWNER ACTION**: the same startup-option behaviour on Supabase's real direct endpoint is not proven (it needs one authorized login): confirm once with a read-only `show statement_timeout` through the apply path at S0a. |
| A5 | Loss/interruption after a possibly committed stage yields explicit UNKNOWN, then reconciliation, not replay | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody SIGKILL of the script mid-push stays `IN-FLIGHT`; the next launch is refused as UNKNOWN; sam cannot clear it; client wall clock gives `UNKNOWN-KILLED`; a new approval cannot launch again. Real CLI: e2e pg kill at 10 s, history stops at the last whole file, the abandoned server statement is aborted. | same, plus `reconcile` (read token, Management API) classifies the approved range NONE / ALL / PARTIAL: **STUB** in CI (the Management API is not reachable from CI). OPEN until one authorized hosted read. |
| A6 | Failed preflight / drain / recovery condition refuses | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST for window, 75-minute rule, S0a freshness, waiver format, expiry. **OPEN: in-flight/old-work drain** is not a launcher control (it lives in OPS's window scripts). | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (STUB provider answer): no evidence, PITR off, span < 6 d, latest point older than the stamp, no/active idle proof, evidence older than 900 s, no heartbeat, evidence read before the heartbeat, recovery point not past the heartbeat: each STOPs with no CLI call. **OPEN: drain**. |
| A7 | Post-apply mismatch stops release and produces the exact receipt | OPEN: the launcher produces `run.txt` (bundle, list, head, PR, receipt, window, mode, timeouts, log shas) and checks the dry-run and push listings; the post-apply read-back (history/ACL/function-body hashes, smoke) is OPS's `window-s1read.sh`, not chained here. | OPEN: same. |
| A8 | No credentials in logs; restart/resume cannot reapply a completed stage | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: custody scans every byte sam received for the canaries (none), approval single-use, state `APPLIED` + consumed approval, "a further apply ... does not push again". | same. |

## B. HON-66 "Required bounded flow" 1-8

| # | Flow item | ATTENDED FALLBACK | AUTONOMOUS |
|---|---|---|---|
| F1 | Versioned manifest: project, hashes, stage order, compatible app/recovery commits, preflight, drain, stop/recovery, verification | PARTIAL: the approval binds project ref, bundle sha, list sha, head, PR, PR head, receipt sha (carries the compatible application commit), first/last/count (never "all pending"), window, recovery basis, S0a sha/time, connection mode, three timeouts. **OPEN: drain rules and verification list** are not in the record. | same. |
| F2 | Noninteractive preflight, pinned tooling, identity/drift/recovery evidence, reviewable GO/NO-GO | PARTIAL: pinned CLI sha, project ref from a root file, dry-run listing, `read-backups`/`idle-probe`/`heartbeat`/`reconcile`/`status`. **OPEN: no single GO/NO-GO report generator.** | same. |
| F3 | Approval bound to exact package/target/window; refuse changes/expiry; no re-approval of routine steps | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: `approve-package.sh` takes typed full shas and recomputes; 60-minute cap; single use; consumed at the first dry-run attempt. | same. |
| F4 | Owner-controlled credential storage, least scopes, no secrets in chat/source/logs; report only the missing one-time setup | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (custody, canary secrets): two secret files (db-password for `apply` and `heartbeat` only; read-pat for `read-backups`, `idle-probe`, `reconcile` only). **T7 on-host custody: not on this host** until Sam's option A is approved and executed; the VPS user is in `docker` and `sudo` and `install.sh` refuses. OWNER ACTION: section D. | same. |
| F5 | Single-release lock, automatic timeout/cancellation, session binding before writes (incl. a very fast push), no reliance on an "armed" prompt or second terminal; fix/reuse the watchdog **or review a supported replacement before removing it** | Lock: PROVEN-ON-CI-RUNNER-NOT-THIS-HOST. Timeout: B2 per-file `set local` (CI supavisor) or the client wall clock. **Watchdog replacement for review (not silently removed):** the old watchdog pinned a session and killed a statement. Now (i) on `direct` the limits are connection STARTUP options, in force before the first statement of the session, so there is no pin step and a push that finishes in 3 s is bound the same as a long one; (ii) `client_connection_check_interval` makes the server abort a statement whose client was killed; (iii) the client wall clock kills the CLI. On `pooler` (B2) each file's own `set local` is in force from the start of that file's transaction. Needs Insurance's fresh review of this paragraph. | Lock PROVEN-ON-CI-RUNNER-NOT-THIS-HOST. Timeout/session binding: B1, e2e pg (real CLI, stock PostgreSQL). **OPEN (OWNER ACTION)**: the hosted direct endpoint (see A4). Machines' guard/gates/resume are NOT folded in (HON66-PROOF: V1-V5/H6c/M9 unproven). |
| F6 | Apply only the approved stage in order; checkpoint; stop on error/drift/lost ownership/failed drain/uncertain write; read back before any resumption; never blind retry | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST: exactly the approved range in order, one dry run, one push, no retry; every non-APPLIED state blocks until root clears; read-back precedes clearing (`reconcile`, STUB in CI). | same. |
| F7 | Automatic verification of history, ACL/function checks, serving source, smoke; tamper-evident receipts | OPEN: only the launcher's own `run.txt` with log shas; the verification set is OPS's read-back scripts. | OPEN: same. |
| F8 | Integrate with the release queue and monitoring; no new scheduler, no blanket auto-merge/apply | Not built; no scheduler, no merge or apply authority is granted by the package. | same. |

## C. Recovery controls (HON-66 "Recovery correction")

| Item | ATTENDED FALLBACK | AUTONOMOUS |
|---|---|---|
| Supported provider recovery-readiness path | A recorded waiver, never a pass; Sam's act. | `read-backups` writes `BACKUPS-EVIDENCE` (read_at, pitr_enabled, earliest, latest, span) from the provider's own answer (shape from the CLI's `V1BackupsResponse`, source cited in EVIDENCE-A). The apply requires, else STOPs: evidence read inside the window and <= 15 min old (<= 30 min just before the push); PITR enabled; span >= `min_span_days` (>= 6, S0-10); S0a sha/time typed from the S0a record, inside the window and <= 3 h; and the E4 proof. **OPEN: the real provider call has never been made** (needs the PAT, OWNER ACTION). |
| E4 quiet database, Sam's one-word choice (`quiet_db=idle` or `heartbeat`, an approval field) | both implemented and rehearsed (STUB CLI): **idle** = two equal user-table write counters 120 s apart (`IDLE-PROOF`) and latest recovery point >= the typed `recovery_stamp`. It proves "no write between the samples", not when the last write was: **OPEN**. **heartbeat** = one `pg_logical_emit_message` (no table, no row; real CLI against a local server, 26/26 e2e pg) and evidence read AFTER it with latest point >= it. **OPEN (OWNER ACTION)**: whether the hosted provider's latest recovery point advances after such a message, and whether the hosted `postgres` role may execute `pg_logical_emit_message`, are unknown; exercise once at S0a. | same. |
| Named restore point | Excluded: no installed script or the launcher can call a restore or restore-point endpoint (CI greps the installed scripts). | same. |
| HTTP 400 on the restore-point POST | UNKNOWN, never retried, never a restore target (not callable from the package). | same. |

## D. T4 and T5, resolved (Sam's ruling: no longer "accepted residuals")

| Item | Result |
|---|---|
| T5 CLI source | v2.102.0 (commit 0ad9687266c7b690f18edffaa9dd63dc1204c8a8): `--db-url` is parsed at `apps/cli-go/internal/utils/flags/db_url.go:42-43,59-68`; the connection is made from a REBUILT URL (`internal/db/push/push.go:29` -> `internal/utils/connect.go:223` `ConnectByUrl(ToPostgresURL(config))`, `connect.go:23-45` emits only `connect_timeout` and RuntimeParams). So `sslmode` / `sslrootcert` in the `--db-url` are NOT honoured. pgx v4 / pgconn v1.14.3 reads `PGSSLMODE` / `PGSSLROOTCERT` for any setting the URL does not carry (`config.go:425,429`), `verify-full` sets `ServerName` to the host (`config.go:688`). The package therefore sets them in the CLI child's environment. |
| T5 proof | CI e2e pg through the REAL CLI: right CA + exact host accepted; wrong CA refused; right CA + host the certificate does not name refused (separates verify-full from verify-ca); no CA refused; an impostor certificate for the right name from another CA refused through the launcher with NO authentication seen by the server. The old CI probe (valid-wrong CA connected) is superseded. |
| Real hostnames, non-credentialed handshake from THIS host (EVIDENCE-A-T5.txt) | PROVEN: SSLRequest + verify against Supabase Root 2021 CA (sha256 of the CA file `70072358...f3b7`): the direct host `db.<ref>.supabase.co` verifies with an EXACT per-project name; the pooler `aws-1-us-east-1.pooler.supabase.com` verifies only as the WILDCARD `*.pooler.supabase.com` (any tenant), so on the pooler the exact host remains a control as well. The direct host is IPv6-only and reachable from this VPS (TLS completed). OWNER ACTION: confirm the CA file's sha256 against the copy in Supabase's dashboard (the agent downloaded it). |
| T4 | B1 direct startup options: proven (A4). B2 per-file `set local statement_timeout` + lexical gate: proven through Supavisor (A4). B3 role-level setting: not used (production setting change, owner action M5, available if B1/B2 are unwanted). |
| B2 file impact, exactly | The gate (run on this host over the files) PASSES the 34 files 0213-0246 and 0247-0258 on `direct`, and on `pooler` REFUSES all of them for lack of `set local statement_timeout`. Under B2 these would need one added line after `begin;`: **0247, 0248, 0249, 0250, 0251, 0252, 0253, 0254, 0255, 0256, 0257, 0258** (12 files; 0213-0246 are applied and frozen). **Not edited**: their review and authority are separate. B1 (direct) needs no file change. |

## E. Sam's custody criteria

| Criterion | ATTENDED FALLBACK | AUTONOMOUS |
|---|---|---|
| Agents cannot read credentials | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (custody: secrets 700/600 owner hone-release; `/proc/<pid>/environ` and `fd` unreadable; canary scan). **T7 on-host custody: not on this host.** Headline limit: holds only if the agent user is in neither `docker` nor `sudo` (sam is in both; `install.sh` refuses). | same. |
| Agents cannot modify privileged scripts | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (all write/replace/move/link/chmod attempts fail; snapshot unchanged; pinned CA is root-owned). | same. |
| Agents cannot run arbitrary commands | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (`sudo -l` shows exactly the six launcher lines; shell escapes, env injection, PATH/LD_PRELOAD, symlink/TOCTOU, argument injection refused). | same. |
| Exact package | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (T1 pins incl. the CA, T2 typed shas, head in the tar header). | same. |
| Restore point excluded; 400 UNKNOWN | see C. | see C. |
| DB-password consumers (HON66-PERMISSIONS END) | Exactly two actions receive the database password: `apply` and `heartbeat` (the latter only under an approval selecting `quiet_db=heartbeat`). Reads use the separate PAT (Database Read + Backups Read). Insurance H1/H6: a Database (Read) token through `db query --linked` uses the general Run-a-query endpoint, so "read-only" rests on the fixed SQL in the scripts (the reconcile SQL is built from two validated 8-digit numbers; the idle probe is a constant), not on the token: OPEN (recorded-request CI test not built). | same. |
| Linux | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (Ubuntu runner, real linux_amd64 CLI 174a90e2). | same. |
| Pooler | PROVEN-ON-CI-RUNNER-NOT-THIS-HOST (local Supavisor session pooler; real CLI; the hosted pooler is not exercised). | not used. |
| Timeout | A4. | A4. |
| Interruption | A5. | A5. |
| Read-back | OPS's read-back scripts (not chained, F7). | same. |

## F. Owner actions (exact; none approved by this document)

1. Sam: decide `quiet_db=idle` or `heartbeat` (one word, per stage).
2. Sam: host-access option A (agent user out of `docker` and `sudo`), then install per `INSTALL.md` (pins typed from the reviewed record), then T7 on-host custody re-proof.
3. Sam: confirm the CA file sha256 against Supabase's dashboard copy.
4. Sam: create the project-scoped read PAT (Database Read + Backups Read) and the DB password file via `set-secret.sh`; first real `read-backups` call.
5. Sam: authorize ONE read-only hosted login to confirm the startup options and `pg_logical_emit_message` behaviour on the real direct endpoint (S0a).
6. Sam/OPS: check whether the operator Mac reaches the IPv6-only direct host; if not, the attended column needs B2 (12 files above) or B3.
7. Insurance: fresh review of the watchdog-replacement paragraph (F5) and the exact head.
