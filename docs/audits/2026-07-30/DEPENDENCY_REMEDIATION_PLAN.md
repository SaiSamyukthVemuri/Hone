# Dependency-ordered remediation plan — `c64366c9ba4130283932bbe21e32bf2ed62c4975`

Generated from canonical `depends_on` / `train` / `parallel_group`, not hand-edited.

```
T0-copy    N-DOC-001, F-DOC-001            copy-only, no deps          -> PR-02
T0-charting CHLOE-001/002/004              code-only, no deps          -> PR-03, PR-08, PR-10
T1         L19a, L20                       default-privilege sweep     -> PR-01
T2         L18                             app-first THEN revoke       -> PR-06 then PR-07   (depends: T1)
T3         N-SEC-001, F-SEC-001, L19b       identity/attribution        -> PR-04, PR-05       (no dep on T1)
T4         F-SEC-002, F-SCHED-001           appointment command bounds  -> PR-11              (no dep on T2)
T5         F-SCHED-002/003, F-PUBLIC-001/002 public booking             -> PR-14              (depends: T4)
T6         F-SCHED-004/005/006, F-SCALE-002 timezone & slots            -> PR-15              (depends: T4)
T7         F-PAY-001                        payment authority           -> PR-02
T8         F-CLIN-003/004, F-COPY-001       intake & copy integrity     -> PR-12
T9         F-PRIV-001/002                   telemetry privacy           -> PR-05
T10        F-IMPORT-001, F-DATA-001/002,    import/export/retention     -> PR-13, PR-16, PR-17
           F-RET-001, F-STORAGE-001,
           F-SCALE-001, F-OFF-001
T11        F-OPS-*, F-STAGE-001, F-TEST-*,  ops, restore, assurance     -> PR-18, PR-19, PR-20
           F-COMP-001, L21
T13        F-ONB-*, F-PROV-001, F-BILL-001, SaaS signup & billing       (depends: T2)
           CHLOE-003/005
T14        F-GCAL-*, F-CAL-001              Google Calendar (dormant)   (depends: T4)
```

**Ordering rules enforced:** Google Calendar (T14), SaaS signup (T13) and public booking (T5) all sit
behind their applicable open P1 dependencies. The dependency graph was checked for cycles — **it is
acyclic**.

## Open P0/P1 placement

| ID | Sev | Status | Train | PR | Gate | Depends on |
|---|---|---|---|---|---|---|
| `F-SEC-002` | P1 | OPEN | T4 | PR-11 | BEFORE_STUDIO_2 | — |
| `F-PAY-001` | P1 | PARTIALLY_FIXED | T7 | PR-02 | BEFORE_STUDIO_2 | — |
| `F-PRIV-001` | P1 | OPEN | T9 | PR-05 | WILLOW_NOW | — |
| `F-DATA-001` | P1 | OPEN | T10 | PR-16, PR-17 | BEFORE_STUDIO_2 | F-IMPORT-001 |
| `F-IMPORT-001` | P1 | OPEN | T10 | PR-13 | BEFORE_STUDIO_2 | — |
| `F-COMP-001` | P1 | OPEN | T11 | PR-04 | WILLOW_NOW | — |
| `N-SEC-001` | P1 | OPEN | T3 | PR-04 | BEFORE_STUDIO_2 | — |
| `N-DOC-001` | P1 | OPEN | T0-copy | PR-02 | WILLOW_NOW | — |
| `CHLOE-001` | P1 | OPEN | T0-charting | PR-03 | WILLOW_NOW | — |
