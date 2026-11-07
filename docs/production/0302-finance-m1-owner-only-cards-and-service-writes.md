# 0302: finance M1, owner-only card summaries and owner-only service writes (HON-44)

**Status: APPLIED to production 2026-11-07 (read-back 16:32:02Z-16:32:05Z, APPLIED+VERIFIED).**
`supabase/migrations/0302_finance_m1_owner_only_cards_and_service_writes.sql`.
The apply was Sam's own-words decision; the record is in `docs/production/migration-ledger.md`
and `docs/production/migration-state.json`. This file is the proof the migration relied on. It is
evidence and argument, not apply authority, and it was written before the apply. The migration
is frozen; the down file was not applied.

## What it changes

Policies only. No grant, no function, no data (zero migration-level DML), one table comment.

| Table | Before | After |
|---|---|---|
| `client_payment_methods` | SELECT for every studio member (0058) | SELECT for the studio owner only (`is_studio_owner`) |
| `services` | INSERT and UPDATE for every member (0173) | INSERT and UPDATE for the owner only |
| `services` SELECT | member-wide | unchanged (M3 owns it) |

## Why no application change is needed

- Every application reader of `client_payment_methods` uses the service-role client.
  Pinned by `tests/security/finance-m1-card-readers.test.ts`, with a negative control.
- Every application writer of `services` sits behind `assertOwner`
  (`app/(app)/settings/services/actions.ts`). No practitioner flow writes the table.
- SECURITY DEFINER paths and the service role ignore policies, so card save,
  settlement and jurisdiction are unaffected.

## Proof (local, owned stack, synthetic data only)

- Chain applied from scratch with the pinned CLI (2.102.0); 0302 applied cleanly.
- `tests/db/finance-m1-owner-only.db.test.ts`, real JWTs: 14 of 14. Cases: owner, non-owner
  practitioner, receptionist, other studio's owner, anon, for the card table; owner,
  member, receptionist, other studio for services insert and update.
- Down file rehearsed: the 4 member-visibility cases go red, re-applying 0302 turns them
  green. `supabase/rollbacks/0302_...down.sql` restores 0058's and 0173's policies and
  0058's comment byte for byte.
- Three older tests pinned the OPEN GAP H1 (members could write services) and were flipped
  in this change: `cross-studio-catalog-guards`, `cross-studio-denial`,
  `appointment-parent-delete-boundary`. 104 of 104 pass across those and the new file;
  64 other related DB files passed before the flip.
- Hosted read-back and preflight with function-body fingerprints (Privacy G-4):
  `machines/window-reads-m1/`. Not run on hosted.

## Not covered (separate migrations)

M2 `client_pricing`, M3 studio fee columns and the checked read path, M4a policy
acknowledgements, M4b card-authorization consent rows. When R3 lands the owner predicate
is replaced by the finance permission keys.
