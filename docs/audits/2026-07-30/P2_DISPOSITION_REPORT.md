# P2 disposition — exact production `c64366c9ba4130283932bbe21e32bf2ed62c4975`

15 findings are currently P2. A P2 does not block Willow today unless its gate says
`WILLOW_NOW`; several block a later rollout gate.

| ID | Title | Status | Gate | Workstream | Closable inside platform phase? |
|---|---|---|---|---|---|
| `F-CLIN-004` | "Mark reviewed" accepts an unsubmitted (in_progress) intake and any intake in the studio — one UI click creates a false clinical-review signal and permanently locks the client out of finishing their intake | OPEN | WILLOW_NOW | clinical | needs its own PR |
| `F-SEC-001` | Same-studio wrong-client re-parenting of clinical sessions/blocks — CLOSED in production by migration 0160 triggers; only association fields (not identity) remain app-validated only | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | privilege & authorization | yes |
| `F-SCHED-001` | Schedule-config direct-write gap is now narrow: availability defaults/overrides were made owner-only by 0135 and breaks are RPC-only, but services and full-day blockouts are still FOR ALL member DML with owner-ship enforced only in application code | PARTIALLY_FIXED | BEFORE_THREE_STUDIOS | scheduling & booking | needs its own PR |
| `F-SCHED-002` | Public booking (and public reschedule) bypass the capacity booking-pause gate that internal booking enforces — inert today because capacity is OFF everywhere | OPEN | BEFORE_THREE_STUDIOS | scheduling & booking | needs its own PR |
| `F-SCHED-003` | Public booking is not one transaction: it inserts the client row before the appointment, so a lost race leaves an orphan client; policy checks (hours, service-active, pause) are unserialized — but overlap, blockout, block, break and buffer races ARE DB-serialized | OPEN | BEFORE_TEN_STUDIOS | scheduling & booking | yes |
| `F-SCHED-006` | Slot generation ignores errors on the blockout and reservation reads and fails OPEN (offers conflicted slots with no alert); the capacity-ON availability probes ignore errors too, but the live capacity-OFF availability read already fails closed | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | scheduling & booking | yes |
| `F-PAY-001` | Session-payment amount is browser-supplied and unbounded up to CAD 2,000; any active practitioner (not just the owner) can prepare and execute the charge | PARTIALLY_FIXED | BEFORE_STUDIO_2 | payments | needs its own PR |
| `F-RET-001` | Published 30-day / 90-day retention and deletion commitments have no implementing code: no purge job, no hard-delete path, no legal hold, no cross-system lifecycle | OPEN | BEFORE_PUBLIC_SELF_SERVICE | retention | yes |
| `F-STORAGE-001` | Treatment-image upload can orphan private storage objects with no reconciler, and archive never deletes bytes at all | OPEN | BEFORE_TEN_STUDIOS | storage | yes |
| `F-OFF-001` | No offboarding, studio-deletion or provider-disconnection workflow exists in any form | OPEN | BEFORE_TEN_STUDIOS | offline | yes |
| `F-SCALE-001` | Studio export loads every row, builds the whole ZIP in server memory and returns it base64-encoded through a server action | OPEN | BEFORE_TEN_STUDIOS | scale | yes |
| `F-SCALE-002` | Anonymous "next available" performs an unbounded sequential day-by-day scan, up to ~370 days x 4 DB round-trips per single public request | OPEN | BEFORE_TEN_STUDIOS | scale | yes |
| `F-OPS-004` | No backup, restore-drill, RPO/RTO, on-call or incident-command evidence exists for a production system already holding real clinical data | OPEN | WILLOW_NOW | operations | needs its own PR |
| `F-TEST-003` | Mobile lane is Chromium emulating an iPhone, not WebKit/iOS Safari, and no accessibility or physical-device acceptance evidence exists | OPEN | WILLOW_NOW | test assurance | needs its own PR |
| `F-PUBLIC-002` | Public booking reuses an existing client from an unverified email, permitting nuisance bookings attributed to a real client and an existing-client enumeration oracle | OPEN | BEFORE_PUBLIC_SELF_SERVICE | public booking | yes |

## P3 findings (28)

