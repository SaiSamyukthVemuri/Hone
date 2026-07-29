# Rollout — migration 0158: containment for finalized structured treatment areas

> **STATUS: NOT APPLIED.** At the time of writing, production migration max is **0157** and
> `0158_finalized_structured_area_containment.sql` exists only in the repo. Applying it needs
> its own explicit, separate migration authorization. Nothing in this runbook has been
> executed.

**Rollout model: MIGRATION-FIRST (DB-first). The application deployment must NOT precede the
migration.** This one is unusual: the containment lives *entirely* in the migration. There is
no new application behaviour to ship alongside it.

---

## 1. The defect (P0, audit ref F-CLIN-000)

Migration 0128 made `public.session_block_areas` the **authoritative** structured
treatment-area + per-area laterality representation. `lib/sessions/block-areas.ts` states and
enforces the read contract: *if a block has `session_block_areas` rows, they are
authoritative*; the legacy `session_blocks.primary_area` / `side` pair is only a fallback for
blocks that have none.

0128 shipped that table **outside every clinical-integrity mechanism** introduced by 0119
(finalization) and 0120 (corrections/amendments):

| Mechanism | Covers | Covers `session_block_areas`? |
|---|---|---|
| `guard_finalized_clinical_write` trigger (0119) | `sessions`, `session_blocks`, `electrolysis_entries`, `laser_entries`, `treatment_images` | **No.** The table's only trigger was the 0128 studio-derive trigger. |
| Table privileges | Clinical artifacts are service-role-write | **No.** `authenticated` held SELECT/INSERT/UPDATE/DELETE/**TRUNCATE**/REFERENCES/TRIGGER — verified in production — under one `FOR ALL` RLS policy. |
| `build_session_snapshot` (0119) | Serializes the legacy block projection (`primary_area`, `side`, `custom_area_detail`) | **No.** Structured area rows are not in the signed document, so changing them does not change the `content_hash`. |
| 0120 correction appliers | `sessions`, `session_blocks`, `electrolysis_entries`, `laser_entries`, `treatment_images` | **No.** There is no structured-area applier and no snapshot representation, so an area change can be neither versioned nor restored. |

