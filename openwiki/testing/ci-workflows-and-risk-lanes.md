---
type: ci pipeline
title: CI workflows, risk lanes and browser sharding
description: How Hone's CI decides what to run — the ci.yml job graph keyed off one changed-path classifier, the deterministic risk tiers T0–T3, browser group selection and sharding, the fail-closed browser aggregator that is the stable required check, the nightly full matrix, job budgets, the least-privilege and SHA-pinning guards that cover every workflow file, and what a green run does and does not prove.
tags: [ci, github-actions, risk-tiers, classification, supply-chain, testing]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-59c16bf7bd22b83f7591cc98
    resource: repo://.github/workflows/nightly.yml
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-3ad934bbd2c1fea4924f842a
    resource: repo://ENGINEERING_STANDARDS.md
  - id: openwiki-source-d76a4c2ee174d60d80d31d1d
    resource: repo://scripts/ci-plan.mjs
  - id: openwiki-source-8576950bcf5d6a2cb4498309
    resource: repo://scripts/classify-changes.mjs
  - id: openwiki-source-4b59b7f9dc0acb9c398d87f2
    resource: repo://scripts/verify-changed.mjs
  - id: openwiki-source-b4b8e96cb5e10de20a1b35cb
    resource: repo://tests/ci/aggregate-fail-closed.test.ts
  - id: openwiki-source-2596c45699032de1ba03ae0c
    resource: repo://tests/ci/ci-config.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# CI workflows, risk lanes and browser sharding

There are two workflows under guard, `ci.yml` and `nightly.yml`.

- **PR CI is risk-based.** It runs only the lanes a diff can affect.
- **The nightly workflow runs everything**, so coverage is moved rather than lost.

