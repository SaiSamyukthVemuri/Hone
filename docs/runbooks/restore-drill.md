# Restore drill: database rows plus Storage objects (HIPAA-READY-01 G-12)

Issue #828 (gap G-12) and the Thursday rehearsal in #824 require an
**isolated, synthetic** backup-and-restore drill. This runbook defines it.
`scripts/ops/restore-drill.sh` runs it.

> This is local evidence about Hone's *procedure*. It is not evidence about
> the hosted project's backup configuration (PITR, retention, plan). That
> is checked read-only and recorded separately in
> `docs/security/hipaa-readiness-assessment.md` (G-03, G-12).

## Why Storage needs its own step

Supabase says: "Database backups do not include objects you store via the
Storage API, as the database only includes metadata about these objects"
([backups](https://supabase.com/docs/guides/platform/backups)). Treatment
photos live in the private `treatment-images` bucket. A database restore
alone brings back `treatment_images` rows that point at missing bytes.

## What the drill does

| Step | Action |
|---|---|
| 1 | Starts its **own** stack (`hone-restore-drill`, ports `5652x`/`8683`) from a scratch copy of `supabase/`. Only Postgres, PostgREST, Storage and Kong run. |
| 2 | Seeds synthetic rows (`scripts/ops/restore-drill-seed.sql`) and uploads three synthetic objects to `treatment-images` at paths that satisfy the table's path check. |
| 3 | Fingerprints every `public` table, plus `auth.users` and `storage.buckets` / `storage.objects`: row count and an order-independent md5. Also hashes the object bytes. |
| 4 | Backs up the rows with `pg_dump --data-only` and the object bytes through the Storage API, separately. |
| 5 | Destroys the project: `supabase stop --no-backup` deletes its volumes. |
| 6 | Starts a **new** project from the repository migrations, truncates the rows the migrations seeded, loads the export with `session_replication_role = replica`, and re-uploads the object bytes. |
| 7 | Compares fingerprints and object hashes. `storage.objects` is compared by count, because re-uploading refreshes its timestamps and version. Exits non-zero on any difference. |

**Guards.**
- It refuses to start if any `SUPABASE_`/`HONE_` variable names a hosted
  Supabase URL, or if a drill port is in use.
- It always deletes its stack on exit.
- It never touches another lane's stack.
- Run it on its own, never alongside a full local suite or another reset.

```bash
scripts/ops/restore-drill.sh /path/to/evidence-dir
```

## Recovery objectives (proposal: Sam to decide)

| Objective | Proposal | Basis |
|---|---|---|
| RPO, database | Point-in-time recovery window once PITR is enabled (G-03); until then, the plan's daily backup | Hosted configuration, unverified |
| RPO, Storage objects | Needs a scheduled object export; **none exists today** | This drill shows the export and restore route works; no schedule is set yet |
| RTO | Hours, not minutes, for a full rebuild; see the measured local timings below | Local drill timing is a lower bound |

## Results

Filled in by each run. Keep earlier rows.

| Date (UTC) | Migrations head | Result | Tables equal | Objects byte-equal | Backup | Restore | Total | Notes |
|---|---|---|---|---|---|---|---|---|
| 2026-10-12 00:26 | `6c5eac80` | **FAIL (true positive)** | 93 of 99 | 3 of 3 | 1 s | 280 s | 599 s | Six seeded tables restored **empty**. With `pg_dump`, `--table` overrides `--schema`, so the combined call exported no `public` rows. The fingerprint comparison caught it. Fixed by splitting the export into two dumps, plus a guard that fails the run if the export has no `public.clients` rows. |
| 2026-10-12 00:37 | `6c5eac80` | **PASS** | 99 of 99 | 3 of 3 | 1 s | 283 s | 594 s | Restore time is almost entirely re-applying the migration chain to the new project. |

**What this does and does not show**
- **Shows:** with Hone's migrations, a logical row export plus a separate
  object export is enough to rebuild a project: rows identical and photo
  bytes identical. It also shows the procedure detects an incomplete export.
- **Does not show:**
  - hosted PITR or backup configuration;
  - any hosted restore;
  - passwords for custom database roles. Supabase's daily backups omit
    them too;
  - restore at production data volume;
  - a scheduled object export. None exists yet; that is G-12's remaining
    gap.
