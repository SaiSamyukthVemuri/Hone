# Preparation evidence — client groups

Prepared from production `7ca53e639`.
This records working-tree checks; publication must verify the final committed tree.
Nothing here touched a production database, sent a message or changed a provider.

- `npx vitest run tests/lib/clients tests/app/clients tests/components/client-groups-mounted.test.ts tests/lib/nav/directory-return.test.ts`: **102 files, 1,453 tests passed**. Includes existing directory/profile decomposition, identity, role and source contracts; new read/action/render/mounted regressions.
- `npx vitest run tests/app/clients/client-groups-profile-read.test.ts`: **2 tests passed**, added after the broader run; verifies nonowner/nonoverview zero DB creation and one-client scoping.
- `NODE_OPTIONS=--max-old-space-size=6144 npx tsc --noEmit --pretty false`: **passed** after removing stale generated `.next/types` from an unrelated previous branch. No source was changed to satisfy those generated stale routes.
- ESLint on all changed application/library files and new unit/DB/browser specs: **passed**.
- `git diff --check`: **passed**.
- `npm run check:stripe-gates`: **passed**; no payment path changed.
- `NODE_OPTIONS=--max-old-space-size=6144 npm run build`: **passed**, including compilation, type validation, static generation and optimization. The initial default-heap attempt compiled but its checking worker exhausted the 2 GB Node heap; the expanded-heap retry completed successfully. Existing lint/deprecation and unset local email-key warnings remain.
- Migration source, documentation and CI selection contracts: **60 files / 1,295 cases covered**. The first run caught the new browser spec missing from the manifest and two stale documented spec counts. After registering it in the existing extended group and updating counts, the two affected suites passed all **43 tests**; the other 58 files had passed unchanged.
- `node scripts/migration-state.mjs --json`: **passed**; no numbered migration was added.
- Negative control: temporarily disabling the application owner gate made both practitioner/receptionist denial tests fail as expected. The original source was restored byte-for-byte and all **7 action tests passed** again. This is application-layer evidence, not a substitute for real DB privilege tests.
- Independent source review checked owner RLS, grants, composite tenant FKs, command scope and completeness checks. The identified stale-rename form bug was fixed and pinned by a mounted regression. Root additionally checked the final studio-lock serialization and directory integration.
- Classifier plan: the highest risk tier (privileged commands, tenancy and database permissions). Standard safety/type/lint/build/unit lanes, DB integration and extended browser are required. Payment/Google/mobile lanes are skipped by the classifier, not claimed as executed.

The existing profile read-decomposition test initially caught three stranded serial
reads; group reads now join its existing independent parallel wave. The existing
directory-control architecture assertion now permits the new group selector while
keeping existing sort/intake/last-visit controls exposed. No behavior assertion was
removed or weakened to clear a failing workflow.

## Local qualification (owned test stack, 22 Nov 2026)

- `tests/db/client-groups.db.test.ts`: 4 tests passed (rolled-back transaction).
- `tests/db/client-groups-applied.db.test.ts`: 12 tests passed. The proposal is installed for real, then removed with `DOWN.sql`, and the whole public catalogue equals its state before. Covers exact privileges by role name, owner-only reads, tenant isolation, cascading foreign keys, and two-connection races (same name, create at 99 groups, rename against create, rename against rename, same-pair assign against remove, and the studio lock) with no deadlock or timeout.
- Seven database mutants each turned a test red: no studio lock, no per-command lock timeout, a service-role read grant, no cascade, a `DOWN.sql` that leaves a function, and a cap off by one.
- `e2e/client-groups.spec.ts` passed (1 test, not skipped) with the proposal installed.
- Unit mutants: a repeated membership id, a short labels page and a fall-back to every client each turn a test red.

The earlier line below describes the first preparation pass, before these runs:

Real DB proposal tests and browser journey are **provided but not run** here: this
preparation environment lacks an owned PostgreSQL/Docker stack and browser runtime
qualification. The browser spec explicitly skips schema absence, so a skip remains
pending evidence. The required pull-request checks still have to pass. The SQL
has no migration number yet. See the README for checks, concurrency and rollback.
