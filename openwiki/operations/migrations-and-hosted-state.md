---
type: engineering mechanics
title: Migrations and hosted migration state
description: How Supabase migrations are numbered, authored, guarded and tested in Hone — the derived repository state versus the declared hosted state, transaction and grant conventions, frozen-file enforcement, the per-migration test pattern and its "current claim" hand-off, generated-type drift checks, and the stale numbers still printed in some docs.
tags: [migrations, supabase, migration-state, grants, testing, schema]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-02T20:08:11.217Z
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
  - id: openwiki-source-fbba42026f7c61101843bef1
    resource: repo://tests/migrations/0199-reminder-sms-candidate-selection.test.ts
  - id: openwiki-source-7eb4a084904f7d07a203cbc2
    resource: repo://tests/migrations/0203-waitlist-mobile-verification-authority.test.ts
  - id: openwiki-source-b037985cdab5a0d739ca0a36
    resource: repo://tests/migrations/0204-new-client-admission-mode.test.ts
  - id: openwiki-source-d1274f4c491d333b834e3c28
    resource: repo://tests/migrations/helpers/migration-state.ts
  - id: openwiki-source-dfb951c77b8f835845bbc3a0
    resource: repo://tests/security/clinical-rpc-grant-guard.test.ts
generated: { by: "claude-code", at: "2026-10-02T20:08:11.217Z" }
---

# Migrations and hosted migration state

## 1. Files and numbers

