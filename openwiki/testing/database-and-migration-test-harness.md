---
type: test infrastructure
title: Database and migration test harness
description: How Hone proves database behaviour — the separate vitest DB lane against a local, fully migrated Supabase Postgres, the localhost-only harness with role and JWT simulation, seeding and synthetic-tenant helpers, lock-wait observation for concurrency tests, reachability closure, migration source-contract tests and frozen-hash pins, the pinned Supabase CLI and one-fresh-reset rule, and what a passing DB test does and does not prove.
tags: [db-tests, rls, migrations, vitest, supabase, testing, concurrency]
verified:
  - by: openwiki/0.6.1
    at: 2026-10-04T01:59:59.625Z
sources:
  - id: openwiki-source-a2371d6362e5db4bc834ad03
    resource: repo://CLAUDE.md
  - id: openwiki-source-eb10efb7264b39a67076cb7b
    resource: repo://docs/09_DATABASE_AND_RLS.md
  - id: openwiki-source-d81538d8891efe37053aeccb
    resource: repo://supabase/config.toml
  - id: openwiki-source-f6a9df45d3a108b6059bb641
    resource: repo://tests/ci/browser-selection.test.ts
  - id: openwiki-source-f08cb5f9aff737afac9bb1d1
    resource: repo://tests/db/active-card-per-mode.db.test.ts
  - id: openwiki-source-0d83da4b8318a33a4625642e
    resource: repo://tests/db/helpers/harness.ts
  - id: openwiki-source-830b65e7c20641e1009eeeba
    resource: repo://tests/db/helpers/reachability.ts
  - id: openwiki-source-9a78148f22629cd148561eaf
    resource: repo://tests/db/helpers/synth-fleet.ts
  - id: openwiki-source-7c8dd39f7c48bd2ffeb19e8b
    resource: repo://tests/db/helpers/waitlist-concurrency.ts
  - id: openwiki-source-4d53e0951cb8b5b071868d30
    resource: repo://tests/db/mode-scoped-connect-provisioning.db.test.ts
  - id: openwiki-source-a122c291bea87f78ace90c43
    resource: repo://tests/db/new-studio-admission-default.db.test.ts
  - id: openwiki-source-7b7b3bd77fe1c8a232af1dcd
    resource: repo://tests/migrations/0127-fix-author-insert-policy.test.ts
  - id: openwiki-source-a11a9d40d902ff26739beca0
    resource: repo://tests/migrations/0205-new-studio-admission-default.test.ts
  - id: openwiki-source-d1274f4c491d333b834e3c28
    resource: repo://tests/migrations/helpers/migration-state.ts
  - id: openwiki-source-672b943870a6b7ef89646e1e
    resource: repo://tests/scripts/db-harness-guardrails.test.ts
  - id: openwiki-source-f312c1d8cbce2135dbecf8e0
    resource: repo://vitest.db.config.ts
generated: { by: "claude-code", at: "2026-10-04T01:59:59.625Z" }
---

# Database and migration test harness

There are two layers of database proof:

| Lane | Location | How it proves things |
|---|---|---|
| **DB integration** | `tests/db/**/*.db.test.ts`, run by `npm run test:db` | exercises the **real migrated database**: policies, triggers, commands, constraints, privileges, races |
| **Migration source contracts** | `tests/migrations/`, part of the ordinary unit lane | reads migration SQL as text and pins scope, wording, and the bytes of applied migrations |

The CI job that runs the DB lane is described on [CI workflows and risk lanes](ci-workflows-and-risk-lanes.md).

## 1. What a passing DB test proves — and what it cannot