| ID | Title | Status | Gate |
|---|---|---|---|
| `F-CLIN-000` | Direct browser DML on the authoritative structured-area table (session_block_areas) — CLOSED by 0159 §5c; the "finalized/unsigned" half is retired, not deferred | PRODUCTION_VERIFIED | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-CLIN-001` | Finalize-versus-child-write interleaving — unreachable: finalization is permanently retired and cannot be invoked by any runtime role | SUPERSEDED_BY_PRODUCT_DECISION | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-CLIN-002` | Signed snapshot omits authoritative fields — moot: no new snapshot can ever be produced; the one legacy snapshot is frozen legacy evidence | SUPERSEDED_BY_PRODUCT_DECISION | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-CLIN-003` | Intake-to-client profile sync has no version predicate — but it is fill-only-if-null and append-only, so the stated overwrite scenario is not reproducible; a narrow read-then-write lost-update window remains | OPEN | BEFORE_TEN_STUDIOS |
| `F-SCHED-004` | utcInstantFromLocal silently shifts nonexistent spring-forward wall times one hour earlier and cannot address the second fall-back hour; no caller round-trip validates the typed time | OPEN | BEFORE_TEN_STUDIOS |
| `F-SCHED-005` | Public booking hard-codes assignment to the single active owner-role practitioner (or NULL); no eligibility, choice, or no-preference allocation — a not-yet-built capability, plus a live edge case when a studio does not have exactly one active owner | OPEN | BEFORE_THREE_STUDIOS |
| `F-PAY-002` | Public-booking deposits, card-on-file capture at booking, packages and partial/split payments are not built (deliberate scope hold) | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-PRIV-002` | Public-booking audit row duplicates the raw client email and free-text booking notes into appointment_audit.details | OPEN | BEFORE_PUBLIC_SELF_SERVICE |
| `F-BILL-001` | SaaS subscription billing, entitlements, dunning and access-suspension control plane do not exist (studio billing is manual) | NOT_A_LAUNCH_REQUIREMENT | BEFORE_PUBLIC_SELF_SERVICE |
| `F-DATA-002` | Export audit_logs metadata lists 10 files and 9 row counts while the archive actually contains 14 files — the four record-keeping CSVs are missing from both | OPEN | BEFORE_TEN_STUDIOS |
| `F-OPS-001` | Public rate limiting deliberately fails open on limiter/provider failure (missing-config sub-case now closed by a production build gate) | OPEN | BEFORE_PUBLIC_SELF_SERVICE |
| `F-OPS-002` | Twilio STOP handling scans every phone-bearing client across all studios in one service-role process | OPEN | BEFORE_50_STUDIOS |
| `F-OPS-003` | Appointment reminders run on an external scheduler that is not deploy-as-code (heartbeat and stale/missing alerting DO exist, contrary to the original evidence) | OPEN | BEFORE_STUDIO_2 |
| `F-OPS-005` | Operational alerts have no durable retry or outbox and can be lost if the DB insert and the critical email both fail | OPEN | BEFORE_TEN_STUDIOS |
| `F-STAGE-001` | No production-shape staging, canary rollout or migration rehearsal — but fresh-DB full-chain application runs on every CI run | OPEN | BEFORE_TEN_STUDIOS |
| `F-TEST-001` | 62% of the unit test surface asserts source-file text rather than runtime behaviour, and no coverage classification exists | OPEN | BEFORE_TEN_STUDIOS |
| `F-TEST-002` | Public-booking-versus-schedule-mutation concurrency regression is still missing (the finalizer-versus-child-write half is moot after the 0159 retirement) | OPEN | BEFORE_PUBLIC_SELF_SERVICE |
| `F-EXEC-001` | Exact-head verification lanes were environment-blocked for the original audit — now satisfied by a green all-lane CI run on the production SHA | RETIRED | POST_GA |
| `F-DOC-001` | Documentation asserts production facts it cannot prove, and the canonical register self-contradicts on whether migration 0160 is applied | PARTIALLY_FIXED | BEFORE_STUDIO_2 |
| `F-GCAL-001` | Deployed Google Calendar route header comments still claim "NOT cron-registered" while vercel.json registers both daily crons | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS |
| `F-GCAL-002` | Google refresh-token crypto has no previous-key slot: any key-version change forces reconnect_required on every connected practitioner | OPEN | BEFORE_TEN_STUDIOS |
| `F-GCAL-003` | Inbound Google busy-time import and true two-way sync are not built (outbound-only scope, correctly labelled in the UI) | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-CAL-001` | Calendar-feed rotate/revoke UI IS shipped; last-used telemetry is still absent, and both the route comment and the card's privacy copy are stale | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS |
| `F-ONB-001` | Studio provisioning writes only studios + owner pending_invitation (plus optional welcome email); no catalogue, availability, consent, provider or launch-verification defaults | OPEN | BEFORE_THREE_STUDIOS |
| `F-ONB-002` | Onboarding v2 wizard's requiredComplete covers only service + availability + public bookability; the wizard is flag-gated OFF and its copy claims booking readiness, not launch approval | OPEN | BEFORE_TEN_STUDIOS |
| `F-PROV-001` | Repository provenance gap from the ZIP-based audit - resolved for this reconciliation by reading a git worktree pinned to the production SHA | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION |
| `F-PUBLIC-001` | Public booking is non-transactional: a client INSERT (and an existing-client SMS-consent UPDATE) commit before the appointment INSERT, so a failed booking can leave an orphan client | OPEN | BEFORE_PUBLIC_SELF_SERVICE |
| `F-COPY-001` | Whole-session-copy provenance ledger cascades away: both source and target session FKs are ON DELETE CASCADE | OPEN | BEFORE_TEN_STUDIOS |
