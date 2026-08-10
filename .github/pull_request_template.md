## Summary

<!-- What changed and why? -->

## Risk

<!-- Tiers and expected validation depth: ENGINEERING_STANDARDS.md
     Baseline from `npm run ci:plan` — a baseline, never semantic proof. -->

Baseline risk tier: T0 / T1 / T2 / T3

Semantic escalation:
<!-- None, or higher tier + why. Classification may never justify DE-escalation. -->

Risk reason:

Trust boundary changed:
<!-- No / Yes: ... -->

Database or migration:
<!-- No / Yes: ... -->

External side effect:
<!-- No / Yes: ... -->

## High-risk considerations

<!-- Complete only where applicable. T0/T1 can use N/A. -->

Cross-system / cross-command interaction:

Deployment skew:

Privilege impact:

Failure / rollback behaviour:

Observability / SLO / alert impact:

## Proof

Focused behavioural tests:

Integration / browser E2E:

Negative control:
<!-- T3 or selected T2 only. N/A otherwise. -->

## Production

Production access:
<!-- NONE / READ-ONLY / WRITE -->

Migration:
<!-- NONE / PENDING / APPLIED -->

## Engineering friction / repeated manual work

<!-- OPTIONAL.
Record concrete repeated recon, evidence gathering, or process pain that may
eventually justify automation. Keep it factual. This is the evidence source for
the pain-before-platform rule. -->

## Process exception

<!-- OPTIONAL.
Only if bypassing the pain-before-platform rule or normal risk-tier ceremony.
Name the failure class and why the exception is justified. -->

<!-- Security, payment and Stripe grep-gate expectations are NOT restated here.
     They are owned by CONTRIBUTING.md and enforced mechanically by
     `scripts/check-stripe-gates.mjs` in CI. -->
