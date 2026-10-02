---
type: process contract
title: Delivery sequence, review provenance and merge authority
description: How a change moves from a local commit to production in Hone — the committed-tree delivery sequence and what verify:prepush actually checks, the PR template, exact-head review provenance through the eng CLI, merge-authorization rules, and why green CI, review, merge, deployment and human acceptance are separate facts.
tags: [delivery, verify-prepush, code-review, merge-authority, release, provenance]
sources:
  - id: openwiki-source-1e075575622e1a77a3dc46e6
    resource: repo://.github/pull_request_template.md
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-f317ee207e1653d2033c81a4
    resource: repo://CONTRIBUTING.md
  - id: openwiki-source-3ad934bbd2c1fea4924f842a
    resource: repo://ENGINEERING_STANDARDS.md
  - id: openwiki-source-837c723b2b0170b3cd08a5fc
    resource: repo://scripts/eng/cli.mjs
  - id: openwiki-source-6b5fe954139e99220a1e1100
    resource: repo://scripts/eng/evidence.mjs
  - id: openwiki-source-1ebd424bc474dffbf39fa70c
    resource: repo://scripts/eng/review-provenance.mjs
  - id: openwiki-source-5b4944d20634a35670ad6c22
    resource: repo://scripts/verify-prepush.mjs
  - id: openwiki-source-d81538d8891efe37053aeccb
    resource: repo://supabase/config.toml
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-80bc5185d95430a1f19fc11d
    resource: repo://tests/source-guards/supabase-temp-untracked.test.ts
generated: { by: "claude-code", at: "2026-10-02T22:34:57.394Z" }
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T22:34:57.394Z
---

# Delivery sequence, review provenance and merge authority

Five facts are routinely confused and Hone keeps them apart:

1. **CI is green** — a property of one commit SHA in one workflow run.
2. **Review is clean** — a verdict from the trusted reviewer *at that exact head*.
3. **Merged** — the commit is an ancestor of the production branch `claude/build-hone-saas-hOex7`.
4. **Deployed** — Vercel's production deployment is built from a commit that contains it.
5. **Human accepted** — the person who asked for it has used it and confirmed it.

