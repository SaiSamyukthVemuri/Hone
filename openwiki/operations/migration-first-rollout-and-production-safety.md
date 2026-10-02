---
type: process contract
title: Migration-first rollout and production safety
description: The contract for getting a schema change into production — migration-first ordering, the list/dry-run/apply/verify/merge/deploy sequence and its stop conditions, what a ledger apply record must contain, how frozen applied migrations are enforced, the read-only production verifier, and the rollback posture.
tags: [migrations, rollout, production-safety, ledger, rollback, verification]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-7d7ee7c428a6bb9b97b5ef92
    resource: repo://docs/11_RUNBOOK.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-dcf66e41ef5dcf8f31ba54ce
    resource: repo://docs/runbooks/migration-first-process.md
  - id: openwiki-source-e992a10390ffd889171e7aa3
    resource: repo://scripts/verify-production.mjs
  - id: openwiki-source-3827198ab0508041e05f0c55
    resource: repo://supabase/migrations/0067_ops_alerts.sql
  - id: openwiki-source-fbba42026f7c61101843bef1
    resource: repo://tests/migrations/0199-reminder-sms-candidate-selection.test.ts
  - id: openwiki-source-76ee7f374fa037e5afe07176
    resource: repo://tests/scripts/verify-production.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Migration-first rollout and production safety

