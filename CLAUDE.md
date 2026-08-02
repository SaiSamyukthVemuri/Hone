# Contributor instructions — Hone

Working agreements for anyone (human or agent) changing this repository.

---

## 1. The delivery sequence — verify the COMMITTED tree, not the working tree

**"Typecheck passed" is a claim about your working tree, not about what you pushed.**

This has bitten us twice, both times the same way — the tested tree and the
committed tree diverged:

- a `git stash push -- <paths>` cycle reset the index for those paths, so a
  subsequent commit captured only the *new* files and CI failed on a missing
  export while local `tsc` was still clean;
- a `git add app docs tests` missed `README.md` at the repository root, so a
  locally-green commit would have failed the docs guard.

Follow this sequence before every push:

```bash
git add -A                     # 1. stage everything, including new files
git diff --cached --check      # 2. whitespace / conflict markers
git status --porcelain         # 3. confirm no untracked file was omitted
git commit -m "..."            # 4. commit
git status --porcelain         # 5. must be empty (bar the allowlist below)
git diff HEAD --exit-code      # 6. must be empty — commit == tree
npm run verify:prepush         # 7. all of the above, mechanically
git push                       # 8. push
```

`npm run verify:prepush` performs steps 2, 3, 5, 6, 7 and fails on:

- tracked modifications remaining after the commit;
- untracked files that look like they belong in the commit;
- unresolved conflict markers;
- whitespace errors;
- a migration state that does not derive cleanly.

It installs no Git hook and mutates nothing. Run it explicitly.

**Documented local-only allowlist** (never commit these):
`supabase/config.toml` — local E2E stack config, untracked by CLI convention.

---

## 2. Migration state is DERIVED — never hard-code it

`scripts/migration-state.mjs` is the single source of truth.

```bash
npm run migration:state          # human summary
npm run migration:state -- --json
```

It derives from `supabase/migrations/*.sql`:

- repository migration max
- next free migration number (skipping permanently-skipped slots)
- total migrations, duplicate detection, malformed-prefix rejection

**Do not add a `toBe(0166)` or a `/^01(6[7-9]|[7-9]\d)_/` "trip on the next one"
regex to a test.** Those pins previously lived in **18 files** across
`tests/migrations/`, `tests/docs/` and `tests/scripts/`, so every migration meant
a mechanical sweep — and a local run scoped to the "obviously relevant"
directory missed the rest. That is precisely how 0163, 0164 and 0165 each went
red after push. Import from `tests/migrations/helpers/migration-state.ts`
instead:

```ts
import { isRepoMax, versionsAbove } from "./helpers/migration-state";
```

Only the **current maximum** migration's own test may assert `isRepoMax`.
Older per-migration tests must not — their "nothing above me" tripwire is now
served centrally.

### Hosted state is declared, not derived

A file on disk says nothing about what production has applied. Hosted state
lives in exactly one place:

**`docs/production/migration-state.json`** — `hosted_migration_max` and when it
was applied. Update it in the same change that records a production apply. The
full narrative apply record stays in `docs/production/migration-ledger.md`.

Everything else — `docs/09_DATABASE_AND_RLS.md`, `README.md`, the roadmap,
`current-state.md` — should reference the canonical record rather than repeating
a number that changes. Historical apply records are **not** rewritten.

---

## 3. CI is risk-based — expect only the lanes your diff can affect

PR CI classifies the diff against the **merge base** and runs only the relevant
lanes. Logic: `scripts/classify-changes.mjs`, proved by
`tests/ci/classify-changes.test.ts`.

| Change | Lanes |
|---|---|
| Docs / ledger / apply record only | docs + consistency checks only |
| Application (UI, routes, actions) | typecheck, lint, build, unit, core browser |
| Database / migration / RLS / security | migration checks, fresh DB chain, DB+RLS, security guards |
| Payment | core + payment safety gates + payment E2E |
| Google Calendar | core + Google unit/integration + fake-Google E2E |
| Mobile / responsive | core + mobile completion E2E |
| Shared infra (`package.json`, `tsconfig`, `lib/supabase/**`, test harnesses) | **full matrix** |
| CI workflows themselves | **full matrix** |

A lane that does not apply is reported **skipped**, which satisfies branch
protection — it does not silently disappear.

**The full matrix still runs**, nightly at 07:00 UTC and on demand via
`workflow_dispatch` (`.github/workflows/nightly.yml`). Coverage was *moved*, not
weakened. Run it manually before a deliberate release candidate, or whenever you
doubt a risk classification.

### Local testing by migration risk class

1. **Privilege-only / comment-only / metadata-only** — source-contract test,
   focused DB privilege test, one fresh DB reset, migration-state guards.
   No full unit suite.
2. **Additive function/RPC** — focused DB behavioural tests, affected
   application tests, typecheck, one fresh DB reset. No full unit suite unless
   shared runtime code changed.
3. **Table / trigger / RLS / destructive / payment** — focused DB tests,
   affected unit tests, one full unit suite, broader CI as appropriate.

One fresh DB reset per migration head, maximum. Use the **pinned** CLI:

```bash
npx --yes supabase@2.102.0 db reset --local
```

A newer CLI's `db reset` strips Data-API grants; every authenticated query then
fails at the privilege layer and it looks exactly like an application bug.
Confirm `has_table_privilege(...)` before trusting a failing lane.

---

## 4. Production safety

- No production write or migration without explicit, per-change authorization.
- Read-only production SQL is `supabase db query --linked`. Never `db execute`.
- Confirm `supabase/.temp/project-ref` is the intended project before every
  Supabase command.
- An applied migration is **frozen** — never edit it. Write a new one.
- A migration must open its own `begin;` / `commit;` and `set local
  lock_timeout` inside it. `supabase db push` does not wrap a file in a
  transaction, so a bare `SET LOCAL` emits `25P01` and never arms.
- Supabase's `ALTER DEFAULT PRIVILEGES` grants EXECUTE to `anon`,
  `authenticated` **and** `service_role` at function-create time. An
  authenticated-only command must revoke from **all three** explicitly, by name.
  Missed once in 0129 (`anon`) and again in 0164 (`service_role`); now pinned by
  `tests/security/clinical-rpc-grant-guard.test.ts`.