None implies the next. "Green CI is not merge authorization"
([`CLAUDE.md` § 4. CI watchers and delivery ceremony](../../CLAUDE.md#4-ci-watchers-and-delivery-ceremony)); "green CI is necessary, not sufficient"
([`ENGINEERING_STANDARDS.md` § 4. Proof](../../ENGINEERING_STANDARDS.md#4-proof)); merged is not
deployed, and usage is not acceptance (see
[Production truth authorities and lifecycle states](../architecture/production-truth-and-lifecycle-states.md)).

## 1. Risk tier first

Before choosing how much to prove, determine the baseline tier with `npm run ci:plan -- --json`
and then apply semantic judgement on top
([`ENGINEERING_STANDARDS.md` § 2. Risk tiers](../../ENGINEERING_STANDARDS.md#2-risk-tiers)):

| Tier | Scope | Expected proof |
|---|---|---|
| T0 | docs, non-runtime comments | focused checks, normal CI |
| T1 | low-risk UI / local behaviour | focused unit/component test, targeted browser coverage |
| T2 | booking, sessions, calendar, notifications, background jobs, external messaging | behavioural + integration tests, cross-feature reasoning, observability |
| T3 | auth, tenancy, RLS, `service_role`, payments, migrations, destructive ops, external-side-effect state machines | real DB tests, concurrency, negative controls, privilege closure, deployment-skew analysis, independent review, controlled rollout |

The classifier is **path evidence, never semantic proof**; it may never justify de-escalating a
change whose behaviour crosses a higher-risk boundary. Proof hierarchy: real DB → server/action →
component → browser E2E → source/static tripwire, with anti-vacuity proof for important absence
claims ([§ 4. Proof](../../ENGINEERING_STANDARDS.md#4-proof)).

## 2. The committed-tree delivery sequence

"Typecheck passed" is a claim about the working tree, not about what was pushed. The required
sequence ([`CLAUDE.md` § 1. The delivery sequence](../../CLAUDE.md#1-the-delivery-sequence--verify-the-committed-tree-not-the-working-tree)):

```bash
git add -A
git diff --cached --check
git status --porcelain
git commit -m "..."
git status --porcelain        # must be empty
git diff HEAD --exit-code     # commit == tree
npm run verify:prepush
git push
```

### What `npm run verify:prepush` checks — and what it does not

[`scripts/verify-prepush.mjs`](../../scripts/verify-prepush.mjs) runs only git and the
migration-state derivation; it installs no hook and mutates nothing:

| Check | Lines |
|---|---|
| no tracked modification after the commit; untracked files fail unless on the allowlist (`supabase/config.toml`, `node_modules`) | [L62-L90](../../scripts/verify-prepush.mjs#L62-L90) |
| `git diff HEAD` empty | [L92-L96](../../scripts/verify-prepush.mjs#L92-L96) |
| `git diff --check` and `--cached --check` | [L98-L104](../../scripts/verify-prepush.mjs#L98-L104) |
| no line-start conflict markers in any tracked text file | [L106-L123](../../scripts/verify-prepush.mjs#L106-L123) |
| untracked source-like files (`.ts .tsx .mjs .js .sql .yml .json .md`) not in `HEAD` | [L125-L140](../../scripts/verify-prepush.mjs#L125-L140) |
| `node scripts/migration-state.mjs` exits 0 | [L142-L150](../../scripts/verify-prepush.mjs#L142-L150) |

It runs **no** typecheck, lint, build or test. Behavioural proof comes from `npm run
verify:changed` (the focused local checks the diff warrants) and CI; see
[CI workflows and risk lanes](../testing/ci-workflows-and-risk-lanes.md).

## 3. The PR body

[`.github/pull_request_template.md` § Summary](../../.github/pull_request_template.md#summary) requires:
summary; baseline tier and any semantic escalation; whether a trust boundary, database/migration or
external side effect is involved; high-risk considerations (cross-command interaction, deployment
skew, privilege impact, rollback, observability); proof (focused tests, integration/E2E, negative
control); and the **production section** — production access `NONE / READ-ONLY / WRITE` and
migration `NONE / PENDING / APPLIED`. `CONTRIBUTING.md` adds an eleven-item PR report
(existing-state audit, files and reasons, schema/RPC/grants, migration applied before merge, what
was intentionally not changed, validation table, Stripe gate results, manual smoke not run, …)
([§ What must be in every PR report](../../CONTRIBUTING.md#what-must-be-in-every-pr-report)).

## 4. Review provenance: `npm run eng -- status <pr>`

The eng CLI **reports GitHub facts at one exact head; it does not decide readiness, record
findings or merge** ([`scripts/eng/cli.mjs` L1-L36](../../scripts/eng/cli.mjs#L1-L36)). It is
operator-side by design: wiring it into a workflow would need a GitHub API credential, which the CI
posture removes ([`CLAUDE.md` § CI supply chain](../../CLAUDE.md#ci-supply-chain)).

- **One positive gate.** `mayAssertPositive` allows GREEN/CLEAN only when evidence is both
  **COMPLETE** (the whole paginated collection was read) and **AUTHORIZED**
  ([`scripts/eng/evidence.mjs` L28-L51](../../scripts/eng/evidence.mjs#L28-L51)).
- **Trusted reviewer by immutable account id** (the Codex connector bot), not by login,
  `author_association` or verdict wording ([L52-L101](../../scripts/eng/evidence.mjs#L52-L101)).
- **Four confusions it refuses:** comments GitHub re-anchored onto a newer head, replies treated as
  review completion, an empty review object treated as a clean verdict, and stale verdicts for
  other heads treated as current; abbreviated SHAs are prefix-matched with a 7-character minimum
  ([`review-provenance.mjs` L1-L83](../../scripts/eng/review-provenance.mjs#L1-L83)).
- Behaviour is pinned against recorded PR fixtures in
  [`tests/eng/review-provenance.test.ts`](../../tests/eng/review-provenance.test.ts).

## 5. Merge, watchers and post-merge rules

From [`CLAUDE.md` § 4. CI watchers and delivery ceremony](../../CLAUDE.md#4-ci-watchers-and-delivery-ceremony):

- exactly one active CI watcher per PR head; never poll in parallel; report only when a run settles;
- cancel a superseded head's run when pushing a new head;
- a conditional **exact-head** merge authorization is honoured as given once CI settles green — a
  **changed head invalidates it**;
- no post-merge full CI rerun: verify branch containment, deployment success where applicable, and a
  clean tree;
- **green CI is not merge authorization.**

Job budgets distinguish a *performance target* from a *hard timeout*, which must exceed the target
including variable setup cost; a cancelled shard should be checked for what it completed before
blaming the diff ([§ 4. CI watchers and delivery ceremony](../../CLAUDE.md#4-ci-watchers-and-delivery-ceremony)).

## 6. From merge to "deployed" and "runtime-bearing"

- Vercel builds production from pushes to the production branch; each PR gets a preview
  ([`docs/01_ARCHITECTURE.md` § Runtime stack](../../docs/01_ARCHITECTURE.md#runtime-stack)). The production build
  runs the env gates first ([`package.json` L7](../../package.json#L7-L7)).
- Whether a merge changes what production *runs* is decided by the composed predicate recorded in
  `current-state.md`: not documentation per `scripts/classify-changes.mjs`, **and** not in a
  non-shipping root (`tests/`, `e2e/`, `.github/`, `scripts/` except scripts the build executes)
  ([`current-state.md` § Reconciliation header](../../docs/production/current-state.md#reconciliation-header)).
- A schema change follows the migration-first order instead; see
  [Migration-first rollout and production safety](migration-first-rollout-and-production-safety.md).

## 7. Contradictions and open questions

1. **`supabase/config.toml` is tracked, but the delivery rules treat it as untracked local-only.**
   `CLAUDE.md` lists it as "local E2E stack config, untracked by CLI convention … never commit"
   ([§ 1. The delivery sequence](../../CLAUDE.md#1-the-delivery-sequence--verify-the-committed-tree-not-the-working-tree)) and `verify-prepush` allowlists it as an *untracked* file
   ([L76-L80](../../scripts/verify-prepush.mjs#L76-L80)); `git ls-files` shows it tracked (it is used
   by the DB/E2E harness). The separate guard
   [`supabase-temp-untracked.test.ts`](../../tests/source-guards/supabase-temp-untracked.test.ts#L28-L41)
   only covers `supabase/.temp/`.
2. **The canonical-facts guard says `verify:prepush` enforces its history rules; it does not.** The
   guard's comment says Rule A enforces "in a developer's checkout, and so `npm run verify:changed` /
   `verify:prepush` before every push"
   ([`canonical-production-facts.test.ts` L1651-L1658](../../tests/docs/canonical-production-facts.test.ts#L1651-L1658)),
   but `verify:prepush` runs no tests.
3. **History-dependent guard vs the portability standard.** `ENGINEERING_STANDARDS.md` says a test
   "must not require full developer git history" and that a test passing only in one checkout is not
   portable proof ([§ 4. Proof](../../ENGINEERING_STANDARDS.md#4-proof)); the canonical-facts Rule A
   requires full history and skips in CI's shallow clones.
4. **`CONTRIBUTING.md` describes CI as running the full command set on every PR** ("the same set
   automatically on every PR") and lists six commands that "must pass"
   ([§ Required commands before opening a PR](../../CONTRIBUTING.md#required-commands-before-opening-a-pr)); `CLAUDE.md` §3 and the workflow are risk-based and skip
   the validate lane for documentation-only diffs.
