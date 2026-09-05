# Contributor instructions — Hone

Working agreements for anyone (human or agent) changing this repository.

---

## Engineering standards — read this first

[ENGINEERING_STANDARDS.md](./ENGINEERING_STANDARDS.md) is canonical and is **not
restated here**. Follow it.

[docs/16_TOOL_AUTHORITY.md](./docs/16_TOOL_AUTHORITY.md) names which sources may
settle a question and which may only raise one. It adds no process. **T0/T1 work
acquires no role, review or evidence-stamping ceremony from it** — a one-line UI
change asserting nothing about production gets none of it. But whenever work of
*any* tier makes a claim about production, database state, a deployment, provider
state, or current-versus-historical evidence, that document's claim-validity and
source-of-truth rules apply. A T0 production reconciliation is exactly such a
claim.

**Validation depth follows risk, not habit.** Determine the baseline risk tier
(T0–T3) before choosing how much to prove.

- `npm run ci:plan -- --json` emits the **baseline** `baselineRiskTier` and
  `riskReasons`. (Plain `npm run ci:plan` answers lane selection; it prints only
  the boolean classification values, so the tier is in the JSON.) That is
  deterministic path evidence, **not semantic proof** — it cannot see what a
  file actually does.
- **Escalate** when the behaviour you are writing crosses a higher-risk
  boundary, even when every path looks ordinary.
- **Automated classification may never justify de-escalating** a change whose
  actual behaviour crosses a higher-risk boundary.
- Safety **and** speed are both requirements. Do not spend T3 ceremony — DB
  resets, negative-control campaigns, skew matrices, concurrency review — on
  T0/T1 work without naming the higher-risk failure class it catches.

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

### Know the scope before you test

```bash
npm run ci:plan              # what CI will run for this diff, and why
npm run verify:changed       # run the focused local checks that diff warrants
npm run verify:changed -- --plan   # dry run, execute nothing
```

**Use `ci:plan` output rather than inventing test scope by hand.** The CI
classifier and the local verifier share one path map (`scripts/classify-changes.mjs`
+ `scripts/browser-groups.mjs`); there is deliberately no second competing map,
so local expectations cannot drift from CI behaviour.

### Browser coverage is selected, not blanket

Measured: `browser e2e (local stack)` was **15.9–16.8 min**, of which **14.2 min
was the single test step** — 53 specs running serially (`workers: 1`). Setup was
only ~2.6 min, so caching setup was never the win.

Now: a PR runs only the browser **groups** its diff can affect (plus `smoke`),
and genuinely broad runs are **sharded across four separate jobs** (~45 specs
each) — separate runners mean separate Supabase stacks, preserving the
isolation the single-worker config protects.

Playwright browsers are cached in **every** browser-driving job, keyed to
runner OS + the exact resolved `@playwright/test` version + the lockfile hash.
On a cache hit only `playwright install-deps` runs; the ~150MB browser download
is skipped.

Shared paths (`e2e/helpers/**`, `playwright.config.*`, `lib/supabase/**`,
`middleware.*`, app shell, `package.json`, `.github/workflows/**`) force
**extended** coverage. Unattributable application code **fails safe to extended**
— never to a narrow group.

The required check is the stable `browser e2e (local stack)` **aggregator**.
Branch protection must never point at a dynamic shard name.

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

## 4. CI watchers and delivery ceremony

- **Exactly one active watcher per PR head.** Starting a new one requires
  stopping any stale watcher first.
- **Never poll in parallel** with a watcher, and never re-check a running job
  repeatedly. Report only when a run **settles**, or on a genuine
  timeout/failure.
- **A superseded head's watcher must terminate.** When you push a new head,
  cancel the superseded GitHub Actions run rather than letting it burn minutes.
- **Conditional exact-head merge authorization is honoured as given.** If the
  user authorizes a merge at an exact head, merge at that head once CI settles
  green — do not re-ask. A **changed head invalidates the authorization**.
- **No post-merge full CI rerun.** After merging, verify only: branch
  containment, deployment success where applicable, and a clean tree.
- **Green CI is not merge authorization.**

**A hard timeout must always EXCEED its performance target.** Run
`30767725631` set both to 10 minutes, so two extended shards were *cancelled*
at exactly their target — shard 2 had completed 72/90 tests with **zero
failures**. A budget problem was reported as a test failure. Targets and hard
timeouts are now separate numbers.

This has now recurred **three times**, always the same way: a lane sitting just
under its ceiling, a small workload increase, then a cancellation with zero test
failures that reads like a broken diff. Run `30814919019` took the targeted lane
(10 → 15). Run `31852791688` took extended shard 3 (12 → 18) — it ran 60 of 81
assigned tests, **all 60 passed**, and was cut at 12m15s after the suite gained
a spec and Playwright handed that shard +35% work.

F-PAY-002 took the **payment** lane (10 → 18) *before* it could recur a fourth
time, which is the cheaper way to learn this: the lane measured **9.6-10.4
min** locally across repeated runs of 57 serial specs while its single number
10 was serving as both target and ceiling. The observed run time and the ceiling were the same number,
with nothing left for a slow runner's setup.

**A ceiling must clear SETUP plus tests, and setup is not a fixed cost.** The
same 81 tests spent **508s** before the first test executed on one runner and
**266s** on another, while per-test speed barely moved (3.8s vs 3.6s) — so the
shard passed in 9m18s or was cancelled at 12m depending purely on which runner
it drew. Everything before the first test varies: the Supabase stack, the full
migration chain from scratch, Playwright, and the `next build` inside
Playwright's webServer. **When a shard is cancelled, check what it completed
before assuming the diff broke something.**

| Job | Budget |
|---|---|
| changed-path detection | 2 min |
| validate (typecheck/lint/build/unit) | 8 min |
| db integration | 8 min |
| targeted browser lane | target ~6 min · **hard timeout 15 min** |
| extended browser shard (×4) | target <10 min · **hard timeout 18 min** |
| nightly browser shard (×4) | hard timeout 15 min |
| payment browser e2e (fake stripe) | target ~10 min · **hard timeout 18 min** |
| Google / mobile | 10 min each |

---

## 5. Production safety

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

### CI supply chain

- Every action in `.github/workflows/**` is pinned to a **commit SHA** with a
  trailing `# vX.Y.Z` comment. A tag is mutable, and `supabase/setup-cli@v1` was
  a **branch** (`refs/heads/v1`), so every DB-touching job ran whatever that
  branch pointed at. Closes the pinning half of HNE-CI-001; the register row is
  referenced, never rewritten.
- `supabase/setup-cli` stays on the **v1** line. v3 is a composite action that
  installs the CLI from npm via Bun, and `version: 2.102.0` above is a
  grants-parity invariant — a major bump is its own ticket with its own grants
  re-verification and a fresh `db reset` proof.
- Both workflows declare `permissions: contents: read` at the top level and every
  checkout sets `persist-credentials: false`. No workflow holds write
  credentials. A new workflow that genuinely needs one declares **job-level**
  `permissions:` rather than widening the top-level block.
- Codex exact-head review (`npm run eng -- status <pr>`) is **operator-side**. Do
  not wire it into a workflow: it needs a GitHub API credential, which is exactly
  what the posture above removes.
