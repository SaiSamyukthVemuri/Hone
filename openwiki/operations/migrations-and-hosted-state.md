---
type: operations
title: Migrations and hosted migration state
description: How Supabase migrations are numbered, authored, guarded and tested in Hone — derived repository state versus declared hosted state, transaction and grant conventions, frozen files, the per-migration test pattern (derived assertions, floors for applied migrations, only the current head asserting it is the maximum), the narrow guards against hand-maintained pins, generated-type drift checks, and the stale numbers still printed in some docs.
tags: [migrations, migration-state, supabase, grants, testing, schema]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-eb10efb7264b39a67076cb7b
    resource: repo://docs/09_DATABASE_AND_RLS.md
  - id: openwiki-source-0a7f1727d82c9ac5dce569e4
    resource: repo://docs/production/known-limitations.md
  - id: openwiki-source-f79f369ce2044c952565dcb9
    resource: repo://docs/production/migration-ledger.md
  - id: openwiki-source-23775c3de52f3ab95a13cb8b
    resource: repo://README.md
  - id: openwiki-source-25d32ed0ba4ba4c604917396
    resource: repo://scripts/check-db-types.mjs
  - id: openwiki-source-ccd552a653e6c21921624856
    resource: repo://scripts/check-migration-extension-qualification.mjs
  - id: openwiki-source-8576950bcf5d6a2cb4498309
    resource: repo://scripts/classify-changes.mjs
  - id: openwiki-source-bed9aa4fdff900b1eb1dd662
    resource: repo://scripts/migration-state.mjs
  - id: openwiki-source-f12a840b2f4a93ce89828ca9
    resource: repo://supabase/migrations/0204_new_client_admission_mode.sql
  - id: openwiki-source-2596c45699032de1ba03ae0c
    resource: repo://tests/ci/ci-config.test.ts
  - id: openwiki-source-84ee60a98182dfa16e1f3603
    resource: repo://tests/docs/canonical-production-facts.test.ts
  - id: openwiki-source-fbba42026f7c61101843bef1
    resource: repo://tests/migrations/0199-reminder-sms-candidate-selection.test.ts
  - id: openwiki-source-7eb4a084904f7d07a203cbc2
    resource: repo://tests/migrations/0203-waitlist-mobile-verification-authority.test.ts
  - id: openwiki-source-b037985cdab5a0d739ca0a36
    resource: repo://tests/migrations/0204-new-client-admission-mode.test.ts
  - id: openwiki-source-a11a9d40d902ff26739beca0
    resource: repo://tests/migrations/0205-new-studio-admission-default.test.ts
  - id: openwiki-source-d1274f4c491d333b834e3c28
    resource: repo://tests/migrations/helpers/migration-state.ts
  - id: openwiki-source-dfb951c77b8f835845bbc3a0
    resource: repo://tests/security/clinical-rpc-grant-guard.test.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Migrations and hosted migration state

## 1. Files and numbers

