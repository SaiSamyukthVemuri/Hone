# Custom client groups proposal (HON-14)

Status: application and proposal prepared; **unnumbered and unapplied**. OPS owns
migration numbering, qualification, production apply and activation. No hosted
schema, client data, booking eligibility, payments, consent or outbound delivery
is changed by preparing this proposal.

## Data and authority

`client_groups` is a reusable, owner-only studio catalogue (at most 100 names,
trimmed, 1–60 characters, case-insensitive uniqueness). Stable UUIDs survive
renames. `client_group_memberships` links one client to any number of groups.
Composite foreign keys prove both links share the studio. Archiving/restoring a
client leaves memberships untouched. Existing clinical `client_tags` are separate
and remain unchanged and hidden from the main profile.

Only owners read these relations through their signed-in session. No practitioner,
receptionist, anonymous or service-role API reads are granted. Authenticated callers
have enumerated SELECT columns, no table write privileges. Three narrowly granted
commands independently verify `is_studio_owner` against the selected studio. There
is no caller-controlled actor, service-role client, deletion command or bulk
membership replacement. Create and individual membership changes are idempotent.
Rename compares both the expected name and precise timestamp, refusing stale tabs.
All three commands serialize under a studio NO KEY UPDATE lock; membership FK
checks do not introduce a key-share lock upgrade. Overlapping membership commands execute in the studio lock order, changing only
that one pair, never replacing other memberships.

## Availability and deployment order

- Old app + old DB: unchanged directory/profile.
- New app + old DB: ordinary directory works; owners see groups unavailable.
  An explicitly requested group filter fails closed with retry/remove guidance.
- Old app + new DB: no new writer or side effect; groups remain unused.
- New app + new DB: complete owner workflow appears when invoker reads succeed.

No unknown membership is reported as empty. Catalogue reads require exact count;
selected membership reads page in batches of 500 and reject truncation, duplicate
rows, changing counts and excessive bounds. Display labels read only the visible
page plus overview (at most 26 clients), never the entire membership dataset in
browser props. Filtering happens before counting and pagination. Invalid/foreign
filters do not reveal existence or fall back to all clients.

## Qualification and rollout

1. Review exact UP/DOWN SQL and assign the next OPS-controlled migration number
   after reconciling held changes. Do not copy over an existing reservation.
2. Run `tests/db/client-groups.db.test.ts` with the existing paired local API/SQL
   guard on an owned isolated stack. Each test installs the proposal when both
   relations are absent, or exercises the already-installed implementation. It
   always rolls back fixtures and compares the function/table catalogue; a
   partially installed schema refuses qualification.
3. Review direct-write/role denials, tenant FKs, duplicate/stale/idempotent results,
   cap and multi-studio owner behavior. Exercise concurrent catalogue creation at
   99 groups and same-pair assign/remove in the qualification slot.
4. On an owned disposable browser stack, install only the reviewed proposal with
   operator authority, then run `e2e/client-groups.spec.ts`. The browser spec never
   installs DDL and explicitly skips if the proposal is missing. A skip is pending
   qualification, not successful workflow evidence. Use existing local egress guards
   and synthetic fixtures; the normal disposable-stack reset owns cleanup.
5. Obtain exact-package production authorization before hosted apply. Regenerate
   schema snapshot/docs/production record only when promoted to a numbered migration.
6. Deploy app after qualified DB apply, or safely before it in unavailable mode.
   Verify owner directory/profile/manage flows and nonowner absence, then record
   deployment evidence. Owner acceptance remains separate.

## Recovery

A failed read presents unavailable; a failed selected filter presents an explicit
refusal. Expected command refusals use ordinary field feedback. An uncertain RPC
outcome asks to reload; it never promises that nothing changed. No automatic retry.
Existing logging does not receive names, client ids or SQL errors from this feature.

Prefer app rollback while retaining additive catalogue data. `DOWN.sql` removes
only the feature functions and tables, **destroying group labels and memberships**;
use it only with explicit authorization after evidence/export, never as automatic
cleanup on production. It does not alter clients or their operational state.

## Validation status

Pure/session-fake/action/rendered/mounted tests run without a database. Actual DB
and full browser qualification require the owned local stack and are pending in
this preparation environment (no PostgreSQL/Docker execution available). No claim
of live deployment or owner acceptance is made.
