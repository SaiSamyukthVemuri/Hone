# OpenWiki instructions — Hone

Hone is an electrolysis-practice operating system. Build a coding-agent wiki
focused on repository truth and operational correctness.

## Prioritize

1. booking/calendar/scheduling authority, buffers, timezone and concurrency;
2. waitlist/new-client admission and invitation lifecycle;
3. treatment memory, sessions, blocks, entries, probes/settings/outcomes;
4. authentication, RLS, tenant boundaries and SECURITY DEFINER commands;
5. email/SMS/provider delivery, consent, STOP and idempotency;
6. migrations, production-state authorities and rollout discipline;
7. CI, browser/DB tests, source guards and release verification.

## Keep lifecycle states distinct

Keep designed, implemented, merged, deployed, migration-applied,
production-exercised and human-accepted states distinct.

## Evidence rules

Prefer code + executable tests for behavioral claims.

For mutable production truth, use the canonical `docs/production` authorities and
explicit release evidence.

Identify contradictions instead of silently reconciling them.

Never expose secrets, credentials, tokens or client data.

## Page shape

Optimize pages for coding agents: responsibilities, invariants, write
authorities, data flow, failure semantics and exact source evidence.
