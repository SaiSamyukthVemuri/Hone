# Release record — Willow new-client waitlist pilot

Immutable record of one release. Facts only; behaviour is defined by PR #601.

## Release

| Field | Value |
|---|---|
| Date | 2026-08-19 |
| Release source | `3aa0a64a0afd31489db47c53fc22e3d84d4fccec` |
| Feature head | `ca545459126ec4a1ecf5620cc4c07e7205ed75e9` |
| Product delivery PR | #601 |
| Migration | none; `0185` not created and not claimed |

## Vehicle history

| PR | Role | State |
|---|---|---|
| #599 | superseded discovery | open, never merged |
| #600 | superseded discovery | open, never merged |
| **#601** | **product delivery — the sole PR that shipped this capability** | merged |
| #602 | failed documentation vehicle | closed, never merged |
| #603 | failed documentation vehicle | closed, never merged |

## Feature flag

`NEW_CLIENT_WAITLIST_STUDIO_SLUGS` — semantics in [../../10_DEPLOYMENT_AND_ENV.md](../../10_DEPLOYMENT_AND_ENV.md).

| Observation at release (runtime, not a permanent property) | Evidence class |
|---|---|
| Present on the Production target; absent from Preview and Development | machine-measured |
| `/book/willow-electrolysis` rendered `newClientWaitlistEnabled: true` | machine-measured |
| Pilot value used at activation: `willow-electrolysis` | operator-declared; the stored value is Sensitive and was not read back |

## Stages, canary and evidence

| Item | Result | Evidence class |
|---|---|---|
| Stage A — dark deploy, flag absent from the Production target | PASS, new-client and existing-client public booking paths | operator-observed |
| Stage B — Willow pilot activation | PASS, new-client and existing-client public booking paths | operator-observed |
| Controlled canary | exactly one submission, by an operator-controlled identity | operator-run |
| Controlled-canary observation on the three named surfaces | Willow `clients` 0 → 0; Willow `appointments` 0 → 0; `public.waitlist` 0 → 0 | operator-run bounded query |
| Provider-acceptance semantics | belong to the PR #601 implementation contract | implementation contract |
| Canary studio email | physically observed by a human in the configured studio-owner inbox | operator-observed |
| Rollback | not executed | operator-observed |
| P3 diagnostics from PR #601 | a network throw carries an imprecise diagnostic label; connection-refused is conservatively classified ambiguous | PR #601 |