> **Agent contract.** Nothing on this page authorizes an action. Applying a migration, writing to
> the production database, or running any linked Supabase command beyond read-only verification
> requires **explicit, per-change authorization** from the operator
<!-- openwiki: broken internal link [../../CLAUDE.md#L274-L276] heading anchor "L274-L276" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
> ([`CLAUDE.md` L274-L276](../../CLAUDE.md#L274-L276)). Reading this page is not that
> authorization.

## 1. The principle

**The production schema must be a superset of what the deployed code needs.** A migration that
adds or changes anything deployed code reads or writes — column, table, constraint, RLS policy,
index or RPC — is applied to production **before** the code that depends on it merges and deploys
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L7-L20] heading anchor "L7-L20" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
([`docs/runbooks/migration-first-process.md` L7-L20](../../docs/runbooks/migration-first-process.md#L7-L20)).
The runbook records why: in the `0108` incident, code that wrote a new column deployed before the
column existed and production charting writes returned 500 until the apply
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L82-L92] heading anchor "L82-L92" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
([L82-L92](../../docs/runbooks/migration-first-process.md#L82-L92)). The `0204` release repeated
the lesson in the other direction — new booking code calls a function that only `0204` creates, so
deploying first would have broken every new-client booking; the apply preceded the deploy
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L31-L37] heading anchor "L31-L37" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
([`migration-ledger.md` L31-L37](../../docs/production/migration-ledger.md#L31-L37)).

## 2. The sequence and its stop conditions

<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L27-L57] heading anchor "L27-L57" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
From [`migration-first-process.md` L27-L57](../../docs/runbooks/migration-first-process.md#L27-L57),
<!-- openwiki: broken internal link [../../CLAUDE.md#L274-L288] heading anchor "L274-L288" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
tightened by the production-safety rules in [`CLAUDE.md` L274-L288](../../CLAUDE.md#L274-L288):

1. Confirm the linked project is the intended production project (and that the gitignored
   `supabase/.temp/project-ref` names it) before **every** Supabase command.
2. `supabase migration list --linked`: remote max is the expected current max; the new file is the
   only local-only one.
3. `supabase db push --linked --dry-run` must name **exactly one** migration — the new one.
4. **STOP** if the dry run names anything else, the linked project is wrong, the verifier reports a
   FAIL (beyond the documented local-heartbeat INCOMPLETE), or the Stripe gates are not all passing.
5. Apply with `supabase db push --linked` using the **pinned CLI 2.102.0** (a newer CLI's
<!-- openwiki: broken internal link [../../CLAUDE.md#L205-L213] heading anchor "L205-L213" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
   `db reset` strips Data-API grants — [`CLAUDE.md` L205-L213](../../CLAUDE.md#L205-L213)); recent
   applies record "without `--include-all`" explicitly
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L69-L70] heading anchor "L69-L70" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
   ([ledger L69-L70](../../docs/production/migration-ledger.md#L69-L70)).
6. Verify **read-only**: `supabase migration list --linked`, `supabase db query --linked` against
   catalog views (never insert probe rows into a live table), `node scripts/verify-production.mjs`,
   `node scripts/check-stripe-gates.mjs`, and recent critical ops alerts
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L59-L68] heading anchor "L59-L68" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
   ([L59-L68](../../docs/runbooks/migration-first-process.md#L59-L68)).
7. Merge only after verification; Vercel deploys the production branch head.
8. Post-deploy: remote max unchanged, no new critical alerts, feature reads/writes the new schema.

Code-only PRs skip 2–7. Migration authoring rules (own `begin;`/`commit;`, `set local
lock_timeout` inside the transaction, revoke default `EXECUTE` from `anon`, `authenticated` **and**
`service_role` by name) are on [Migrations and hosted migration state](migrations-and-hosted-state.md).

## 3. What an apply record contains

Every apply appends a new `## Current state` block to
[`docs/production/migration-ledger.md`](../../docs/production/migration-ledger.md) and demotes the
previous one to `## Previous state`; `migration-state.json` is updated in the **same** change
<!-- openwiki: broken internal link [../../CLAUDE.md#L117-L128] heading anchor "L117-L128" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
([`CLAUDE.md` L117-L128](../../CLAUDE.md#L117-L128)). The current block
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L17-L86] heading anchor "L17-L86" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
([ledger L17-L86](../../docs/production/migration-ledger.md#L17-L86)) and earlier ones (for example
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L504-L594] heading anchor "L504-L594" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
`0199`, [L504-L594](../../docs/production/migration-ledger.md#L504-L594)) record, field by field:

- hosted and repo maxima, remote-only and pending sets, and the derived next free number;
- the **reviewed release head** the apply was authorized at and performed from, and the production
  application SHA at apply time (apply ≠ merge ≠ deploy);
- the CLI version and exact command, and that the dry run named only the intended file;
- the migration's **sha256**, computed and gated before the write;
- the apply time **with its precision** (a server apply instant is usually not capturable, so an
  operator-observed client window is recorded instead and never copied into `hosted_applied_at`);
- pre- and post-apply read-only evidence (history row counts, `max(version)`, object shapes,
  grants by role, business-row counts before and after);
- old-application inertness where relevant, **"What this apply does NOT mean"**, and rollback notes.

These records are what [Production truth authorities](../architecture/production-truth-and-lifecycle-states.md)
treats as the narrative authority; `tests/docs/canonical-production-facts.test.ts` checks that the
current block agrees with `migration-state.json`.

## 4. Applied migrations are frozen — and mechanically so

"An applied migration is **frozen** — never edit it. Write a new one"
<!-- openwiki: broken internal link [../../CLAUDE.md#L280-L280] heading anchor "L280-L280" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
([`CLAUDE.md` L280](../../CLAUDE.md#L280-L280)). The repository enforces this for recent applies:
33 files under `tests/migrations/` recompute the sha256 of their migration's raw bytes and compare
it with the value gated before the production write; a red result means "restore the file", never
"update the constant" ([example: `0199` test L81-L100](../../tests/migrations/0199-reminder-sms-candidate-selection.test.ts#L81-L100)).
Consequently, review findings against an applied migration can only be recorded and fixed by a new
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L78-L80] heading anchor "L78-L80" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
forward migration (as `0074` corrected `0073`, [runbook L78-L80](../../docs/runbooks/migration-first-process.md#L78-L80)).

## 5. The read-only production verifier

[`scripts/verify-production.mjs`](../../scripts/verify-production.mjs#L1-L40) is an operator-run
health check, **not** a CI gate (CI has no production link):

- every database read goes through `supabase db query --linked`, returns scalars only, and the
  script never pushes, executes, writes, emails, calls Stripe write APIs or triggers cron — pinned by
  [`tests/scripts/verify-production.test.ts` L32-L78](../../tests/scripts/verify-production.test.ts#L32-L78);
- checks: remote `max(version)` **equals** the repo max derived from filenames
  ([L155-L171](../../scripts/verify-production.mjs#L155-L171)); the effects of `0093`/`0097`/`0098`/`0099`;
  RLS on a curated list of critical tables; zero unresolved critical payment-related ops alerts
  ([L335-L354](../../scripts/verify-production.mjs#L335-L354)); the Stripe source gates; reminder
  heartbeat freshness; plus a non-gating payments posture report;
- fail-closed: any FAIL or INCOMPLETE exits non-zero; missing Upstash env is INCOMPLETE, never PASS
  ([test L158-L176](../../tests/scripts/verify-production.test.ts#L158-L176)).

Because it demands equality, the verifier **fails by design** while a reviewed migration is
authored but not yet applied (the normal migration-first pending state) — run it after the apply.

## 6. Rollback posture

- Prefer additive, idempotent, backward-compatible migrations so the currently deployed code keeps
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L70-L80] heading anchor "L70-L80" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
  working against the new schema ([runbook L70-L80](../../docs/runbooks/migration-first-process.md#L70-L80)).
- **Code rollback** = revert the merge on the production branch and let Vercel redeploy; the schema
<!-- openwiki: broken internal link [../../docs/11_RUNBOOK.md#L289-L300] heading anchor "L289-L300" does not exist in "../../docs/11_RUNBOOK.md". Fix the href or restore the target, then delete this comment. -->
  stays ([`docs/11_RUNBOOK.md` L289-L300](../../docs/11_RUNBOOK.md#L289-L300)).
- **Schema rollback** = a new corrective or teardown migration, never a manual down-migration on the
  live database.
- Feature activations with their own runtime switches (for example the admission-mode cutover) carry
  their own rollback plan; see [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 7. Contradictions and open questions

1. **The runbook's ops-alert check can never match `error`.** It queries
   `severity in ('critical','error')`
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L67-L68] heading anchor "L67-L68" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
   ([L67-L68](../../docs/runbooks/migration-first-process.md#L67-L68)), but `ops_alerts.severity` is
   constrained to `info`, `warning`, `critical`
   ([`0067` L70-L73](../../supabase/migrations/0067_ops_alerts.sql#L70-L73)); only the `critical`
   half of the filter does anything.
2. **The verifier's schema-effect checks stop at `0099`.** Later migrations' objects, grants and
   constraints are not verified by the script; per-apply verification for them lives only in the
   ledger's hand-run read-only queries.
3. **The runbook describes itself as the process "actually used for migrations 0108–0112"**
<!-- openwiki: broken internal link [../../docs/runbooks/migration-first-process.md#L3-L5] heading anchor "L3-L5" does not exist in "../../docs/runbooks/migration-first-process.md". Fix the href or restore the target, then delete this comment. -->
   ([L3-L5](../../docs/runbooks/migration-first-process.md#L3-L5)) and omits the pinned-CLI and
   sha256-gating steps that later ledger entries record; the ledger, not the runbook, is the fuller
   description of current practice.