- Files live in `supabase/migrations/` and must match `NNNN_snake_case_name.sql`; a malformed name or
  a duplicate version makes `scripts/migration-state.mjs` throw
  ([L42-L98](../../scripts/migration-state.mjs#L42-L98)).
- **`0158` is permanently skipped** and the next free number skips it
  ([L42-L43](../../scripts/migration-state.mjs#L42-L43), [L145-L147](../../scripts/migration-state.mjs#L145-L147)).
- **Never type a migration number as current truth.** Derive it:

```bash
npm run migration:state            # human summary
npm run migration:state -- --json  # repo max, next free, pending, repo_equals_hosted, …
```

- **Hosted state is declared, not derived**: `docs/production/migration-state.json` holds
  `hosted_migration_max`, `hosted_applied_at` (nullable) and its precision note, plus an append-only
  `$comment` history; update it in the same change that records an apply
<!-- openwiki: broken internal link [../../CLAUDE.md#L86-L128] heading anchor "L86-L128" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
  ([`CLAUDE.md` L86-L128](../../CLAUDE.md#L86-L128)). As recorded on 2026-10-01 the declared hosted
  max equalled the repository max with nothing pending
<!-- openwiki: broken internal link [../../docs/production/migration-ledger.md#L17-L17] heading anchor "L17-L17" does not exist in "../../docs/production/migration-ledger.md". Fix the href or restore the target, then delete this comment. -->
  ([`migration-ledger.md` L17](../../docs/production/migration-ledger.md#L17-L17)) — re-derive before
  relying on that.

A repository max **above** hosted is the normal migration-first state; a hosted max above the
repository is the defect. See [Production truth authorities](../architecture/production-truth-and-lifecycle-states.md)
and [Migration-first rollout](migration-first-rollout-and-production-safety.md).

## 2. Authoring conventions

| Convention | Why | Evidence |
|---|---|---|
<!-- openwiki: broken internal link [../../CLAUDE.md#L281-L283] heading anchor "L281-L283" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
| Open your own `begin;` … `commit;` and put `set local lock_timeout` **inside** it | `supabase db push` does not wrap a file in a transaction, so a bare `SET LOCAL` raises `25P01` and never arms | [`CLAUDE.md` L281-L283](../../CLAUDE.md#L281-L283); e.g. [`0204` L40-L42](../../supabase/migrations/0204_new_client_admission_mode.sql#L40-L42), [L794](../../supabase/migrations/0204_new_client_admission_mode.sql#L794-L794) |
<!-- openwiki: broken internal link [../../CLAUDE.md#L284-L288] heading anchor "L284-L288" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
| Revoke `EXECUTE` from `public`, `anon`, `authenticated` **and** `service_role` by name, then grant narrowly | Supabase default privileges grant `EXECUTE` on every new function to all three API roles (`0129` left `anon`, `0164` left `service_role`) | [`CLAUDE.md` L284-L288](../../CLAUDE.md#L284-L288); guard [`clinical-rpc-grant-guard.test.ts` L1-L40](../../tests/security/clinical-rpc-grant-guard.test.ts#L1-L40) |
| `SECURITY DEFINER` functions pin `search_path` | prevents resolution hijack | pattern across `0164`–`0204` (see [RLS, grants and SECURITY DEFINER](../security/rls-grants-and-security-definer.md)) |
| Schema-qualify pgcrypto / uuid-ossp calls as `extensions.<fn>` | on a fresh managed project those extensions are not on the migration `search_path`; `gen_random_uuid()` is built in and exempt | [`check-migration-extension-qualification.mjs` L1-L40](../../scripts/check-migration-extension-qualification.mjs#L1-L40) |
| Prefer additive, idempotent DDL; correct mistakes with a **new** migration | applied files are frozen | [Migration-first rollout](migration-first-rollout-and-production-safety.md#4-applied-migrations-are-frozen--and-mechanically-so) |

**Migration headers are authoring-time statements.** Because an applied file can never be edited,
its header keeps whatever it said when written — `0204`'s header still opens with "CANDIDATE, NOT
APPLIED" although the ledger records it applied
([`0204` L1-L7](../../supabase/migrations/0204_new_client_admission_mode.sql#L1-L7)). Read status
from the ledger and `migration-state.json`, never from a migration comment.

## 3. Per-migration tests

Each significant migration has a `tests/migrations/NNNN-*.test.ts` that pins its **structure from the
SQL text** (objects created, grants, CHECK sets, transaction framing) and, for applied ones, the
**sha256 of the file** against the bytes gated before the production write (see
[Migration-first rollout §4](migration-first-rollout-and-production-safety.md)). DB behaviour is
proven separately in `tests/db/` (see [Database and migration test harness](../testing/database-and-migration-test-harness.md)).

<!-- openwiki: broken internal link [../../CLAUDE.md#L86-L115] heading anchor "L86-L115" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
Rules from [`CLAUDE.md` L86-L115](../../CLAUDE.md#L86-L115) and the helper
[`tests/migrations/helpers/migration-state.ts`](../../tests/migrations/helpers/migration-state.ts#L1-L72):

- never hard-code the repository max or a "trip on the next one" filename regex; import
  `isRepoMax`, `versionsAbove`, `countVersion`, `fileForVersion` from the helper;
- only the **current maximum** migration's own test may assert it is the max.

**The "current claim" hand-off.** The newest applied migration's test holds the equality claim —
`0204`'s asserts hosted = repo = `0204`, nothing pending and next free `0205`, with an explicit note
that whoever applies the next migration must narrow it to a floor
([`0204` test L35-L49](../../tests/migrations/0204-new-client-admission-mode.test.ts#L35-L49)).
Older tests hold only floors such as "hosted ≥ this version"
([`0199` test L55-L80](../../tests/migrations/0199-reminder-sms-candidate-selection.test.ts#L55-L80)).

## 4. Generated types and other schema checks

- `lib/types/database.ts` is **hand-rolled** (narrower unions than generated output);
  `npm run check:db-types` generates types from the **local** stack only (`--local`, refuses
  hosted-looking URLs) and compares **column sets in both directions** for a curated table list
  ([`check-db-types.mjs` L1-L80](../../scripts/check-db-types.mjs#L1-L80)).
- `npm run check:migration-extensions` (extension qualification) and
  `npm run check:fresh-managed` keep the full chain applicable to a fresh managed project.
- Classifier: any change under `supabase/migrations/`, `tests/db/`, `tests/migrations/`,
  `scripts/migration-state.mjs` or the extension checks selects the database lane in CI
  ([`classify-changes.mjs` L50](../../scripts/classify-changes.mjs#L50-L50)).

## 5. Adding a migration — checklist

1. `npm run migration:state` → take the next free number.
2. Write the file with its own transaction, lock timeout, pinned `search_path` and by-name revokes.
3. Add `tests/migrations/NNNN-….test.ts` (structure) and `tests/db/…` (behaviour); move the
   "current claim" from the previous head's test when the new migration is **applied**, not merely
   authored.
4. If it changes columns of a curated table, update `lib/types/database.ts`.
5. Follow [Migration-first rollout](migration-first-rollout-and-production-safety.md); never apply
   without explicit per-change authorization.

## 6. Contradictions and open questions

1. **Six older migration tests pin the exact list of versions above them.** `0198`–`0203` assert
   `versionsAbove(VERSION)` equals a literal list ending in `"0204"`
   (e.g. [`0199` test L41-L53](../../tests/migrations/0199-reminder-sms-candidate-selection.test.ts#L41-L53),
   [`0203` test L42](../../tests/migrations/0203-waitlist-mobile-verification-authority.test.ts#L42-L42)),
   so authoring `0205` turns all six red. That is the "nothing above me" tripwire `CLAUDE.md` says
<!-- openwiki: broken internal link [../../CLAUDE.md#L101-L115] heading anchor "L101-L115" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
   older per-migration tests must not carry ([L101-L115](../../CLAUDE.md#L101-L115)). The `0199`
   test's own title, "is no longer the repository maximum — 0201 is", is also stale.
2. **`docs/09_DATABASE_AND_RLS.md` and `README.md` still print a current migration max.** `docs/09`
   says "Current repo max `0165`, so the next is `0166`" and "Repo and hosted are at parity: both are
<!-- openwiki: broken internal link [../../docs/09_DATABASE_AND_RLS.md#L30-L37] heading anchor "L30-L37" does not exist in "../../docs/09_DATABASE_AND_RLS.md". Fix the href or restore the target, then delete this comment. -->
   `0165`" ([L30-L37](../../docs/09_DATABASE_AND_RLS.md#L30-L37)); `README.md`'s status block says
   "Production migration max **0165** … next number is `0164`"
<!-- openwiki: broken internal link [../../README.md#L9-L12] heading anchor "L9-L12" does not exist in "../../README.md". Fix the href or restore the target, then delete this comment. -->
   ([L9-L12](../../README.md#L9-L12)). `CLAUDE.md` says these files should reference the canonical
<!-- openwiki: broken internal link [../../CLAUDE.md#L126-L128] heading anchor "L126-L128" does not exist in "../../CLAUDE.md". Fix the href or restore the target, then delete this comment. -->
   record instead of repeating a number ([L126-L128](../../CLAUDE.md#L126-L128)); neither file is in
   the canonical-facts guard's scanned set.
3. **Trigger-function `EXECUTE` is treated two ways.** The grant guard deliberately excludes
   `returns trigger` functions because they cannot be called directly
   ([`clinical-rpc-grant-guard.test.ts` L26-L31](../../tests/security/clinical-rpc-grant-guard.test.ts#L26-L31)),
   while known-limitation L33 records `0204`'s trigger function holding `EXECUTE` for every role as
   debt needing a new migration
<!-- openwiki: broken internal link [../../docs/production/known-limitations.md#L658-L658] heading anchor "L658-L658" does not exist in "../../docs/production/known-limitations.md". Fix the href or restore the target, then delete this comment. -->
   ([`known-limitations.md` L658](../../docs/production/known-limitations.md#L658-L658)).