A green `tests/db` run proves the behaviour of the schema produced by **this checkout's migrations**, applied
from `0001` onward to a disposable local Postgres 17
([`supabase/config.toml` L33-L42](../../supabase/config.toml#L33-L42)).

It does **not** prove anything about the hosted database:

- whether a migration is applied there;
- whether production carries out-of-band objects the repository lacks — the appointment page records exactly
  such a gap for `snapshot_appointment_buffer()`;
- what the production ACLs are.

Hosted state comes only from the authorities on [Migrations and hosted state](../operations/migrations-and-hosted-state.md),
and production privilege facts need a recorded verification (see
[RLS, grants and SECURITY DEFINER commands](../security/rls-grants-and-security-definer.md#7-what-production-verification-records)).

## 2. The DB lane

`vitest.db.config.ts` ([L1-L45](../../vitest.db.config.ts#L1-L45)):

- includes only `tests/db/**/*.db.test.ts`;
- runs in node with forked processes and **file parallelism off**, because every suite shares one local database;
- sets a 20 s test timeout and a 30 s hook timeout;
- stubs `server-only` so DB tests can import server modules.

The unit lane excludes `tests/db/`, so `npm test` and `npm run ci` never need Docker. A guardrail pins this
([`db-harness-guardrails.test.ts` L22-L97](../../tests/scripts/db-harness-guardrails.test.ts#L22-L97)).

### The harness (`tests/db/helpers/harness.ts`)

**Connection guard** ([L1-L65](../../tests/db/helpers/harness.ts#L1-L65)):

- The only environment variable consulted is `HONE_LOCAL_DB_URL`, defaulting to the local port 54322. The
  harness never reads production credentials.
- The **whole** connection string is matched against hosted-database host patterns, and the parsed host must be
  a loopback name; otherwise it throws before any query runs.

**Execution helpers:**

| Helper | Runs as | Behaviour |
|---|---|---|
| `adminQuery` | local `postgres` (bypasses RLS) | autocommit; for seeding and ground truth |
| `adminTx` | local `postgres` | one transaction and one connection, so statements share a single `now()` ([L87-L124](../../tests/db/helpers/harness.ts#L87-L124)) |
| `asUser` / `userQuery` | `authenticated`, with `request.jwt.claims` set to `{sub, role}` | as PostgREST presents a signed-in user, so `auth.uid()` and RLS behave as in production; commits so trigger side effects are visible ([L126-L187](../../tests/db/helpers/harness.ts#L126-L187)) |
| `asRole` | `anon`, `authenticated` or `service_role` (allow-listed literal) | always **rolled back**; for EXECUTE and privilege probes |

**Seeding** (`seedStudio`, `seedMember`, `seedSession`):

- inserts fake `auth.users` rows with random UUIDs and `@harness.local` emails, plus studio, practitioner and
  client rows;
- uses random ids, so suites can rerun against the same database. Assertions must scope by those ids, never by
  global counts ([L189-L235](../../tests/db/helpers/harness.ts#L189-L235)).

**Time-dependent states.** Some states can only be built by bypassing a guard trigger, such as a 72-hour-old
appointment audit row. Those helpers disable the trigger **as the table owner** inside the test, then re-enable
it, deliberately instead of shipping a production-reachable RPC that would accept an arbitrary timestamp
([L296-L312](../../tests/db/helpers/harness.ts#L296-L312)).

### Other helpers

- **Synthetic tenant fleet** ([`synth-fleet.ts` L4-L38](../../tests/db/helpers/synth-fleet.ts#L4-L38)):
  - studios A (solo), B (three practitioners) and C (failure/recovery);
  - `SYNTH-` names and `@synth.local` emails, with run-unique ids and cleanup by id;
  - **partially delivered** — Studio C's failure modes are vocabulary only, with no executable fault injection
    yet.
- **Lock-wait observation** ([`waitlist-concurrency.ts` L5-L60](../../tests/db/helpers/waitlist-concurrency.ts#L5-L60)).
  Concurrency tests poll `pg_stat_activity` until a backend is **actually parked on a lock**, rather than
  inferring blocking from elapsed time, and report the last observed state when it never blocks. See
  [Scheduling concurrency and lock order](../scheduling/concurrency-and-lock-order.md).
- **Reachability closure** ([`reachability.ts` L1-L40](../../tests/db/helpers/reachability.ts#L1-L40)). A pure
  graph walk over function-to-function mentions, function-to-table mentions, table triggers and foreign-key
  actions. It over-approximates (reaching a table counts as writing it), so a resource can be called "dead" only
  when no application-reachable path touches it.

## 3. Migration source-contract tests

`tests/migrations/` has one file per significant migration. These files pin:

- each migration's scope — what it changes and what it must not touch;
- the bytes of earlier **applied** migrations through SHA-256, computed with `createHash("sha256")` over the file, for example
  [`0127-fix-author-insert-policy.test.ts` L42-L51](../../tests/migrations/0127-fix-author-insert-policy.test.ts#L42-L51),
  which pins `0126`.

Tests must not hard-code the repository maximum or a "nothing above me" filename pattern. They import
[`tests/migrations/helpers/migration-state.ts`](../../tests/migrations/helpers/migration-state.ts#L1-L72), which wraps
`scripts/migration-state.mjs` and exposes:

- the repository maximum, the next free number and skipped versions;
- the declared hosted maximum and its precision;
- `versionsAbove` and `countVersion` (which must be 1).

`CLAUDE.md` records that those hand-maintained pins once lived in 18 files and went red after each new migration
([§ 2. Migration state is DERIVED](../../CLAUDE.md#2-migration-state-is-derived--never-hard-code-it)). Only the current
head's own test may assert that it is the maximum; at this source head that is `0205`
([`0205-new-studio-admission-default.test.ts` L137-L144](../../tests/migrations/0205-new-studio-admission-default.test.ts#L137-L144)).
The same derive-don't-pin rule reaches database tests: the `0205` apply-time repair suite reads its census set from the
migration file instead of restating it
([`new-studio-admission-default.db.test.ts` L858-L880](../../tests/db/new-studio-admission-default.db.test.ts#L858-L880)).
How the per-migration tests are shaped is on [Migrations and hosted state](../operations/migrations-and-hosted-state.md).

## 4. The pinned CLI and the fresh-reset rule

`CLAUDE.md` sets local testing scope by migration risk class, at most **one fresh reset per migration head**,
using the **pinned** CLI ([§ Local testing by migration risk class](../../CLAUDE.md#local-testing-by-migration-risk-class)):

```bash
npx --yes supabase@2.102.0 db reset --local
```

A newer CLI's `db reset` strips the Data-API grants. Every `authenticated` query then fails at the privilege layer
in a way that looks like an application bug, so check `has_table_privilege(...)` before trusting a red lane. CI
pins the same version through `supabase/setup-cli`, and `tests/ci/ci-config.test.ts` guards that pin.

`npm run verify:changed` prints this reset-and-test command as a suggestion for database diffs; it never runs it
automatically.

## 5. Rerun hazards

Most suites are rerun-safe because they seed by random id. Where a **globally unique** column is involved, a
hard-coded fixture value would pass on a fresh database and fail on the second local run. Two Stripe-account
suites fixed this by deriving every synthetic id from one run-unique namespace instead of deleting rows
([`mode-scoped-connect-provisioning.db.test.ts` L29-L45](../../tests/db/mode-scoped-connect-provisioning.db.test.ts#L29-L45);
[`active-card-per-mode.db.test.ts` L15-L21](../../tests/db/active-card-per-mode.db.test.ts#L15-L21)). New suites
touching globally unique columns need the same treatment.

Data accumulates across runs because there is no cleanup by design. Anything asserting global counts will drift
until the next reset.

## 6. Contradictions and open questions

1. **`docs/09` gives unpinned reset instructions.** Its harness and types-drift sections say to run
   `supabase db start && supabase db reset --local`, with the CLI "on brew"
   ([`docs/09` § DB/RLS integration test harness (PR #220)](../../docs/09_DATABASE_AND_RLS.md#dbrls-integration-test-harness-pr-220), [§ Generated types drift check (PR #221)](../../docs/09_DATABASE_AND_RLS.md#generated-types-drift-check-pr-221)).
   `CLAUDE.md` requires the pinned `supabase@2.102.0`, because newer CLIs strip grants
   ([§ Local testing by migration risk class](../../CLAUDE.md#local-testing-by-migration-risk-class)).
2. **`docs/09` quotes a dated browser-spec count.** It cites "54 specs under `e2e/`" in a dated note
   ([§ DB/RLS integration test harness (PR #220)](../../docs/09_DATABASE_AND_RLS.md#dbrls-integration-test-harness-pr-220)). The browser group manifest now maps 94 specs.
3. **The synthetic fleet is incomplete by its own account.** Its Studio C failure modes are inert labels, and
   richer per-domain seeding is not delivered
   ([`synth-fleet.ts` L26-L38](../../tests/db/helpers/synth-fleet.ts#L26-L38)). Do not cite it as fault-injection
   coverage.
