# Launch gate matrix — exact production `c64366c9ba4130283932bbe21e32bf2ed62c4975`

Gates are independent of severity. Every gate used is defined.

| Gate | Definition | Total | Open/partial | P1 | P2 | P3 |
|---|---|---|---|---|---|---|
| **WILLOW_NOW** | Affects Willow on the live build today. | 9 | 9 | 4 | 5 | 0 |
| **BEFORE_STUDIO_2** | Must close before an unrelated second studio is onboarded. | 9 | 9 | 5 | 2 | 2 |
| **BEFORE_THREE_STUDIOS** | Must close before a third studio. | 7 | 7 | 0 | 4 | 3 |
| **BEFORE_TEN_STUDIOS** | Must close before ten studios. | 19 | 19 | 0 | 8 | 11 |
| **BEFORE_PUBLIC_SELF_SERVICE** | Must close before anyone can sign up without supervision. | 7 | 6 | 0 | 2 | 5 |
| **BEFORE_50_STUDIOS** | Must close before fifty studios. | 1 | 1 | 0 | 0 | 1 |
| **POST_GA** | May follow general availability. | 2 | 1 | 0 | 0 | 2 |
| **NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION** | Out of scope by an explicit product decision. | 6 | 0 | 0 | 0 | 6 |

## Open blockers per gate

### WILLOW_NOW — 9 open

**Live-reachable defects (7)**

- `F-CLIN-004` **P2** OPEN — "Mark reviewed" accepts an unsubmitted (in_progress) intake and any intake in the studio — one UI click creates a false clinical-review signal and pe…
- `F-PRIV-001` **P1** OPEN — Sentry receives raw bearer credentials embedded in URL path segments (intake, portal, appointment-manage and calendar-feed tokens)
- `F-COMP-001` **P1** OPEN — The in-app Data settings page tells studio owners their clinical data is hosted in Canada while the privacy policy states it is in AWS US-East-1
- `N-DOC-001` **P1** OPEN — Public terms page claims a subscription and refund lifecycle the product does not have
- `CHLOE-001` **P1** OPEN — Typing a custom treatment area commits one partial area row per keystroke
- `CHLOE-002` **P2** EVIDENCE_LIMITATION — Checkout amount does not reliably default from the booked service, and the internal note is believed mandatory
- `CHLOE-004` **P2** OPEN — Dashboard truncates the remember-note and the latest-settings summary

**Not reachable today / unbuilt capability (2)**

- `F-OPS-004` **P2** OPEN — No backup, restore-drill, RPO/RTO, on-call or incident-command evidence exists for a production system already holding real clinical data
- `F-TEST-003` **P2** OPEN — Mobile lane is Chromium emulating an iPhone, not WebKit/iOS Safari, and no accessibility or physical-device acceptance evidence exists

### BEFORE_STUDIO_2 — 9 open

**Live-reachable defects (8)**