**Net effect.** A finalized clinical record's authoritative treated areas and laterality could
be rewritten — by any studio member's browser JWT, straight through PostgREST — while
`record_status`, `finalized_at`, `record_version`, `current_snapshot_id` and the signed
`content_hash` all stayed byte-identical. The record would still *present* as sealed. Note
`TRUNCATE` in particular: it is not a row-level operation, so **no RLS policy is consulted for
it at all** (see [09_DATABASE_AND_RLS.md](../09_DATABASE_AND_RLS.md), "RLS is not the same
thing as a table privilege").

### Why this is a P0 independent of feature-flag state

`clinical_finalization_enabled` and `clinical_corrections_enabled` are false on all 5 studios,
so today nothing can *become* finalized through the product. That is a fact about **exposure**,
not about the defect:

1. **The defect is in the integrity mechanism itself, not in a feature.** The finalization
   boundary's whole claim is "after finalization the clinical record is frozen and the freeze
   is provable." With the authoritative area table outside the guard, the snapshot and outside
   the correction lineage, that claim is false for a load-bearing clinical fact — the area
   actually treated. A flag cannot make a false integrity claim true.
2. **The flag is a runtime toggle, not a schema property.** Turning
   `clinical_finalization_enabled` on for one studio is a single `UPDATE`. If the toggle is
   the only thing standing between production and a silently mutable "sealed" record, the
   guard is the flag — which is exactly the posture 0119 was written to eliminate.
3. **One finalized record already exists.** Production has a real finalized session today (see
   §2). The boundary is not hypothetical; it is already in force on live data.
4. **Privileges are exploitable regardless of the flag.** The `authenticated` grants were live
   for every studio member, on every row, whether or not any record was finalized. `TRUNCATE`
   on the authoritative area table is a full-tenant clinical data-loss primitive that no RLS
   policy was ever going to stop.

## 2. Verified production state (read-only, project `alhhybgqdmcdyzpybykj`)

> **These are dated observations of a LIVE system, not standing facts.** Production charts daily:
> between 2026-07-27 and 2026-07-29 `session_block_areas` went from 8 rows to 15 and sessions from
> 72 to 76, with no action from anyone working on this PR. **Re-derive the baseline in §5
> immediately before applying** — the STOP conditions there, not the counts below, are what gate
> the apply. The invariant rows are what have held on *every* observation and are what make the
> apply safe.

Observed 2026-07-27 (the reconciliation baseline), re-confirmed 2026-07-29:

| Fact | Verified value |
|---|---|
| Hosted migration max | **0157**; 0128 applied; **no `0158`+ applied anywhere** |
| `clinical_finalization_enabled` | **false for all 5 studios** (Willow included) |
| `clinical_corrections_enabled` | **false for all 5 studios** (Willow included) |
| Sessions | 72 total — **71 draft, 1 finalized**; 59 legacy-origin, 13 native |
| The single finalized session | Belongs to a **non-Willow test studio**, finalized **2026-07-11T00:42:12Z**, has 1 block and **ZERO** `session_block_areas` rows, and has 1 `original` snapshot |
| `session_block_areas` | **8 rows** / 8 blocks / 1 studio (Willow) on 2026-07-27; **15 rows** / 1 studio on 2026-07-29 — live charting, expect it to have moved again |
| Structured-area rows on any **non-draft** record | **0** — invariant, holds on every observation |
| Structured-area rows created after their parent session's `finalized_at` | **0** — invariant, holds on every observation |
| The single finalized session's snapshot re-derives to its stored `content_hash` | **MATCH** — re-confirmed 2026-07-29 |
| `clinical_record_amendments` | **0 rows** |
| `clinical_audit_events` | **0 rows** |

### ⚠️ Explicit caveat — there is no durable update/delete history for this table

`session_block_areas` columns are `(id, session_block_id, studio_id, area, laterality,
display_order, created_at)`. There is **no `updated_at`**, **no `deleted_at`**, and **no
history/audit table**.

Therefore: **"0 rows were created after their parent session's `finalized_at`" does NOT prove
that no UPDATE or DELETE ever occurred.** An area row that was edited or deleted after
finalization would leave no trace at all — the row-count and `created_at` evidence above is
structurally incapable of detecting it. Every count in this document must be read with that
limit stated. What can honestly be said is:

- the only finalized session in production has **zero** area rows *today*, so there is nothing
  on it for 0158 to freeze — and, per the caveat directly above, a set of area rows *deleted*
  after finalization would be indistinguishable from a record that never had any. This bullet
  is a statement about current state, not about history;
- all 8 existing area rows hang off **draft** sessions, where mutation is legitimate;
- absence of evidence of tampering is **not** evidence of absence, and this baseline cannot be
  retroactively reconstructed. It becomes reconstructible only once structured areas are in
  the signed snapshot (see the mandatory follow-up, §8).

## 3. What migration 0158 does

Containment only. Read the migration header — it is the authoritative description; this is the
summary.

1. **`assert_session_chartable(uuid, uuid)`** and
   **`assert_structured_area_parent_mutable(uuid, boolean)`** — both `SECURITY DEFINER` with
   `search_path = ''` and every reference schema-qualified. Both lock the parent encounter with
   `select … from public.sessions where id = … **for no key update**`, and both reject a
   non-draft (finalized/void) or soft-deleted parent. Tenancy is read from the **stored**
   session row, so a forged `p_studio_id` can only narrow, never re-tenant. Neither is
   executable by `public`, `anon`, `authenticated` **or** `service_role`.

   *Why `for no key update` and not `for update`* — it is the strongest mode that still
   conflicts with the `FOR UPDATE` taken by `finalize_session` (0119), `correct_finalized_session`
   (0120) and `copy_session_setup` (0157), and with itself, **while remaining compatible with
   the `FOR KEY SHARE` Postgres takes on a parent row when a child row is inserted**. That
   matters: `soft_delete_session_area` (0123) locks a `session_blocks` row *first* and only then
   inserts its `session_audit` row, which needs `FOR KEY SHARE` on the session. With `FOR UPDATE`
   here, a concurrent area save and area removal deadlock — reproduced as SQLSTATE `40P01`
   during review, and now covered by a regression test in
   `tests/db/finalized-structured-area-containment.db.test.ts`.
2. **Trigger `session_block_areas_guard_finalized`** — `BEFORE INSERT OR UPDATE OR DELETE FOR
   EACH ROW` on `public.session_block_areas`, running
   `guard_finalized_structured_area_write()` (`SECURITY DEFINER`). It resolves the parent
   block → session **server-side** from the row, checks **both the old and the new parent on
   UPDATE** (so block reassignment *and* `display_order` reorder are covered), and tolerates
   exactly one path: the FK `ON DELETE CASCADE` cleanup where the parent block is already
   gone — which item 7 below (not 0119) makes safe. 0119's child-table branches compare only
   `record_status`, so they would *not* have made it safe on their own.
   Triggers are not bypassed by `service_role` and there is **no correction-context bypass**:
   the 0120 GUC permit is deliberately not honoured here, because structured areas have no
   correction representation yet, so a bypass would be a hole rather than a feature.
3. **Once finalized, always frozen.** The freeze does *not* key on `record_status` alone. The
   0120 permit lets a direct-connection caller UPDATE a finalized `sessions` row — including
   `record_status` — so a status round-trip (`finalized` → `draft` → mutate → `finalized`) would
   otherwise walk straight around the guard with `record_version`, `current_snapshot_id` and the
   signed `content_hash` all untouched. Both asserts therefore also reject on the finalization
   **evidence**: `finalized_at`, `current_snapshot_id`, and the existence of a signed row in
   `clinical_record_snapshots`. That last leg is the tamper-resistant one — snapshots are
   append-only for every role (0119), so the evidence cannot be edited away to reopen the window.
   Reproduced and covered by a regression test.
4. **Least privilege** — `revoke all on public.session_block_areas from public, anon,
   authenticated`, then `grant select` back to `authenticated`; the 0128 `FOR ALL` policy is
   narrowed to a SELECT-only policy named `session_block_areas_member_select`. `service_role`
   keeps `SELECT/INSERT/UPDATE/DELETE` — the trigger binds it — but **loses
   `TRUNCATE`/`REFERENCES`/`TRIGGER`**. `TRUNCATE` is the one that matters: it is statement-level,
   fires no `BEFORE ROW` trigger and consults no policy, so as `service_role` a single
   `truncate public.session_block_areas` would have emptied a finalized record's authoritative
   areas with every signed field byte-identical. Nothing in the product truncates this table.
5. **Hardened `create_session_block_with_areas` / `update_session_block_with_areas`** — same
   signatures, same allow-listed column set, same optimistic-concurrency contract
   (`stale_block_version`), same payload shape. The only change is that they call
   `assert_session_chartable(p_session_id, p_studio_id)` **first**, which locks the parent
   session before the block lock and fixes the global lock order at
   **`sessions` → `session_blocks` → `session_block_areas`** — the order `copy_session_setup`
   (0157) already uses. As a side effect the `max(sort_order)+1` computation in the create RPC
   can no longer race.
7. **`session_blocks_guard_signed_write`** — a companion guard on the PARENT table, covering
   `INSERT`, a reparenting `UPDATE` and `DELETE`. Two routes change a finalized record's
   authoritative areas **without writing a single `session_block_areas` row**, so the area guard
   above cannot see either:
   - **erase** — hard-delete the parent block; the areas follow by FK cascade, and by the time
     the area trigger fires there is no session left to resolve;
   - **reparent** — move a block (with its whole area set) into the signed record, or move the
     record's own block out. **Reproduced during review as `service_role`: a signed record's area
     count went 2 → 4 with `record_status`, `record_version`, `current_snapshot_id` and the signed
     `content_hash` all byte-identical.**
   - **soft-delete** — flip `deleted_at` on the parent block. Every read surface filters
     `deleted_at is null` (`getSessionBlocks`, the Before Today preview, the studio data export and
     `build_session_snapshot` itself), so the areas vanish from the chart, history and export
     without a row being deleted. **Reproduced during review as plain `authenticated` on a direct
     connection: a signed record's live areas went from three to one, `content_hash` unchanged.**
     The 0123 RPC path was already closed; this closes the raw `UPDATE`.

   0119 permits both after the status round-trip in item 3, because its child-table branches
   compare only `record_status`. This guard keys on the append-only snapshot instead. It is inert
   for every legitimate flow: a snapshot-carrying session cannot be deleted at all (the snapshot FK
   is `RESTRICT`), a finalized record's blocks are already frozen by 0119, and ordinary charting
   `UPDATE`s touch neither `session_id` nor `deleted_at`. Soft-deleting a block on a
   **never-signed** draft — the product's actual removal path, `soft_delete_session_area` (0123) —
   still works exactly as before.

   All three legs, and the area guard's own freeze, share ONE definition of "has ever been signed"
   (`session_has_been_signed`: `finalized_at`, `current_snapshot_id`, or an append-only snapshot
   row). An asymmetry between the two guards would itself be a hole.
8. **The 0128 studio-derive trigger is widened** to `before insert or update of session_block_id,
   studio_id`. It previously fired only on a `session_block_id` change, so an UPDATE touching
   **only** `studio_id` escaped the anti-spoof derivation and left a row whose denormalized
   `studio_id` disagreed with its parent — readable by the wrong studio through the
   studio-scoped SELECT policy and invisible to its real owner. The column list is kept narrow
   on purpose: an unrestricted `UPDATE` clause would make this `SECURITY INVOKER` trigger resolve
   the parent block on every edit, which fails for any role without a direct `SELECT` grant on
   `public.session_blocks`.

### Residual risks, stated rather than hidden

- **The table owner** can still `TRUNCATE` the table, `ALTER TABLE … DISABLE TRIGGER`, or set
  `session_replication_role = 'replica'` (which suppresses every `ENABLE ORIGIN` trigger).
  Verified on a CI-parity database: that GUC is **denied to both `authenticated` and
  `service_role`** — it is an owner-only lever. The trigger is deliberately left `ENABLE ORIGIN`
  rather than `ENABLE ALWAYS`: `ALWAYS` buys nothing against an owner who can simply drop the
  trigger, and it would make a logical restore (`pg_restore --disable-triggers`) of a finalized
  record's area rows fail. This residual is true of every trigger-enforced guarantee in the
  schema (0115, 0119, 0120, 0157); owner access *is* the migration channel.
- **A block can still be moved between two never-signed draft records** by a direct `UPDATE` on
  `public.session_blocks` — carrying its whole structured-area set with it — because
  `authenticated` holds DML on *that* table. Item 7 above blocks the move whenever **either**
  endpoint has ever been signed (keyed on the snapshot, so a `record_status` round-trip does not
  help), so no signed record can gain or lose areas this way. Draft-to-draft moves remain
  unguarded; they share a root cause with **L19** in `known-limitations.md` and are out of scope
  here.
- The containment claim is therefore precise: **no role reachable from the application — `anon`,
  `authenticated`, or `service_role` — can add, change, reorder, move, reparent, soft-delete,
  delete or erase a finalized (or ever-signed) record's structured areas.** The freeze keys on the append-only
  snapshot, so a `record_status` round-trip through the 0120 permit does not reopen any of those
  routes. It does **not** claim tamper-*evidence*: the signed `content_hash` still does not cover
  these rows, so a change made by the table owner, a future migration or a restore would leave the
  snapshot unchanged. That is snapshot v2 (§8).

### What 0158 deliberately does NOT do

- **No backfill. No area rewrite. No snapshot regeneration. No `record_status` change. No flag
  change. No historical-record modification. ZERO data operations.**
- It does **not** add structured areas to the signed snapshot.
- It does **not** add a structured-area correction applier.

### State this plainly

**0158 contains *mutation*. It does not make finalized structured areas tamper-EVIDENT.**

After 0158, a finalized record's areas cannot be changed through the database. But the signed
`content_hash` still does not cover them, so if an area row were ever altered by some path
outside the trigger (a future migration, a direct superuser session, a restore), **the
snapshot would not reveal it**. Detection requires snapshot v2 (§8). Do not describe 0158 as
making the clinical record tamper-evident, provable, or complete. It closes the write path;
it does not create evidence.

## 4. Why DB-first — and why it is safe in BOTH directions

This migration is schema/privilege-only with **zero data operations**, and it ships with no
application change. Both mixed-version directions are safe, which is what makes it applicable
ahead of (or entirely without) a deploy.

### Old app against the new DB — safe

The currently-deployed application contains **ZERO direct writes to `session_block_areas`**.
Verified by inspection of the deployed source; every reference is a `select`:

| Reference | Operation |
|---|---|
| `lib/supabase/queries.ts` | `select` (block area read for charting/history) |
| `lib/dashboard/before-today-previews.ts` | `select` (Before Today preview) |
| `app/(app)/clients/[id]/sessions/[sessionId]/whole-session-copy-actions.ts` | `select` (copy source projection) |
| `app/(app)/settings/data/actions.ts` | `select` (studio data export) |

Every **write** already flows through a `SECURITY DEFINER` RPC:

- `create_session_block_with_areas` (0129, hardened here),
- `update_session_block_with_areas` (0129, hardened here),
- `copy_session_setup` (0157) — which already requires an electrolysis **draft**, non-deleted,
  empty target session held under a `FOR UPDATE` lock, so its inserts satisfy the new trigger
  by construction.

Revoking browser DML therefore removes a privilege the deployed app never exercises. The one
privilege the app *does* need — `SELECT` — is explicitly re-granted, and the narrowed
`session_block_areas_member_select` policy keeps the same `is_studio_member(studio_id)`
predicate the 0128 `FOR ALL` policy used, so no existing read changes.

### New app against the old DB — safe

There is no new application call. 0158 adds no RPC the app invokes and changes no RPC
signature or payload shape. No runtime code path needs 0158 to exist in order to run.

One operator-tool caveat, by design: `scripts/verify-production.mjs` derives its expected
migration max from `supabase/migrations/`, so **run from this branch against a production still
at 0157 it will report "Remote migration max: expected 0158, actual 0157" and exit non-zero.**
That is the intended pending-apply signal, not a break — the same behaviour every
migration-first PR in this repo produces between merge and apply (see the comment on the
assertion in `tests/scripts/verify-production.test.ts`). Run it in §7, *after* the apply, where
it is a genuine health check.

**Consequence: 0158 can be applied on its own, under its own authorization, with no
coordinated deploy.** The documentation PR that accompanies it is code-free.

## 5. Pre-apply verification (READ-ONLY)

Run from the repo root. **Confirm the linked project ref is the intended production project
before any `--linked` command.** `supabase/.temp/project-ref` is a local CLI artifact that is
not tracked at the branch head but is present (carrying the production ref) in the operator's
main checkout, so a `--linked` command can silently target production from any directory that
inherits it. Never assume the link target; print it first.

```bash
# 0. Which project is linked?
supabase projects list

# 1. Remote max must be 0157; 0158 must show as local-only / pending.
supabase migration list --linked

# 2. Dry-run must print EXACTLY ONE filename:
#    0158_finalized_structured_area_containment.sql
#    STOP if it prints anything else.
supabase db push --linked --dry-run
```

Capture the "before" baseline so the post-apply diff is provable:

```bash
# BEFORE — privilege posture. Expected: authenticated = true across the board.
supabase db query --linked "
select r.rolname,
       has_table_privilege(r.rolname,'public.session_block_areas','SELECT')     as sel,
       has_table_privilege(r.rolname,'public.session_block_areas','INSERT')     as ins,
       has_table_privilege(r.rolname,'public.session_block_areas','UPDATE')     as upd,
       has_table_privilege(r.rolname,'public.session_block_areas','DELETE')     as del,
       has_table_privilege(r.rolname,'public.session_block_areas','TRUNCATE')   as trn,
       has_table_privilege(r.rolname,'public.session_block_areas','REFERENCES') as ref,
       has_table_privilege(r.rolname,'public.session_block_areas','TRIGGER')    as trg
  from pg_roles r
 where r.rolname in ('anon','authenticated','service_role')
 order by r.rolname;"

# BEFORE — policies. Expected: one FOR ALL policy (polcmd = '*').
supabase db query --linked "
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
  from pg_policy where polrelid = 'public.session_block_areas'::regclass order by polname;"

# BEFORE — triggers. Expected: the 0128 studio-derive trigger only.
supabase db query --linked "
select tgname from pg_trigger
 where tgrelid = 'public.session_block_areas'::regclass and not tgisinternal
 order by tgname;"

# BEFORE — data baseline. Nothing below may change across the apply.
supabase db query --linked "
select (select count(*) from public.session_block_areas)                            as area_rows,
       (select count(distinct session_block_id) from public.session_block_areas)    as blocks_with_areas,
       (select count(distinct studio_id) from public.session_block_areas)           as studios_with_areas,
       (select count(*) from public.sessions where record_status = 'draft')         as draft_sessions,
       (select count(*) from public.sessions where record_status <> 'draft')        as non_draft_sessions,
       (select count(*) from public.clinical_record_snapshots)                      as snapshots,
       (select count(*) from public.clinical_record_amendments)                     as amendments,
       (select count(*) from public.clinical_audit_events)                          as audit_events;"

# BEFORE — no area row hangs off a non-draft record. Expected: 0.
supabase db query --linked "
select count(*) as areas_on_non_draft
  from public.session_block_areas a
  join public.session_blocks b on b.id = a.session_block_id
  join public.sessions      s on s.id = b.session_id
 where s.record_status <> 'draft';"

# BEFORE — clinical flags. Expected: 0 / 0 out of 5.
supabase db query --linked "
select count(*)                                                as studios,
       count(*) filter (where clinical_finalization_enabled)    as finalization_on,
       count(*) filter (where clinical_corrections_enabled)     as corrections_on
  from public.studios;"

# BEFORE — fingerprint the signed artifacts + the protected clinical functions,
# so the post-apply run can prove byte-identity.
supabase db query --linked "
select count(*) as snapshots,
       md5(coalesce(string_agg(content_hash, ',' order by id::text), '')) as snapshot_digest
  from public.clinical_record_snapshots;"

supabase db query --linked "
select p.proname, md5(pg_get_functiondef(p.oid)) as def_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('build_session_snapshot','finalize_session','correct_finalized_session',
                     'guard_finalized_clinical_write','_apply_block_correction','copy_session_setup')
 order by p.proname;"
```

**STOP conditions:** the dry-run lists anything other than the single 0158 file · the linked
project is not production · `areas_on_non_draft` is not 0 · either clinical flag is true on
any studio. Any of these means the assumptions this migration was written under no longer
hold; re-verify before applying.

## 6. Apply

```bash
supabase db push --linked
```

Expect **exactly three NOTICEs** and nothing else — they are the file's own idempotent
`drop … if exists` no-ops firing against a database that does not yet have these objects:

```
NOTICE: trigger "session_block_areas_guard_finalized" for relation "public.session_block_areas" does not exist, skipping
NOTICE: trigger "session_blocks_guard_signed_delete" for relation "public.session_blocks" does not exist, skipping
NOTICE: policy "session_block_areas_member_select" for relation "public.session_block_areas" does not exist, skipping
```

No warnings, no errors, and **no row-count output** — 0158 performs zero data operations.

If the apply fails with `canceling statement due to lock timeout` (SQLSTATE `55P03`), that is
the file's deliberate `set local lock_timeout = '5s'` refusing to queue an ACCESS EXCLUSIVE
request behind live charting reads. Nothing was applied — the migration is one transaction and
performs no data operations — so simply retry, ideally outside clinic hours.

## 7. Post-apply verification (READ-ONLY)

```bash
# Ledger advanced to 0158, applied exactly once, nothing beyond it.
supabase migration list --linked
supabase db query --linked "
select version, count(*) from supabase_migrations.schema_migrations
 where version >= '0157' group by version order by version;"

# Both guard triggers exist, are row triggers, and cover INSERT + UPDATE + DELETE.
# tgtype must have bits 1 (ROW), 2 (BEFORE), 4 (INSERT), 8 (DELETE), 16 (UPDATE) = 31.
supabase db query --linked "
select t.tgrelid::regclass as tbl, t.tgname, p.proname, t.tgtype, t.tgenabled
  from pg_trigger t join pg_proc p on p.oid = t.tgfoid
 where t.tgrelid in ('public.session_block_areas'::regclass, 'public.session_blocks'::regclass)
   and not t.tgisinternal
 order by tbl, t.tgname;"

# The two assert helpers and the guard function exist, are SECURITY DEFINER,
# and pin search_path (proconfig must show search_path="").
supabase db query --linked "
select p.proname, p.prosecdef, p.proconfig
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('assert_session_chartable','assert_structured_area_parent_mutable',
                     'guard_finalized_structured_area_write','guard_signed_record_block_write')
 order by p.proname;"

# The assert helpers are executable by NOBODY (not even service_role) — they are
# internal to the trigger and the charting RPCs. Expected: all false.
supabase db query --linked "
select r.rolname,
       has_function_privilege(r.rolname,'public.assert_session_chartable(uuid,uuid)','EXECUTE')           as chartable,
       has_function_privilege(r.rolname,'public.assert_structured_area_parent_mutable(uuid,boolean)','EXECUTE') as parent_mutable
  from pg_roles r where r.rolname in ('anon','authenticated','service_role') order by r.rolname;"

# Privilege matrix AFTER. Expected: anon all false; authenticated SELECT only;
# service_role SELECT/INSERT/UPDATE/DELETE true.
supabase db query --linked "
select r.rolname,
       has_table_privilege(r.rolname,'public.session_block_areas','SELECT')     as sel,
       has_table_privilege(r.rolname,'public.session_block_areas','INSERT')     as ins,
       has_table_privilege(r.rolname,'public.session_block_areas','UPDATE')     as upd,
       has_table_privilege(r.rolname,'public.session_block_areas','DELETE')     as del,
       has_table_privilege(r.rolname,'public.session_block_areas','TRUNCATE')   as trn,
       has_table_privilege(r.rolname,'public.session_block_areas','REFERENCES') as ref,
       has_table_privilege(r.rolname,'public.session_block_areas','TRIGGER')    as trg
  from pg_roles r
 where r.rolname in ('anon','authenticated','service_role')
 order by r.rolname;"

# Exactly one policy, SELECT-only (polcmd = 'r'), same is_studio_member predicate.
supabase db query --linked "
select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
  from pg_policy where polrelid = 'public.session_block_areas'::regclass order by polname;"

# The charting RPCs kept their signatures and gained the lifecycle preamble.
supabase db query --linked "
select p.proname, pg_get_function_identity_arguments(p.oid) as args,
       pg_get_functiondef(p.oid) like '%assert_session_chartable%' as calls_assert
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('create_session_block_with_areas','update_session_block_with_areas')
 order by p.proname;"

# ZERO DATA OPERATION — every number must equal the pre-apply baseline.
supabase db query --linked "
select (select count(*) from public.session_block_areas)                            as area_rows,
       (select count(distinct session_block_id) from public.session_block_areas)    as blocks_with_areas,
       (select count(distinct studio_id) from public.session_block_areas)           as studios_with_areas,
       (select count(*) from public.sessions where record_status = 'draft')         as draft_sessions,
       (select count(*) from public.sessions where record_status <> 'draft')        as non_draft_sessions,
       (select count(*) from public.clinical_record_snapshots)                      as snapshots,
       (select count(*) from public.clinical_record_amendments)                     as amendments,
       (select count(*) from public.clinical_audit_events)                          as audit_events;"

# Signed artifacts untouched — digest must match the pre-apply digest byte for byte.
supabase db query --linked "
select count(*) as snapshots,
       md5(coalesce(string_agg(content_hash, ',' order by id::text), '')) as snapshot_digest
  from public.clinical_record_snapshots;"

# Protected 0119/0120/0157 function definitions unchanged — same md5 as pre-apply.
supabase db query --linked "
select p.proname, md5(pg_get_functiondef(p.oid)) as def_md5
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('build_session_snapshot','finalize_session','correct_finalized_session',
                     'guard_finalized_clinical_write','_apply_block_correction','copy_session_setup')
 order by p.proname;"

# Flags untouched. Expected: 0 / 0 out of 5.
supabase db query --linked "
select count(*)                                             as studios,
       count(*) filter (where clinical_finalization_enabled) as finalization_on,
       count(*) filter (where clinical_corrections_enabled)  as corrections_on
  from public.studios;"

# Health.
node scripts/verify-production.mjs
node scripts/check-stripe-gates.mjs
supabase db query --linked "
select count(*) as unresolved_critical from public.ops_alerts
 where severity = 'critical' and resolved_at is null;"
```

**Do not verify the guard by writing a probe row.** Inspect the trigger and function
definitions instead. The behavioural proof belongs in the local DB lane
(`tests/db/`), never on live clinical data.

Read-only post-apply application health check: open an existing draft charting session, add
and edit a treatment area, and confirm it saves. That path goes through
`update_session_block_with_areas`, so it proves the revoked browser DML did not break the
deployed app. **Do not finalize anything.**

## 8. MANDATORY FOLLOW-UP — snapshot v2 + structured-area corrections

> ### 🔒 HARD GATE
>
> **`clinical_finalization_enabled` MUST NOT be set true for any studio — including Willow —
> until snapshot v2 ships.** 0158 freezes structured areas at finalization; it does not put
> them in the signed document and does not make them correctable. Enabling finalization before
> the follow-up lands would mean: (a) a "sealed" record whose signed hash still does not cover
> its authoritative treated areas, and (b) a mis-recorded area that is **frozen forever** with
> no lawful correction path, forcing practitioners into a workaround the system cannot
> represent. That is a worse clinical-records position than today's dormant state.

Scope of the follow-up — all four parts are required before the gate lifts:

**(a) Put structured areas in the signed snapshot, under a NEW canonicalization version.**
`build_session_snapshot` (0119) emits `'schema', 'hone.clinical_snapshot.v1'`, and
`clinical_record_snapshots.canonicalization_version` is `integer not null default 1`. Snapshot
v2 must serialize each block's `session_block_areas` rows (area, laterality, display_order, in
a deterministic order) **under a new schema id and a new `canonicalization_version`** — not by
editing v1. Existing v1 hashes must stay valid and independently reproducible: an auditor must
be able to take a v1 row, re-run the v1 canonicalization, and get the same `content_hash`. The
version field is what makes that possible; do not repurpose it.

