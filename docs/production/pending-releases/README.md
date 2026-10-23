# Pending-release receipts

A production merge that is not record-only (it changes anything outside
`docs/production/**`) used to make the canonical record stale at once: rule
**A5** in `tests/docs/canonical-production-facts.test.ts` failed on the merge's
own push run until a dedicated record PR landed. A receipt in this directory
lets such a merge be **batched** into a later record refresh instead. The rule
it relaxes is not weakened: every claim a receipt makes is recomputed from git.

Authority: Sam's standing ruling, HON-18 comment 39ad5aaf, row "Production
records" (batch narrative record updates, keep exact release receipts
immediate, never weaken the oracle).

## The release step

Every release PR whose merge will not be record-only adds **one** file,
`docs/production/pending-releases/<PR>.json`, in the PR itself:

```json
{
  "pr": 1234,
  "runtime": true,
  "migrations": [],
  "release_receipt": "01-ops/1234-release-receipt.json"
}
```

- `pr`: the PR number. It must equal the number in GitHub's merge subject
  (`Merge pull request #1234 from ...`) and the file name.
- `runtime`: `true` when the merge changes any runtime-bearing path, judged by
  the same rule A3 uses (`scripts/classify-changes.mjs` plus the non-shipping
  roots in the guard). CI-, test- and docs-only changes are `false`. If in
  doubt, run the guard: a wrong value fails it.
- `migrations`: every `supabase/migrations/**` path the merge changes, or `[]`.
- `release_receipt`: the operator's release receipt (READY deployment, alias,
  smoke), written at release time exactly as before. CI cannot check Vercel, so
  the guard only checks that this pointer has the conventional shape.

A merge that has **already landed** without a receipt is covered by a *late*
receipt, which must also name the exact merge commit in `merge` (40 characters).
`1048.json` is the first one: #1048 merged as `a1164b9b` before this mechanism
existed.

## What the guard confirms (and refuses)

A non-record merge after the recorded **Current Git branch HEAD** is covered
only when:

1. it is a two-parent GitHub pull-request merge;
2. its receipt was added **by that merge** (the file is absent from the merge's
   first parent), or the receipt names the merge's exact SHA;
3. the receipt's `runtime` equals the recomputed decision for the merge's own
   first-parent diff;
4. its `migrations` equal the migration paths that diff changes.

A malformed receipt (unknown key, wrong type, wrong pointer) fails the guard
and is never skipped. A receipt is read from the tree it was merged in (or, for
a late receipt, from the checkout and production; the same receipt found in
both counts once, while two different receipts naming one merge fail).

**A3** additionally requires every runtime-bearing merge since the runtime pin
to be covered with `runtime: true` **and to lie after the recorded Current Git
branch HEAD**. A runtime-bearing merge at or before the recorded HEAD fails A3
whatever receipt it has: once a refresh records past a runtime merge, the pin
must have moved with it.

**A7** bounds the batch:

- **8 covered merges** after the recorded HEAD is the hard limit; a ninth fails.
- The oldest covered merge may trail the production tip by at most **72 hours,
  measured in git committer time against the production tip's own committer
  time**, not against the wall clock. The rule is reproducible for any
  checkout, but it does not age on a branch that receives no further merges.
  The merge count is the bound that always holds.

## The batched record refresh

When the batch is due (or A7 says so), one record PR updates the narrative, the
**Current Git branch HEAD** and, if runtime shipped, the runtime-bearing pin in
`current-state.md`, and deletes the receipts it absorbs.

**If the batch contains any runtime-bearing merge, the refresh MUST move the
runtime-bearing pin to the newest of them.** Deleting a receipt does not
uncover its merge (in-PR receipts are read from the merge's own tree), so it is
not the deletion that keeps the record honest. It is A3: after the refresh,
every runtime-bearing merge at or before the new recorded HEAD must be at or
before the pin, or A3 fails. A5 and A7 then count only merges after the new
recorded HEAD.
