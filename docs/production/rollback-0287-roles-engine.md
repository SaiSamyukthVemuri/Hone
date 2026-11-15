# Rollback note: 0287 (Roles permission engine), HELD

Down SQL: `supabase/rollbacks/0287_roles_permission_engine.down.sql` (an operator runs it; supabase never does).

## Read this first: dropping the engine WIDENS access (Privacy G1)
Dropping the engine does not tighten anything. Every owner restriction stored in it (a permission switched off for practitioners or receptionists, for example `clin.view_photos` off) **stops applying**, and the app goes back to its legacy checks, which are more permissive than a restricted studio's settings. A studio that had narrowed a role would find that role has its old access again until the engine is restored. Treat the rollback as an access-widening change: do it only in a maintenance window, tell the affected owners, and re-apply 0287 and re-check their settings afterwards.

## What happens to the app if the engine is dropped
`requirePermission` (lib/permissions/require-permission.ts) distinguishes "the engine is not installed" (the database says `has_studio_permission` does not exist) from "the engine answered no" or "could not be read". When the engine is absent it **falls back to today's legacy checks** (every wired action keeps the studio, role and owner checks it had before the Roles work) and raises ONE operator alert per process (`permission_engine_absent`, ids only). It does **not** refuse anyone. Any other failure still fails closed. (Fail-open on a missing engine is a decision for Sam: NQ-9.)
So: dropping the engine, or deploying the app before 0287 is applied, restores legacy behaviour plus an alert. It is not a lockout.

## Order
The full apply, deploy, release and owner-activation sequence (keys pending until the operator releases them) is in [activation-0287-roles-engine.md](./activation-0287-roles-engine.md).
0287 applied and verified first, then the app that enforces. The pending-release receipt for the app PR states the dependency.

## Data loss
Dropping the engine deletes stored role permissions, ship gates and `permission_audit`. Export the audit first if it must be kept. No client, appointment or payment data is touched.

## Test
`tests/db/permission-engine.db.test.ts` ("rollback") applies the down SQL inside a transaction, proves the engine objects are gone and an existing table is unchanged, then rolls the transaction back. `tests/lib/permissions/require-permission.test.ts` proves the absent-engine fallback both ways.

## Must fix BEFORE the `staff_role_change` gate is turned on (Insurance RF-1)
`change_staff_role` is off by default (operator gate). While it is off this does not matter. Before any studio's gate is turned on: a new appointment can still be inserted for the practitioner between the upcoming-appointment count and the role change, because the check locks the existing rows but not rows not yet inserted. The fix is to lock the practitioner membership row (`FOR UPDATE`) first and re-check the count after the update, inside the same transaction, with a race test that inserts an appointment during the change. No code is written for this tonight; turning the gate on without it is a release blocker.