Both declare `permissions: contents: read`, use no secrets and write nothing to GitHub
([`ci.yml` L1-L60](../../.github/workflows/ci.yml#L1-L60); [`nightly.yml` L1-L49](../../.github/workflows/nightly.yml#L1-L49)).

## 1. Triggers

- `ci.yml` runs on every `pull_request` and on pushes to the default branch.
- Its concurrency group is per PR, so a new push cancels the superseded run.
- Every job pins the historical E2E port 3111; worktree-derived ports are only for local runs.
- `nightly.yml` runs at 07:00 UTC daily and on `workflow_dispatch`, with an optional reason.

## 2. The job graph

`changes` (changed-path detection, 2 minutes) runs first and every lane keys off its outputs
([L74-L226](../../.github/workflows/ci.yml#L74-L226)). It:

1. diffs the PR head against the **merge base** — a full-history checkout with `persist-credentials: false`;
2. runs `scripts/classify-changes.mjs`;
3. runs `scripts/browser-groups.mjs` to pick groups and shards.

| Job | Runs when | Timeout | What it does |
|---|---|---|---|
| `validate` | not `docs_only` | 15 min | `npm ci`, typecheck, lint, build, `npm test`, `git diff --check`, Stripe gates, migration extension check ([L228-L339](../../.github/workflows/ci.yml#L228-L339)) |
| `db-integration` | `database` or `security` or full matrix | 20 min | local Supabase, `supabase db reset --local` with the **whole** migration chain, a fresh-managed extension proof, `npm run test:db`, a generated-types drift check ([L341-L472](../../.github/workflows/ci.yml#L341-L472)) |
| `browser-e2e-shard` (matrix) | `browser_run` or full matrix | 15 min targeted / 18 min extended | one Supabase stack per shard; dynamic job name ([L487-L550](../../.github/workflows/ci.yml#L487-L550)) |
| `browser-e2e` (aggregator) | `always()` | 2 min | the **stable required check** for browser coverage (§4) |
| `payment-browser-e2e` | `payment` or full matrix | 18 min | fake-Stripe lane |
| `mobile-completion-e2e` | `mobile` or full matrix | 10 min | Chromium iPhone-profile lane |
| `google-browser-e2e` | `google_calendar` or full matrix | 15 min | fake-Google lane ([L781-L1093](../../.github/workflows/ci.yml#L781-L1093)) |

Every DB and browser job brings up the **local** Supabase stack and runs the full migration chain from scratch.
None uses `--linked`, a project ref or an access token. The browser lanes and their fakes are described on
[Browser E2E suites and provider fakes](browser-e2e-suites-and-fakes.md), and the DB harness on
[Database and migration test harness](database-and-migration-test-harness.md).

## 3. Classification and risk tiers

`classify(files)` ([`scripts/classify-changes.mjs` L18-L278](../../scripts/classify-changes.mjs#L18-L278)) sets
lane booleans from path rules:

```
database  security  payment  google_calendar  mobile  ci_workflows  browser_core  application
```

Then:

- **`docs_only`** is true when every path is under `docs/`, is `README.md` or `CLAUDE.md`, ends in `.md`, or is a
  GitHub issue/PR template. It switches every lane off.
- **`full_matrix_required`** is set by package files, tsconfig, next/vitest/playwright config, middleware,
  `lib/supabase/`, `lib/env/`, the e2e and DB test helpers, **any** CI-workflow change, or an empty diff. It
  switches every lane on.

**Tiers.** The classifier also emits a **baseline tier**
([L60-L217](../../scripts/classify-changes.mjs#L60-L217)), and the highest matching tier wins regardless of rule
order:

| Tier | Signals |
|---|---|
| T0 | docs only |
| T1 | application code with no higher signal |
| T2 | business workflows; integrations and messaging; cron; server actions and APIs; CI; shared build configuration |
| T3 | migrations and DB tests; security paths; payment **authority** modules and money-moving `-actions.ts` files (not every file mentioning "payment"); auth and tenancy paths; public and token routes; sensitive-data libraries |

An empty diff fails safe to T3. The tier is a **floor, not a ceiling**: `ENGINEERING_STANDARDS.md` says automated
classification is "not semantic proof" and may never be cited to de-escalate a change whose behaviour crosses a
<!-- openwiki: broken internal link [../../ENGINEERING_STANDARDS.md#L27-L72] heading anchor "L27-L72" does not exist in "../../ENGINEERING_STANDARDS.md". Fix the href or restore the target, then delete this comment. -->
higher-risk boundary ([L27-L72](../../ENGINEERING_STANDARDS.md#L27-L72)).

Local tooling shares the same classifier and group selector:

- `npm run ci:plan` prints what CI will run ([`ci-plan.mjs` L1-L40](../../scripts/ci-plan.mjs#L1-L40));
- `npm run verify:changed` auto-runs only the cheap focused checks and prints expensive lanes as suggestions
  ([`verify-changed.mjs` L1-L60](../../scripts/verify-changed.mjs#L1-L60)).

[`classify-changes.test.ts`](../../tests/ci/classify-changes.test.ts) proves the mapping with table-driven cases.

## 4. Browser sharding and the fail-closed aggregator

**Shards** ([`ci.yml` L146-L216](../../.github/workflows/ci.yml#L146-L216), [L494-L550](../../.github/workflows/ci.yml#L494-L550)):

- **Targeted** selections run in at most three shards, never more than the number of selected spec files.
- **Extended** selections — including any run reached with no group selected — run the whole suite in four
  shards.
- Timeouts are failure ceilings above a stated target of under 10 minutes per shard. The comments record the
  runs that forced the ceilings up, where shards were cancelled with zero test failures.

**The aggregator** `browser-e2e` is the stable required check, because the shard jobs have dynamic names
([L678-L771](../../.github/workflows/ci.yml#L678-L771)). It **fails closed**:

| Condition | Result |
|---|---|
| `changes` did not succeed | **fail** — without its outputs, coverage cannot be shown to be unnecessary. This was observed as a false green during a GitHub Actions incident |
| a required shard result is missing | **fail** |
| shards cancelled, including at a timeout | **fail** |
| shards skipped while coverage was required | **fail** |
| an extended run with other than four shards | **fail** |
| no coverage required and shards skipped | pass |
| shards succeeded | pass |

[`aggregate-fail-closed.test.ts` L149-L297](../../tests/ci/aggregate-fail-closed.test.ts#L149-L297) extracts the
real script from the workflow and drives each case.

## 5. The nightly full matrix

`nightly.yml` runs these lanes with `fail-fast: false`, so one failure does not hide the others
([L51-L100](../../.github/workflows/nightly.yml#L51-L100)):

- the unit, static and safety gates;
- the full migration chain plus the DB/RLS integration suite;
- the core browser suite in four shards;
- the payment, mobile and Google lanes.

Use `workflow_dispatch` before a deliberate release candidate, or when a PR's classification is in doubt.

## 6. Supply chain and least privilege — guarded over the whole directory

`tests/ci/ci-config.test.ts` reads **every** file in `.github/workflows/`
([L904-L1316](../../tests/ci/ci-config.test.ts#L904-L1316)). For each one it requires:

- valid YAML;
- every `uses:` pinned to a 40-character SHA with a `# vX.Y.Z` comment;
- `persist-credentials: false` on every checkout;
- top-level permissions of **exactly** `{ contents: read }`, with **no** `write` scope anywhere, including job
  level ([L1046-L1082](../../tests/ci/ci-config.test.ts#L1046-L1082));
- no `GITHUB_TOKEN`, `git push` or `git tag`, `gh` write commands, `secrets.` references or secrets passed to
  called workflows ([L1103-L1154](../../tests/ci/ci-config.test.ts#L1103-L1154));
- `supabase/setup-cli` on the v1 line with the grants-parity CLI version;
- a reviewed checkout count of **8** across the directory: 7 in `ci.yml` and 1 in `nightly.yml`
  ([L1301-L1313](../../tests/ci/ci-config.test.ts#L1301-L1313)).

The CI-supply-chain rules in `CLAUDE.md` (SHA pins with version comments, setup-cli on v1) are the policy this
test enforces.

## 7. What green CI proves — and what it does not

Green CI proves the encoded checks passed for that head against a **local** database built from the
repository's migrations, using fakes for every provider. It does **not** prove:

- that a migration is applied to production — see
  [Migrations and hosted state](../operations/migrations-and-hosted-state.md);
- that the code is deployed;
- that a provider integration works for real;
- that anyone accepted the change.

<!-- openwiki: broken internal link [../../ENGINEERING_STANDARDS.md#L96-L99] heading anchor "L96-L99" does not exist in "../../ENGINEERING_STANDARDS.md". Fix the href or restore the target, then delete this comment. -->
"Green CI is necessary, not sufficient" ([`ENGINEERING_STANDARDS.md` L96-L99](../../ENGINEERING_STANDARDS.md#L96-L99)),
<!-- openwiki: broken internal link [../../CLAUDE.md#L231-L231] heading anchor "L231-L231" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
and "Green CI is not merge authorization" ([`CLAUDE.md` L231](../../CLAUDE.md#L231-L231)). See
[Delivery and review authority](../operations/delivery-and-review-authority.md).

## 8. Contradictions and open questions

1. **The workflow header understates the lanes.** `ci.yml`'s opening comment lists six local gates and describes
   a single job ([L1-L21](../../.github/workflows/ci.yml#L1-L21)). The browser-shard comment still says "ONE
   browser (Chromium), ONE core flow" ([L474-L479](../../.github/workflows/ci.yml#L474-L479)), although the job
   runs a selected or sharded multi-spec suite and three more browser lanes exist.
2. **Any new workflow is subject to the whole-directory guards.** A workflow that needs a write scope, a secret
   or another checkout fails the guards in §6 unless the guards and the reviewed checkout count change with it.
   The generated `openwiki-update.yml` scaffold is in that position: it requests write permissions and
   provider secrets.
3. **Docs-only diffs skip the `validate` lane, including `npm test`.** A Markdown-only PR therefore never runs the
   docs-consistency vitest suites in CI ([L228-L231](../../.github/workflows/ci.yml#L228-L231)). Those guards run
   only through local `verify:changed` (which auto-runs `tests/docs/` for a docs-only diff) or on a later
   non-docs PR and the nightly matrix.