- `F-SEC-002` **P1** OPEN — Any authenticated studio member can create, retime, re-status or delete appointments by direct PostgREST DML, bypassing the owner gates, duration aut…
- `F-PAY-001` **P1** PARTIALLY_FIXED — Session-payment amount is browser-supplied and unbounded up to CAD 2,000; any active practitioner (not just the owner) can prepare and execute the ch…
- `F-DATA-001` **P1** OPEN — Owner ZIP export omits most tenant-owned data (intake, consent, clinical notes, images, payments, portal, numbing/inventory fields) while the UI pres…
- `F-IMPORT-001` **P1** OPEN — Quick Import commits clients and treatment memories in separate statements; a memory-insert failure strands clients permanently with no idempotent re…
- `F-OPS-003` **P3** OPEN — Appointment reminders run on an external scheduler that is not deploy-as-code (heartbeat and stale/missing alerting DO exist, contrary to the origina…
- `N-SEC-001` **P1** OPEN — Session practitioner attribution can be re-pointed, including to another studio's practitioner
- `CHLOE-003` **P2** OPEN — Service move up/down reordering is unreliable and a service cannot be brought to the top
- `CHLOE-005` **P2** OPEN — Service cards are spaced too tightly and the colour choices are hard to distinguish

**Not reachable today / unbuilt capability (1)**

- `F-DOC-001` **P3** PARTIALLY_FIXED — Documentation asserts production facts it cannot prove, and the canonical register self-contradicts on whether migration 0160 is applied

### BEFORE_THREE_STUDIOS — 7 open

**Live-reachable defects (4)**

- `F-SCHED-001` **P2** PARTIALLY_FIXED — Schedule-config direct-write gap is now narrow: availability defaults/overrides were made owner-only by 0135 and breaks are RPC-only, but services an…
- `F-SCHED-005` **P3** OPEN — Public booking hard-codes assignment to the single active owner-role practitioner (or NULL); no eligibility, choice, or no-preference allocation — a …
- `F-ONB-001` **P3** OPEN — Studio provisioning writes only studios + owner pending_invitation (plus optional welcome email); no catalogue, availability, consent, provider or la…
- `L19b` **P2** OPEN — sessions.appointment_id and treatment_plan_id are same-studio but not same-client validated

**Not reachable today / unbuilt capability (3)**

- `F-SCHED-002` **P2** OPEN — Public booking (and public reschedule) bypass the capacity booking-pause gate that internal booking enforces — inert today because capacity is OFF ev…
- `L19a` **P2** OPEN — Broad default table privileges: TRUNCATE granted to anon and authenticated on 64 of 86 tables
- `L20` **P3** OPEN — service_role retains TRIGGER on the guarded clinical tables; owner can set session_replication_role

### BEFORE_TEN_STUDIOS — 19 open

**Live-reachable defects (13)**

- `F-CLIN-003` **P3** OPEN — Intake-to-client profile sync has no version predicate — but it is fill-only-if-null and append-only, so the stated overwrite scenario is not reprodu…
- `F-SCHED-003` **P2** OPEN — Public booking is not one transaction: it inserts the client row before the appointment, so a lost race leaves an orphan client; policy checks (hours…
- `F-SCHED-004` **P3** OPEN — utcInstantFromLocal silently shifts nonexistent spring-forward wall times one hour earlier and cannot address the second fall-back hour; no caller ro…
- `F-SCHED-006` **P2** PARTIALLY_FIXED — Slot generation ignores errors on the blockout and reservation reads and fails OPEN (offers conflicted slots with no alert); the capacity-ON availabi…
- `F-DATA-002` **P3** OPEN — Export audit_logs metadata lists 10 files and 9 row counts while the archive actually contains 14 files — the four record-keeping CSVs are missing fr…
- `F-STORAGE-001` **P2** OPEN — Treatment-image upload can orphan private storage objects with no reconciler, and archive never deletes bytes at all
- `F-SCALE-001` **P2** OPEN — Studio export loads every row, builds the whole ZIP in server memory and returns it base64-encoded through a server action
- `F-SCALE-002` **P2** OPEN — Anonymous "next available" performs an unbounded sequential day-by-day scan, up to ~370 days x 4 DB round-trips per single public request
- `F-OPS-005` **P3** OPEN — Operational alerts have no durable retry or outbox and can be lost if the DB insert and the critical email both fail
- `F-GCAL-001` **P3** PARTIALLY_FIXED — Deployed Google Calendar route header comments still claim "NOT cron-registered" while vercel.json registers both daily crons
- `F-CAL-001` **P3** PARTIALLY_FIXED — Calendar-feed rotate/revoke UI IS shipped; last-used telemetry is still absent, and both the route comment and the card's privacy copy are stale
- `F-COPY-001` **P3** OPEN — Whole-session-copy provenance ledger cascades away: both source and target session FKs are ON DELETE CASCADE
- `L18` **P2** OPEN — authenticated holds direct row DML on five clinical tables

**Not reachable today / unbuilt capability (6)**

- `F-SEC-001` **P2** PARTIALLY_FIXED — Same-studio wrong-client re-parenting of clinical sessions/blocks — CLOSED in production by migration 0160 triggers; only association fields (not ide…
- `F-OFF-001` **P2** OPEN — No offboarding, studio-deletion or provider-disconnection workflow exists in any form
- `F-STAGE-001` **P3** OPEN — No production-shape staging, canary rollout or migration rehearsal — but fresh-DB full-chain application runs on every CI run
- `F-TEST-001` **P3** OPEN — 62% of the unit test surface asserts source-file text rather than runtime behaviour, and no coverage classification exists
- `F-GCAL-002` **P3** OPEN — Google refresh-token crypto has no previous-key slot: any key-version change forces reconnect_required on every connected practitioner
- `F-ONB-002` **P3** OPEN — Onboarding v2 wizard's requiredComplete covers only service + availability + public bookability; the wizard is flag-gated OFF and its copy claims boo…

### BEFORE_PUBLIC_SELF_SERVICE — 6 open

**Live-reachable defects (5)**

- `F-PRIV-002` **P3** OPEN — Public-booking audit row duplicates the raw client email and free-text booking notes into appointment_audit.details
- `F-RET-001` **P2** OPEN — Published 30-day / 90-day retention and deletion commitments have no implementing code: no purge job, no hard-delete path, no legal hold, no cross-sy…
- `F-OPS-001` **P3** OPEN — Public rate limiting deliberately fails open on limiter/provider failure (missing-config sub-case now closed by a production build gate)
- `F-PUBLIC-001` **P3** OPEN — Public booking is non-transactional: a client INSERT (and an existing-client SMS-consent UPDATE) commit before the appointment INSERT, so a failed bo…
- `F-PUBLIC-002` **P2** OPEN — Public booking reuses an existing client from an unverified email, permitting nuisance bookings attributed to a real client and an existing-client en…

**Not reachable today / unbuilt capability (1)**

- `F-TEST-002` **P3** OPEN — Public-booking-versus-schedule-mutation concurrency regression is still missing (the finalizer-versus-child-write half is moot after the 0159 retirem…

### BEFORE_50_STUDIOS — 1 open

**Live-reachable defects (1)**

- `F-OPS-002` **P3** OPEN — Twilio STOP handling scans every phone-bearing client across all studios in one service-role process

### POST_GA — 1 open

**Not reachable today / unbuilt capability (1)**

- `L21` **P3** OPEN — Same-transaction session delete with a block-attached treatment image raises 23503