**(b) Add a structured-area correction applier plus the matching narrow permit.** 0120 has
appliers for sessions, blocks, electrolysis entries, laser entries and images, and a single
narrow bypass: the transaction-local, session-scoped `hone.correction_session_id` GUC that the
write guards honour only when it equals that exact row's `session_id`. Structured areas need
the same shape — an `_apply_structured_area_correction` allow-list applier, and a permit in
`guard_finalized_structured_area_write` that honours the same GUC under the same
session-scoped equality test. 0158 deliberately omits the permit, because a bypass with no
applier behind it is a hole. When the applier lands, the permit lands **with it, in the same
migration**, so a corrected area becomes a **new signed version** rather than a silent edit.

**(c) Resolve the inconsistency that already exists in 0120.**
`_apply_block_correction` allow-lists `primary_area`, `side` and `custom_area_detail` — so
today a correction *can* rewrite the **legacy projection** on a finalized record while the
**authoritative** `session_block_areas` rows stay unchanged. Because
`lib/sessions/block-areas.ts` prefers the structured rows whenever any exist, such a
correction is **silently overridden by the read contract**: the amendment is recorded, the new
snapshot version is written, and the chart still displays the old area. This is live in the
deployed 0120 code and is not fixed by 0158. Snapshot v2 must decide and implement one of:
correct both representations atomically; or reject a legacy-projection area correction on a
block that has structured rows; or drop the legacy fields from the correction allow-list
entirely once structured areas are correctable. Whichever is chosen, it must be documented in
the migration header and covered by the DB lane.

