---
type: process
title: Migration-first rollout and production safety
description: The contract for getting a schema change into production — migration-first ordering and why it exists, the list/dry-run/apply/verify/merge/deploy sequence and its stop conditions, what a ledger apply record contains, how applied migrations are frozen by digest tests, the read-only production verifier and what it cannot see, and the rollback posture.
tags: [migrations, production-safety, rollout, ledger, verify-production, rollback]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
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
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Migration-first rollout and production safety

> **Agent contract.** Nothing on this page authorizes an action. Applying a migration, writing to the production
> database, or running any linked Supabase command beyond read-only verification requires **explicit, per-change
> authorization** from the operator ([`CLAUDE.md` § 5. Production safety](../../CLAUDE.md#5-production-safety)). Reading
> this page is not that authorization.

## 1. The principle

**The production schema must be a superset of what the deployed code needs.** A migration that adds or changes
anything deployed code reads or writes (a column, table, constraint, RLS policy, index or RPC) is applied to
production **before** the code that depends on it merges and deploys
([`docs/runbooks/migration-first-process.md` § Principle](../../docs/runbooks/migration-first-process.md#principle)).

The runbook records why: in the `0108` incident, code that wrote a new column deployed before the column existed and
production charting writes returned 500 until the apply. The `0204` release states the same lesson the other way
round: new booking code calls a function only `0204` creates, so deploying first would have broken every new-client
booking, and the apply preceded the deploy
([ledger § post-0204 apply](../../docs/production/migration-ledger.md#previous-state-verified-2026-10-01-post-0204-apply-0204-applied-repo--hosted)).

## 2. The sequence and its stop conditions

This is a summary of [`migration-first-process.md`](../../docs/runbooks/migration-first-process.md), tightened by the
production-safety rules in [`CLAUDE.md` § 5](../../CLAUDE.md#5-production-safety); follow the runbook itself for the
exact commands.

1. Confirm the linked project is the intended production project (the gitignored `supabase/.temp/project-ref` names
   it) before **every** Supabase command.
2. `supabase migration list --linked`: the remote maximum is the expected one and the new file is the only local-only
   one.
3. `supabase db push --linked --dry-run` must name **exactly one** migration, the new one.
4. **Stop** if the dry run names anything else, the linked project is wrong, the verifier reports a FAIL, or the Stripe
   gates are not all passing.
5. Apply with `supabase db push --linked` using the **pinned CLI 2.102.0** (a newer CLI's `db reset` strips Data-API
   grants, [`CLAUDE.md` § Local testing by migration risk class](../../CLAUDE.md#local-testing-by-migration-risk-class));
   recent apply records state explicitly that the push ran without `--include-all`.
6. Verify **read-only**: `supabase migration list --linked`, `supabase db query --linked` against catalog views (never
   probe rows in a live table), `node scripts/verify-production.mjs`, `node scripts/check-stripe-gates.mjs`, and recent
   critical ops alerts ([§ Verifier steps (read-only)](../../docs/runbooks/migration-first-process.md#verifier-steps-read-only)).
7. Merge only after verification; Vercel deploys the production branch head.
8. Post-deploy: remote maximum unchanged, no new critical alerts, the feature reads and writes the new schema.

Code-only PRs skip steps 2–7. Authoring rules (an own `begin;`/`commit;`, `set local lock_timeout` inside the
transaction, revoking default `EXECUTE` from `anon`, `authenticated` and `service_role` by name) are on
[Migrations and hosted migration state](migrations-and-hosted-state.md).

## 3. What an apply record contains

Every apply prepends a new `## Current state` block to
[`docs/production/migration-ledger.md`](../../docs/production/migration-ledger.md) and demotes the previous one to
`## Previous state` unchanged, and `migration-state.json` is updated in the **same** change
([`CLAUDE.md` § Hosted state is declared, not derived](../../CLAUDE.md#hosted-state-is-declared-not-derived)). The current
block (the `0205` apply) and earlier ones record, field by field:

- the hosted and repository maxima, the remote-only and pending sets, and the derived next free number;
- the **reviewed release head** the apply was authorized at, and the production application SHA at apply time
  (apply ≠ merge ≠ deploy);
- the CLI version and exact command, and that the dry run named only the intended file;
- the migration's **sha256**, computed and gated before the write;
- the apply time **with its precision** (a server apply instant is usually not capturable, so an operator-observed
  client window is recorded and never copied into `hosted_applied_at`);
- pre- and post-apply read-only evidence, old-application inertness where relevant, what the apply does *not* mean,
  and rollback notes.

The `0205` block is a compact example of the form: it inventories every statement, records that the bounded repair
the migration carries had nothing to repair, and records an open grant deviation as still open rather than closed.
These records are the narrative authority described on
[Production truth authorities](../architecture/production-truth-and-lifecycle-states.md), and the canonical-facts guard
checks that the current block agrees with `migration-state.json`.

## 4. Applied migrations are frozen, mechanically

`CLAUDE.md` says an applied migration is **frozen**: never edit it, write a new one. For recent applies the repository
enforces this: the per-migration test recomputes the sha256 of the migration's raw bytes and compares it with the value
gated before the production write, and a red result means "restore the file", never "update the constant"
([`0199` test L93-L110](../../tests/migrations/0199-reminder-sms-candidate-selection.test.ts#L93-L110)). Review findings
against an applied migration are therefore fixed by a new forward migration (as `0074` corrected `0073`).

## 5. The read-only production verifier

[`scripts/verify-production.mjs`](../../scripts/verify-production.mjs#L1-L40) is an operator-run health check, **not** a
CI gate (CI has no production link):

- every database read goes through `supabase db query --linked` and returns scalars only, and the script never pushes,
  executes, writes, emails, calls Stripe write APIs or triggers cron
  ([`tests/scripts/verify-production.test.ts` L32-L78](../../tests/scripts/verify-production.test.ts#L32-L78));
- it checks that the remote `max(version)` **equals** the repository maximum derived from filenames
  ([L155-L171](../../scripts/verify-production.mjs#L155-L171)), the effects of `0093`/`0097`/`0098`/`0099`, RLS on a
  curated list of critical tables, that no unresolved critical payment-related ops alert exists
  ([L335-L354](../../scripts/verify-production.mjs#L335-L354)), the Stripe source gates and reminder heartbeat freshness;
- it fails closed: any FAIL or INCOMPLETE exits non-zero, and missing Upstash env is INCOMPLETE, never PASS
  ([test L158-L176](../../tests/scripts/verify-production.test.ts#L158-L176)).

Because it demands equality, the verifier **fails by design** while a reviewed migration is authored but not yet
applied; run it after the apply.

## 6. Rollback posture

- Prefer additive, idempotent, backward-compatible migrations, so the deployed code keeps working against the new
  schema ([runbook § Rollback considerations](../../docs/runbooks/migration-first-process.md#rollback-considerations)).
- **Code rollback** reverts the merge on the production branch and lets Vercel redeploy; the schema stays
  ([`docs/11_RUNBOOK.md` § Rollback](../../docs/11_RUNBOOK.md#rollback)).
- **Schema rollback** is a new corrective or teardown migration, never a manual down-migration on the live database.
- Activations with their own runtime switches, such as the admission-mode cutover, carry their own rollback plan;
  see [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 7. Contradictions and open questions

1. **The runbook's ops-alert check can never match `error`.** It queries `severity in ('critical','error')`, but
   `ops_alerts.severity` is constrained to `info`, `warning` and `critical`
   ([`0067` L70-L73](../../supabase/migrations/0067_ops_alerts.sql#L70-L73)); only the `critical` half of the filter
   does anything.
2. **The verifier's schema-effect checks stop at `0099`.** Later migrations' objects, grants and constraints are not
   verified by the script; their per-apply verification lives only in the ledger's hand-run read-only queries.
3. **The runbook describes itself as the process "actually used for migrations 0108–0112"** and omits the pinned-CLI
   and sha256-gating steps that later ledger entries record; the ledger, not the runbook, is the fuller description of
   current practice.