- Files live in `supabase/migrations/` and must match `NNNN_snake_case_name.sql`; a malformed name or a duplicate
  version makes `scripts/migration-state.mjs` throw ([L42-L98](../../scripts/migration-state.mjs#L42-L98)).
- **`0158` is permanently skipped**, and the next free number skips it
  ([L145-L147](../../scripts/migration-state.mjs#L145-L147)).
- **Never type a migration number as current truth.** Derive it:

```bash
npm run migration:state            # human summary
npm run migration:state -- --json  # repo max, next free, pending, repo_equals_hosted, …
```

- **Hosted state is declared, not derived**: `docs/production/migration-state.json` holds `hosted_migration_max`,
  `hosted_applied_at` (nullable) with its precision note, and an append-only `$comment` history, and it is updated in
  the same change that records an apply ([`CLAUDE.md` § 2. Migration state is DERIVED](../../CLAUDE.md#2-migration-state-is-derived--never-hard-code-it)).
  The relationship at the last recorded apply is stated in the ledger's current block
  ([`migration-ledger.md`](../../docs/production/migration-ledger.md)); re-derive before relying on it.

A repository maximum **above** hosted is the normal migration-first state; a hosted maximum above the repository is
the defect. See [Production truth authorities](../architecture/production-truth-and-lifecycle-states.md) and
[Migration-first rollout](migration-first-rollout-and-production-safety.md).

## 2. Authoring conventions

| Convention | Why | Evidence |
|---|---|---|
| Open your own `begin;` … `commit;` and put `set local lock_timeout` **inside** it | `supabase db push` does not wrap a file in a transaction, so a bare `SET LOCAL` raises `25P01` and never arms | [`CLAUDE.md` § 5](../../CLAUDE.md#5-production-safety); e.g. [`0204` L40-L42](../../supabase/migrations/0204_new_client_admission_mode.sql#L40-L42), [L794](../../supabase/migrations/0204_new_client_admission_mode.sql#L794-L794) |
| Revoke `EXECUTE` from `public`, `anon`, `authenticated` **and** `service_role` by name, then grant narrowly | Supabase default privileges grant `EXECUTE` on every new function to all three API roles (`0129` left `anon`, `0164` left `service_role`) | [`CLAUDE.md` § 5](../../CLAUDE.md#5-production-safety); guard [`clinical-rpc-grant-guard.test.ts` L1-L40](../../tests/security/clinical-rpc-grant-guard.test.ts#L1-L40) |
| `SECURITY DEFINER` functions pin `search_path` | prevents resolution hijack | see [RLS, grants and SECURITY DEFINER](../security/rls-grants-and-security-definer.md) |
| Schema-qualify pgcrypto and uuid-ossp calls as `extensions.<fn>` | on a fresh managed project those extensions are not on the migration `search_path`; built-in `gen_random_uuid()` is exempt | [`check-migration-extension-qualification.mjs` L1-L40](../../scripts/check-migration-extension-qualification.mjs#L1-L40) |
| Prefer additive, idempotent DDL; correct mistakes with a **new** migration | applied files are frozen | [Migration-first rollout](migration-first-rollout-and-production-safety.md#4-applied-migrations-are-frozen-mechanically) |

**Migration headers are authoring-time statements.** An applied file can never be edited, so its header keeps what it
said when written: `0204`'s header still opens with "CANDIDATE, NOT APPLIED"
([`0204` L1-L7](../../supabase/migrations/0204_new_client_admission_mode.sql#L1-L7)) although the ledger records it
applied. Read status from the ledger and `migration-state.json`, never from a migration comment.

## 3. Per-migration tests

Each significant migration has a `tests/migrations/NNNN-*.test.ts` that pins its **structure from the SQL text**
(objects, grants, CHECK sets, transaction framing) and, for applied ones, the **sha256 of the file** against the bytes
gated before the production write. Database behaviour is proven separately in `tests/db/` (see
[Database and migration test harness](../testing/database-and-migration-test-harness.md)).

The rules come from [`CLAUDE.md` § 2](../../CLAUDE.md#2-migration-state-is-derived--never-hard-code-it) and the helper
[`tests/migrations/helpers/migration-state.ts`](../../tests/migrations/helpers/migration-state.ts#L1-L72): never hard-code
the repository maximum or a "trip on the next one" regex; import `isRepoMax`, `versionsAbove`, `countVersion` and
`fileForVersion` instead. At this source head the tests take three shapes:

- **The current head asserts it is the maximum.** Only the newest migration's own test asserts `isRepoMax` and that
  nothing sits above it ([`0205` test L137-L144](../../tests/migrations/0205-new-studio-admission-default.test.ts#L137-L144)).
  Because `isRepoMax` is derived from the migrations directory, this flips when the next file is **authored**, so the
  assertion moves to the new head's test at authoring time.
- **Older tests assert derived facts only.** `0198`–`0203` assert that something sits above them and that every
  version above is greater, never a literal list
  ([`0199` test L52-L63](../../tests/migrations/0199-reminder-sms-candidate-selection.test.ts#L52-L63)).
- **Applied tests hold floors, not equality.** `0204`'s test asserts that hosted is at or above `0204` and that nothing
  at or below it is pending; no per-migration file holds the hosted equality any more. That is proved centrally by
  the canonical-facts guard, which compares `migration-state.json` with the derived state
  ([`0204` test L35-L62](../../tests/migrations/0204-new-client-admission-mode.test.ts#L35-L62),
  [guard L533-L540](../../tests/docs/canonical-production-facts.test.ts#L533-L540)).

## 4. Generated types and other schema checks

- `lib/types/database.ts` is **hand-rolled** (narrower unions than generated output). `npm run check:db-types`
  generates types from the **local** stack only (`--local`, refusing hosted-looking URLs) and compares **column sets in
  both directions** for a curated table list ([`check-db-types.mjs` L1-L80](../../scripts/check-db-types.mjs#L1-L80)).
- `npm run check:migration-extensions` and `npm run check:fresh-managed` keep the full chain applicable to a fresh
  managed project.
- The classifier selects the database lane in CI for any change under `supabase/migrations/`, `tests/db/`,
  `tests/migrations/`, `scripts/migration-state.mjs` or the extension checks
  ([`classify-changes.mjs` L50](../../scripts/classify-changes.mjs#L50-L50)).

## 5. Adding a migration: checklist

1. `npm run migration:state` and take the next free number.
2. Write the file with its own transaction, lock timeout, pinned `search_path` and by-name revokes.
3. Add `tests/migrations/NNNN-….test.ts` (structure) and `tests/db/…` (behaviour). Move the "is the maximum" assertion
   from the previous head's test to the new one; never add a literal version list or a hosted-equality pin.
4. If it changes columns of a curated table, update `lib/types/database.ts`.
5. Follow [Migration-first rollout](migration-first-rollout-and-production-safety.md); never apply without explicit
   per-change authorization.

## 6. Contradictions and open questions

1. **Nothing mechanically stops the pins #780 removed from coming back.** #780 converted the literal
   "versions above me" lists in the `0198`–`0203` tests to derived assertions and narrowed `0204`'s hosted-equality
   claim to a floor, so the old contradiction (authoring the next migration turned six tests red) is gone. The guards
   that remain in `tests/ci/ci-config.test.ts` match only two historical shapes, a hard-coded `maxNum` comparison and
   one `^01(6[…` filename regex ([L822-L854](../../tests/ci/ci-config.test.ts#L822-L854)); neither would catch a
   reintroduced literal `versionsAbove` list or a per-migration "hosted == me" assertion, which `CLAUDE.md` forbids.
   An anti-regression scan for those shapes is still open work. (A residue of the old pins: the `0199` test's title
   still says the repository maximum is `0201`.)
2. **`docs/09_DATABASE_AND_RLS.md` and `README.md` still print a current migration maximum**
   ([§ Migration discipline](../../docs/09_DATABASE_AND_RLS.md#migration-discipline), [§ Status](../../README.md#status)),
   while `CLAUDE.md` says these files should reference the canonical record instead
   ([§ Hosted state is declared, not derived](../../CLAUDE.md#hosted-state-is-declared-not-derived)); neither file is in the
   canonical-facts guard's scanned set.
3. **Trigger-function `EXECUTE` is treated two ways, and the open item survived `0205`.** The grant guard excludes
   `returns trigger` functions because they cannot be called directly
   ([`clinical-rpc-grant-guard.test.ts` L26-L31](../../tests/security/clinical-rpc-grant-guard.test.ts#L26-L31)), while
   limitation L33 records `0204`'s admission-guard trigger holding `EXECUTE` for every role as debt
   ([`known-limitations.md` § L33](../../docs/production/known-limitations.md#l33--0204s-admission-guard-trigger-holds-execute-for-every-application-role-including-public)).
   An execution record had earmarked `0205` to close it, but `0205` was used for the admission default and contains no
   grant statements, so the ledger records the deviation as still open and needing a new migration.
