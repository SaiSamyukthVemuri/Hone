# Activation and apply package: 0287 (Roles permission engine), HELD

Nothing here is authorized. Applying 0287 to a hosted database needs OPS's per-change authorization (CLAUDE.md §5). This note is the order of operations and what each step does and does not change. Rollback: [rollback-0287-roles-engine.md](./rollback-0287-roles-engine.md).

## The one rule to remember
**Applying 0287 and deploying the app change nothing for any user.** Every permission key is seeded **PENDING** (`permission_key_release.released_at` is null). A pending key resolves to today's behaviour (the existing snapshot), so an owner who sets a permission **Off** sees it saved and **no effect**: the stored choice is inert, and the Roles page reports the row as `source: unreleased` ("Saved, but not in force yet"). Nothing becomes effective until an operator **releases** the key, and for a widening, until the owner **activates** it.

## Order (do not reorder)
1. **Apply 0287** (operator, after authorization). Verify: `select count(*) from permission_key_release` is 14, all with `released_at is null`; 8 rows `release_kind='full'` (appt.cancel, appt.mark_no_show, appt.edit_notes, clin.view_records, clin.view_photos, clin.view_intake, clin.view_aftercare, clin.edit_records) and 6 `'narrow'` (appt.book, appt.move, appt.reassign, avail.manage_own, avail.manage_others, avail.manage_studio_hours). `appt.complete` (observe) has no row and is never released by this step. Down SQL: `supabase/rollbacks/0287_roles_permission_engine.down.sql`.
2. **Deploy the app that asks the keys** (#1341 and what stacks on it). An app deployed before 0287 falls back to legacy checks plus one operator alert; it does not lock anyone out.
3. **Release the keys, per key, only after step 2 is live and verified.** Operator only (no API role can execute it):
   `select public.mark_permissions_released(array['clin.view_records', ...], '<release tag>', 'full');` and the same for the narrow keys with kind `'narrow'`. A key is released once; a `narrow` release may later be upgraded to `full` under a NEW tag; anything else answers `already_released`. Release only keys whose enforcing code is deployed: releasing earlier makes an owner's Off apply to an action the app does not yet check.
   **`clin.edit_records` is the exception to "release with the rest": release it ONLY after 0289 (edit-record protections) is applied AND its proof has passed (the 0289 DB suite green on the applied schema, the guard triggers present, and the review of #1344/#1351 cleared). Until then it stays PENDING, so an owner's Off for it has no effect and the chart stays editable. Releasing it earlier would make an owner's Off apply in the app's gates without the database backstop (the 0289 guard) behind them.**
4. **Tell owners, then they activate.** A `narrow` key: an owner's narrowing (Off, or Own instead of Studio) applies at once on release; a widening beyond the snapshot stays at the snapshot. A `full` key: a stored choice made before release stays inert until the owner reviews the preview (`preview_activation`) and confirms (`activate_released_permissions` with the preview hash, a reason and, for sensitive keys, a confirmation). A studio created after the release gets the approved new-studio default.
5. **Verify** on one studio before announcing: set a key Off, confirm the refusal in the app and in `get_role_permissions` (`effective` = off, `source` not `unreleased`).

## What an owner sees before step 3
Setting a key Off saves, bumps the version and audits the change, **and has no effect** (page: "Saved, but not in force yet"). This is by design, so that deploying never silently narrows or widens access. Pinned by `tests/db/permission-activation.db.test.ts` ("unreleased key: an Off has no effect, and the page says so") and `tests/db/permission-production-config.db.test.ts`.

## Things that go wrong if the order is skipped
- Releasing before the app is deployed: an Off applies at the database but not in the actions that do not yet ask the key.
- Releasing `clin.edit_records` before 0289 is applied and proven: an owner's Off would refuse edits in the app but leave the database unguarded (a direct write or a missed action would still go through), and the page would show a protection that is only half there. Keep it pending until both are true.
- Telling owners to "turn it Off" before step 3: nothing happens, and they may believe access is restricted when it is not. Do not announce until step 5.
- The release step is operator-run and easy to forget: the whole product depends on it. Record each release (keys, tag, kind, time) in the migration ledger apply record.

## Not covered here
The TypeScript mirror of the resolver (`lib/permissions/catalog.ts`) does not yet implement pending/narrow; the Roles page must read `get_role_permissions`, not recompute. Hosted apply is not done.
