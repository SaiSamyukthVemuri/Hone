# Rollback note: 0287 (Roles permission engine), HELD

Down SQL: `supabase/rollbacks/0287_roles_permission_engine.down.sql` (an operator runs it; supabase never does).

## What happens to the app if the engine is dropped
`requirePermission` (lib/permissions/require-permission.ts) distinguishes "the engine is not installed" (the database says `has_studio_permission` does not exist) from "the engine answered no" or "could not be read". When the engine is absent it **falls back to today's legacy checks** (every wired action keeps the studio, role and owner checks it had before the Roles work) and raises ONE operator alert per process (`permission_engine_absent`, ids only). It does **not** refuse anyone. Any other failure still fails closed.
So: dropping the engine, or deploying the app before 0287 is applied, restores legacy behaviour plus an alert. It is not a lockout.

## Order
0287 applied and verified first, then the app that enforces. The pending-release receipt for the app PR states the dependency.

## Data loss
Dropping the engine deletes stored role permissions, ship gates and `permission_audit`. Export the audit first if it must be kept. No client, appointment or payment data is touched.

## Test
`tests/db/permission-engine.db.test.ts` ("rollback") applies the down SQL inside a transaction, proves the engine objects are gone and an existing table is unchanged, then rolls the transaction back. `tests/lib/permissions/require-permission.test.ts` proves the absent-engine fallback both ways.
