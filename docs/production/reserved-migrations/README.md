# Reserved migration numbers

One empty marker file per reserved number, named with the four-digit number (for example `0333`).

A number is reserved when it is claimed for work that is not in this tree yet, so its absence below a higher migration is not a hole.
`scripts/migration-state.mjs` reads this directory through the same validation as the array in `migration-state.json`
(`reserved_unallocated_above_hosted`): a reserved number must be strictly above the hosted max and below the repo max, and must have no
repo file. A number declared both here and in the array is invalid.

- **Add** a marker in the change that records the claim.
- **Remove** a marker in the same commit that adds the migration file for that number, and only that marker. A marker left beside its
  migration file fails the migration-state checks.
