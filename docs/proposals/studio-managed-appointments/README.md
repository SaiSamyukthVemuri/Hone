# Studio-managed appointments rollout

This is an unnumbered SQL proposal, not an applied migration. The application
change enables the owner-only control only when the database has the mode column.
No hosted apply, studio activation, message send, or financial change is part of
this PR.

## Contract

`studio_managed_appointments` defaults to false. Enabling it overrides client
portal, new/returning/invitation booking, cancellation and rescheduling. It does
not rewrite the studio's admission mode or individual self-service flags.
Disabling it restores those saved choices. Internal owner/staff booking remains
on its existing authorization path.

The authenticated owner command accepts the server-selected studio ID and a
boolean. It proves active ownership of that studio inside the database; the app
never forwards a browser-supplied studio ID. Multiple owned studios are supported. The
command holds the studio row lock through commit. Public booking/cancellation/
rescheduling commands acquire a `FOR NO KEY UPDATE` lock before any existing command body
runs. This conflicts with mode updates but permits the waitlist lifecycle
writers’ foreign-key `KEY SHARE` locks. Do not strengthen it to `FOR UPDATE`. If the mode is on, a fixed permission error aborts the transaction. Legacy
cancel/reschedule wrappers delegate to those guarded commands.

The guard is inserted into the actual migrated PL/pgSQL bodies without changing
function identity, arguments, defaults, return types, ACLs, ownership, or existing
booking decisions. The proposal refuses missing, overloaded, already-patched or
unexpected-owner commands. A missing studio continues to the existing command's
validation. Authenticated/anonymous/service roles cannot call the private guard
directly. Only authenticated owners may call the setting command.

### Booking-related commands outside the guarded set

Checked against the migrated chain (and pinned by the applied-state DB test), so
a reader does not assume the mode reaches something it does not:

- `reschedule_appointment_v2` is not patched. It delegates to the guarded
  `reschedule_appointment_v3`, so it refuses under the mode through that call.
- `cancel_appointment_core` is not patched. No client-facing role, and not the
  service role, may execute it, so a client cannot reach it.
- The first-generation `reschedule_appointment` and
  `finalize_card_required_public_booking` were dropped by earlier migrations and
  do not exist in the chain. The apply package must confirm that on the hosted
  catalog with a read-only check; if either still exists there, it needs the same
  guard in the same change.

If any of these gains a client-facing caller, or one of the dropped names is
created again, it needs the same guard in the same change.

## Qualification before release

1. Coordinate a migration number with the repository's migration queue. Do not
   reuse a number that is held or that another writer has reserved. Promote
   `UP.sql` into the migration chain only after review and numbering. Regenerate
   the schema snapshot and DB types through the repository's existing process.
2. On an owned isolated local stack, verify the paired API/SQL target and source
   SHA using `CLAUDE.md`. Save exact original definitions, signatures, owners,
   config and ACLs for all target functions in the reviewed apply package.
3. Run `tests/db/studio-managed-appointments.db.test.ts` through
   `vitest.db.config.ts`. It applies the proposal inside rolled-back transactions,
   uses synthetic fixtures, exercises real role/command behavior and verifies
   the original function catalog is unchanged afterward. No DB pass is claimed
   from source inspection or mocked tests.
4. Rehearse the numbered migration on a fresh full chain. Exercise valid new,
   returning and invited bookings with mode off; then refuse them with mode on.
   Check no invitation is spent, client created or appointment changed on refusal.
   Exercise existing internal booking, staff moves/cancellation and portal/old
   magic links. Verify standalone intake, confirmation, reminder and receipt
   delivery using the existing fake-provider harnesses.
5. Use two local connections to race mode enablement against each public commit
   entry point. A command holding the studio lock first may complete before the
   setting; after enablement commits, later public commands must refuse. Confirm
   no deadlock with waitlist locks and no mutation after a refused command.
6. Run normal required CI and independent review on the final numbered package.
   A unit/source check is not a substitute for DB behavior or concurrency proof.

The current preparation environment has no Docker or PostgreSQL executable.
The DB qualification file is provided but was not executed here. This remains a
release blocker until verified on an owned stack.

## Deployment and rollback

Apply only under the existing reviewed migration authorization. Deploy the
mode-aware application before enabling the mode for any studio. Old app plus
new database is compatible while the default remains off, but old app code does
not withdraw portal access or message links. Do not enable the control while an
old build still serves traffic.

New app plus old database preserves the old behavior and shows the setting as
unavailable. A missing/failed setting command never reports a successful save.
Existing studios are not silently opted into managed mode.

Already delivered messages cannot be recalled. Requests frozen in the existing
notification outbox before enablement may still contain an old link. Current
server gates refuse that link while managed mode is on; do not rewrite or replay
frozen provider requests to change their links.

After a studio enables managed mode, an application rollback must retain a
mode-aware build and the database guards. Rolling back to an unaware build can
reopen portal reads even though booking writes remain blocked. Do not drop the
column or guards while any studio relies on them. Disabling managed mode is an
explicit owner decision, not an automatic failure recovery step.

If full SQL rollback is authorized after all studios have explicitly disabled
the mode, restore the exact original command definitions from the preflight
package, verify their catalog/ACLs, then remove the private guard, owner command
and mode column in one reviewed transaction. Preserve the original archive and
receipts. Never reconstruct old bodies from a remembered historical migration.
