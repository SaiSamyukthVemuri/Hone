# P2 and P3 disposition — exact production `395532489a07defd16d5c3a04ce26d2aedf46096`

## P2 (18)

| ID | Title | Status | Gate | Train | PR | Closable in platform phase? |
|---|---|---|---|---|---|---|
| `F-SEC-001` | Same-studio wrong-client re-parenting of clinical sessions/blocks — CLOSED in production by migration 0160 triggers; only association fields (not ide… | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | T6-identity | PR-08 | yes |
| `F-SCHED-001` | Schedule-config direct-write gap is now narrow: availability defaults/overrides were made owner-only by 0135 and breaks are RPC-only, but services an… | PARTIALLY_FIXED | BEFORE_THREE_STUDIOS | T8-schedule | PR-16 | yes |
| `F-SCHED-002` | Public booking (and public reschedule) bypass the capacity booking-pause gate that internal booking enforces — inert today because capacity is OFF ev… | OPEN | BEFORE_THREE_STUDIOS | T9-public | PR-17 | yes |
| `F-SCHED-003` | Public booking is not one transaction: it inserts the client row before the appointment, so a lost race leaves an orphan client; policy checks (hours… | OPEN | BEFORE_TEN_STUDIOS | T9-public | PR-17 | yes |
| `F-SCHED-006` | Slot generation ignores errors on the blockout and reservation reads and fails OPEN (offers conflicted slots with no alert); the capacity-ON availabi… | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | T9-public | PR-18 | yes |
| `F-STORAGE-001` | Treatment-image upload can orphan private storage objects with no reconciler, and archive never deletes bytes at all | OPEN | BEFORE_TEN_STUDIOS | T10-data | PR-21 | yes |
| `F-OFF-001` | No offboarding, studio-deletion or provider-disconnection workflow exists in any form | OPEN | BEFORE_TEN_STUDIOS | T10-data | PR-23 | yes |
| `F-SCALE-001` | Studio export loads every row, builds the whole ZIP in server memory and returns it base64-encoded through a server action | OPEN | BEFORE_TEN_STUDIOS | T10-data | PR-22 | yes |
| `F-SCALE-002` | Anonymous "next available" performs an unbounded sequential day-by-day scan, up to ~370 days x 4 DB round-trips per single public request | OPEN | BEFORE_TEN_STUDIOS | T9-public | PR-18 | yes |
| `F-OPS-004` | No backup, restore-drill, RPO/RTO, on-call or incident-command evidence exists for a production system already holding real clinical data | OPEN | WILLOW_NOW | T11-ops | PR-26 | yes |
| `F-TEST-003` | Mobile lane is Chromium emulating an iPhone, not WebKit/iOS Safari, and no accessibility or physical-device acceptance evidence exists | OPEN | WILLOW_NOW | T11-ops | PR-25 | yes |
| `F-PUBLIC-002` | Public booking reuses an existing client from an unverified email, permitting nuisance bookings attributed to a real client and an existing-client en… | OPEN | BEFORE_PUBLIC_SELF_SERVICE | T9-public | PR-17 | yes |
| `L19a` | Broad default table privileges: TRUNCATE granted to anon and authenticated on 64 of 86 tables | OPEN | BEFORE_THREE_STUDIOS | T1-privilege | PR-01 | yes |
| `L19b` | sessions.appointment_id and treatment_plan_id are same-studio but not same-client validated | OPEN | BEFORE_THREE_STUDIOS | T6-identity | PR-09 | yes |
| `CHLOE-002` | Checkout amount does not reliably default from the booked service, and the internal note is believed mandatory | DEPLOYED_NOT_VERIFIED | NONE_SHIPPED | NONE | — | n/a (closed) |
| `CHLOE-003` | Service move up/down reordering is unreliable and a service cannot be brought to the top | OPEN | BEFORE_STUDIO_2 | T3-charting | PR-14 | yes |
| `CHLOE-004` | Dashboard truncates the remember-note and the latest-settings summary | OPEN | WILLOW_NOW | T3-charting | PR-15 | yes |
| `CHLOE-005` | Service cards are spaced too tightly and the colour choices are hard to distinguish | OPEN | BEFORE_STUDIO_2 | T3-charting | PR-15 | yes |

## P3 (30)

| ID | Title | Status | Gate | Train |
|---|---|---|---|---|
| `F-CLIN-000` | Direct browser DML on the authoritative structured-area table (session_block_areas) — CLOSED by 0159 §5c; the "finalized/unsigned" half is retired, n… | PRODUCTION_VERIFIED | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-CLIN-001` | Finalize-versus-child-write interleaving — unreachable: finalization is permanently retired and cannot be invoked by any runtime role | SUPERSEDED_BY_PRODUCT_DECISION | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-CLIN-002` | Signed snapshot omits authoritative fields — moot: no new snapshot can ever be produced; the one legacy snapshot is frozen legacy evidence | SUPERSEDED_BY_PRODUCT_DECISION | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-CLIN-003` | Intake-to-client profile sync has no version predicate — but it is fill-only-if-null and append-only, so the stated overwrite scenario is not reprodu… | OPEN | BEFORE_TEN_STUDIOS | T5-intake |
| `F-SCHED-004` | utcInstantFromLocal silently shifts nonexistent spring-forward wall times one hour earlier and cannot address the second fall-back hour; no caller ro… | OPEN | BEFORE_TEN_STUDIOS | T9-public |
| `F-SCHED-005` | Public booking hard-codes assignment to the single active owner-role practitioner (or NULL); no eligibility, choice, or no-preference allocation — a … | OPEN | BEFORE_THREE_STUDIOS | T9-public |
| `F-PAY-002` | Public-booking deposits, card-on-file capture at booking, packages and partial/split payments are not built (deliberate scope hold) | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-PRIV-002` | Public-booking audit row duplicates the raw client email and free-text booking notes into appointment_audit.details | OPEN | BEFORE_PUBLIC_SELF_SERVICE | T4-privacy |
| `F-BILL-001` | SaaS subscription billing platform is not built (capability gap, not a defect) | NOT_A_LAUNCH_REQUIREMENT | BEFORE_PUBLIC_SELF_SERVICE | NONE |
| `F-DATA-002` | Export audit_logs metadata lists 10 files and 9 row counts while the archive actually contains 14 files — the four record-keeping CSVs are missing fr… | OPEN | BEFORE_TEN_STUDIOS | T10-data |
| `F-OPS-001` | Public rate limiting deliberately fails open on limiter/provider failure (missing-config sub-case now closed by a production build gate) | OPEN | BEFORE_PUBLIC_SELF_SERVICE | T11-ops |
| `F-OPS-002` | Twilio STOP handling scans every phone-bearing client across all studios in one service-role process | OPEN | BEFORE_50_STUDIOS | NONE |
| `F-OPS-003` | Appointment reminders run on an external scheduler that is not deploy-as-code (heartbeat and stale/missing alerting DO exist, contrary to the origina… | OPEN | BEFORE_STUDIO_2 | T11-ops |
| `F-OPS-005` | Operational alerts have no durable retry or outbox and can be lost if the DB insert and the critical email both fail | OPEN | BEFORE_TEN_STUDIOS | NONE |
| `F-STAGE-001` | No production-shape staging, canary rollout or migration rehearsal — but fresh-DB full-chain application runs on every CI run | OPEN | BEFORE_TEN_STUDIOS | T11-ops |
| `F-TEST-001` | 62% of the unit test surface asserts source-file text rather than runtime behaviour, and no coverage classification exists | OPEN | BEFORE_TEN_STUDIOS | NONE |
| `F-TEST-002` | Public-booking-versus-schedule-mutation concurrency regression is still missing (the finalizer-versus-child-write half is moot after the 0159 retirem… | OPEN | BEFORE_PUBLIC_SELF_SERVICE | NONE |
| `F-EXEC-001` | Exact-head verification lanes were environment-blocked for the original audit — now satisfied by a green all-lane CI run on the production SHA | RETIRED | NONE_CLOSED | NONE |
| `F-DOC-001` | Documentation asserts production facts it cannot prove, and the canonical register self-contradicts on whether migration 0160 is applied | PARTIALLY_FIXED | BEFORE_STUDIO_2 | T0-copy |
| `F-GCAL-001` | Deployed Google Calendar route header comments still claim "NOT cron-registered" while vercel.json registers both daily crons | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | NONE |
| `F-GCAL-002` | Google refresh-token crypto has no previous-key slot: any key-version change forces reconnect_required on every connected practitioner | OPEN | BEFORE_TEN_STUDIOS | NONE |
| `F-GCAL-003` | Inbound Google busy-time import and true two-way sync are not built (outbound-only scope, correctly labelled in the UI) | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-CAL-001` | Calendar-feed rotate/revoke UI IS shipped; last-used telemetry is still absent, and both the route comment and the card's privacy copy are stale | PARTIALLY_FIXED | BEFORE_TEN_STUDIOS | NONE |
| `F-ONB-001` | Studio provisioning writes only studios + owner pending_invitation (plus optional welcome email); no catalogue, availability, consent, provider or la… | OPEN | BEFORE_THREE_STUDIOS | NONE |
| `F-ONB-002` | Onboarding v2 wizard's requiredComplete covers only service + availability + public bookability; the wizard is flag-gated OFF and its copy claims boo… | OPEN | BEFORE_TEN_STUDIOS | NONE |
| `F-PROV-001` | Repository provenance gap from the ZIP-based audit - resolved for this reconciliation by reading a git worktree pinned to the production SHA | NOT_A_LAUNCH_REQUIREMENT | NOT_REQUIRED_BY_CURRENT_PRODUCT_DECISION | NONE |
| `F-PUBLIC-001` | Public booking is non-transactional: a client INSERT (and an existing-client SMS-consent UPDATE) commit before the appointment INSERT, so a failed bo… | OPEN | BEFORE_PUBLIC_SELF_SERVICE | T9-public |
| `F-COPY-001` | Whole-session-copy provenance ledger cascades away: both source and target session FKs are ON DELETE CASCADE | OPEN | BEFORE_TEN_STUDIOS | T10-data |
| `L20` | service_role retains TRIGGER on the guarded clinical tables; owner can set session_replication_role | OPEN | BEFORE_THREE_STUDIOS | T1-privilege |
| `L21` | Same-transaction session delete with a block-attached treatment image raises 23503 | OPEN | POST_GA | NONE |
