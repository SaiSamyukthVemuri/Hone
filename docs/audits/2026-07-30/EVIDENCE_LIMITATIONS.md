# Evidence limitations

What this audit could **not** prove, stated so nothing reads as verified that is not.

## Verification classes used

- **Source-verified** — read at `c64366c9ba4130283932bbe21e32bf2ed62c4975` in the exact worktree.
- **Hosted-verified** — read-only query against the production database.
- **Supplied, not independently verified** — taken from the task or from GitHub metadata.

The production **git SHA**, **migration set**, **ACL/trigger/flag state** and the **Willow practitioner
aggregate** are hosted-verified. The **serving deployment identity** (that deployment
`EdFCbgfuPn7jsh6n73kTcsVwVqEX` is the process actually serving hone.care) is **supplied, not
independently verified** — only that the URLs return 200 was checked.

## Permanently unavailable inputs

| Artifact | Status | Searches |
|---|---|---|
| `Hone_Findings.csv` | **PERMANENTLY UNAVAILABLE THIS RUN** | Exact-filename search of `~/Downloads`, `~/Documents`, `~/Desktop`, `~/Library/Mobile Documents`, `/Users/chloebaca/Hone`, `/Users/chloebaca/Hone-lineage` (maxdepth 4) |
| `hone_evidence_excerpt.txt` | **PERMANENTLY UNAVAILABLE THIS RUN** | Same |

Content was **not** reconstructed. No finding depends on them.

## Structural limitations

1. **Historical registers preserved, not re-verified.** All 74 July-10/18 rows are carried in full,
   but only the 48 July-27 findings plus the rows discovered here were individually re-verified.
2. **No production writes.** Read-only by authorization; findings needing a mutating reproduction say so.
3. **Test evidence.** CI run **30577864921 / #912** executed green at the audit head, covering the unit
   suite and the DB/RLS lane. Where a finding cites a test file that was **not** run, its
   `behavioural_test_evidence` says so rather than implying a green run.
4. **Raw-grant reachability.** `anon`, `authenticated` and `service_role` are all **NOLOGIN**; only
   `authenticator` and `postgres` can connect and PostgREST exposes no TRUNCATE verb. This is why the
   64-table TRUNCATE posture is P2 defence-in-depth and not a P0.
5. **Chloe feedback is a sanitized report**, not a reproduction: no names, screenshots or treatment
   content are stored. `CHLOE-002` is explicitly `EVIDENCE_LIMITATION` because the repository claims a
   fix that is not confirmed on the deployed build.

## Findings carrying missing evidence

**51 of 60** canonical findings record something they could not prove. That is not the same as
"status = EVIDENCE_LIMITATION" (which is **1**), and §A of the reconciliation report reports both.

