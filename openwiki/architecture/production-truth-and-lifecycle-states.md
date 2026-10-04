---
type: architecture
title: Production truth authorities and lifecycle states
description: How Hone keeps designed, implemented, merged, migration-applied, deployed, enabled, production-exercised and human-accepted states apart, which canonical documents may assert mutable production facts, how migration state is derived versus declared, how the canonical-facts guard enforces the rules and where it silently cannot, and where the canonical records are stale or disagree at this source head.
tags: [production-truth, lifecycle-states, canonical-docs, migration-state, docs-guards]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-164e2da859b5277df81c7d94
    resource: repo://.github/workflows/ci.yml
  - id: openwiki-source-f07bd6e082ff96434e028ea3
    resource: repo://docs/15_DOCS_MAINTENANCE.md
  - id: openwiki-source-3934c2f87cfed2d7e74c8303
    resource: repo://docs/production/capability-register.md
  - id: openwiki-source-723c675bbe2438236148b868
    resource: repo://docs/production/current-state.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-25950163322ecb962b98e506
    resource: repo://docs/production/release-changelog.md
  - id: openwiki-source-bed9aa4fdff900b1eb1dd662
    resource: repo://scripts/migration-state.mjs
  - id: openwiki-source-5b4944d20634a35670ad6c22
    resource: repo://scripts/verify-prepush.mjs
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-68fb49d65cba642bd3811eda
    resource: repo://tests/docs/helpers/canonical-facts.ts
  - id: openwiki-source-d1274f4c491d333b834e3c28
    resource: repo://tests/migrations/helpers/migration-state.ts
  - id: openwiki-source-fbadcd8591b65031efaaedce
    resource: repo://vitest.config.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Production truth authorities and lifecycle states

Hone treats "what is true in production" as a small set of **declared or derived facts with named
authorities**. No document, code comment, PR body or agent memory may assert a production fact on its
own. This page maps the lifecycle states, which file may say what, how the repository checks those
files mechanically, and where the records currently disagree.

> **Read this before writing any production claim** into code, docs, a PR or this wiki. A table,
> migration, route, component or flag existing is never evidence that a capability runs in production,
> and this wiki deliberately restates **no** production counts, tenant names, record ids or
> deployment ids: it points to the record that holds them.

## 1. The lifecycle vocabulary

