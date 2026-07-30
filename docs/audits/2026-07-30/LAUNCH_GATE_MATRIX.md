# Launch gate matrix — exact production `c64366c9ba4130283932bbe21e32bf2ed62c4975`

Gates are assigned independently of severity. A P2 may block public self-service; a missing
public-self-service capability is not automatically a Willow P1.

| Gate | Count | P1 | P2 | P3 | Findings |
|---|---|---|---|---|---|
| **WILLOW_NOW** | 5 | 2 | 3 | 0 | `F-CLIN-004`, `F-PRIV-001`, `F-OPS-004`, `F-TEST-003`, `F-COMP-001` |
| **BEFORE_STUDIO_2** | 7 | 4 | 1 | 2 | `F-SEC-002`, `F-PAY-001`, `F-DATA-001`, `F-IMPORT-001`, `F-OPS-003`, `F-DOC-001`, `N-SEC-001` |
| **BEFORE_THREE_STUDIOS** | 4 | 0 | 2 | 2 | `F-SCHED-001`, `F-SCHED-002`, `F-SCHED-005`, `F-ONB-001` |
| **BEFORE_TEN_STUDIOS** | 18 | 0 | 7 | 11 | `F-CLIN-003`, `F-SEC-001`, `F-SCHED-003`, `F-SCHED-004`, `F-SCHED-006`, `F-DATA-002`, `F-STORAGE-001`, `F-OFF-001`, `F-SCALE-001`, `F-SCALE-002`, `F-OPS-005`, `F-STAGE-001`, `F-TEST-001`, `F-GCAL-001`, `F-GCAL-002`, `F-CAL-001`, `F-ONB-002`, `F-COPY-001` |
| **BEFORE_PUBLIC_SELF_SERVICE** | 7 | 0 | 2 | 5 | `F-PRIV-002`, `F-BILL-001`, `F-RET-001`, `F-OPS-001`, `F-TEST-002`, `F-PUBLIC-001`, `F-PUBLIC-002` |
| **BEFORE_50_STUDIOS** | 1 | 0 | 0 | 1 | `F-OPS-002` |
| **POST_GA** | 1 | 0 | 0 | 1 | `F-EXEC-001` |
| **NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION** | 6 | 0 | 0 | 6 | `F-CLIN-000`, `F-CLIN-001`, `F-CLIN-002`, `F-PAY-002`, `F-GCAL-003`, `F-PROV-001` |

## Blockers per gate

### WILLOW_NOW — 5 open/partial

- `F-CLIN-004` **P2** OPEN — "Mark reviewed" accepts an unsubmitted (in_progress) intake and any intake in the studio — one UI click creates a false clinical-review signal and permanently locks the client out of finishing their intake
- `F-PRIV-001` **P1** OPEN — Sentry receives raw bearer credentials embedded in URL path segments (intake, portal, appointment-manage and calendar-feed tokens)
- `F-OPS-004` **P2** OPEN — No backup, restore-drill, RPO/RTO, on-call or incident-command evidence exists for a production system already holding real clinical data
- `F-TEST-003` **P2** OPEN — Mobile lane is Chromium emulating an iPhone, not WebKit/iOS Safari, and no accessibility or physical-device acceptance evidence exists
- `F-COMP-001` **P1** OPEN — The in-app Data settings page tells studio owners their clinical data is hosted in Canada while the privacy policy states it is in AWS US-East-1

### BEFORE_STUDIO_2 — 7 open/partial

- `F-SEC-002` **P1** OPEN — Any authenticated studio member can create, retime, re-status or delete appointments by direct PostgREST DML, bypassing the owner gates, duration authority, booking kill switch, buffer rule and every audit row of create_internal_appointment_v2 / move_or_reass…
- `F-PAY-001` **P2** PARTIALLY_FIXED — Session-payment amount is browser-supplied and unbounded up to CAD 2,000; any active practitioner (not just the owner) can prepare and execute the charge
- `F-DATA-001` **P1** OPEN — Owner ZIP export omits most tenant-owned data (intake, consent, clinical notes, images, payments, portal, numbing/inventory fields) while the UI presents it as a complete backup
- `F-IMPORT-001` **P1** OPEN — Quick Import commits clients and treatment memories in separate statements; a memory-insert failure strands clients permanently with no idempotent repair, and the final batch-completion update is unchecked
- `F-OPS-003` **P3** OPEN — Appointment reminders run on an external scheduler that is not deploy-as-code (heartbeat and stale/missing alerting DO exist, contrary to the original evidence)
- `F-DOC-001` **P3** PARTIALLY_FIXED — Documentation asserts production facts it cannot prove, and the canonical register self-contradicts on whether migration 0160 is applied
- `N-SEC-001` **P1** OPEN — Session practitioner attribution can be re-pointed, including to another studio's practitioner

### BEFORE_THREE_STUDIOS — 4 open/partial