| ID | Missing evidence |
|---|---|
| `F-CLIN-000` | I did not (and was told not to) re-query production, so I rely on the supplied hosted ACL/flag facts for the live grant state rather than my own has_table_privilege run. I did not execute a fresh-DB behavioural test proving an authenticated PostgREST INSERT into session_block_areas is refused; the … |
| `F-CLIN-001` | No two-transaction barrier test was ever written for finalizer-versus-child-write, and none should be now — the code path it would exercise is unreachable. I cannot prove from source whether the race ever occurred historically; the single legacy finalized session's snapshot hash still re-derives pe… |
| `F-CLIN-002` | I did not read build_session_snapshot's body at 0119 to enumerate exactly which columns it omits, because the answer cannot change the disposition — the function is unexecutable and no new snapshot can be inserted. I therefore neither confirm nor refute the audit's specific claim that session_block… |
| `F-CLIN-003` | I could not prove whether this interleaving has ever actually occurred in production — that would need a query correlating client_intake_forms.submitted_at against clients row-modification history, and no such history table is guaranteed to exist for public.clients; I did not query production. Ther… |
| `F-CLIN-004` | I did not query production, so I cannot say whether any live intake row is currently in status='reviewed' with submitted_at IS NULL — that single read-only query (`select count(*) from public.client_intake_forms where status='reviewed' and submitted_at is null and deleted_at is null`, grouped by st… |
| `F-SEC-001` | I could not verify from source whether the composite same-studio key that the hosted-facts summary attributes to sessions.treatment_plan_id actually exists in the live database: at commit c64366c the only DDL for that column is the plain single-column FK in 0024_treatment_plans.sql:69-70, and 0094/… |
| `F-SEC-002` | I could not determine from source how many active non-owner practitioners exist at Willow today; if the answer is zero, the member-versus-owner half of this bypass has no distinct actor at Willow right now (the owner-versus-her-own-invariants half, and the audit-cascade half, remain). A direct read… |
| `F-SCHED-001` | I could not establish how many active non-owner practitioners exist at Willow, which determines whether a distinct actor can exploit the residual today. I also could not verify from source alone that no operator or support workflow writes services/studio_blockouts through the authenticated PostgRES… |
| `F-SCHED-002` | Live values of studios.practitioner_capacity_enabled and studios.practitioner_capacity_booking_enabled for all 5 studios were not re-queried today. If any studio is capacity-ON, this finding flips to production_reachable=true and back to P1. |
| `F-SCHED-003` | Whether Willow's public booking page is actually receiving traffic today (no hosted appointment-source counts were supplied), and whether orphan client rows already exist. Also whether the Upstash rate limiter is configured in production — lib/rate-limit/public.ts fails open when the env is missing… |
| `F-SCHED-004` | Whether any existing appointment, timed block or recurring-break occurrence was actually written from a wall time inside a past DST gap — that requires a hosted query over starts_at against transition windows per studio timezone, which I did not run. |
| `F-SCHED-005` | Per-studio count of active role='owner' practitioners (needed to know whether the null-assignment branch is live at any tenant), current per-studio values of practitioner_capacity_enabled, and whether any appointments rows already have practitioner_id IS NULL. |
| `F-SCHED-006` | Real-world frequency of these query errors in production (no hosted error-rate or ops_alerts data was supplied), so I cannot say how often the fail-open has actually fired. |
| `F-PAY-001` | I could not determine from source how many ACTIVE practitioner rows Willow currently has. If Chloe is the sole owner-practitioner, the present-day exposure is limited to her own mistyping (refundable by her); if Willow already has an employee practitioner, the authorization gap is live today and th… |
| `F-PAY-002` | I could not determine from source whether any prospective studio has actually asked for deposits or no-show protection; the audit asserts commercial parity pressure without demand evidence. Whether this ever becomes a launch requirement depends on that demand signal, which is not in the repository. |
| `F-PRIV-001` | I cannot prove from source whether any such event has ALREADY been transmitted to Sentry — that requires querying the Sentry project's stored events (search by route pattern, never exporting raw URLs). I also cannot confirm from the repository whether Sentry's data region is US or EU, or the projec… |
| `F-PRIV-002` | I cannot determine from source how many public-booking audit rows exist in production or how many carry non-empty notes, so the size of the historical remediation is unknown. I also could not find any code that redacts appointments.notes on request, so the redaction-divergence scenario is currently… |
| `F-BILL-001` | I cannot determine from the repository whether Willow is currently paying, and if so under what arrangement — that is contractual information outside the tree. I also cannot verify whether hone.care/pricing (referenced by the terms page) actually publishes plans, since the marketing pricing page co… |
| `F-DATA-001` | Willow's live row counts for client_intake_forms, client_consent_signatures, client_clinical_notes, treatment_images and client_portal_messages were not queried, so the concrete volume of currently-unexportable Willow data is unquantified. No test or CI check exists that compares export coverage to… |
| `F-DATA-002` | No count of existing action='studio_export' audit_logs rows at Willow, so the number of already-mis-recorded exports is unknown. |
| `F-IMPORT-001` | Whether Quick Import has ever been executed in production (import_batches row count, and whether any row has voided_at set or completed_at NULL) was not queried. No fault-injection test exists, so the actual behaviour of the failure branch under a real DB error is unproven. |
| `F-RET-001` | Supabase backup retention configuration and whether a 90-day backup purge actually occurs could not be established from source; that is provider-side. No count of currently soft-deleted rows past 30 days at Willow. No legal review of whether the published wording matches operational reality. |
| `F-STORAGE-001` | No production evidence either way: ops_alerts was not queried for treatment_image_orphan_cleanup_failed, and the bucket object count was not compared to the treatment_images row count. A single production reconciliation query would settle whether orphans already exist. |
| `F-OFF-001` | Nothing to prove from source — the workflow simply does not exist. Whether a manual offboarding runbook exists outside the repository could not be established from the code. |
| `F-SCALE-001` | No load test and no measured memory profile at any scale; the actual row counts at Willow and the serverless memory limit configured for the deployment were not established, so the failure threshold is unquantified. |
| `F-SCALE-002` | Whether NEXT_PUBLIC/Upstash rate-limit env vars are actually configured in Vercel production (if not, limitPublicSlots is a no-op and there is NO brake at all), Willow's configured public_booking_horizon_months, and whether Willow's booking slug is publicly published. No benchmark of query count or… |
| `F-OPS-001` | Cannot verify actual Upstash availability history, plan tier or SLA from source; I did not query Upstash or Vercel env values. Cannot prove whether any real fail-open event has occurred in production (would require Vercel log search for event="ratelimit_backend_unavailable"). |
| `F-OPS-002` | I did not query production for the current `clients` row count or for the number of cross-studio duplicate phone numbers, so the actual scan cost today is unknown. No production evidence of a STOP having been processed. |
| `F-OPS-003` | Cannot confirm from source or from the authoritative hosted facts that the cron-job.org job is enabled, uses the correct CRON_SECRET, or has run recently. Confirming this requires reading the current Upstash `reminder_cron:last_success` key or the /admin Reminder scheduler card, neither of which I … |
| `F-OPS-004` | I did not and could not verify from source: the Supabase plan tier, whether daily backups or PITR are actually enabled on the production project, backup encryption, or whether any restore has ever been attempted. Confirming requires the Supabase dashboard (Database -> Backups). |
| `F-OPS-005` | I did not query production ops_alerts for evidence of ops_alert_insert_failed / ops_alert_email_send_failed events, so I cannot say whether an alert has ever actually been dropped in production. |
| `F-STAGE-001` | I could not verify whether the isolated staging project referenced in earlier work is still provisioned or at what migration level — it is not referenced anywhere in this source tree. No migration timing data from production is available in the repo. |
| `F-TEST-001` | I counted files, not assertions — a file that calls readFileSync once and then makes 40 behavioural assertions is counted as source-string. The true assertion-level ratio may be lower than 62%. |
| `F-TEST-002` | None material. I traced the public booking action end to end and enumerated tests/db/; the omission is verified by exhaustion rather than inferred. |
| `F-TEST-003` | No recorded acceptance run on a physical iPhone exists in the repository or in the production register. I cannot determine which iOS/Safari version Chloe uses. |
| `F-EXEC-001` | I did not download the per-lane logs or artifact checksums, so I confirm lane conclusions rather than individual assertion counts. No lane covers real providers (Stripe/Resend/Twilio/Google are all faked or dummied by design), so provider-contract behaviour at head remains unproven by CI. |
| `F-DOC-001` | I enumerated the drift instances I could reach by targeted grep on migration maxima, cron registration and deployment claims; the documentation set is large and other stale assertions likely remain unenumerated. |
| `F-COMP-001` | I could not verify from source the actual AWS region of the production Supabase project, the plan tier, whether backups are encrypted, or whether any subprocessor or data-processing agreement exists. Resolving which of the two statements is true requires the Supabase dashboard and the provider cont… |
| `F-GCAL-001` | I did not re-query hosted calendar_sync_control.worker_enabled or studios.google_calendar_outbound_sync_enabled today; the fail-closed gating is proven from 0125 and reconcile-store.ts source plus prior documented production state, not from a live read. I also have no production log evidence of the… |
| `F-GCAL-002` | I did not verify how many Google connection rows exist in production or their encryption_key_version values, so I cannot quantify the real blast radius. I also did not verify whether GOOGLE_TOKEN_ENCRYPTION_KEY_VERSION is currently set in Vercel production (if unset, isGoogleTokenCryptoConfigured()… |
| `F-GCAL-003` | I did not read every marketing page character by character; I grepped app/page.tsx, app/features and app/electrolysis-software for Google/Calendar/sync claims and found none, but a sales deck or email outside this repo could still overclaim two-way sync. |
| `F-CAL-001` | I did not verify whether any Willow practitioner currently has a non-null calendar_feed_token_hash, so I cannot say whether a live feed URL exists in production at all. I also did not check whether feed fetches are incidentally observable in Vercel/Sentry logs in lieu of a telemetry column. |
| `F-ONB-001` | I did not verify which of the 5 hosted studios have onboarding_v2_enabled = true, nor whether any studio_onboarding rows exist, so I cannot say whether the welcome-email branch has ever actually run in production. I also could not verify the manual runbook (docs/20) against the wizard. |
| `F-ONB-002` | I did not query studios.onboarding_v2_enabled in production, so production_reachable=false rests on the deployed fail-closed gates plus prior documented flag state, not on a live read. If the flag were on for any studio this becomes reachable (still P3, because the copy is honest). |
| `F-PROV-001` | I verified this worktree is clean and pinned to c64366c9..., but I did not independently verify from Vercel that c64366c9... is the SHA currently serving hone.care; I rely on the orchestrator's statement plus the migration-set cross-check. I also did not verify lockfile or build provenance. |
| `F-PUBLIC-001` | I did not measure how often 23P01/HB001 actually fires in production (a booking_slot_collision log event is emitted at :800-810, so the frequency is observable in Vercel logs, but I did not read them). I also did not count existing orphan clients at Willow, so the practical blast radius to date is … |
| `F-PUBLIC-002` | I did not confirm from a hosted read that Willow's public booking page currently passes the readiness gate (loadPublicReadiness at :455-464), so "live and bookable today" rests on documented product state rather than a live probe. Most importantly, I did not verify whether the Upstash rate-limit en… |
| `F-COPY-001` | I did not query the hosted session_copy_operations row count as of today, so I cannot state how many provenance rows currently exist and are at risk (it was 0 at deploy). I also did not verify whether the RLS policy on sessions actually permits a studio member's direct PostgREST DELETE to succeed -… |
| `N-SEC-001` | Not reproduced by an actual PATCH (writes not authorized in this audit). CI-parity reproduction is the required next evidence. |
| `N-DOC-001` | No legal review performed; this audit states the mismatch, not its legal weight. |
| `CHLOE-002` | Not reproduced on the deployed build; the repository's claim that both were fixed is NOT independently confirmed. Classified EVIDENCE_LIMITATION for that reason. |
