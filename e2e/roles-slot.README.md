# Roles slot proofs (`e2e/roles-r6-*.slot.ts`)

Browser and API proofs for the Roles permission engine, written and run by the Photos lane on an OWNED stack in the exclusive slot.
They are named `*.slot.ts`, not `*.spec.ts`, so CI and the spec map do not pick them up (they need a prepared stack). Test-only.

Preconditions (the files skip with `BLOCKED, not FAIL` and the reason when the first is missing):
1. The permission keys are RELEASED on the stack. Seeds are PENDING (a stored Off is inert): run the operator function
   `mark_permissions_released` for the 7 `full` and the 6 `narrow` keys, tag `R1-R2`, as seeded (see `e2e/helpers/roles-release.ts`).
2. An owned local stack with the migrations of the head under test; `E2E_SUPABASE_URL` + `HONE_LOCAL_DB_URL` as a pair; the exclusive slot.

Run: `ROLES_R6_OUT=<dir> npx playwright test -c e2e/roles-slot.playwright.config.ts --project=chromium [-g "<title>"]`.
Rows are written to `$ROLES_R6_OUT/*.rows.jsonl`; `accepted` is always false: a run is evidence for review, not an acceptance.
`roles-r6-wired-keys` also needs storage in the stack (the photos row).