**(d) Decide and document the legacy / back-compat rule for records finalized before v2.** The
one finalized record in production today was signed under v1 and has zero structured-area
rows, so it is a clean case — but the rule must be written down, not inferred:

- Are pre-v2 snapshots re-hashed, or left at `canonicalization_version = 1` forever? (Default
  answer: **left alone**. Re-hashing a signed artifact destroys the property that made it
  worth signing.)
- How does a verifier know which canonicalization to apply? (By reading
  `canonicalization_version` off the row — which means every verification tool must branch on
  it, not assume v1.)
- What does the reader show for a v1-signed record whose block has structured rows added
  later — the rows exist but are outside the signature? Under 0158 that combination cannot be
  *created* after finalization, but a record finalized *before* 0158 could already carry it,
  and the caveat in §2 means we cannot prove none does.
- Is a pre-v2 record correctable at all under (b), and if so does correcting it migrate it to
  v2? Both answers are defensible; the point is that one must be chosen and written down.

Until all four ship, the honest description of the clinical record is: **finalized structured
areas are frozen, but they are not signed and not correctable.**

## 9. Rollback posture

| Scenario | Position |
|---|---|
| **Application rollback** | Not applicable — there is no application change. The documentation PR is code-free. |
| **Reverting 0158 (a hand-written down-migration)** | Would restore the P0. It would re-grant browser DML on the authoritative area table (including `TRUNCATE`), restore the `FOR ALL` policy, drop **both** guard triggers (`session_block_areas_guard_finalized` and `session_blocks_guard_signed_write`), restore `service_role`'s `TRUNCATE`, narrow the 0128 studio-derive trigger back to `session_block_id` only, and revert the charting RPCs to their unlocked 0155/0156 preamble — reopening the erase and reparent routes as well as the direct-DML one. **Do not do this as a reflex.** Prefer a forward corrective migration, as 0074 corrected 0073. |
| **What a revert would restore** | Exactly the pre-0158 schema/privilege/policy/trigger posture, and nothing else. |
| **What a revert would NOT restore** | Nothing — because 0158 destroys nothing. It performs **zero data operations**: no row is written, deleted, backfilled or rewritten, no snapshot is regenerated, no `record_status` or `record_version` changes, no flag changes. There is therefore **no data to restore** and no lost state to recover. |
| **Forward-compatibility of the old app** | Unaffected either way. The deployed app never writes this table directly (§4), so both applying and reverting 0158 are invisible to it apart from the freeze on finalized records. |
| **The one real behavioural change to be aware of** | After 0158, any attempt to write structured areas under a finalized, void or soft-deleted parent raises `check_violation` with a practitioner-readable message instead of silently succeeding. If some future path depends on that silent success, that path is the bug. |

## 10. Guardrails

- **Zero data operations.** If any verification step reports a changed row count, changed
  snapshot digest, or changed protected-function md5, stop and investigate — 0158 is not
  supposed to be capable of that.
- **No flag change.** `clinical_finalization_enabled` and `clinical_corrections_enabled` stay
  false on every studio. This migration is not authorization to enable either; §8 is a hard
  gate against enabling the first one.
- **No feature flag, cron, worker, or Google / Stripe / SMS / email interaction.**
- `probe_lots` and `electrolysis_entries.probe_lot_id` stay dormant.
- **Do not add a correction-context bypass to the structured-area guard** until the applier in
  §8(b) exists. The permit and the applier ship together or not at all.
- Do not verify the guard with a write against production. Use the local DB lane.
- **Out of scope, separately reported:** the role `anon` currently holds
  SELECT/INSERT/UPDATE/DELETE/TRUNCATE on `public.session_blocks`. 0158 does **not** touch it.
  It needs its own authorization and its own migration — see
  [../production/known-limitations.md](../production/known-limitations.md) (L19).