The status words are defined once, in
[`capability-register.md` § Status vocabulary](../../docs/production/capability-register.md#status-vocabulary).
They are **independent dimensions**, and a capability normally holds several at once.

| Status | Meaning (paraphrased from the register) | Typical evidence |
|---|---|---|
| Designed | A reviewed design exists; no claim that code exists. | design doc or decision record |
| Implemented | Code exists in the repository. | source and tests at a commit |
| Merged | On the production branch `claude/build-hone-saas-hOex7`. | `git merge-base --is-ancestor <commit> <production-head>` |
| DB applied | Its migration is applied to the hosted production database. | `migration-state.json` plus the ledger's apply record |
| Deployed | Part of the production build serving the product. | the deployment record for the exact SHA |
| Enabled | A runtime gate (studio flag, env, config) permits it to run. | a dated read of the gate |
| Production exercised | It ran against production data at least once, with evidence. | a row, a log line or a recorded operation |
| Human accepted | The operator who asked for it used it and confirmed it. | that person's explicit statement |
| Dormant / Held / Deferred | Deployed but unable to act / blocked by a server-side gate pending approval / out of scope by product decision. | register row |
| Retired | **Terminal.** Permanently removed, and the database enforces that it cannot be enabled. | a constraint or revocation in a migration |

Rules that follow:

- **Never write "live" because code exists.** The bar for *Production exercised* is a row, a log line
  or a recorded operation, not the existence of a code path.
- **Usage is not acceptance.** `current-state.md` §15 lists deployed, and in some cases repeatedly
  exercised, features that still lack human acceptance, and forbids inferring acceptance from usage
  ([§ 15. Human acceptance still pending](../../docs/production/current-state.md#15-human-acceptance-still-pending)).
- **Merged is not deployed, and green CI is neither.** An open PR is never production. The durable test
  for "shipped" is ancestry of the production head
  ([§ Open pull requests are not production](../../docs/production/current-state.md#open-pull-requests-are-not-production)).
- **Retired is not dormant.** The signed/finalized clinical-record system is retired and
  database-enforced; see [Sessions, blocks and entries](../treatment-memory/sessions-blocks-and-entries.md).

## 2. The authority map

| Fact | Single authority | Mechanism |
|---|---|---|
| Hosted migration max and apply instant | [`docs/production/migration-state.json`](../../docs/production/migration-state.json) (`hosted_migration_max`, `hosted_applied_at`, `hosted_applied_at_precision`, `hosted_note`, append-only `$comment`) | Declared by whoever performed the apply, in the change that records it; only the ledger's current block may restate it |
| Repository migration max, total, next free number, pending set | **Derived** by [`scripts/migration-state.mjs`](../../scripts/migration-state.mjs) (`npm run migration:state`) | Filename scan of `supabase/migrations/`; nobody restates it |
| Narrative apply evidence | [`docs/production/migration-ledger.md`](../../docs/production/migration-ledger.md) | A new `## Current state` block is prepended; the old one is demoted to `## Previous state` unchanged |
| Production branch head, runtime-bearing head, tenant classification, open-PR set | [`docs/production/current-state.md`](../../docs/production/current-state.md) | Dated reconciliation (a PROD-TRUTH-class change); the only document allowed to pin a SHA |
| Per-capability status | [`docs/production/capability-register.md`](../../docs/production/capability-register.md) | Defers SHAs and tenancy to `current-state.md` |
| Residual limitations | [`docs/production/known-limitations.md`](../../docs/production/known-limitations.md) | Closed by evidence on the limitation's own heading, never by deletion |
| What shipped in a wave | [`docs/production/release-changelog.md`](../../docs/production/release-changelog.md) | Rows keep their then-state wording; only the preamble is kept current |

**Not authorities:** `docs/14_AI_HANDOFF.md` (it heads its older entries "Historical entries —
point-in-time only"), `docs/reviews/**`, audit packs under `docs/audits/**` (excluded from this wiki
by `.openwikiignore`), code comments, PR descriptions and any agent memory. They can tell you where to
look; they never establish a current value.

### Derived repository state versus declared hosted state

`scripts/migration-state.mjs` is split in two on purpose:

- **Derived.** `scanMigrations` reads `supabase/migrations/*.sql`, throws on any filename that is not
  `NNNN_snake_case.sql` and on duplicate versions, and `getMigrationState` computes the maximum, the
  total and the next free number, skipping the permanently unused slot `0158`
  ([L42-L98](../../scripts/migration-state.mjs#L42-L98), [L140-L148](../../scripts/migration-state.mjs#L140-L148)).
- **Declared.** `readCanonicalRecord` reads `migration-state.json`, requires `hosted_migration_max`,
  `hosted_applied_at` and `hosted_note`, requires a four-digit maximum, and accepts
  `hosted_applied_at` only as `null` or an ISO date or instant
  ([L100-L135](../../scripts/migration-state.mjs#L100-L135)). `null` is legitimate: the hosted
  `schema_migrations` table has no timestamp column.
- **Pending** is every repository version above the declared hosted maximum, and `repo_equals_hosted`
  is a plain numeric comparison ([L149-L175](../../scripts/migration-state.mjs#L149-L175)). A repository
  maximum above hosted is the normal state of a migration-first change in flight.

The derivation is executed, not just documented. The canonical-facts guard runs the script with
`--json` and compares its output with the ledger and the record
([guard L70-L71](../../tests/docs/canonical-production-facts.test.ts#L70-L71),
[L486-L540](../../tests/docs/canonical-production-facts.test.ts#L486-L540)); per-migration tests use it
through [`tests/migrations/helpers/migration-state.ts`](../../tests/migrations/helpers/migration-state.ts);
and `npm run verify:prepush` fails when the script throws
([`verify-prepush.mjs` L142-L149](../../scripts/verify-prepush.mjs#L142-L149)).

Numbering and authoring rules are on [Migrations and hosted migration state](../operations/migrations-and-hosted-state.md);
the apply sequence is on [Migration-first rollout](../operations/migration-first-rollout-and-production-safety.md).

## 3. How to re-derive production state

`current-state.md` ends with a re-verification recipe and a **source-of-truth order** that puts existing
documentation last ([§ How to re-verify this document](../../docs/production/current-state.md#how-to-re-verify-this-document)):

1. the production Git graph;
2. the deployment record for the exact SHA;
3. `supabase migration list --linked`, after confirming the gitignored `supabase/.temp/project-ref`
   names the intended project;
4. read-only production queries (`supabase db query --linked`, **never** `db execute`);
5. code and migrations at the exact production SHA;
6. merged PR metadata and CI;
7. deployment and runbook reports;
8. existing documentation, *as claims to verify, never as evidence*.

The same section says the document is not evidence for itself and that every production count must
carry an as-of stamp and a tenant scope. Steps 2–4 are production access: out of scope for routine
agent work unless the operator explicitly authorizes them.

## 4. Tenant classes

`current-state.md` §0 is the canonical classification of production tenants
([§ 0. Tenant register](../../docs/production/current-state.md#0-tenant-register--real-controlled-test-synthetic)).
Reason in **classes**; never copy the register's names or counts:

- **Real customer** — studios whose rows are customer activity.
- **Controlled test** — a validation studio, identified in §0 by its enabled flags rather than its name.
- **Synthetic** — a sanctioned synthetic tenant *inside the production database* with generated,
  privacy-safe rows. Its rows are never customer activity.
- **Empty** tenants.

"Non-synthetic" is **not** "real customer": subtracting the synthetic tenant still leaves the controlled
test studio in a total. All-tenant totals may be quoted only when labelled as including synthetic rows,
and the guard requires every tenant to be classified and real-customer figures to come from the
real-customer row, never from a subtraction.

## 5. The guard that enforces all of this

[`tests/docs/canonical-production-facts.test.ts`](../../tests/docs/canonical-production-facts.test.ts)
(about 3,460 lines) turns these rules into assertions. Its only exemption mechanism is an explicit
`<!-- canonical-facts:ignore-start reason=… -->` … `<!-- canonical-facts:ignore-end -->` frozen region;
everything outside such a region is current prose
([`helpers/canonical-facts.ts` L13-L34](../../tests/docs/helpers/canonical-facts.ts#L13-L34)).

| Rule family | What it pins | Lines |
|---|---|---|
| No hard-coded current migration state | `current-state`, `capability-register` and `known-limitations` state no current maximum or next free number; the changelog preamble states neither a current maximum nor a head | [L404-L468](../../tests/docs/canonical-production-facts.test.ts#L404-L468) |
| Ledger agrees with the record | The ledger's current block states the declared hosted maximum and the derived repository maximum; the relationship is **PARITY or MIGRATION-FIRST PENDING** only | [L470-L746](../../tests/docs/canonical-production-facts.test.ts#L470-L746) |
| Synthetic rows | Every tenant classified; real-customer figures come from the real-customer row | [L812-L885](../../tests/docs/canonical-production-facts.test.ts#L812-L885) |
| Durable waitlist activation | Recorded as a **dated bound** with a dated non-zero row count; no canonical doc may call it dormant, dark or zero-rowed | [L921-L1000](../../tests/docs/canonical-production-facts.test.ts#L921-L1000) |
| Apply history | `$comment` in `migration-state.json` is an append-only array: entries may be added, never edited or removed (entry count and digest are pinned) | [L1352-L1418](../../tests/docs/canonical-production-facts.test.ts#L1352-L1418) |
| Frozen-region markers | Every ignore block in every scanned document declares a reason | [L1420-L1461](../../tests/docs/canonical-production-facts.test.ts#L1420-L1461) |
| Rule A | Every SHA in `current-state.md` resolves; the runtime pin is an ancestor of `HEAD`; **nothing runtime-bearing changed since the pin**, judged by `scripts/classify-changes.mjs` | [L1650-L1825](../../tests/docs/canonical-production-facts.test.ts#L1650-L1825) |
| Rule X, A5 | The recorded current branch head equals the real production ref | [L2531-L2575](../../tests/docs/canonical-production-facts.test.ts#L2531-L2575) |
| Rule A4 | Only `current-state.md` may contain a commit SHA; the register and limitations must reference it | [L2820-L2848](../../tests/docs/canonical-production-facts.test.ts#L2820-L2848) |
| Rule F | Open PRs are declared, carry a non-production state word, and none has actually merged | [L2850-L2975](../../tests/docs/canonical-production-facts.test.ts#L2850-L2975) |
| Rule G | `current-state.md` says it is not evidence for itself and orders documentation last | [L2981-L3000](../../tests/docs/canonical-production-facts.test.ts#L2981-L3000) |

### Where the guard runs, and where it silently does not

- It is an ordinary Vitest file, so `npm test` runs it: the unit config includes `tests/**/*.test.ts`
  and excludes only `tests/db/**` ([`vitest.config.ts` L40-L46](../../vitest.config.ts#L40-L46)).
- **Rules A and A5 need real history.** They record their environment and skip on a shallow clone
  ([L1650-L1666](../../tests/docs/canonical-production-facts.test.ts#L1650-L1666),
  [L2554-L2557](../../tests/docs/canonical-production-facts.test.ts#L2554-L2557)).
- In CI only the change-detection job checks out full history
  ([`ci.yml` L105-L122](../../.github/workflows/ci.yml#L105-L122)); the `validate` job that runs `npm test`
  uses the default shallow checkout ([L281-L284](../../.github/workflows/ci.yml#L281-L284),
  [L321](../../.github/workflows/ci.yml#L321)), so **these rules are skipped in CI** and enforce only on
  full local clones, including `npm run verify:changed` and `verify:prepush`.
- `validate` is skipped entirely when the classifier reports `docs_only`
  ([`ci.yml` L228-L232](../../.github/workflows/ci.yml#L228-L232)), so a Markdown-only diff under `docs/`
  runs **none** of these guards in PR CI.

## 6. Lifecycle states in practice

- **Whole-session copy** is recorded as *DB applied · merged · deployed · enabled · production
  exercised · human acceptance pending*, every dimension stated separately
  ([§ 2. Whole-session copy](../../docs/production/current-state.md#2-whole-session-copy)).
- **The durable new-client waitlist** is recorded as a *dated activation bound*, not a standing posture,
  because persisted rows outlive the environment flag that enabled them
  ([§ WAIT-02B Stage B1](../../docs/production/current-state.md#wait-02b-stage-b1--disclosure-shipped-and-since-acted-on-shipped--activation-taken)).
- **NEW-CLIENT-MODE-01 (migration `0204`)** is recorded as operational facts that are explicitly *not*
  a re-pin: applied before deploy, owner stamping incomplete, and several activation steps recorded as
  UNKNOWN rather than inferred
  ([§ NEW-CLIENT-MODE-01 release](../../docs/production/current-state.md#new-client-mode-01-release--what-actually-happened-on-2026-10-01)).
- **NEW-STUDIO-ADMISSION-DEFAULT (migration `0205`)** is recorded in the migration ledger's current
  block as applied, with repository and hosted at parity. The same block records that the grant
  deviation an earlier execution record had earmarked `0205` to close is **still open**, because `0205`
  was used for this change instead. See [New-client admission mode](../waitlist/new-client-admission-mode.md).

## 7. Contradictions and open questions

Recorded against this generation's source head (the production branch after #783). They are **not**
reconciled here.

1. **`current-state.md` is behind production by its own admission, and its guards fail on a full
   clone.** The reconciliation header pins a branch head and a last runtime-bearing head at its
   2026-09-20/21 sync ([§ Reconciliation header](../../docs/production/current-state.md#reconciliation-header)),
   and the NEW-CLIENT-MODE-01 subsection states that production has advanced past the pin and that it
   deliberately does not re-pin. Rule A3 asserts that nothing runtime-bearing changed since the pin and
   Rule A5 asserts that the recorded branch head equals the production ref.
   *Observation from this generation run, not a repository fact:* on a full clone of this source head,
   `canonical-production-facts.test.ts` fails exactly A3 and A5 (107 other tests pass). CI cannot see
   it, because both rules skip on shallow checkouts (§5).
2. **The tenant register is older than the apply records.** §0 is a dated measurement; the migration
   ledger's later apply records verify more studio rows than §0 classifies, and `current-state.md`'s own
   NEW-CLIENT-MODE-01 table refers to more studios than its header's tenant posture. At least one
   production studio row is therefore outside the canonical classification until §0 is re-measured.
3. **Reconciliation dates differ across the canonical set.** `capability-register.md` and
   `known-limitations.md` were reconciled before `current-state.md`'s 2026-09-20/21 sync, and the
   ledger's current block (the `0205` apply) is newer than all three. A status present in the newest
   record may be absent, or older, in the register.
4. **`docs/15_DOCS_MAINTENANCE.md` contradicts the canonical record.** Its "How to avoid false claims"
   list still bans saying *"Whole-session copy is production-exercised"* and prints a hard-coded
   production migration maximum as current
   ([§ How to avoid false claims](../../docs/15_DOCS_MAINTENANCE.md#how-to-avoid-false-claims)), while
   `current-state.md` records whole-session copy as production exercised. That file is not among the
   documents the guard scans.
5. **WAIT activation: "next work" versus "already taken".** `current-state.md` §16 item 5 still lists
   *WAIT-02B Stage B2 (activation)* as next work whose authorization is not granted
   ([§ 16. Next work](../../docs/production/current-state.md#16-next-work)), while limitation L25 records that
   the activation was already taken and that the open item is only the missing governance record
   ([known-limitations § L25](../../docs/production/known-limitations.md#l25--the-durable-new-client-waitlist-is-deployed-dark-its-table-would-hold-prospect-pii-the-public-privacy-policy-does-not-disclose)).
   The guard's pre-cutover phrasing rules do not match item 5's wording, so it stays green.

## 8. Agent checklist

- Derive repository migration facts with `npm run migration:state`; never type a migration number as
  current truth.
- Treat any production count, flag value, health reading or provider state as **dated**: point to its
  record, or don't use it.
- Before calling something shipped, check ancestry against the production head you just re-read;
  before calling it exercised, find the record; before calling it accepted, find the person's
  explicit statement.
- When two authorities disagree, record both and their dates; do not pick one.
- Never copy tenant names, counts, record ids, deployment ids, project refs or environment values into
  code, docs or this wiki.
