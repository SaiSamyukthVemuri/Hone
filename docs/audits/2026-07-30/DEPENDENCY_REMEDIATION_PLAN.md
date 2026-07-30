# Dependency-ordered remediation plan — exact production `c64366c9ba4130283932bbe21e32bf2ed62c4975`

This is a dependency graph, not a severity sort. Two orderings are **hard constraints** and reversing
either would break production:

1. **L18 cannot be solved revoke-first.** `authenticated` holds row DML on `sessions`,
   `session_blocks`, `electrolysis_entries`, `laser_entries` and `treatment_images`, and 26
   application call sites write them directly. Revoking before those callers move onto narrow commands
   would break Willow's live charting the moment the migration applied — before any deploy. Order is:
   **move callers → deploy → then revoke.**
2. **Privilege cleanup precedes anything that depends on privilege posture.** L19(a) and L20 share one
   root cause (Supabase `ALTER DEFAULT PRIVILEGES`) and must be swept and verified together, not
   piecemeal inside a feature migration.

## Dependency graph

```
T0  containment                    (EMPTY — zero current P0)
      |
T1  privilege & ACL cleanup        L19(a) TRUNCATE sweep + L20 service_role TRIGGER
      |                            + default-privilege change for future tables + ACL drift test
      |
      +--> T2  command-only clinical writes   (L18)  [app-first, then revoke]
      |          26 direct writers -> narrow commands -> deploy -> revoke
      |
      +--> T3  identity & attribution         N-SEC-001 practitioner re-parenting
      |                                        + appointment_id / treatment_plan_id same-client
      |
      +--> T4  appointment & schedule command boundaries   F-SEC-002, F-SCHED-001
                 |
                 +--> T5  public booking atomicity + kill switches
                 |          F-SCHED-002, F-SCHED-003, F-PUBLIC-001, F-PUBLIC-002
                 |
                 +--> T6  timezone & slot correctness      F-SCHED-004, F-SCHED-006, F-SCALE-002

T7  payment authority              F-PAY-001 (+ historical HNE-PAY-001/002)
T8  intake merge & state integrity F-CLIN-003, F-CLIN-004 (+ P1-03/04/05/06)
T9  privacy telemetry              F-PRIV-001, F-PRIV-002
T10 import/export/retention/storage F-IMPORT-001, F-DATA-001, F-RET-001, F-STORAGE-001, F-SCALE-001, F-OFF-001
T11 ops, restore, test assurance   F-OPS-001..005, F-STAGE-001, F-TEST-001..003, F-EXEC-001, F-COMP-001
T12 multi-tenant foundation        RBAC, org/location, capacity, suspension  (needs T1-T4)
T13 SaaS signup / provisioning / billing   F-ONB-*, F-PROV-001, F-BILL-001  (needs T12)
T14 Google Calendar outbound v1    F-GCAL-001..003, F-CAL-001  (DORMANT; needs T4)
T15 Resend / Twilio multi-tenant comms
T16 support, export, self-service lifecycle
```

**Ordering rules enforced above.** Google Calendar (T14), Twilio/Resend (T15) and public
self-service (T5/T13) are all scheduled *after* their applicable P1 dependencies. Nothing in T14–T16
may start while an applicable T1–T4 item is open.

## Open P1s and where they sit

| ID | Severity | Status | Train | Gate | Dependency |
|---|---|---|---|---|---|
| `F-SEC-002` | P1 | OPEN | T4 | BEFORE_STUDIO_2 | Independent of L18 and of the clinical work. Two coupled steps: (1) revoke insert, update, delete on public.appointments from anon, authenticated (SELECT retained — the user-scope… |
| `F-PRIV-001` | P1 | OPEN | T9 | WILLOW_NOW | None — fully self-contained and code-only, confined to lib/observability/sentry-scrub.ts. Three changes: (1) in scrubRequest, canonicalize the path against the known bearer-route … |
| `F-DATA-001` | P1 | OPEN | T10 | BEFORE_STUDIO_2 | Two-phase. Phase 1 (no migration, days): correct app/(app)/settings/data/page.tsx to say "partial export", replace the "Not included" paragraph with the real exclusion list (intak… |
| `F-IMPORT-001` | P1 | OPEN | T10 | BEFORE_STUDIO_2 | Needs a transactional import RPC (SECURITY DEFINER, owner-verified, taking the planned clients + memories as one JSON payload and inserting both inside one statement), or staged t… |
| `F-COMP-001` | P1 | OPEN | T11 | WILLOW_NOW | Independent of all engineering findings. Shares a root cause with F-DOC-001 — no gated claims manifest — but must not wait for that control to be built. The verified-wording chang… |
| `N-SEC-001` | P1 | OPEN | T3 | BEFORE_STUDIO_2 | Independent of L18. Fix is a same-studio composite FK plus/or a 0160-style column guard; both are additive and need no application change (no call site writes these columns from a… |
