# Receptionist desk: activation runbook (HELD, prepare-only)

Nothing here is authorized. Each stage needs Sam's own-words approval for that stage. The desk is dark by default: `HONE_RECEPTIONIST_DESK_ENABLED` must be exactly `true`.

## Prerequisites (database)
0258, 0266, 0272, then 0274, applied from a production-merged tree (see machines/RBAC-D3-MIN-PACKAGE-20261101.md). The desk reads only `receptionist_client_directory` and `receptionist_calendar_v2`.

## Gates before setting the flag (Privacy D-4)
1. A catalog read shows receptionist memberships only in the studios intended. The flag is process-wide; studio scoping is by membership rows.
2. The receptionist negative-test suite passes against the exact deployed app sha and the migrated database, with an owner positive control.
3. R8 (service names on the schedule) is decided, and D4 below is fixed or accepted in writing.

## D4: the schedule renders in the device clock (activation condition)
A receptionist cannot read the studio row, so the desk schedule uses the browser's timezone, and its window ("now minus 12 hours to now plus 7 days") is not a studio day. A front-desk device set to another zone shows wrong hours with no warning. Before the flag is set, either `receptionist_calendar_v2` returns the studio timezone (a reviewed 0274 change: read `studios.timezone` for the caller's studio only, validate against `pg_timezone_names`, UTC fallback, one string) and the desk formats on the server, or Sam accepts the device-clock limit in writing.

## Known limits
No multi-studio chooser (a receptionist in two studios lands on `/no-access?reason=multiple-studios`). Only the OAuth/magic-link callback lands on `/desk`; a password sign-in still goes to the dashboard first. The desk has no booking actions (create, move, cancel exist in the database, 0220, but have no screen).

## Rollback
Unset the flag and restart: `/desk` is a 404, the middleware exemption and the sign-in landing stop, no database read happens. Database rollback is by privilege, per role, never by drop (see the D3 package, section 7).