- `F-SCHED-001` **P2** PARTIALLY_FIXED — Schedule-config direct-write gap is now narrow: availability defaults/overrides were made owner-only by 0135 and breaks are RPC-only, but services and full-day blockouts are still FOR ALL member DML with owner-ship enforced only in application code
- `F-SCHED-002` **P2** OPEN — Public booking (and public reschedule) bypass the capacity booking-pause gate that internal booking enforces — inert today because capacity is OFF everywhere
- `F-SCHED-005` **P3** OPEN — Public booking hard-codes assignment to the single active owner-role practitioner (or NULL); no eligibility, choice, or no-preference allocation — a not-yet-built capability, plus a live edge case when a studio does not have exactly one active owner
- `F-ONB-001` **P3** OPEN — Studio provisioning writes only studios + owner pending_invitation (plus optional welcome email); no catalogue, availability, consent, provider or launch-verification defaults

### BEFORE_TEN_STUDIOS — 18 open/partial

- `F-CLIN-003` **P3** OPEN — Intake-to-client profile sync has no version predicate — but it is fill-only-if-null and append-only, so the stated overwrite scenario is not reproducible; a narrow read-then-write lost-update window remains
- `F-SEC-001` **P2** PARTIALLY_FIXED — Same-studio wrong-client re-parenting of clinical sessions/blocks — CLOSED in production by migration 0160 triggers; only association fields (not identity) remain app-validated only
- `F-SCHED-003` **P2** OPEN — Public booking is not one transaction: it inserts the client row before the appointment, so a lost race leaves an orphan client; policy checks (hours, service-active, pause) are unserialized — but overlap, blockout, block, break and buffer races ARE DB-serial…
- `F-SCHED-004` **P3** OPEN — utcInstantFromLocal silently shifts nonexistent spring-forward wall times one hour earlier and cannot address the second fall-back hour; no caller round-trip validates the typed time
- `F-SCHED-006` **P2** PARTIALLY_FIXED — Slot generation ignores errors on the blockout and reservation reads and fails OPEN (offers conflicted slots with no alert); the capacity-ON availability probes ignore errors too, but the live capacity-OFF availability read already fails closed
- `F-DATA-002` **P3** OPEN — Export audit_logs metadata lists 10 files and 9 row counts while the archive actually contains 14 files — the four record-keeping CSVs are missing from both
- `F-STORAGE-001` **P2** OPEN — Treatment-image upload can orphan private storage objects with no reconciler, and archive never deletes bytes at all
- `F-OFF-001` **P2** OPEN — No offboarding, studio-deletion or provider-disconnection workflow exists in any form
- `F-SCALE-001` **P2** OPEN — Studio export loads every row, builds the whole ZIP in server memory and returns it base64-encoded through a server action
- `F-SCALE-002` **P2** OPEN — Anonymous "next available" performs an unbounded sequential day-by-day scan, up to ~370 days x 4 DB round-trips per single public request
- `F-OPS-005` **P3** OPEN — Operational alerts have no durable retry or outbox and can be lost if the DB insert and the critical email both fail
- `F-STAGE-001` **P3** OPEN — No production-shape staging, canary rollout or migration rehearsal — but fresh-DB full-chain application runs on every CI run
- `F-TEST-001` **P3** OPEN — 62% of the unit test surface asserts source-file text rather than runtime behaviour, and no coverage classification exists
- `F-GCAL-001` **P3** PARTIALLY_FIXED — Deployed Google Calendar route header comments still claim "NOT cron-registered" while vercel.json registers both daily crons
- `F-GCAL-002` **P3** OPEN — Google refresh-token crypto has no previous-key slot: any key-version change forces reconnect_required on every connected practitioner
- `F-CAL-001` **P3** PARTIALLY_FIXED — Calendar-feed rotate/revoke UI IS shipped; last-used telemetry is still absent, and both the route comment and the card's privacy copy are stale
- `F-ONB-002` **P3** OPEN — Onboarding v2 wizard's requiredComplete covers only service + availability + public bookability; the wizard is flag-gated OFF and its copy claims booking readiness, not launch approval
- `F-COPY-001` **P3** OPEN — Whole-session-copy provenance ledger cascades away: both source and target session FKs are ON DELETE CASCADE

### BEFORE_PUBLIC_SELF_SERVICE — 6 open/partial

- `F-PRIV-002` **P3** OPEN — Public-booking audit row duplicates the raw client email and free-text booking notes into appointment_audit.details
- `F-RET-001` **P2** OPEN — Published 30-day / 90-day retention and deletion commitments have no implementing code: no purge job, no hard-delete path, no legal hold, no cross-system lifecycle
- `F-OPS-001` **P3** OPEN — Public rate limiting deliberately fails open on limiter/provider failure (missing-config sub-case now closed by a production build gate)
- `F-TEST-002` **P3** OPEN — Public-booking-versus-schedule-mutation concurrency regression is still missing (the finalizer-versus-child-write half is moot after the 0159 retirement)
- `F-PUBLIC-001` **P3** OPEN — Public booking is non-transactional: a client INSERT (and an existing-client SMS-consent UPDATE) commit before the appointment INSERT, so a failed booking can leave an orphan client
- `F-PUBLIC-002` **P2** OPEN — Public booking reuses an existing client from an unverified email, permitting nuisance bookings attributed to a real client and an existing-client enumeration oracle

### BEFORE_50_STUDIOS — 1 open/partial

- `F-OPS-002` **P3** OPEN — Twilio STOP handling scans every phone-bearing client across all studios in one service-role process

